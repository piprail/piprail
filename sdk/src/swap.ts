/**
 * Swap — the OPTIONAL, opt-in helper for "I hold the wrong token".
 *
 * PROTOCOL LAYER — pure types + pure helpers, ZERO chain libraries (STANDARDS §1).
 * The work happens in the drivers, behind two OPTIONAL contract methods
 * (`quoteSwap?` / `swap?` on {@link ResolvedNetwork}), so a family that can't swap
 * simply doesn't implement them and nothing about it changes.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * A 402 names a token. A wallet holds what it holds. Today, holding XLM when the
 * invoice wants USDC is a dead end: `planPayment()` reports INSUFFICIENT_TOKEN and
 * stops. This turns that dead end into a suggestion the caller may act on — or
 * ignore entirely.
 *
 * ── IT IS NOT ON BY DEFAULT, AND IT NEVER WILL BE ──────────────────────────────
 * Nothing here runs unless you call it. `fetch()` never swaps. `planPayment()`
 * never swaps. There is no `autoSwap` flag, deliberately: moving one asset into
 * another is a priced, irreversible act, and it is not something a payment library
 * should ever do on your behalf because it noticed you were short. You ask, or it
 * doesn't happen. (STANDARDS §0: opt-in, defaults unchanged.)
 *
 * ── 🔴 PIPRAIL DOES NOT PRICE ANYTHING ─────────────────────────────────────────
 * STANDARDS §7 forbids a price oracle, and a swap rate IS a price. So every
 * {@link SwapQuote} carries a {@link SwapQuoteSource} naming WHO said it. PipRail
 * relays a rate; it never asserts one. Read `quote.source` before you trust a
 * number, exactly as you would read which facilitator settled a payment.
 *
 * Two tiers ship today, and the type system keeps them apart.
 *
 * **Tier 1, `kind: 'protocol'`** — the ledger itself swaps, so there is no third party
 * at all:
 *
 *   - **Stellar** — a `PathPaymentStrictReceive` to your own account. One atomic
 *     operation, routed by the **Stellar SDEX** across its order books and liquidity pools.
 *   - **XRPL** — a cross-currency `Payment` to your own address (the ledger permits
 *     `Account == Destination` precisely for currency conversion), routed by the
 *     **XRPL DEX + AMM** across the order books and AMM pools, auto-bridging through XRP
 *     when that is cheaper.
 *
 * Both are protocol primitives: no third-party contract, no router to approve, no
 * solver, no relayer, no API key, and no integrator fee, because there is nowhere to
 * put one. The funds never leave the user's own account.
 *
 * **Tier 2, `kind: 'provider'`** — a named third-party router, used because those
 * chains have no protocol-level swap:
 *
 *   - **Solana** via **Jupiter**, verified keyless with `platformFee: null`.
 *   - **EVM** (9 live-probed chains) via **KyberSwap**, verified keyless, no integrator fee.
 *   - **Sui** via **Aftermath**, which returns a complete signable transaction block.
 *   - **NEAR** via **Ref Finance**, chosen over Intents because Intents re-adds a facilitator.
 *   - **Algorand** via **Vestige**, whose unsigned group names only you as a signer.
 *   - **Aptos** via **Hyperion**, which publishes no API at all: the quote and the swap are
 *     both Move calls straight to the router contract.
 *   - **TON** via **STON.fi**, whose `reverse_swap` simulation fixes the ask side; the request
 *     is padded so the router's on-chain floor is at least the invoice.
 *   - **Tron** via **SunSwap V2**, also called contract-to-contract with no API.
 *
 * The first five were adopted only after a plain server-side request returned HTTP 200 with
 * no key. The last three need no request at all, because they are read straight off the
 * chain. 0x, 1inch, Odos, OpenOcean, Squid, Rango and thirdweb Bridge all failed that bar
 * and were rejected. PipRail never sets a platform or integrator fee field on any provider,
 * so it takes nothing on top, ever.
 *
 * ⭐ **Three of them are exact-output natively.** Hyperion, STON.fi and SunSwap V2 take the
 * invoice amount as the OUTPUT and cap the input on-chain, which is the exact shape of an
 * x402 quote. Every other route prices an exact input, so the amount is probed and scaled.
 */
import type { Caip2 } from './x402.js'
import type { TokenInput } from './drivers/types.js'

/**
 * WHO produced a rate. PipRail never asserts a price of its own, so this is
 * REQUIRED on every quote — there is no anonymous number in this module.
 *
 * - `'protocol'` — the chain's own DEX decided it (Stellar SDEX, XRPL order books
 *   + AMM). No company is involved and no fee is taken by anyone but the pool.
 * - `'provider'` — a named third party quoted it. Judge it as you would a
 *   facilitator: it can be down, it can be wrong, and it may take a cut.
 */
export interface SwapQuoteSource {
  kind: 'protocol' | 'provider'
  /** Human name, e.g. `'Stellar SDEX'`, `'XRPL DEX + AMM'`. */
  name: string
  /** Anything the caller should know before trusting the rate (pool fees, caveats). */
  note?: string
}

/** One side of a swap, in both machine and human units. */
export interface SwapSide {
  /** Driver-native asset id (`'native'`, `'USDC:GA5Z…'`, an XRPL `CODE.issuer`). */
  asset: string
  symbol: string
  decimals: number
  /** Base units. */
  amount: string
  /** Human units, for display and for an LLM to reason about. */
  amountFormatted: string
}

/** What you want swapped. Shaped for the x402 case: an invoice names an exact price. */
export interface SwapRequest {
  /** The token you HOLD and are willing to spend. */
  from: TokenInput
  /** The token you NEED. */
  to: TokenInput
  /**
   * How much of `to` you need, in human units (e.g. `'0.50'`). Exact-output, because
   * that is the shape of an invoice: the amount owed is fixed and the cost floats.
   */
  wantAmount: string
  /**
   * Slippage tolerance in basis points, applied to the INPUT side as a hard on-chain
   * cap (Stellar `sendMax`, XRPL `SendMax`). Default {@link DEFAULT_SLIPPAGE_BPS}.
   * The cap is enforced by the validators, not by this library: if the market moves
   * past it the transaction fails rather than overspending.
   */
  slippageBps?: number
}

/**
 * ── AGENT MODE: who is answerable for this wallet ───────────────────────────────────
 *
 * The capability an AI agent gets used to depend on which PACKAGE it imported: a model
 * driving `@piprail/mcp` could never swap, while the same wallet driven through the SDK
 * could. That is the wrong axis. Whether an agent may move its own funds between
 * denominations is a question about AUTHORITY, not transport.
 *
 * So it is declared, once, by whoever provisions the key:
 *
 * - `'supervised'` — a human approves each payment at the moment of spend. The human is
 *   the policy. (MCP: `PIPRAIL_CONFIRM=1`.)
 * - `'budgeted'` — **the default.** The `policy` IS the consent: the agent runs free
 *   inside caps it cannot exceed, with no per-payment prompt. Swapping is withheld,
 *   because every cap counts PAYMENTS and a swap is not one.
 * - `'sovereign'` — the agent owns the wallet and answers for it. Swapping is unlocked,
 *   governed by {@link SwapPolicy} rather than by the payment caps.
 *
 * 🔴 **A model can never set its own mode.** It is read at construction from the
 * environment the operator controls, exactly as an agent cannot grant itself broader
 * permissions in its host. `client.mode()` reads it back; nothing writes it.
 *
 * 🔴 **Sovereign does not mean unguarded.** It means guarded by the RIGHT instrument.
 * A payment cap cannot bound a swap, so sovereignty ships with `swapPolicy` instead:
 * a ceiling on what one swap may spend and on the slippage it may accept. Unlocking the
 * capability without that would repeat the exact mistake the withholding avoided.
 *
 * Defaults are unchanged (STANDARDS §0): omit `mode` and everything behaves byte-for-byte
 * as before, with the same eight tools.
 */
export type AgentMode = 'supervised' | 'budgeted' | 'sovereign'

/** The default. Named, so the fallback is never an unexplained string literal. */
export const DEFAULT_AGENT_MODE: AgentMode = 'budgeted'

/** Every valid mode, for validation and for surfaces that enumerate them. */
export const AGENT_MODES: readonly AgentMode[] = ['supervised', 'budgeted', 'sovereign']

/**
 * Guardrails for SWAPPING, the instrument the payment policy cannot be.
 *
 * A payment cap counts money leaving for a merchant. A swap moves your own funds between
 * denominations, so it passes every such cap untouched: a loop of USDC → SOL → USDC bleeds
 * the pool fee each time while the ledger records no spend at all. These bound the two
 * things that actually leak value on that path.
 */
export interface SwapPolicy {
  /**
   * The most one swap may SPEND, in human units of the token being sold (e.g. `'25.00'`).
   * Compared against the quote's on-chain ceiling (`maxSpend`), never the estimate, so a
   * route that moves against you cannot slip past it.
   */
  maxPerSwap?: string
  /**
   * The worst slippage this agent may accept, in basis points. Caps the tolerance a
   * caller (or a model) may ask for; a request above it is refused rather than clamped,
   * because silently tightening a number somebody chose is its own surprise.
   */
  maxSlippageBps?: number
  /**
   * Optional allowlist of token symbols this agent may swap into. Omit for no restriction.
   * Useful for "may consolidate into USDC, may not take a position in anything else".
   */
  allowTo?: readonly string[]
}

/** A priced, executable swap. Read `source` before trusting `maxSpend`. */
export interface SwapQuote {
  /** 🔴 WHO said this rate. Never absent. */
  source: SwapQuoteSource
  network: Caip2
  /** What you'd spend at the quoted rate. */
  from: SwapSide
  /** What you'd receive — exactly `wantAmount`, since these rails are exact-output. */
  to: SwapSide
  /** The most you can possibly spend, base units. Enforced ON-CHAIN, not here. */
  maxSpend: string
  maxSpendFormatted: string
  slippageBps: number
  /**
   * Opaque routing data the driver needs to execute (a Stellar path, an XRPL
   * `Paths` array). Treat it as a token: pass it back, never interpret it.
   */
  route: unknown
}

/** Proof that a swap settled. */
export interface SwapReceipt {
  /** Tx hash / ledger ref, the same shape a payment receipt uses. */
  transaction: string
  network: Caip2
  source: SwapQuoteSource
  /** What actually left the wallet, when the chain reports it; else the quote. */
  from: SwapSide
  to: SwapSide
}

/** Default slippage tolerance: 0.5%. Conservative, and overridable per request. */
export const DEFAULT_SLIPPAGE_BPS = 50

/** Basis-point ceiling. 10% — past this, a "swap" is a donation to an arbitrageur. */
export const MAX_SLIPPAGE_BPS = 1000

/**
 * Validate and default a slippage setting. Pure. Throws {@link RangeError} rather
 * than a `PipRailError` because this is a programming mistake in the caller's own
 * arguments, not a payment condition — see ERRORS.md §1.
 */
export function resolveSlippageBps(bps: number | undefined): number {
  if (bps === undefined) return DEFAULT_SLIPPAGE_BPS
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new RangeError(
      `slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS} (got ${bps}).`
    )
  }
  return bps
}

/**
 * Apply a slippage tolerance to an input amount, rounding UP so the on-chain cap is
 * never tighter than asked for. Pure integer maths — no floats anywhere near money.
 */
export function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 + bps) + 9_999n) / 10_000n
}

/**
 * One human sentence describing a quote, for a log line or an LLM. Always names the
 * source, so the "who priced this?" question is answered wherever the quote is shown.
 */
export function summarizeSwap(q: SwapQuote): string {
  return (
    `Swap ~${q.from.amountFormatted} ${q.from.symbol} → ${q.to.amountFormatted} ${q.to.symbol} ` +
    `(at most ${q.maxSpendFormatted} ${q.from.symbol}, ${q.slippageBps / 100}% slippage). ` +
    `Rate from ${q.source.name}.`
  )
}
