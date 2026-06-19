/**
 * The standard x402 `exact` rail on Solana (SVM) — the buyer's partial-sign + the gate's
 * verify-and-self-settle (merchant as fee payer), with NO network: a stub `connection` returns
 * a fixed blockhash and controllable simulate/broadcast/confirm. Proves the round-trip, the
 * fee-payer MUST-rules, the trusted-accept binding, and the VerifyResult/SettlementError split.
 */
import { describe, it, expect } from 'vitest'
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { payExactSolana, verifyAndSettleExactSolana } from '../../src/drivers/solana/exact.js'
import { createPaymentGate } from '../../src/index.js'
import { SettlementError, UnsupportedSchemeError } from '../../src/errors.js'
import type { X402ExactAcceptEntry } from '../../src/x402.js'

const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 1))
// SPL-Memo program (category-exempt §2.2.2) — the scheme-MUST instruction the buyer now appends.
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

const buyer = Keypair.generate()
const feePayer = Keypair.generate() // the merchant's gas/relayer key (NOT payTo)
const merchant = Keypair.generate() // payTo (receive)
const MINT = Keypair.generate().publicKey

function makeAccept(over: {
  payTo?: string
  amount?: string
  asset?: string
  feePayer?: string
  decimals?: number
  tokenProgram?: 'spl-token' | 'token-2022'
  memo?: string
} = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: over.amount ?? '50000',
    asset: over.asset ?? MINT.toBase58(),
    payTo: over.payTo ?? merchant.publicKey.toBase58(),
    maxTimeoutSeconds: 600,
    extra: {
      assetTransferMethod: 'svm',
      feePayer: over.feePayer ?? feePayer.publicKey.toBase58(),
      decimals: over.decimals ?? 6,
      tokenProgram: over.tokenProgram ?? 'spl-token',
      minConfirmations: 1,
      ...(over.memo !== undefined ? { memo: over.memo } : {}),
    },
  }
}

/** Decompile a built buyer tx into `{ program, data }[]` (program = base58 id, data = UTF-8 text). */
function decodeInstructions(b64: string): { program: string; data: Buffer }[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
  return tx.message.compiledInstructions.map((ix) => ({
    program: tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58(),
    data: Buffer.from(ix.data),
  }))
}

/** The single SPL-Memo instruction's UTF-8 data from a built buyer tx (asserts exactly one Memo). */
function memoText(b64: string): string {
  const memos = decodeInstructions(b64).filter((ix) => ix.program === MEMO_PROGRAM)
  expect(memos).toHaveLength(1)
  return memos[0]!.data.toString('utf8')
}

// getAccountInfo → a non-null account means the recipient ATA EXISTS, so the buyer builds the
// canonical [cu-limit, cu-price, TransferChecked]. (The "missing ATA → throws" path is tested below.)
const ATA_EXISTS = { data: Buffer.alloc(165), owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false }
const buyerConn = {
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
  getAccountInfo: async () => ATA_EXISTS,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConn = any
function sellerConn(
  over: Partial<{
    simulate: () => Promise<unknown>
    send: () => Promise<string>
    statuses: () => Promise<unknown>
    getALT: () => Promise<unknown>
  }> = {}
): AnyConn {
  return {
    getAddressLookupTable: over.getALT ?? (async () => ({ value: null })),
    simulateTransaction: over.simulate ?? (async () => ({ value: { err: null } })),
    sendRawTransaction: over.send ?? (async () => 'SETTLE_TXID'),
    getSignatureStatuses:
      over.statuses ?? (async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 7 }] })),
  }
}

async function buildPayload(accept = makeAccept()): Promise<{ transaction: string }> {
  const { payload } = await payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept })
  return payload
}

/** Manually compile a buyer message (so adversarial tests can malform it). */
function compileBuyer(accept: X402ExactAcceptEntry, opts: { extraFeePayerIx?: boolean; memoOnly?: boolean } = {}): VersionedTransaction {
  const mint = new PublicKey(accept.asset)
  const payTo = new PublicKey(accept.payTo)
  const fp = new PublicKey(accept.extra.feePayer!)
  const source = getAssociatedTokenAddressSync(mint, buyer.publicKey, true)
  const dest = getAssociatedTokenAddressSync(mint, payTo, true)
  const ixs = []
  if (opts.memoOnly) {
    ixs.push(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: payTo, lamports: 1 }))
  } else {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, dest, payTo, mint))
    ixs.push(createTransferCheckedInstruction(source, mint, dest, buyer.publicKey, BigInt(accept.amount), accept.extra.decimals!, [], TOKEN_PROGRAM_ID))
    if (opts.extraFeePayerIx) ixs.push(SystemProgram.transfer({ fromPubkey: fp, toPubkey: dest, lamports: 1 }))
  }
  const msg = new TransactionMessage({ payerKey: fp, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message()
  return new VersionedTransaction(msg)
}
const toB64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString('base64')

/** Compile N TransferChecked to payTo's ATA (each from `auth`'s ATA) + an idempotent ATA-create,
 *  then sign with `signers`. Lets adversarial tests mix signed + unsigned transfer authorities. */
function compileTransfers(
  accept: X402ExactAcceptEntry,
  transfers: { auth: Keypair; amount: string }[],
  signers: Keypair[]
): string {
  const mint = new PublicKey(accept.asset)
  const payTo = new PublicKey(accept.payTo)
  const fp = new PublicKey(accept.extra.feePayer!)
  const dest = getAssociatedTokenAddressSync(mint, payTo, true)
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, dest, payTo, mint)]
  for (const t of transfers) {
    const src = getAssociatedTokenAddressSync(mint, t.auth.publicKey, true)
    ixs.push(createTransferCheckedInstruction(src, mint, dest, t.auth.publicKey, BigInt(t.amount), accept.extra.decimals!, [], TOKEN_PROGRAM_ID))
  }
  const msg = new TransactionMessage({ payerKey: fp, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign(signers)
  return toB64(tx)
}

describe('SVM exact — buyer (payExactSolana)', () => {
  it('partial-signs: fee-payer slot empty, buyer slot filled, base64 round-trips, nonce = buyer sig', async () => {
    const accept = makeAccept()
    const { payload, payerFrom, nonce } = await payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept })
    expect(payerFrom).toBe(buyer.publicKey.toBase58())
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.transaction, 'base64'))
    const keys = tx.message.staticAccountKeys
    expect(keys[0]!.equals(feePayer.publicKey)).toBe(true) // fee payer is index 0
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true) // its slot is EMPTY
    const bi = keys.findIndex((k) => k.equals(buyer.publicKey))
    expect(tx.signatures[bi]!.some((b) => b !== 0)).toBe(true) // buyer slot filled
    expect(nonce).toBe(bs58.encode(tx.signatures[bi]!)) // dedupe nonce = buyer signature
  })

  it('builds the canonical 4-instruction form: [cu-limit, cu-price, TransferChecked, Memo]', async () => {
    const { payload } = await payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept: makeAccept() })
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.transaction, 'base64'))
    const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58())
    expect(programs).toHaveLength(4)
    expect(programs[0]).toBe(COMPUTE_BUDGET)
    expect(programs[1]).toBe(COMPUTE_BUDGET)
    expect(programs[2]).toBe(TOKEN_PROGRAM_ID.toBase58())
    expect(programs[3]).toBe(MEMO_PROGRAM) // [3] the spec-required SPL-Memo, inside Path-1's 3-to-7
  })

  it('emits the spec-required SPL-Memo: extra.memo verbatim when present', async () => {
    const accept = makeAccept({ memo: 'order-abc-123' })
    const { payload } = await payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept })
    expect(memoText(payload.transaction)).toBe('order-abc-123') // exactly one Memo, data === extra.memo
  })

  it('emits a random ≥16-byte hex-nonce Memo when extra.memo is absent', async () => {
    const { payload } = await payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept: makeAccept() })
    const data = memoText(payload.transaction)
    expect(data).toMatch(/^[0-9a-f]{32}$/) // 16 CSPRNG bytes, hex-encoded (32 ASCII chars)
  })

  it('the random-nonce Memo is unique across builds (concurrency uniqueness)', async () => {
    const a = memoText((await buildPayload(makeAccept())).transaction)
    const b = memoText((await buildPayload(makeAccept())).transaction)
    expect(a).not.toBe(b) // two memo-less builds → different CSPRNG nonces
  })

  it('rejects an extra.memo over the 256-byte scheme cap', async () => {
    const accept = makeAccept({ memo: 'x'.repeat(257) })
    await expect(payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept })).rejects.toThrow(UnsupportedSchemeError)
    await expect(payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept })).rejects.toThrow(/256/)
  })

  it('throws when the recipient token account does not exist (the exact rail cannot create it)', async () => {
    const noAta = { ...buyerConn, getAccountInfo: async () => null }
    await expect(payExactSolana({ connection: noAta as AnyConn, keypair: buyer, accept: makeAccept() })).rejects.toThrow(/token account|onchain-proof/i)
  })

  it('refuses native / a missing feePayer / feePayer === payTo', async () => {
    await expect(payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept: makeAccept({ asset: 'native' }) })).rejects.toThrow(/SPL/i)
    const noFp = makeAccept(); delete (noFp.extra as { feePayer?: string }).feePayer
    await expect(payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept: noFp })).rejects.toThrow(/feePayer/i)
    await expect(
      payExactSolana({ connection: buyerConn as AnyConn, keypair: buyer, accept: makeAccept({ feePayer: merchant.publicKey.toBase58(), payTo: merchant.publicKey.toBase58() }) })
    ).rejects.toThrow(/differ from payTo/i)
  })
})

describe('SVM exact — seller happy path (verifyAndSettleExactSolana)', () => {
  it('verifies, co-signs as fee payer, broadcasts → an exact receipt (txid = the broadcast sig)', async () => {
    const accept = makeAccept()
    const payload = await buildPayload(accept)
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.receipt).toMatchObject({
      scheme: 'exact',
      success: true,
      network: NETWORK,
      transaction: 'SETTLE_TXID',
      asset: MINT.toBase58(),
      amount: '50000',
      payer: buyer.publicKey.toBase58(),
      payTo: merchant.publicKey.toBase58(),
    })
  })

  it('accepts an overpayment (amount >= required)', async () => {
    const payload = await buildPayload(makeAccept({ amount: '60000' }))
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept: makeAccept({ amount: '50000' }) })
    expect(res.ok).toBe(true)
  })
})

describe('SVM exact — adversarial (every field bound to the trusted accept)', () => {
  it('fee payer named in an instruction → signature_invalid', async () => {
    const tx = compileBuyer(makeAccept(), { extraFeePayerIx: true })
    tx.sign([buyer])
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: toB64(tx) }, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('a pre-filled fee-payer slot → signature_invalid', async () => {
    const tx = compileBuyer(makeAccept())
    tx.sign([buyer, feePayer]) // buyer wrongly fills the fee-payer slot too
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: toB64(tx) }, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('an oversized compute-unit price/limit → signature_invalid (sponsor-drain guard)', async () => {
    // Every other check passes (valid transfer to payTo's ATA, fee payer isolated, buyer signed),
    // but a huge CU price/limit would drain the fee payer the priority fee for a sub-cent transfer.
    const accept = makeAccept()
    const mint = new PublicKey(accept.asset)
    const payTo = new PublicKey(accept.payTo)
    const fp = new PublicKey(accept.extra.feePayer!)
    const source = getAssociatedTokenAddressSync(mint, buyer.publicKey, true)
    const dest = getAssociatedTokenAddressSync(mint, payTo, true)
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000n }), // drain attempt
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), // Solana's per-tx max
      createTransferCheckedInstruction(source, mint, dest, buyer.publicKey, BigInt(accept.amount), accept.extra.decimals!, [], TOKEN_PROGRAM_ID),
    ]
    const msg = new TransactionMessage({ payerKey: fp, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message()
    const tx = new VersionedTransaction(msg)
    tx.sign([buyer])
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: toB64(tx) }, accept })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
    if (!res.ok) expect(res.detail).toMatch(/cap|drain|exceeds/i)
  })

  it('an empty buyer signature slot → signature_invalid', async () => {
    const tx = compileBuyer(makeAccept()) // never signed
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: toB64(tx) }, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('payment to the wrong recipient → wrong_recipient (destination is recomputed from payTo)', async () => {
    const attacker = Keypair.generate()
    const payload = await buildPayload(makeAccept({ payTo: attacker.publicKey.toBase58() }))
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('amount below the requirement → amount_too_low', async () => {
    const payload = await buildPayload(makeAccept({ amount: '1' }))
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept: makeAccept({ amount: '50000' }) })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('wrong mint → transfer_not_found', async () => {
    const payload = await buildPayload(makeAccept({ asset: Keypair.generate().publicKey.toBase58() }))
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('no TransferChecked at all → transfer_not_found', async () => {
    const tx = compileBuyer(makeAccept(), { memoOnly: true })
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: toB64(tx) }, accept: makeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('a forged signature (sigVerify simulation fails) → signature_invalid', async () => {
    const payload = await buildPayload()
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ simulate: async () => ({ value: { err: 'Transaction signature verification failure' } }) }),
      feePayerKeypair: feePayer,
      payload,
      accept: makeAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('an execution revert in simulation → tx_reverted (the fee payer never broadcasts)', async () => {
    const payload = await buildPayload()
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ simulate: async () => ({ value: { err: { InstructionError: [1, 'Custom'] } } }) }),
      feePayerKeypair: feePayer,
      payload,
      accept: makeAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })
})

describe('SVM exact — settle failures (the 402-vs-5xx split)', () => {
  it('an expired blockhash at broadcast → payment_expired (client re-pays, not a server fault)', async () => {
    const payload = await buildPayload()
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ send: async () => { throw new Error('Blockhash not found') } }),
      feePayerKeypair: feePayer,
      payload,
      accept: makeAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('a valid tx that fails to broadcast (RPC down) → throws SettlementError (gate → 5xx)', async () => {
    const payload = await buildPayload()
    await expect(
      verifyAndSettleExactSolana({
        connection: sellerConn({ send: async () => { throw new Error('connection refused') } }),
        feePayerKeypair: feePayer,
        payload,
        accept: makeAccept(),
      })
    ).rejects.toBeInstanceOf(SettlementError)
  })

  it('a misconfigured rail (feePayer === payTo) → throws SettlementError', async () => {
    const payload = await buildPayload()
    await expect(
      verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept: makeAccept({ payTo: feePayer.publicKey.toBase58() }) })
    ).rejects.toBeInstanceOf(SettlementError)
  })

  it('the gate relayer key not matching extra.feePayer → throws SettlementError', async () => {
    const payload = await buildPayload()
    await expect(
      verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: Keypair.generate(), payload, accept: makeAccept() })
    ).rejects.toBeInstanceOf(SettlementError)
  })
})

describe('SVM exact — gate advertisement (offline; resolveExactRail tolerates a dead RPC)', () => {
  const relayer = Keypair.generate()
  const payTo = Keypair.generate().publicKey.toBase58()

  it('dual-advertises a `svm` exact rail (extra.feePayer = the relayer) beside onchain-proof', async () => {
    const gate = createPaymentGate({
      chain: 'solana',
      rpcUrl: 'http://127.0.0.1:1', // dead → getAccountInfo fails → tokenProgram defaults to spl-token
      token: 'USDC',
      amount: '0.05',
      payTo,
      exact: { settle: 'self', relayer: { key: relayer.secretKey } },
    })
    const { challenge } = await gate.challenge('https://api/x')
    expect(challenge.accepts).toHaveLength(2)
    const [exact, proof] = challenge.accepts
    expect(exact!.scheme).toBe('exact')
    expect(proof!.scheme).toBe('onchain-proof')
    expect(exact!.extra).toMatchObject({ assetTransferMethod: 'svm', feePayer: relayer.publicKey.toBase58(), tokenProgram: 'spl-token' })
    expect(exact!.payTo).toBe(payTo)
  })

  it('a native solana exact gate offers no exact rail → the gate refuses loudly', async () => {
    const gate = createPaymentGate({
      chain: 'solana',
      rpcUrl: 'http://127.0.0.1:1',
      token: 'native',
      amount: '0.01',
      payTo,
      exact: { settle: 'self', relayer: { key: relayer.secretKey } },
    })
    await expect(gate.challenge()).rejects.toThrow(/none of the offered rails support it/i)
  })
})

describe('SVM exact — multi-transfer counting (only authentically-signed transfers credit)', () => {
  const victim = Keypair.generate()

  it('a tiny SIGNED + a large UNSIGNED transfer does NOT reach the amount → amount_too_low', async () => {
    // The over-count attack: the gate must count ONLY the buyer-signed 1, never the victim's 49999.
    const txB64 = compileTransfers(makeAccept(), [{ auth: buyer, amount: '1' }, { auth: victim, amount: '49999' }], [buyer])
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: txB64 }, accept: makeAccept({ amount: '50000' }) })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('TWO transfers both signed by the buyer SUM to the required amount → paid', async () => {
    const txB64 = compileTransfers(makeAccept(), [{ auth: buyer, amount: '20000' }, { auth: buyer, amount: '30000' }], [buyer])
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: txB64 }, accept: makeAccept({ amount: '50000' }) })
    expect(res.ok).toBe(true)
  })

  it('a single transfer from a NON-signing authority → signature_invalid (never counted)', async () => {
    const txB64 = compileTransfers(makeAccept(), [{ auth: victim, amount: '50000' }], []) // nobody signs the transfer
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload: { transaction: txB64 }, accept: makeAccept({ amount: '50000' }) })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })
})

describe('SVM exact — Address Lookup Tables (MUST-rule #2: resolve every account)', () => {
  function compileWithAlt(accept: X402ExactAcceptEntry): { txB64: string; lut: AddressLookupTableAccount } {
    const mint = new PublicKey(accept.asset)
    const payTo = new PublicKey(accept.payTo)
    const fp = new PublicKey(accept.extra.feePayer!)
    const source = getAssociatedTokenAddressSync(mint, buyer.publicKey, true)
    const dest = getAssociatedTokenAddressSync(mint, payTo, true)
    // Pull the non-signer transfer accounts into a lookup table (the token program + the buyer
    // signer stay static); the seller must resolve the table to see them.
    const lut = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [source, dest, mint, payTo] },
    })
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, dest, payTo, mint),
      createTransferCheckedInstruction(source, mint, dest, buyer.publicKey, BigInt(accept.amount), accept.extra.decimals!, [], TOKEN_PROGRAM_ID),
    ]
    const msg = new TransactionMessage({ payerKey: fp, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message([lut])
    const tx = new VersionedTransaction(msg)
    tx.sign([buyer])
    return { txB64: Buffer.from(tx.serialize()).toString('base64'), lut }
  }

  it('resolves the lookup table and settles when accounts are ALT-hidden', async () => {
    const { txB64, lut } = compileWithAlt(makeAccept())
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ getALT: async () => ({ value: lut }) }),
      feePayerKeypair: feePayer,
      payload: { transaction: txB64 },
      accept: makeAccept(),
    })
    expect(res.ok).toBe(true)
  })

  it('an UNRESOLVABLE lookup table fails closed → signature_invalid', async () => {
    const { txB64 } = compileWithAlt(makeAccept())
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ getALT: async () => ({ value: null }) }),
      feePayerKeypair: feePayer,
      payload: { transaction: txB64 },
      accept: makeAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('a transient lookup-table read fails open as retryable → tx_not_found', async () => {
    const { txB64 } = compileWithAlt(makeAccept())
    const res = await verifyAndSettleExactSolana({
      connection: sellerConn({ getALT: async () => { throw new Error('RPC down') } }),
      feePayerKeypair: feePayer,
      payload: { transaction: txB64 },
      accept: makeAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('SVM exact — token coverage: USDC, USDT, token-2022, memo all gasless via the same path', () => {
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

  it('USDT (classic spl-token, like USDC) settles gasless — no token-level requirement', async () => {
    const accept = makeAccept({ asset: USDT_MINT })
    const payload = await buildPayload(accept)
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe(USDT_MINT)
  })

  it('a token-2022 mint round-trips (ATA derived with the token-2022 program on both ends)', async () => {
    const t22Mint = Keypair.generate().publicKey.toBase58()
    const accept = makeAccept({ asset: t22Mint, tokenProgram: 'token-2022' })
    const payload = await buildPayload(accept)
    // Sanity: the buyer used the token-2022 program (the dest ATA differs from the spl-token one).
    const splDest = getAssociatedTokenAddressSync(new PublicKey(t22Mint), merchant.publicKey, true, TOKEN_PROGRAM_ID)
    const t22Dest = getAssociatedTokenAddressSync(new PublicKey(t22Mint), merchant.publicKey, true, TOKEN_2022_PROGRAM_ID)
    expect(splDest.equals(t22Dest)).toBe(false)
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept })
    expect(res.ok).toBe(true)
  })

  it('a rail with an extra.memo emits exactly that Memo AND round-trips (memo is isolation-safe)', async () => {
    const accept = makeAccept({ memo: 'order-abc-123' })
    const payload = await buildPayload(accept)
    expect(memoText(payload.transaction)).toBe('order-abc-123') // the buyer USES extra.memo verbatim
    const res = await verifyAndSettleExactSolana({ connection: sellerConn(), feePayerKeypair: feePayer, payload, accept })
    expect(res.ok).toBe(true) // and the (always-present) Memo never breaks the gate's verify
  })
})
