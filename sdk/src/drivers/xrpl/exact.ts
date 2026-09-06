/**
 * ── XRPL SECTION: x402 `exact` scheme — BUYER + SELLER ─────────────────────
 *
 * PipRail's own gates default to `onchain-proof` (the buyer broadcasts a normal payment and proves
 * it with the memo nonce). This module is the standard x402 `exact` interop for the XRP Ledger, in
 * BOTH directions, on the existing `xrpl` lazy peer (no new dep) — mirroring
 * `drivers/algorand/exact.ts` and `drivers/solana/exact.ts`.
 *
 *   • BUYER side (client) — {@link payExactXrpl} builds a FULLY SIGNED `Payment` and returns the
 *     hex blob. It broadcasts nothing: the resource server (or its facilitator) submits.
 *   • SELLER side (gate) — {@link verifyAndSettleExactXrpl} decodes the blob, re-derives every
 *     checked field from the TRUSTED accept, submits, and waits for a validated `tesSUCCESS`.
 *
 * ## What makes XRPL different from every other exact family
 *
 * **The payer pays the fee.** The fee is a field inside the signed transaction and the ledger
 * charges it to `Account`, so there is no sponsor, no fee-payer co-signature, and no fee-drain
 * guard to write (`extra.areFeesSponsored` "must be false" per the scheme). The buyer needs XRP for
 * the amount *and* the fee. That is what makes XRPL the cheapest family to implement — and it is
 * why the buyer signs something immediately submittable, which in turn makes `LastLedgerSequence`
 * mandatory: it is the only thing bounding how long a merchant may sit on a signed payment.
 *
 * **The binding is `InvoiceID`, not a memo.** `scheme_exact_xrpl.md` has facilitators REJECT any
 * transaction carrying `Memos` — so this path must NOT reuse `pay.ts`, whose whole nonce binding is
 * a memo. Here the challenge binds through `InvoiceID = SHA-256(extra.invoiceId)`, and `invoiceId`
 * is present on 1,732 of 1,732 live rails.
 *
 * **`extra.areFeesSponsored` is required by the spec and absent from 100% of deployed rails.** It
 * is therefore read as *false unless present*. Requiring it would reject the entire XRPL x402 web —
 * the same bug `assetTransferMethod` caused across the whole ecosystem, and `extra.decimals` caused
 * on Solana. A rail that explicitly says `true` is refused, because we cannot honour a sponsor.
 *
 * ## Scope: native XRP only, deliberately
 *
 * The two XRPL asset forms use DIFFERENT amount conventions on the wire — verified against live
 * merchant challenges: native XRP is an integer **drops** string (`"10000"`), an issued currency is
 * a **decimal** `value` (`"0.01"`). The SDK prices and spend-caps every rail in base units, so
 * reading an IOU's `"12"` as base units would understate a 12-RLUSD payment by 10^15 and slip it
 * under any policy cap while the buyer signed the real amount. Rather than special-case that inside
 * the signer, the driver declares only native XRP exact-payable (`exactPayableAsset`) so IOU rails
 * are dropped at GATHER. 863 of the 1,732 live rails are native XRP; the RLUSD half waits until the
 * decimal path is threaded through quoting and the policy.
 */
import type { Wallet } from 'xrpl'
import { createHash } from 'node:crypto'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import { isXrpNative } from './chains.js'
import { exactTransferMethod } from '../../x402.js'
import type {
  ExactXrplPaymentPayload,
  VerifyErrorCode,
  VerifyResult,
  X402ExactAcceptEntry,
} from '../../x402.js'

/** XRPL closes a ledger roughly every 4 seconds. */
const SECONDS_PER_LEDGER = 4

/** Bounds on the `LastLedgerSequence` window, in ledgers (~20s … ~4min). */
const MIN_LEDGER_WINDOW = 5
const MAX_LEDGER_WINDOW = 60

/**
 * How many ledgers the signed payment stays submittable, derived from the rail's OWN
 * `maxTimeoutSeconds`.
 *
 * The scheme has the settler check that `LastLedgerSequence` is "within policy window", and a
 * merchant's policy is exactly what `maxTimeoutSeconds` announces — so a fixed window is a
 * conformance bug waiting to happen: a rail offering 60s got an ~80s blob from us, i.e. one that
 * outlives the merchant's own quote. Erring SHORT is also the safer direction for the buyer, since
 * the window is the only bound on how long a merchant may sit on a signed payment.
 */
function ledgerWindowFor(maxTimeoutSeconds: number): number {
  const secs = Number.isFinite(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? maxTimeoutSeconds : 60
  const ledgers = Math.floor(secs / SECONDS_PER_LEDGER)
  return Math.min(MAX_LEDGER_WINDOW, Math.max(MIN_LEDGER_WINDOW, ledgers))
}

/** The ledger's floor fee, in drops. Used when the open-ledger fee reads lower or unparseable. */
const MIN_FEE_DROPS = 12

/** A signed payment the gate will refuse outright if it asks the payer for more than this in fees.
 *  XRPL fees are ~12 drops; 1 XRP of headroom is absurdly generous and still catches a hostile or
 *  fat-fingered blob before it is submitted. (The payer pays, so this protects the BUYER's own
 *  wallet on the buyer side, and on the gate side it just refuses to broadcast something silly.) */
const MAX_FEE_DROPS = 1_000_000

/**
 * `tfFullyCanonicalSig` — the flag every real XRPL client sets, and what `xrpl.js` autofills when
 * you don't specify `Flags` at all.
 *
 * We used to send `Flags: 0` to be explicit about NOT setting `tfPartialPayment`. That is a
 * different bit (`0x00020000`), so zero was never necessary to exclude it — and it made our
 * transactions the only ones on the ledger without the canonical-signature flag, which at least one
 * live merchant's verifier rejected as `invalid_payload`. Diffed against a payment that merchant
 * had successfully accepted from another client; the flag was the difference.
 */
const TF_FULLY_CANONICAL_SIG = 0x80000000

/** `tfPartialPayment` — lets a sender deliver LESS than `Amount`. Must never be set. */
const TF_PARTIAL_PAYMENT = 0x00020000

/** The JSON-RPC reads the exact BUYER needs — a subset of `XrplPayClient`, minus `submit`, because
 *  this side never broadcasts. Injected so the signer is unit-testable against a plain mock. */
export interface XrplExactPayClient {
  accountSequence(account: string): Promise<number>
  feeDrops(): Promise<string>
  currentLedgerIndex(): Promise<number>
}

/** The JSON-RPC the exact SELLER needs: submit the buyer's blob, then poll for validation. */
export interface XrplExactSettleClient {
  submit(txBlob: string): Promise<{
    engine_result: string
    engine_result_message?: string
    tx_json?: { hash?: string }
  }>
  /** `tx` lookup by hash → validated flag + metadata, or null while it is not yet found. */
  txByHash(hash: string): Promise<{
    validated?: boolean
    meta?: { TransactionResult?: string; delivered_amount?: unknown }
    Account?: string
  } | null>
}

/** `true` unless the rail explicitly opts into a sponsor we cannot provide. */
function feesAreSponsored(accept: X402ExactAcceptEntry): boolean {
  return accept.extra?.areFeesSponsored === true
}

/** The scheme's binding: `InvoiceID` is the SHA-256 of `extra.invoiceId`, as 32-byte upper hex. */
export function invoiceIdHash(invoiceId: string): string {
  return createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase()
}

/** Honour a higher open-ledger fee, but never go below the floor and never above the sanity cap. */
function feeForSubmit(openLedgerFee: string): string {
  const fee = Number(openLedgerFee)
  const chosen = Number.isFinite(fee) && fee > MIN_FEE_DROPS ? Math.ceil(fee) : MIN_FEE_DROPS
  return String(Math.min(chosen, MAX_FEE_DROPS))
}

/**
 * Build and SIGN the buyer's XRPL `Payment` for a standard x402 `exact` rail. Broadcasts nothing —
 * the returned hex blob is what the resource server submits.
 *
 * THROWS {@link UnsupportedSchemeError} for an issued currency (see the scope note above), a rail
 * demanding a fee sponsor, a rail naming a sequencing method we cannot produce, or a non-integer
 * drops amount.
 */
export async function payExactXrpl(input: {
  client: XrplExactPayClient
  wallet: Wallet
  accept: X402ExactAcceptEntry
}): Promise<{
  payload: ExactXrplPaymentPayload
  accepted: X402ExactAcceptEntry
  payerFrom: string
  nonce: string
}> {
  const { client, wallet, accept } = input

  if (!isXrpNative(accept.asset)) {
    throw new UnsupportedSchemeError(
      `XRPL exact currently signs native XRP only — ${accept.asset} is an issued currency, whose wire ` +
        'amount is a decimal rather than base units and would misprice the spend cap. Pay it via onchain-proof.'
    )
  }
  if (feesAreSponsored(accept)) {
    throw new UnsupportedSchemeError(
      'XRPL exact rail advertises areFeesSponsored:true, but the XRP Ledger charges the fee to the ' +
        'transaction Account — the scheme requires false and PipRail cannot honour a sponsor here.'
    )
  }
  // An absent method means the scheme default `'sequence'`; anything else we cannot build. This is
  // belt-and-braces — the gather already skips an unknown method — but a direct caller gets a typed
  // error rather than a transaction with the wrong sequencing.
  const method = exactTransferMethod(accept, 'xrpl')
  if (method !== 'sequence') {
    throw new UnsupportedSchemeError(
      `XRPL exact: unsupported assetTransferMethod "${method}". Only "sequence" is signable — ` +
        '"ticketSequence" needs a Ticket pre-minted on the payer account, which PipRail does not manage.'
    )
  }
  // Drops are integers. A decimal here would mean the rail is using the issued-currency convention
  // on a native asset, which we must not silently floor.
  if (!/^[0-9]+$/.test(accept.amount)) {
    throw new UnsupportedSchemeError(
      `XRPL exact: native amount "${accept.amount}" is not an integer drops string.`
    )
  }

  const [sequence, openLedgerFee, ledgerIndex] = await Promise.all([
    client.accountSequence(wallet.classicAddress),
    client.feeDrops(),
    client.currentLedgerIndex(),
  ])

  /*
   * Exactly the fields the scheme allows, and nothing else. Notably ABSENT, each on purpose:
   *   • Memos        — facilitators MUST reject them; the binding is InvoiceID.
   *   • SendMax      — MUST be omitted for native XRP (it is MUST-present only for an IOU).
   *   • Paths        — MUST be omitted.
   *   • DeliverMin / DeliverMax — MUST be omitted; `Amount` alone states the exact delivery.
   *   • NetworkID    — omitted on mainnet, per the scheme's network binding.
   *   • Delegate     — never set; facilitators reject it.
   */
  const tx: Record<string, unknown> = {
    TransactionType: 'Payment',
    Account: wallet.classicAddress,
    Destination: accept.payTo,
    Amount: accept.amount, // integer drops, verbatim from the trusted accept
    Sequence: sequence,
    Fee: feeForSubmit(openLedgerFee),
    LastLedgerSequence: ledgerIndex + ledgerWindowFor(accept.maxTimeoutSeconds),
    // tfFullyCanonicalSig ON, tfPartialPayment OFF — the shape every other XRPL client sends.
    Flags: TF_FULLY_CANONICAL_SIG,
  }
  // Only when the rail asks. Unlike the onchain-proof path, the exact rail never INVENTS a tag.
  if (typeof accept.extra?.destinationTag === 'number') {
    tx.DestinationTag = accept.extra.destinationTag
  }
  /*
   * `sourceTag` is NOT in the scheme's `extra` table, yet 1,728 of the 1,732 live XRPL rails carry
   * it — it is how the deployed vendors correlate a payment back to their own quote. Copying it
   * costs nothing, is inert if they ignore it, and omitting it is a plausible reason a merchant
   * refuses a payment it cannot match to an invoice. Mirroring an unknown-but-ubiquitous key is
   * the same tolerance the rest of this release is built on.
   */
  if (typeof accept.extra?.sourceTag === 'number') {
    tx.SourceTag = accept.extra.sourceTag
  }
  if (typeof accept.extra?.invoiceId === 'string' && accept.extra.invoiceId.length > 0) {
    tx.InvoiceID = invoiceIdHash(accept.extra.invoiceId)
  }

  const signed = wallet.sign(tx as never)
  return {
    payload: { signedTxBlob: signed.tx_blob },
    accepted: accept,
    payerFrom: wallet.classicAddress,
    // The tx hash is the natural single-use key: the ledger itself enforces one settlement per
    // (account, sequence), so a replay can never move funds twice even if a gate forgot to dedupe.
    nonce: signed.hash,
  }
}

/** Shape a verifier rejection the same way every other family does. */
const fail = (error: VerifyErrorCode, detail: string): VerifyResult => ({ ok: false, error, detail })

/**
 * SELLER side: verify the buyer's signed blob against the TRUSTED accept, then submit it and wait
 * for a validated `tesSUCCESS`.
 *
 * Every checked field is re-derived from `accept`, never from the client's echo, so a forged
 * `accepted` cannot redirect anything. The decode is done with the caller-injected `decode` (the
 * driver passes `xrpl`'s own), keeping this module free of a static chain-library import.
 */
export async function verifyAndSettleExactXrpl(input: {
  client: XrplExactSettleClient
  /** `xrpl.decode` — hex blob → the transaction's JSON fields. */
  decode: (blob: string) => Record<string, unknown>
  payload: ExactXrplPaymentPayload
  accept: X402ExactAcceptEntry
  /** How many times to poll for validation before giving up (≈1 ledger apart). */
  pollAttempts?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<VerifyResult> {
  const { client, decode, payload, accept } = input
  const attempts = input.pollAttempts ?? 8
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  if (feesAreSponsored(accept)) {
    throw new SettlementError('XRPL exact: rail advertises areFeesSponsored:true, which this ledger cannot honour.')
  }

  let tx: Record<string, unknown>
  try {
    tx = decode(payload.signedTxBlob)
  } catch (err) {
    return fail('signature_invalid', `XRPL exact: undecodable tx blob (${err instanceof Error ? err.message : String(err)}).`)
  }

  // ── Shape + safety rules the scheme makes the facilitator enforce ──────────────
  if (tx.TransactionType !== 'Payment') {
    return fail('signature_invalid', `XRPL exact: expected a Payment, got ${String(tx.TransactionType)}.`)
  }
  if (tx.Memos !== undefined) return fail('signature_invalid', 'XRPL exact: Memos are rejected by the scheme.')
  if (tx.Delegate !== undefined) return fail('signature_invalid', 'XRPL exact: Delegate is rejected by the scheme.')
  if (tx.Paths !== undefined) return fail('signature_invalid', 'XRPL exact: Paths must be omitted.')
  if (tx.DeliverMin !== undefined) return fail('signature_invalid', 'XRPL exact: DeliverMin must be omitted.')
  if (tx.Amount !== undefined && tx.DeliverMax !== undefined) {
    return fail('signature_invalid', 'XRPL exact: Amount and DeliverMax must not both be present.')
  }
  // tfPartialPayment would let the sender deliver LESS than Amount — the whole point of the flag,
  // and fatal for a payment gate. Only that bit is checked: other flags (notably
  // tfFullyCanonicalSig, which every real client sets) are none of our business.
  if (typeof tx.Flags === 'number' && (tx.Flags & TF_PARTIAL_PAYMENT) !== 0) {
    return fail('signature_invalid', 'XRPL exact: tfPartialPayment is rejected.')
  }
  if (typeof tx.LastLedgerSequence !== 'number') {
    return fail('signature_invalid', 'XRPL exact: LastLedgerSequence must be present.')
  }
  if (!tx.TxnSignature && !tx.Signers) {
    return fail('signature_invalid', 'XRPL exact: the transaction is not signed.')
  }

  // ── Every value re-derived from the TRUSTED accept ─────────────────────────────
  if (tx.Destination !== accept.payTo) {
    return fail('wrong_recipient', `XRPL exact: pays ${String(tx.Destination)}, not payTo ${accept.payTo}.`)
  }
  if (tx.Amount !== accept.amount) {
    return fail('amount_too_low', `XRPL exact: Amount ${String(tx.Amount)} ≠ the rail's ${accept.amount} drops.`)
  }
  if (typeof accept.extra?.destinationTag === 'number' && tx.DestinationTag !== accept.extra.destinationTag) {
    return fail('signature_invalid', `XRPL exact: DestinationTag ${String(tx.DestinationTag)} ≠ the rail's ${accept.extra.destinationTag}.`)
  }
  if (typeof accept.extra?.invoiceId === 'string' && accept.extra.invoiceId.length > 0) {
    const want = invoiceIdHash(accept.extra.invoiceId)
    if (String(tx.InvoiceID ?? '').toUpperCase() !== want) {
      return fail('signature_invalid', 'XRPL exact: InvoiceID does not bind this challenge.')
    }
  }
  const feeDrops = Number(tx.Fee)
  if (!Number.isFinite(feeDrops) || feeDrops < 0 || feeDrops > MAX_FEE_DROPS) {
    return fail('signature_invalid', `XRPL exact: implausible Fee ${String(tx.Fee)} drops.`)
  }

  // ── Submit, then poll for a VALIDATED result ───────────────────────────────────
  let hash: string
  try {
    const res = await client.submit(payload.signedTxBlob)
    if (!res.engine_result.startsWith('tes') && !res.engine_result.startsWith('ter')) {
      // A definitive engine rejection — the payer is short, or the tx is stale/malformed.
      return fail(
        'transfer_not_found',
        `XRPL exact: submit rejected — ${res.engine_result}${res.engine_result_message ? ` (${res.engine_result_message})` : ''}.`
      )
    }
    hash = res.tx_json?.hash ?? ''
    if (!hash) throw new Error('submit returned no transaction hash')
  } catch (err) {
    // A transport failure is the GATE's problem, not a buyer rejection → 5xx, and the replay claim
    // is released so the still-valid blob can be re-presented.
    throw new SettlementError(`XRPL exact: submit failed (${err instanceof Error ? err.message : String(err)}).`)
  }

  for (let i = 0; i < attempts; i += 1) {
    let record: Awaited<ReturnType<XrplExactSettleClient['txByHash']>>
    try {
      record = await client.txByHash(hash)
    } catch {
      record = null // not yet propagated — keep polling
    }
    if (record?.validated) {
      const code = record.meta?.TransactionResult
      if (code !== 'tesSUCCESS') {
        return fail('transfer_not_found', `XRPL exact: validated with ${String(code)}, not tesSUCCESS.`)
      }
      /*
       * The partial-payment defence. The scheme only says "use DeliverMax if present, else Amount",
       * which is weaker than the ledger's own truth: `meta.delivered_amount` is what ACTUALLY
       * arrived, and it is the field a tfPartialPayment attack moves. We reject the flag above, so
       * this is the second line — but it costs one comparison and it is the check the existing
       * onchain-proof verifier has always made, so the exact rail is no laxer than its sibling.
       */
      const delivered = record.meta?.delivered_amount
      if (delivered !== undefined && typeof delivered === 'string' && delivered !== accept.amount) {
        return fail('amount_too_low', `XRPL exact: delivered ${delivered} drops, expected ${accept.amount}.`)
      }
      return {
        ok: true,
        receipt: {
          scheme: 'exact',
          success: true,
          network: accept.network,
          transaction: hash,
          asset: accept.asset,
          amount: accept.amount,
          payer: String(record.Account ?? tx.Account ?? ''),
          payTo: accept.payTo,
          verifiedAt: new Date().toISOString(),
        },
      }
    }
    await sleep(1200)
  }
  // Submitted but not yet validated. NOT a rejection — the payment may still land, so this is a
  // gate-side timeout (5xx + claim released), never a "the buyer didn't pay".
  throw new SettlementError(
    `XRPL exact: submitted ${hash} but it was not validated within ${attempts} polls. It may still settle; retry the request.`
  )
}
