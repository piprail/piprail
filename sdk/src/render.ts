/**
 * Agent-facing natural-language renderers — turn the SDK's structured value
 * objects ({@link PaymentPlan}, a thrown {@link PipRailError}, a
 * {@link SpendSummary}) into ONE model-readable English line each, so an
 * autonomous LLM gets a sentence it can act on, not a JSON blob it has to
 * interpret.
 *
 * PURE: zero I/O, zero chain libraries. The only value import is `./errors.js`
 * (chain-agnostic) for `instanceof` + `.code`. These compose only SHIPPED fields
 * — they invent no data and never call the network — so they're unit-testable
 * with plain literals and stay on the viem-free protocol-layer grep.
 */
import { PipRailError } from './errors.js'
import type { PaymentPlan } from './client.js'
import type { SpendSummary } from './ledger.js'

/**
 * One line summarising a {@link PaymentPlan} for a model: what's payable, on which
 * chain, the gas, and how many other rails aren't settleable. `null` (the URL
 * isn't gated) → "no payment required".
 */
export function summarizePlan(plan: PaymentPlan | null): string {
  if (plan == null) return 'No payment required — the URL is not payment-gated.'
  if (plan.payable && plan.best) {
    const q = plan.best.quote
    const c = plan.best.cost
    const otherRails = plan.options.length - 1
    const note = otherRails > 0 ? ` ${otherRails} other rail(s) not settleable.` : ''
    return (
      `Payable: ${q.amountFormatted} ${q.symbol ?? q.asset} on ${plan.best.accept.network} ` +
      `(gas ~${c.feeFormatted} ${c.feeSymbol}).${note}`
    )
  }
  return `NOT payable: ${plan.fundingHint ?? `no settleable rail on ${plan.network}`}`
}

/**
 * One line a model can act on for any failure. For a {@link PipRailError} it
 * switches on the stable `.code`; the broadcast-but-unconfirmed codes
 * (`PAYMENT_TIMEOUT`, `MAX_RETRIES_EXCEEDED`, `CONFIRMATION_TIMEOUT`) carry the
 * load-bearing recovery rule — **recover via `.ref`, never re-pay** (a fresh
 * payment would double-spend). A non-PipRailError → `'Payment failed: <message>'`.
 */
export function explainDecline(err: unknown): string {
  if (!(err instanceof PipRailError)) {
    return `Payment failed: ${err instanceof Error ? err.message : String(err)}`
  }
  switch (err.code) {
    case 'PAYMENT_DECLINED':
      // Already human: the policy reason, an approval decline, or the session-expiry text.
      return err.message
    case 'PAYMENT_TIMEOUT':
    case 'MAX_RETRIES_EXCEEDED':
    case 'CONFIRMATION_TIMEOUT':
      return (
        `${err.message} Recover using the proof on .ref (re-verify or re-submit it); ` +
        `never re-pay — a fresh payment would double-spend.`
      )
    case 'INSUFFICIENT_FUNDS':
      return 'The wallet cannot cover the payment + gas — top up the payer (token and/or native gas) and retry.'
    case 'RECIPIENT_NOT_READY':
      return `${err.message} The fix is on the RECIPIENT (trustline / registration / opt-in / activation), not your balance.`
    case 'NO_COMPATIBLE_ACCEPT':
    case 'UNSUPPORTED_SCHEME':
      // The thrown message already distinguishes "wrong chain" from "enable the
      // 'exact' scheme" — surface it verbatim rather than re-deriving it.
      return err.message
    default:
      return `Payment failed: ${err.message}`
  }
}

/**
 * One line summarising spend so far, per (network, asset) — NEVER a single
 * cross-token figure (there is no price oracle). Count 0 → "no payments yet".
 *
 * NOTE: spend totals are in-memory for THIS process and reset on restart — a
 * convenience, not a durable ledger.
 */
export function formatSpendReport(summary: SpendSummary): string {
  if (summary.count === 0) return 'No payments yet.'
  return summary.byAsset
    .map(
      (a) =>
        `${a.totalFormatted} ${a.symbol ?? a.asset} on ${a.network} ` +
        `(${a.count} payment${a.count === 1 ? '' : 's'})`
    )
    .join('; ')
}
