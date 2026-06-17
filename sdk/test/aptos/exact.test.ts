/**
 * The standard x402 `exact` rail on Aptos — the buyer's fee-payer (sponsored) build + sender-sign,
 * and the gate's verify-and-self-settle (the gate adds the fee-payer signature), with NO network: a
 * mock settle client returns controllable simulate/submit/confirm. Real signed Aptos transactions
 * are built OFFLINE (SDK constructors) so the entry-function DECODE, the off-chain signature verify,
 * and the trusted-accept binding are genuinely exercised. Proves the round-trip, the buyer's gasless
 * sign, every binding (recipient/amount/asset re-derived), the fee-payer + gas-cap guards, sender-sig
 * forgery rejection, and the VerifyResult/SettlementError split.
 */
import { describe, it, expect } from 'vitest'
import {
  Account,
  AccountAddress,
  Aptos,
  AptosConfig,
  ChainId,
  Deserializer,
  EntryFunction,
  Network,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  U64,
  parseTypeTag,
} from '@aptos-labs/ts-sdk'
import {
  payExactAptos,
  verifyAndSettleExactAptos,
  type AptosExactPayClient,
  type AptosExactSettleClient,
} from '../../src/drivers/aptos/exact.js'
import { SettlementError } from '../../src/errors.js'
import type { ExactAptosPaymentPayload, X402ExactAcceptEntry } from '../../src/x402.js'

const NETWORK = 'aptos:1' as const
const USDC = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const METADATA_TYPE = '0x1::fungible_asset::Metadata'

// Offline Aptos instance (mainnet config; no calls are made — sign/simulate go through the mock).
const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }))

const buyer = Account.generate()
const merchant = Account.generate() // payTo AND feePayer (self-settle; Aptos allows feePayer === payTo)
const stranger = Account.generate()

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

function makeAccept(over: Partial<{ payTo: string; amount: string; asset: string; feePayer: string }> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: over.amount ?? '1000',
    asset: over.asset ?? USDC,
    payTo: over.payTo ?? merchant.accountAddress.toString(),
    maxTimeoutSeconds: 600,
    extra: {
      assetTransferMethod: 'aptos',
      feePayer: over.feePayer ?? merchant.accountAddress.toString(),
      decimals: 6,
    },
  }
}

/** Build a fee-payer SimpleTransaction OFFLINE (no network) for the entry function below. */
function buildSimpleTx(opts: {
  sender: AccountAddress
  feePayer: AccountAddress
  payTo: string
  metadata?: string
  amount?: string
  maxGas?: bigint
  gasPrice?: bigint
  expiry?: bigint
  fnModule?: string
  fnName?: string
}): SimpleTransaction {
  const ef = EntryFunction.build(
    (opts.fnModule ?? '0x1::primary_fungible_store') as `${string}::${string}`,
    opts.fnName ?? 'transfer',
    [parseTypeTag(METADATA_TYPE)],
    [AccountAddress.from(opts.metadata ?? USDC), AccountAddress.from(opts.payTo), new U64(BigInt(opts.amount ?? '1000'))]
  )
  const raw = new RawTransaction(
    opts.sender,
    0n, // sequence number
    new TransactionPayloadEntryFunction(ef),
    opts.maxGas ?? 50_000n,
    opts.gasPrice ?? 100n,
    opts.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 600),
    new ChainId(1)
  )
  return new SimpleTransaction(raw, opts.feePayer)
}

/** A signed PipRail Aptos exact payload, built directly (for adversarial cases). `signer` defaults
 *  to the buyer; pass a different account to forge a foreign signature. */
function signedPayload(opts: Parameters<typeof buildSimpleTx>[0] & { signer?: Account }): ExactAptosPaymentPayload {
  const tx = buildSimpleTx(opts)
  const auth = aptos.transaction.sign({ signer: opts.signer ?? buyer, transaction: tx })
  return { transaction: b64(tx.bcsToBytes()), senderAuth: b64(auth.bcsToBytes()) }
}

/** The buyer's pay client — builds the tx offline + signs as the buyer (mirrors index.ts). */
function payClient(signer = buyer): AptosExactPayClient {
  return {
    buildFeePayerTransfer: async ({ sender, metadata, payTo, amount, maxGasAmount }) =>
      // feePayerAddress is left unset here; payExactAptos binds it before signing (as in production).
      buildSimpleTx({ sender: AccountAddress.from(sender), feePayer: AccountAddress.ZERO, payTo, metadata, amount, maxGas: BigInt(maxGasAmount) }),
    signAsSender: ({ transaction }) => aptos.transaction.sign({ signer, transaction }),
  }
}

/** The gate's settle client — real signAsFeePayer (so the binding is genuine); mockable legs. */
function mockSettle(feePayer = merchant, over: Partial<AptosExactSettleClient> = {}): AptosExactSettleClient {
  return {
    signAsFeePayer: over.signAsFeePayer ?? (({ transaction }) => aptos.transaction.signAsFeePayer({ signer: feePayer, transaction })),
    simulate: over.simulate ?? (async () => ({ success: true, vmStatus: 'Executed successfully' })),
    submit: over.submit ?? (async () => '0xMOCKHASH'),
    waitForConfirmation: over.waitForConfirmation ?? (async () => ({ success: true })),
  }
}

const settle = (
  payload: ExactAptosPaymentPayload,
  accept: X402ExactAcceptEntry,
  client = mockSettle(),
  feePayer = merchant
) => verifyAndSettleExactAptos({ client, feePayerAddr: feePayer.accountAddress.toString(), payload, accept })

describe('Aptos exact — BUYER (payExactAptos)', () => {
  it('builds a fee-payer payload: sender-signed tx + senderAuth, fee payer = the rail sponsor', async () => {
    const accept = makeAccept()
    const { payload, payerFrom, nonce } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })

    expect(typeof payload.transaction).toBe('string')
    expect(typeof payload.senderAuth).toBe('string')
    expect(payerFrom).toBe(buyer.accountAddress.toString())
    expect(nonce.length).toBeGreaterThan(0)

    // The serialized tx carries the bound fee payer (the buyer committed to the sponsor).
    const tx = SimpleTransaction.deserialize(new Deserializer(new Uint8Array(Buffer.from(payload.transaction, 'base64'))))
    expect(tx.feePayerAddress?.toString()).toBe(merchant.accountAddress.toString())
    expect(tx.rawTransaction.sender.toString()).toBe(buyer.accountAddress.toString())
  })

  it('rejects native (not exact-payable)', async () => {
    await expect(payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept: makeAccept({ asset: 'native' }) }))
      .rejects.toThrow(/Fungible-Asset only|native/i)
  })

  it('rejects a missing feePayer', async () => {
    const accept = makeAccept()
    delete (accept.extra as { feePayer?: string }).feePayer
    await expect(payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })).rejects.toThrow(/feePayer/i)
  })

  it('rejects feePayer === payer (the buyer must pay zero APT)', async () => {
    await expect(payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept: makeAccept({ feePayer: buyer.accountAddress.toString() }) }))
      .rejects.toThrow(/fee payer must differ/i)
  })

  it('allows feePayer === payTo (Aptos-specific — the fee-payer signature is separate)', async () => {
    const accept = makeAccept({ feePayer: merchant.accountAddress.toString(), payTo: merchant.accountAddress.toString() })
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    expect(payload.transaction).toBeTruthy()
  })
})

describe('Aptos exact — SELLER (verifyAndSettleExactAptos)', () => {
  it('verifies + self-settles a valid fee-payer tx → ok receipt', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const res = await settle(payload, accept)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('exact')
      expect(res.receipt.payer).toBe(buyer.accountAddress.toString())
      expect(res.receipt.payTo).toBe(merchant.accountAddress.toString())
      expect(res.receipt.amount).toBe('1000')
      expect(res.receipt.network).toBe(NETWORK)
      expect(res.receipt.transaction).toBe('0xMOCKHASH')
    }
  })

  it('binds to the TRUSTED accept: a different payTo → wrong_recipient', async () => {
    // Tx pays `merchant`, but the gate's rail says payTo = `stranger`.
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString() })
    const res = await settle(payload, makeAccept({ payTo: stranger.accountAddress.toString() }))
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects an underpayment → amount_too_low', async () => {
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), amount: '1000' })
    const res = await settle(payload, makeAccept({ amount: '2000' }))
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects a wrong asset/metadata → transfer_not_found', async () => {
    const other = AccountAddress.from('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), metadata: other.toString() })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a non-transfer entry function → transfer_not_found', async () => {
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), fnName: 'mint' })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a fee payer NOT matching the trusted rail → signature_invalid', async () => {
    // The buyer baked `stranger` as fee payer, but the rail (and the gate key) is `merchant`.
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: stranger.accountAddress, payTo: merchant.accountAddress.toString() })
    const res = await settle(payload, makeAccept()) // rail feePayer = merchant; gate key = merchant
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects max_gas_amount over the cap → signature_invalid (drain guard)', async () => {
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), maxGas: 500_000n })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects gas_unit_price over the cap → signature_invalid (drain guard)', async () => {
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), gasPrice: 10_000n })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects an expired transaction → payment_expired', async () => {
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), expiry: BigInt(Math.floor(Date.now() / 1000) - 10) })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a foreign sender signature (signed by stranger, claims buyer) → signature_invalid', async () => {
    // sender field = buyer, but signed by `stranger` → the auth key does not derive to the sender.
    const payload = signedPayload({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), signer: stranger })
    const res = await settle(payload, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects a tampered transaction (sig no longer matches) → signature_invalid', async () => {
    const accept = makeAccept()
    const good = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    // Pair the buyer's signature with a DIFFERENT (re-built) tx (amount changed) — sig won't verify.
    const tampered = buildSimpleTx({ sender: buyer.accountAddress, feePayer: merchant.accountAddress, payTo: merchant.accountAddress.toString(), amount: '5000' })
    const res = await settle({ transaction: b64(tampered.bcsToBytes()), senderAuth: good.payload.senderAuth }, accept)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects an unparseable payload → signature_invalid', async () => {
    const res = await settle({ transaction: 'not-base64-bcs!!', senderAuth: 'also-garbage' }, makeAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('settles when feePayer === payTo (the merchant pays its own receive gas)', async () => {
    const accept = makeAccept({ feePayer: merchant.accountAddress.toString(), payTo: merchant.accountAddress.toString() })
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const res = await settle(payload, accept, mockSettle(merchant), merchant)
    expect(res.ok).toBe(true)
  })

  it('maps a simulate would-revert → tx_reverted (402, client fault)', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const client = mockSettle(merchant, { simulate: async () => ({ success: false, vmStatus: 'Move abort: EINSUFFICIENT_BALANCE' }) })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('a valid tx that fails to SUBMIT (server-side) → throws SettlementError', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const client = mockSettle(merchant, { submit: async () => { throw new Error('fullnode 503 unavailable') } })
    await expect(settle(payload, accept, client)).rejects.toBeInstanceOf(SettlementError)
  })

  it('a submit "SEQUENCE_NUMBER_TOO_OLD" → tx_already_used (402, not a server error)', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const client = mockSettle(merchant, { submit: async () => { throw new Error('SEQUENCE_NUMBER_TOO_OLD') } })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('a relayer that does not match the rail feePayer → throws SettlementError (gate misconfig)', async () => {
    const accept = makeAccept() // rail feePayer = merchant
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    await expect(verifyAndSettleExactAptos({ client: mockSettle(stranger), feePayerAddr: stranger.accountAddress.toString(), payload, accept }))
      .rejects.toBeInstanceOf(SettlementError)
  })

  it('a confirmation timeout (null) → throws SettlementError (do not re-pay)', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const client = mockSettle(merchant, { waitForConfirmation: async () => null })
    await expect(settle(payload, accept, client)).rejects.toBeInstanceOf(SettlementError)
  })

  it('an on-chain revert after submit (success:false) → tx_reverted', async () => {
    const accept = makeAccept()
    const { payload } = await payExactAptos({ client: payClient(), sender: buyer.accountAddress.toString(), accept })
    const client = mockSettle(merchant, { waitForConfirmation: async () => ({ success: false }) })
    const res = await settle(payload, accept, client)
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })
})
