/**
 * XRPL `exact` — the buyer's signed Payment and the gate's verify+settle.
 *
 * Signing is REAL (a deterministic `xrpl` Wallet from a fixed seed) and every network call is a
 * mock, so these assert the actual bytes that would go on the ledger without touching it.
 *
 * XRPL is the family where the PAYER pays the fee, so there is no sponsor to co-sign and no
 * fee-drain guard — but the scheme replaces that with a long list of MUST-NOTs the facilitator has
 * to enforce (no `Memos`, no `Paths`, no `tfPartialPayment`, no `Delegate`, no `Amount` +
 * `DeliverMax` together). Each one is a test below, because each one is a way a hostile blob could
 * deliver less than the merchant asked for.
 *
 * Two decisions worth knowing before reading:
 *   • `extra.areFeesSponsored` is REQUIRED by the scheme and ABSENT from all 1,732 live rails, so
 *     it is read as "false unless present". Requiring it would have rejected the entire deployed
 *     XRPL x402 web — the same bug `assetTransferMethod` caused everywhere else.
 *   • Only NATIVE XRP is exact-payable today. The two XRPL asset forms use different wire amount
 *     conventions (drops integer vs decimal `value`), and the SDK spend-caps in base units, so an
 *     IOU rail is dropped at GATHER rather than mispriced.
 */
import { describe, it, expect, vi } from 'vitest'
import { Wallet, decode } from 'xrpl'
import { payExactXrpl, verifyAndSettleExactXrpl, invoiceIdHash } from '../../src/drivers/xrpl/exact.js'
import { InsufficientFundsError, UnsupportedSchemeError, SettlementError } from '../../src/errors.js'
import type { X402ExactAcceptEntry } from '../../src/x402.js'

/** A fixed test payer — deterministic, so a signature change shows up as a diff. */
const PAYER = Wallet.fromSeed('sEdSKaCy2JT7JaM7v95H9SxkhP9wS2r')
const PAY_TO = 'rJb5KsHsDHF1YS5B5DU6QCkH5NsPaKQTcy'

const NETWORK = 'xrpl:0'
const AMOUNT = '10000' // 10,000 drops = 0.01 XRP — the shape of a real live rail

function accept(over: Partial<X402ExactAcceptEntry> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: AMOUNT,
    asset: 'native',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { invoiceId: 'inv-abc-123' },
    ...over,
  } as X402ExactAcceptEntry
}

const payClient = {
  accountSequence: async () => 42,
  feeDrops: async () => '15',
  currentLedgerIndex: async () => 90_000_000,
}

/** Decode what the buyer signed, so assertions read the real transaction. */
const signedFields = async (a = accept()) => {
  const { payload } = await payExactXrpl({ client: payClient, wallet: PAYER, accept: a })
  return { payload, tx: decode(payload.signedTxBlob) as Record<string, unknown> }
}

describe('payExactXrpl — the buyer signs a complete, submittable Payment', () => {
  it('builds a native-XRP Payment with the amount and destination from the TRUSTED accept', async () => {
    const { tx } = await signedFields()
    expect(tx.TransactionType).toBe('Payment')
    expect(tx.Account).toBe(PAYER.classicAddress)
    expect(tx.Destination).toBe(PAY_TO)
    expect(tx.Amount).toBe(AMOUNT) // integer drops, verbatim
    expect(tx.Sequence).toBe(42)
    // tfFullyCanonicalSig ON (0x80000000), tfPartialPayment OFF (0x00020000). We used to send
    // Flags: 0 "to be explicit", which made our transactions the only ones on the ledger without
    // the canonical-signature flag — diffed against a payment a live merchant HAD accepted from
    // another client, and that flag was the difference.
    expect(tx.Flags).toBe(0x80000000)
    expect((tx.Flags as number) & 0x00020000).toBe(0)
  })

  it('mirrors extra.sourceTag into SourceTag — 1,728 of 1,732 live rails carry it', () => {
    // Not in the scheme's extra table, but it is how the deployed vendors correlate a payment back
    // to their own quote. Inert if they ignore it; a plausible refusal if we omit it.
    return signedFields(accept({ extra: { invoiceId: 'inv-abc-123', sourceTag: 804681468 } })).then(({ tx }) => {
      expect(tx.SourceTag).toBe(804681468)
    })
  })

  it('omits SourceTag when the rail states none', async () => {
    const { tx } = await signedFields(accept({ extra: {} }))
    expect(tx.SourceTag).toBeUndefined()
  })

  it('is FULLY signed — the merchant can submit it as-is, with no co-signature', async () => {
    // Unlike Solana/Algorand/Aptos/NEAR, nobody adds a sponsor signature after the buyer.
    const { tx } = await signedFields()
    expect(typeof tx.TxnSignature).toBe('string')
    expect((tx.TxnSignature as string).length).toBeGreaterThan(0)
    expect(tx.SigningPubKey).toBe(PAYER.publicKey)
  })

  it('binds the challenge with InvoiceID = SHA-256(extra.invoiceId), and NEVER a memo', async () => {
    // The scheme has facilitators REJECT Memos — so the onchain-proof path's memo binding (which
    // pay.ts uses) must not leak in here. This is the whole reason exact.ts does not reuse pay.ts.
    const { tx } = await signedFields()
    expect(tx.InvoiceID).toBe(invoiceIdHash('inv-abc-123'))
    expect(tx.InvoiceID).toMatch(/^[0-9A-F]{64}$/)
    expect(tx.Memos).toBeUndefined()
  })

  it('omits InvoiceID entirely when the rail states no invoiceId', async () => {
    const { tx } = await signedFields(accept({ extra: {} }))
    expect(tx.InvoiceID).toBeUndefined()
  })

  it('derives LastLedgerSequence from the rail OWN maxTimeoutSeconds', async () => {
    /*
     * The settler checks that LastLedgerSequence is "within policy window", and the merchant's
     * policy is exactly what maxTimeoutSeconds announces. A fixed window is a conformance bug: a
     * rail offering 60s used to get an ~80s blob from us — one that outlives the merchant's own
     * quote. ~4s a ledger, clamped to [5, 60] ledgers.
     */
    const { tx } = await signedFields() // maxTimeoutSeconds 300 → 75 ledgers, clamped to 60
    expect(tx.LastLedgerSequence).toBe(90_000_060)

    const short = await signedFields(accept({ maxTimeoutSeconds: 60 })) // → 15 ledgers
    expect(short.tx.LastLedgerSequence).toBe(90_000_015)

    const silly = await signedFields(accept({ maxTimeoutSeconds: 1 })) // → clamped up to 5
    expect(silly.tx.LastLedgerSequence).toBe(90_000_005)
  })

  it('accepts the wild spelling of the native coin ("XRP") as well as our own ("native")', async () => {
    // PipRail writes 'native'; all 863 native rails in the wild write 'XRP'. Not recognising it
    // was invisible — the rail was simply dropped and the agent heard "no compatible accept".
    const { tx } = await signedFields(accept({ asset: 'XRP' }))
    expect(tx.Amount).toBe(AMOUNT)
  })

  it('omits SendMax, Paths, DeliverMin and DeliverMax on a native payment', async () => {
    // SendMax is MUST-present for an IOU and MUST-absent for XRP; the rest are always absent.
    const { tx } = await signedFields()
    for (const field of ['SendMax', 'Paths', 'DeliverMin', 'DeliverMax', 'Delegate', 'NetworkID']) {
      expect(tx[field], `${field} must be absent`).toBeUndefined()
    }
  })

  it('copies a DestinationTag only when the rail asks for one', async () => {
    // The onchain-proof path DERIVES a tag from the nonce; the exact rail must never invent one.
    const { tx: without } = await signedFields()
    expect(without.DestinationTag).toBeUndefined()
    const { tx: withTag } = await signedFields(accept({ extra: { destinationTag: 777 } }))
    expect(withTag.DestinationTag).toBe(777)
  })

  it('honours a higher open-ledger fee but never drops below the 12-drop floor', async () => {
    const { tx: high } = await signedFields()
    expect(Number(high.Fee)).toBe(15) // the mock's open-ledger fee
    const { payload } = await payExactXrpl({
      client: { ...payClient, feeDrops: async () => '3' },
      wallet: PAYER,
      accept: accept(),
    })
    expect(Number((decode(payload.signedTxBlob) as { Fee: string }).Fee)).toBe(12)
  })

  it('returns the tx hash as the single-use nonce', async () => {
    const { payload, ...rest } = await payExactXrpl({ client: payClient, wallet: PAYER, accept: accept() })
    expect(payload.signedTxBlob).toMatch(/^[0-9A-F]+$/i)
    expect(rest.payerFrom).toBe(PAYER.classicAddress)
    expect(rest.nonce).toMatch(/^[0-9A-F]{64}$/)
  })

  it('refuses an ISSUED CURRENCY — its wire amount is a decimal, which would misprice the cap', async () => {
    await expect(
      payExactXrpl({
        client: payClient,
        wallet: PAYER,
        accept: accept({ asset: '524C555344000000000000000000000000000000', extra: { issuer: 'rMxCKb' } }),
      })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('refuses a rail demanding a fee sponsor — the ledger charges the fee to Account', async () => {
    await expect(
      payExactXrpl({ client: payClient, wallet: PAYER, accept: accept({ extra: { areFeesSponsored: true } }) })
    ).rejects.toThrow(/areFeesSponsored/)
  })

  it('treats an ABSENT areFeesSponsored as false — 100% of live rails omit it', async () => {
    // If this ever throws, every real XRPL rail becomes unpayable. That is the bug this repo has
    // now shipped twice (assetTransferMethod, extra.decimals); this test is the third guard.
    await expect(signedFields(accept({ extra: {} }))).resolves.toBeTruthy()
  })

  it('refuses "ticketSequence" with a typed error rather than signing the wrong sequencing', async () => {
    await expect(
      payExactXrpl({
        client: payClient,
        wallet: PAYER,
        accept: accept({ extra: { assetTransferMethod: 'ticketSequence' } as never }),
      })
    ).rejects.toThrow(/ticketSequence/)
  })

  it('refuses a non-integer drops amount instead of silently flooring it', async () => {
    await expect(
      payExactXrpl({ client: payClient, wallet: PAYER, accept: accept({ amount: '0.01' }) })
    ).rejects.toThrow(/integer drops/)
  })
})

describe('error handling — ERRORS.md §9: no raw chain error escapes', () => {
  it('an UNACTIVATED payer account becomes InsufficientFundsError, not a raw actNotFound', async () => {
    // On XRPL an account only EXISTS once it holds the base reserve, so `actNotFound` from
    // account_info is an affordability problem wearing a lookup error's clothes. It converges on
    // the same typed error every other family raises (§6), with the fix in the message.
    const dead = { ...payClient, accountSequence: async () => { throw new Error('XRPL RPC account_info error: actNotFound') } }
    const err = await payExactXrpl({ client: dead, wallet: PAYER, accept: accept() }).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientFundsError)
    expect(err.message).toMatch(/base reserve/)
    expect(err.cause).toBeInstanceOf(Error) // the raw chain error is preserved, never swallowed
  })

  it('any OTHER RPC failure is rethrown unchanged — not disguised as an affordability problem', async () => {
    // Misreporting a transient RPC hiccup as "you are broke" would send an agent off to top up a
    // wallet that is already funded.
    const flaky = { ...payClient, feeDrops: async () => { throw new Error('ECONNRESET') } }
    const err = await payExactXrpl({ client: flaky, wallet: PAYER, accept: accept() }).catch((e) => e)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
    expect(err.message).toMatch(/ECONNRESET/)
  })

  it('an xrpl.js ValidationError surfaces as a typed UnsupportedSchemeError with its reason', async () => {
    // xrpl.js validates on sign. A payTo it considers malformed must not leak a raw library error.
    const err = await payExactXrpl({
      client: payClient,
      wallet: PAYER,
      accept: accept({ payTo: 'not-an-xrpl-address' }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedSchemeError)
    expect(err.cause).toBeInstanceOf(Error)
  })
})

/* ───────────────────────────── seller side ───────────────────────────── */

const validated = (over: Record<string, unknown> = {}) => ({
  validated: true,
  meta: { TransactionResult: 'tesSUCCESS', delivered_amount: AMOUNT },
  Account: PAYER.classicAddress,
  ...over,
})

async function settle(over: { record?: unknown; blob?: string; acc?: X402ExactAcceptEntry } = {}) {
  const a = over.acc ?? accept()
  const blob = over.blob ?? (await payExactXrpl({ client: payClient, wallet: PAYER, accept: a })).payload.signedTxBlob
  const submit = vi.fn(async () => ({ engine_result: 'tesSUCCESS', tx_json: { hash: 'A'.repeat(64) } }))
  const res = await verifyAndSettleExactXrpl({
    client: { submit, txByHash: async () => (over.record === undefined ? validated() : (over.record as never)) },
    decode: (b) => decode(b) as Record<string, unknown>,
    payload: { signedTxBlob: blob },
    accept: a,
    pollAttempts: 2,
    sleep: async () => {},
  })
  return { res, submit }
}

describe('verifyAndSettleExactXrpl — the gate checks, submits, and waits for validation', () => {
  it('accepts a good blob and returns a receipt built from the TRUSTED accept', async () => {
    const { res, submit } = await settle()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('exact')
      expect(res.receipt.transaction).toBe('A'.repeat(64))
      expect(res.receipt.amount).toBe(AMOUNT)
      expect(res.receipt.payTo).toBe(PAY_TO)
      expect(res.receipt.payer).toBe(PAYER.classicAddress)
    }
    expect(submit).toHaveBeenCalledOnce()
  })

  it('rejects a payment to the WRONG destination, without submitting it', async () => {
    // The buyer signed a payment to someone else; the gate re-derives payTo from its own rail.
    const other = await payExactXrpl({
      client: payClient,
      wallet: PAYER,
      accept: accept({ payTo: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }),
    })
    const { res, submit } = await settle({ blob: other.payload.signedTxBlob })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('wrong_recipient')
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects a SHORT payment', async () => {
    const short = await payExactXrpl({ client: payClient, wallet: PAYER, accept: accept({ amount: '1' }) })
    const { res } = await settle({ blob: short.payload.signedTxBlob })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('amount_too_low')
  })

  it('rejects a blob whose InvoiceID does not bind THIS challenge', async () => {
    const wrong = await payExactXrpl({
      client: payClient,
      wallet: PAYER,
      accept: accept({ extra: { invoiceId: 'some-other-invoice' } }),
    })
    const { res } = await settle({ blob: wrong.payload.signedTxBlob })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('signature_invalid')
  })

  it('rejects an unparseable blob rather than throwing', async () => {
    const { res } = await settle({ blob: 'NOTHEX!!' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('signature_invalid')
  })

  it('rejects a validated-but-FAILED ledger result', async () => {
    const { res } = await settle({ record: validated({ meta: { TransactionResult: 'tecUNFUNDED_PAYMENT' } }) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('transfer_not_found')
  })

  it('rejects a PARTIAL delivery even when the ledger says tesSUCCESS', async () => {
    // The tfPartialPayment defence, second line: `delivered_amount` is what actually arrived.
    const { res } = await settle({
      record: validated({ meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1' } }),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('amount_too_low')
  })

  it('a submit rejection is a buyer fault (402), not a gate crash', async () => {
    const a = accept()
    const blob = (await payExactXrpl({ client: payClient, wallet: PAYER, accept: a })).payload.signedTxBlob
    const res = await verifyAndSettleExactXrpl({
      client: {
        submit: async () => ({ engine_result: 'tecUNFUNDED_PAYMENT', engine_result_message: 'no funds' }),
        txByHash: async () => null,
      },
      decode: (b) => decode(b) as Record<string, unknown>,
      payload: { signedTxBlob: blob },
      accept: a,
      sleep: async () => {},
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('transfer_not_found')
  })

  it('never-validated is a GATE timeout (throws → 5xx + claim released), never "unpaid"', async () => {
    // The payment may still land. Reporting it as a buyer failure would be a lie that also loses
    // the money — so this must throw, which releases the replay claim for a retry.
    await expect(settle({ record: null })).rejects.toBeInstanceOf(SettlementError)
  })

  it('refuses to settle a rail that demands a fee sponsor', async () => {
    // Build the blob against a NORMAL rail (the buyer would refuse the sponsored one outright),
    // then present it against a sponsored rail — i.e. the gate is misconfigured, not the client.
    const blob = (await payExactXrpl({ client: payClient, wallet: PAYER, accept: accept() })).payload.signedTxBlob
    await expect(
      verifyAndSettleExactXrpl({
        client: { submit: async () => ({ engine_result: 'tesSUCCESS' }), txByHash: async () => null },
        decode: (b) => decode(b) as Record<string, unknown>,
        payload: { signedTxBlob: blob },
        accept: accept({ extra: { areFeesSponsored: true } }),
        sleep: async () => {},
      })
    ).rejects.toBeInstanceOf(SettlementError)
  })
})

describe('the scheme MUST-NOTs — each is a way a hostile blob could underdeliver', () => {
  /** Sign an arbitrary transaction so we can smuggle in a forbidden field. */
  const smuggle = async (extraFields: Record<string, unknown>) => {
    const signed = PAYER.sign({
      TransactionType: 'Payment',
      Account: PAYER.classicAddress,
      Destination: PAY_TO,
      Amount: AMOUNT,
      Sequence: 42,
      Fee: '15',
      LastLedgerSequence: 90_000_020,
      Flags: 0,
      InvoiceID: invoiceIdHash('inv-abc-123'),
      ...extraFields,
    } as never)
    return settle({ blob: signed.tx_blob })
  }

  it('rejects Memos (the scheme has facilitators refuse them outright)', async () => {
    const { res, submit } = await smuggle({ Memos: [{ Memo: { MemoData: 'AABB' } }] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/Memos/)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects tfPartialPayment — the flag that lets a sender deliver less than Amount', async () => {
    const { res, submit } = await smuggle({ Flags: 0x00020000 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/tfPartialPayment/)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects Paths on a direct payment', async () => {
    // `DeliverMin` has no test of its own on purpose: xrpl.js REFUSES TO SIGN it without
    // tfPartialPayment ("tfPartialPayment flag required with DeliverMin"), and with that flag our
    // flag check rejects the blob first. So no signable transaction can reach the DeliverMin
    // branch — it stays as defence in depth against a blob signed by some other library.
    const { res, submit } = await smuggle({
      Paths: [[{ currency: 'USD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }]],
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/Paths/)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects a missing LastLedgerSequence — an unbounded, indefinitely submittable blob', async () => {
    const signed = PAYER.sign({
      TransactionType: 'Payment',
      Account: PAYER.classicAddress,
      Destination: PAY_TO,
      Amount: AMOUNT,
      Sequence: 42,
      Fee: '15',
      Flags: 0,
      InvoiceID: invoiceIdHash('inv-abc-123'),
    } as never)
    const { res } = await settle({ blob: signed.tx_blob })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/LastLedgerSequence/)
  })

  it('rejects an absurd Fee before broadcasting it', async () => {
    const { res, submit } = await smuggle({ Fee: '99000000' }) // 99 XRP of "fee"
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/Fee/)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects a non-Payment transaction type', async () => {
    const signed = PAYER.sign({
      TransactionType: 'AccountSet',
      Account: PAYER.classicAddress,
      Sequence: 42,
      Fee: '15',
      LastLedgerSequence: 90_000_020,
    } as never)
    const { res } = await settle({ blob: signed.tx_blob })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/Payment/)
  })
})
