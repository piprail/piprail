/**
 * The standard x402 `exact` rail on Algorand — the buyer's group build + partial-sign, and the
 * gate's verify-and-self-settle (the fee payer pools the group fee), with NO network: a mock
 * settle client returns controllable simulate/submit/confirm. Proves the round-trip, the buyer's
 * zero-fee axfer, the trusted-accept binding (recipient/amount/asset re-derived), the fee-txn
 * MUST-rules, the group binding, and the VerifyResult/SettlementError split.
 */
import { describe, it, expect } from 'vitest'
import algosdk from 'algosdk'
import {
  payExactAlgorand,
  verifyAndSettleExactAlgorand,
  type AlgorandSettleClient,
} from '../../src/drivers/algorand/exact.js'
import { SettlementError } from '../../src/errors.js'
import type { X402ExactAcceptEntry } from '../../src/x402.js'

const NETWORK = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const
const ASSET_ID = 31566704 // USDC ASA
const ASSET = String(ASSET_ID)

const buyer = algosdk.generateAccount()
const sponsor = algosdk.generateAccount() // the fee payer / relayer (NOT payTo)
const merchant = algosdk.generateAccount() // payTo (receive)

/** Fake suggested params — offline, deterministic. */
function suggestedParams(): algosdk.SuggestedParams {
  return {
    minFee: 1000n,
    fee: 0n,
    firstValid: 1000n,
    lastValid: 2000n,
    genesisID: 'mainnet-v1.0',
    genesisHash: new Uint8Array(32).fill(7),
    flatFee: false,
  } as unknown as algosdk.SuggestedParams
}

function makeAccept(over: Partial<{ payTo: string; amount: string; asset: string; feePayer: string }> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: over.amount ?? '50000',
    asset: over.asset ?? ASSET,
    payTo: over.payTo ?? merchant.addr.toString(),
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: 'algorand',
      feePayer: over.feePayer ?? sponsor.addr.toString(),
      decimals: 6,
    },
  }
}

/** A mock settle client; override any leg. */
function mockClient(over: Partial<AlgorandSettleClient> = {}): AlgorandSettleClient {
  return {
    simulate: over.simulate ?? (async () => ({ failureMessage: null })),
    submit: over.submit ?? (async () => 'SUBMIT_TXID'),
    waitForConfirmation: over.waitForConfirmation ?? (async () => 12345),
  }
}

const b64decode = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

/** Build a buyer payload for `accept`, from `from` (defaults to the buyer). */
async function buildPayload(accept: X402ExactAcceptEntry, from = buyer) {
  return payExactAlgorand({ suggestedParams: suggestedParams(), sk: from.sk, sender: from.addr.toString(), accept })
}

describe('Algorand exact — BUYER (payExactAlgorand)', () => {
  it('builds the canonical 2-txn group: fee-0 buyer axfer + unsigned pooled fee txn', async () => {
    const accept = makeAccept()
    const { payload, payerFrom, nonce } = await buildPayload(accept)

    expect(payload.paymentIndex).toBe(0)
    expect(payload.paymentGroup).toHaveLength(2)
    expect(payerFrom).toBe(buyer.addr.toString())
    expect(nonce).toMatch(/^[A-Z2-7]{52}$/) // an Algorand txid (base32)

    // [0] the buyer's axfer — SIGNED, fee 0 (GASLESS), to payTo, right asset+amount.
    const axfer = algosdk.decodeSignedTransaction(b64decode(payload.paymentGroup[0]!))
    expect(axfer.sig).toBeTruthy()
    expect(axfer.txn.type).toBe('axfer')
    expect(axfer.txn.fee).toBe(0n) // the headline: the buyer pays ZERO ALGO
    expect(axfer.txn.assetTransfer!.amount).toBe(50000n)
    expect(BigInt(axfer.txn.assetTransfer!.assetIndex)).toBe(BigInt(ASSET_ID))
    expect(axfer.txn.assetTransfer!.receiver.toString()).toBe(merchant.addr.toString())
    expect(axfer.txn.group).toBeTruthy()

    // [1] the fee txn — UNSIGNED, sent by the sponsor, 0 ALGO, pools the whole group fee (2× minFee).
    const fee = algosdk.decodeUnsignedTransaction(b64decode(payload.paymentGroup[1]!))
    expect(fee.type).toBe('pay')
    expect(fee.sender.toString()).toBe(sponsor.addr.toString())
    expect(fee.payment!.amount).toBe(0n)
    expect(fee.fee).toBe(2000n) // covers both txns via fee pooling
    // both txns carry the same group id (the buyer signed the pairing)
    expect(Buffer.from(fee.group!).toString('hex')).toBe(Buffer.from(axfer.txn.group!).toString('hex'))
  })

  it('rejects native (not exact-payable)', async () => {
    await expect(buildPayload(makeAccept({ asset: 'native' }))).rejects.toThrow(/ASA-only|native/i)
  })

  it('rejects a missing feePayer', async () => {
    const accept = makeAccept()
    delete (accept.extra as { feePayer?: string }).feePayer
    await expect(buildPayload(accept)).rejects.toThrow(/feePayer/i)
  })

  it('rejects feePayer === payer (the buyer must pay zero ALGO)', async () => {
    await expect(buildPayload(makeAccept({ feePayer: buyer.addr.toString() }))).rejects.toThrow(/fee payer must differ/i)
  })

  it('allows feePayer === payTo (Algorand-specific — the fee txn is separate, unlike Solana)', async () => {
    const accept = makeAccept({ feePayer: merchant.addr.toString() })
    const { payload } = await buildPayload(accept)
    const fee = algosdk.decodeUnsignedTransaction(b64decode(payload.paymentGroup[1]!))
    expect(fee.sender.toString()).toBe(merchant.addr.toString())
  })
})

describe('Algorand exact — SELLER (verifyAndSettleExactAlgorand)', () => {
  const settle = (payload: { paymentIndex: number; paymentGroup: string[] }, accept: X402ExactAcceptEntry, client = mockClient(), feePayer = sponsor) =>
    verifyAndSettleExactAlgorand({ client, feePayerSk: feePayer.sk, feePayerAddr: feePayer.addr.toString(), payload, accept })

  it('verifies + self-settles a valid group → ok receipt', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const res = await settle(payload, accept)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('exact')
      expect(res.receipt.payer).toBe(buyer.addr.toString())
      expect(res.receipt.payTo).toBe(merchant.addr.toString())
      expect(res.receipt.amount).toBe('50000')
      expect(res.receipt.network).toBe(NETWORK)
      expect(res.receipt.transaction).toMatch(/^[A-Z2-7]{52}$/)
    }
  })

  it('settles when feePayer === payTo (the merchant pays its own receive fee)', async () => {
    const accept = makeAccept({ feePayer: merchant.addr.toString() })
    const { payload } = await buildPayload(accept)
    const res = await settle(payload, accept, mockClient(), merchant)
    expect(res.ok).toBe(true)
  })

  it('binds to the TRUSTED accept: a different payTo → wrong_recipient', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept) // pays `merchant`
    const other = algosdk.generateAccount()
    const res = await settle(payload, makeAccept({ payTo: other.addr.toString() }))
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects an underpayment → amount_too_low', async () => {
    const accept = makeAccept({ amount: '50000' })
    const { payload } = await buildPayload(accept)
    const res = await settle(payload, makeAccept({ amount: '60000' }))
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects a wrong asset → transfer_not_found', async () => {
    const accept = makeAccept({ asset: ASSET })
    const { payload } = await buildPayload(accept)
    const res = await settle(payload, makeAccept({ asset: '999999' }))
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a group whose size is not exactly 2 → signature_invalid', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const res = await settle({ paymentIndex: 0, paymentGroup: [payload.paymentGroup[0]!] }, accept)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects when the payment txn is unsigned → signature_invalid', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    // Replace the signed axfer with its UNSIGNED form (decode signed → re-encode unsigned).
    const unsignedAxfer = algosdk.encodeUnsignedTransaction(algosdk.decodeSignedTransaction(b64decode(payload.paymentGroup[0]!)).txn)
    const tampered = { paymentIndex: 0, paymentGroup: [Buffer.from(unsignedAxfer).toString('base64'), payload.paymentGroup[1]!] }
    const res = await settle(tampered, accept)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects when the fee txn sender is not the rail fee payer → signature_invalid', async () => {
    // Build a group whose fee txn is sent by a stranger (not the trusted feePayer).
    const accept = makeAccept()
    const stranger = algosdk.generateAccount()
    const { payload } = await buildPayload(makeAccept({ feePayer: stranger.addr.toString() }), buyer)
    // The gate is configured for `sponsor` but the group's fee txn is the stranger's.
    const res = await verifyAndSettleExactAlgorand({
      client: mockClient(),
      feePayerSk: sponsor.sk,
      feePayerAddr: sponsor.addr.toString(),
      payload,
      accept, // rail feePayer = sponsor
    })
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects a simulate signature failure → signature_invalid (402, client fault)', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const client = mockClient({ simulate: async () => ({ failureMessage: 'signature validation failed for txn 0' }) })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects a simulate would-revert (e.g. recipient not opted in) → tx_reverted', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const client = mockClient({ simulate: async () => ({ failureMessage: 'asset 31566704 missing from receiver (must opt in)' }) })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('a valid group that fails to SUBMIT (server-side) → throws SettlementError', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const client = mockClient({ submit: async () => { throw new Error('algod 503 unavailable') } })
    await expect(settle(payload, accept, client)).rejects.toBeInstanceOf(SettlementError)
  })

  it('a submit "already in ledger" → tx_already_used (402, not a server error)', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const client = mockClient({ submit: async () => { throw new Error('TransactionPool.Remember: transaction already in ledger') } })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('a relayer that does not match the rail feePayer → throws SettlementError (gate misconfig)', async () => {
    const accept = makeAccept() // rail feePayer = sponsor
    const { payload } = await buildPayload(accept)
    const wrong = algosdk.generateAccount()
    await expect(
      verifyAndSettleExactAlgorand({ client: mockClient(), feePayerSk: wrong.sk, feePayerAddr: wrong.addr.toString(), payload, accept })
    ).rejects.toBeInstanceOf(SettlementError)
  })

  it('a confirmation timeout (null) → throws SettlementError (do not re-pay)', async () => {
    const accept = makeAccept()
    const { payload } = await buildPayload(accept)
    const client = mockClient({ waitForConfirmation: async () => null })
    await expect(settle(payload, accept, client)).rejects.toBeInstanceOf(SettlementError)
  })
})
