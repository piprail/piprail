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
import { BRAND } from './selfdescribe.js'
import type { PaymentPlan } from './client.js'
import type { SpendSummary } from './ledger.js'
import type { X402Challenge } from './x402.js'

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
 * One line summarising spend so far: a per-(network, asset) breakdown, plus — when the
 * caller grouped tokens into a denomination (`maxTotalPerDenom`) — the cross-token GRAND
 * TOTAL per unit (e.g. "$12.34 USD total"). The grand total is a sum of tokens declared as
 * one unit, each 1:1 — NEVER a price-converted figure (no oracle). Count 0 → "no payments yet".
 *
 * NOTE: spend totals are in-memory unless a `spendStore` is configured (then they survive
 * a restart); without one they reset per process — a convenience, not a durable ledger.
 */
export function formatSpendReport(summary: SpendSummary): string {
  if (summary.count === 0) return 'No payments yet.'
  const perAsset = summary.byAsset
    .map(
      (a) =>
        `${a.totalFormatted} ${a.symbol ?? a.asset} on ${a.network} ` +
        `(${a.count} payment${a.count === 1 ? '' : 's'})`
    )
    .join('; ')
  if (summary.byDenom.length === 0) return perAsset
  const grand = summary.byDenom.map((d) => `${d.totalFormatted} ${d.denom} total`).join('; ')
  return `${perAsset} — grand total: ${grand}`
}

/**
 * One line a human or model can act on for a 402 challenge: what it is, the first
 * rail's amount/token/chain + recipient, and how to pay it programmatically. Composes
 * only shipped challenge fields (same `amountFormatted ?? amount` / `symbol ?? asset`
 * convention as the renderers above) — pure, no I/O. Used as the human `instruction`
 * inside the self-describe block and as a landing page's headline. An empty `accepts`
 * (shouldn't happen for a valid v2 challenge) degrades to a generic pointer.
 */
export function describeChallenge(challenge: X402Challenge): string {
  const first = challenge.accepts[0]
  if (!first) {
    return `${BRAND.name} x402 payment endpoint. Pay with @piprail/sdk (${BRAND.sdkInstall}). Docs: ${BRAND.home}.`
  }
  // Guard `extra` — describeChallenge is exported and may be handed a foreign challenge
  // whose accepts lack PipRail's extra shape; fall back to base-unit amount + raw asset.
  const extra: { amountFormatted?: string; symbol?: string } = first.extra ?? {}
  const amount = extra.amountFormatted ?? first.amount
  const token = extra.symbol ?? first.asset
  const hasExact = challenge.accepts.some((a) => a.scheme === 'exact')
  const standard = hasExact ? '; or any standard x402 client (an exact rail is offered)' : ''
  return (
    `${BRAND.name} x402 payment endpoint — pay ${amount} ${token} on ${first.network} to ${first.payTo}. ` +
    `Programmatic: ${BRAND.sdkInstall} then client.fetch(url)${standard}. Docs: ${BRAND.home}.`
  )
}
