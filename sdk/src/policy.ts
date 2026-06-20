/**
 * Agent spend policy — the budget guard that makes autonomous payment safe.
 *
 * PURE + chain-agnostic: this module reasons about a single value object
 * ({@link PaymentIntent}) the client builds from the chosen accept; it imports
 * NOTHING from any chain driver. The client enforces the decision before any
 * on-chain send, throwing {@link PaymentDeclinedError} on a refusal.
 *
 * The cardinal rule: a budget is enforced against the token's TRUE decimals
 * (the SDK's own, via the driver's `describeAsset`), never the server-stated
 * `extra.decimals` — so a malicious server can't slip past a cap by claiming a
 * cheap-looking amount. An asset the SDK can't recognise can't be priced
 * safely, so it's declined unless `allowUnknownTokens` is explicitly set.
 */
import { floorUnits, MAX_DECIMALS } from './util/units.js'
import type { Caip2 } from './x402.js'
import type { ChainSelector } from './drivers/types.js'

/**
 * Fixed precision (decimal places) the cross-token GRAND-TOTAL accumulator sums in.
 * Every payment's base-unit amount is scaled to this many decimals before it joins its
 * denomination's running total, so tokens with DIFFERENT decimals (USDC 6dp, USD1 18dp,
 * …) add up exactly with no floating point.
 *
 * Pinned to {@link MAX_DECIMALS} — the most decimals any priceable token may have — ON
 * PURPOSE: it guarantees EVERY token the SDK will price can be summed into a grand total.
 * If this were smaller, a token whose decimals fell in the gap would be silently EXCLUDED
 * from the denomination total, letting a server slip spend past a `maxTotalPerDenom` cap
 * (a real bypass — caught by adversarial review: a hostile token labelled `USDC` with
 * `decimals:25` escaped a 24dp accumulator). With them equal, `scaleToDenom` never returns
 * null for a valid token, so no spend can escape the cap.
 */
export const DENOM_PRECISION = MAX_DECIMALS

/**
 * Static, ship-time DENOMINATION labels for the SDK's built-in stablecoins — the
 * unit of account each one represents, so a caller can cap "total USD across every
 * stablecoin on every chain" with ONE number ({@link PaymentPolicy.maxTotalPerDenom}).
 *
 * This is **not a price oracle**. PipRail never reads a market and never prices a
 * volatile coin. A denomination is the same kind of static, verified-at-ship-time
 * metadata as a token's symbol or decimals; the grand total simply ADDS UP tokens
 * you've grouped as the same unit, each counted 1:1. Native coins (ETH/BNB/SOL/…)
 * and unrecognised tokens have NO denomination — they are never in a bucket (cap
 * them with the per-asset `maxTotal` or the payment-count caps instead).
 *
 * Keys are UPPERCASE true symbols; extend per-policy via {@link PaymentPolicy.denomFor}.
 */
export const BUILTIN_DENOMS: Readonly<Record<string, string>> = {
  USDC: 'USD',
  USDT: 'USD',
  USD1: 'USD',
  FDUSD: 'USD',
  RLUSD: 'USD',
  EURC: 'EUR',
}

/**
 * Resolve a token's denomination for the {@link PaymentPolicy.maxTotalPerDenom}
 * grand total. Resolution order: the caller's `denomFor` override (matched first by
 * exact on-chain asset id, then by case-insensitive TRUE symbol) → the built-in
 * label ({@link BUILTIN_DENOMS}) → `undefined` (the token is not part of any grand
 * total). The result is UPPERCASED so denomination keys are case-insensitive. Pure —
 * no market read, no chain import.
 */
export function denomOf(
  symbol: string | undefined,
  asset: string | undefined,
  policy: PaymentPolicy | undefined
): string | undefined {
  // A NATIVE coin (ETH/BNB/SOL/…) is volatile and NEVER in a denomination bucket — pricing
  // it would need an oracle. Hard-exclude it up front so a server that labels native with a
  // stablecoin symbol (or a stray `denomFor`) can't slip it into a USD/EUR grand total.
  if (asset === 'native') return undefined
  // Normalise to UPPERCASE + trimmed so denomination keys are case- AND whitespace-insensitive
  // (a ` USD ` key, or a 'usd' value, resolves the same as 'USD').
  const norm = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined
  const override = policy?.denomFor
  if (override && typeof override === 'object') {
    // by exact asset id first, then by case-insensitive TRUE symbol. Non-string values are
    // ignored (a malformed denomFor must never throw out of this pure function — see below).
    if (asset && asset in override) {
      const d = norm(override[asset])
      if (d) return d
    }
    if (symbol) {
      const hit = Object.entries(override).find(([k]) => k.trim().toUpperCase() === symbol.trim().toUpperCase())
      if (hit) {
        const d = norm(hit[1])
        if (d) return d
      }
    }
  }
  if (symbol) {
    const builtin = BUILTIN_DENOMS[symbol.trim().toUpperCase()]
    if (builtin) return builtin
  }
  return undefined
}

/**
 * Scale a base-unit amount to the {@link DENOM_PRECISION} grand-total accumulator.
 * Exact for any token with ≤ DENOM_PRECISION decimals (every stablecoin PipRail
 * ships). Returns `null` for a token finer than the accumulator (it can't be summed
 * safely, so it's excluded from the grand total — never silently mis-counted).
 */
export function scaleToDenom(amountBase: bigint, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > DENOM_PRECISION) return null
  return amountBase * 10n ** BigInt(DENOM_PRECISION - decimals)
}

/**
 * Resolve a denomination's cap from `maxTotalPerDenom`, case- AND whitespace-insensitively.
 * If several keys match the same denomination (e.g. `{ USD: '5', usd: '3' }`, or a CSV that
 * repeated a denom), the STRICTEST (numerically smallest) cap wins — so a sloppy or hostile
 * config can never silently relax the leash by adding a looser case-variant. Non-string keys
 * or values are ignored.
 */
function capForDenom(
  caps: Record<string, string> | undefined,
  denom: string
): string | undefined {
  if (!caps || typeof caps !== 'object') return undefined
  const target = denom.trim().toUpperCase()
  let best: string | undefined
  for (const [k, v] of Object.entries(caps)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue
    if (k.trim().toUpperCase() !== target) continue
    if (best === undefined || Number(v) < Number(best)) best = v
  }
  return best
}

export interface PaymentPolicy {
  /** Per-payment ceiling, human-readable (e.g. '0.10'). Compared using the
   *  token's TRUE decimals, so a server can't understate the price. */
  maxAmount?: string
  /** Lifetime ceiling for this client, PER DISTINCT ASSET (network+asset).
   *  Summing across different tokens is unit-meaningless without a price
   *  oracle (which the SDK deliberately doesn't add), so each token gets its
   *  own running cap. Pair with `tokens: ['USDC']` for a single-currency budget.
   *  NOTE — the metered `upto` rail debits this (and `maxTotalPerDenom`/`windowTotal`)
   *  by the authorized **MAX**, not the merchant's claimed settled actual, so an
   *  under-reporting merchant can never loosen the leash; the settled actual is
   *  surfaced on each spend record's `settledBase` for reconciliation. */
  maxTotal?: string
  /** Allowlist of chains the agent may pay on. A 402 on any other chain is
   *  declined. Strings match the configured selector; objects match by id. */
  chains?: ChainSelector[]
  /** Allowlist of token symbols (matched against the TRUE symbol). The special
   *  value `'native'` is a chain-agnostic alias for the chain's native coin — it
   *  matches the native asset on ANY family (ETH/BNB/TRX/XLM/…) without naming
   *  the ticker, mirroring the merchant-side `token: 'native'`. An asset the SDK
   *  can't recognise never satisfies this list. */
  tokens?: string[]
  /** Allowlist of hosts. Exact (`api.example.com`) or wildcard (`*.example.com`). */
  hosts?: string[]
  /** Pay an asset the SDK can't price (custom/unknown token)? Default false —
   *  declined, because its true decimals can't be verified. When true, the
   *  server-stated decimals are trusted (the explicit, opt-in risk). */
  allowUnknownTokens?: boolean
  /**
   * Session time-to-live in SECONDS, relative to session start (client
   * construction). After the deadline EVERY payment is refused
   * (`SESSION_EXPIRED`), regardless of amount — a headless agent's time leash.
   * When both `ttlSeconds` and `expiresAt` are set, the EARLIER deadline wins.
   * Opt-in; omit for no time limit (default). PROCESS-SCOPED — resets on restart.
   */
  ttlSeconds?: number
  /**
   * Absolute session deadline as epoch MILLISECONDS (matches `Date.now()`).
   * SDK-only — there is no MCP env knob (the MCP exposes only the relative-seconds
   * `PIPRAIL_TTL`). A small value expires immediately BY DESIGN; it is NOT
   * auto-corrected from seconds, so pass milliseconds. Opt-in; omit for no limit.
   */
  expiresAt?: number
  /**
   * Rolling-window spend cap per (network, asset), in human units (e.g. '1.00').
   * Refuses a payment that would push spend within the last {@link windowSeconds}
   * past this cap (`OUTSIDE_WINDOW`) — a rate limit on top of the lifetime
   * `maxTotal`. REQUIRED together with `windowSeconds`: setting one without the
   * other is a config error (a half-armed leash is forbidden). Opt-in; heavier.
   */
  windowTotal?: string
  /** Rolling-window width in seconds for {@link windowTotal}. REQUIRED together with it.
   *  Shared by {@link maxPaymentsPerWindow} (the rolling payment-count cap). */
  windowSeconds?: number
  /**
   * Cross-chain, cross-token GRAND-TOTAL spend cap, keyed by DENOMINATION (a unit of
   * account you declare): e.g. `{ USD: '20.00', EUR: '5.00' }`. The SDK sums the
   * human-value of every token of that denomination — across every chain, when the
   * paying clients share a ledger (`MultiChainPayer.fromWallets` or a shared
   * `spendStore`) — and refuses a payment that would push the denomination's
   * running total past the cap (`MAX_TOTAL_DENOM`).
   *
   * This is the single "spend at most $X total, full stop" leash. It is **NOT a price
   * oracle** — PipRail never reads a market and never prices a volatile coin. A token's
   * denomination is a static, ship-time label ({@link BUILTIN_DENOMS}: USDC/USDT/USD1/
   * FDUSD/RLUSD → `'USD'`; EURC → `'EUR'`); the SDK just ADDS UP tokens you've grouped
   * as one unit, each counted 1:1. Native coins and unrecognised tokens have NO
   * denomination and never enter a bucket — cap those with {@link maxTotal} or
   * {@link maxPayments}. Keys are case-insensitive. Coexists with the per-asset
   * `maxTotal`; the stricter cap wins. Opt-in; omit for no grand total (default).
   *
   * Best-effort under concurrency (like `maxTotal`, see STANDARDS §7): many in-flight
   * payments can race past it; the SDK ships no reservation system.
   */
  maxTotalPerDenom?: Record<string, string>
  /**
   * Fold EXTRA tokens into a denomination for the {@link maxTotalPerDenom} grand total,
   * by TRUE symbol (`{ PYUSD: 'USD' }`) or by on-chain asset id (`{ '0x…': 'USD' }`).
   * Your assertion of equivalence, layered ON TOP of the built-in labels — use it for a
   * stablecoin the SDK doesn't ship a label for, or to group a custom token. Symbol keys
   * are case-insensitive; asset-id keys match exactly and win over symbol.
   */
  denomFor?: Record<string, string>
  /**
   * Lifetime cap on the NUMBER of settled payments for this client/ledger — across
   * EVERY chain and token (a count needs no price oracle, so it spans everything). A
   * payment that would be the `(maxPayments + 1)`-th is refused (`MAX_PAYMENTS`). Opt-in.
   */
  maxPayments?: number
  /**
   * Rolling-window cap on the NUMBER of payments within {@link windowSeconds} — a rate
   * limit independent of amount (`WINDOW_COUNT`). REQUIRED together with `windowSeconds`
   * (which it shares with `windowTotal`); setting it without `windowSeconds` is a config
   * error. Opt-in.
   */
  maxPaymentsPerWindow?: number
  /**
   * Emit a `budget-threshold` event (via the client's `onEvent`) the FIRST time
   * cumulative spend crosses this fraction (0–1] of ANY configured cap — `maxTotal`,
   * `maxTotalPerDenom`, `maxPayments`, `windowTotal`, or `maxPaymentsPerWindow` — so an
   * agent/operator is warned BEFORE the hard decline. e.g. `0.8` = warn at 80%. Purely
   * observational (never blocks a payment). Opt-in; omit for no warning (default).
   */
  warnAtFraction?: number
}

/** What the policy reasons over — built by the client from the chosen accept. */
export interface PaymentIntent {
  /** Host of the gated URL (for the `hosts` allowlist). */
  host: string
  /** The selector the client is configured with (for the `chains` allowlist). */
  chain: ChainSelector
  network: Caip2
  asset: string
  /** Server-stated base units — what actually transfers on-chain. */
  amountBase: bigint
  /** TRUE decimals if the asset is recognised, else the server-stated value. */
  decimals: number
  /** TRUE symbol if recognised, else the server-stated value (may be undefined). */
  symbol?: string
  /** Did the driver's `describeAsset` recognise this asset? */
  recognized: boolean
}

/**
 * A typed, machine-readable code for WHICH guard refused a payment — set by
 * `deny()` alongside the human `reason`, so the client routes a denial to the
 * right {@link PayBlocker}/`reasonCode` WITHOUT substring-matching the prose
 * (which would silently break on a wording tweak).
 */
export type PolicyDenyCode =
  | 'CHAIN'
  | 'HOST'
  | 'UNKNOWN_TOKEN'
  | 'TOKEN'
  | 'MAX_AMOUNT'
  | 'MAX_TOTAL'
  | 'MAX_TOTAL_DENOM'
  | 'MAX_PAYMENTS'
  | 'SESSION_EXPIRED'
  | 'WINDOW_TOTAL'
  | 'WINDOW_COUNT'

export interface PolicyDecision {
  allowed: boolean
  /** Why it was refused (only when `allowed === false`). */
  reason?: string
  /** Which guard fired, as a typed enum (only when `allowed === false`). */
  code?: PolicyDenyCode
}

/**
 * INTERNAL — the injected clock + the pre-sliced per-asset window total the
 * client builds for the otherwise-pure {@link evaluatePolicy}. NOT exported: the
 * client is the only producer, and keeping it private de-risks a future
 * fold-`spentForAssetBase`-into-ctx refactor. All time state is process-scoped.
 */
interface PolicyContext {
  /** A single `Date.now()` captured per quote — the expiry check and the window edge share it. */
  now: number
  /** Session clock origin (epoch-ms) = client construction. */
  sessionStart: number
  /** Base units spent on THIS (network, asset) within the rolling window; `0n` when no window cap. */
  spentInWindowBase: bigint
  /**
   * Running grand-total already spent on THIS intent's DENOMINATION, scaled to
   * {@link DENOM_PRECISION}, across the (possibly shared, cross-chain) ledger.
   * Powers `maxTotalPerDenom`. `0n` when no denom cap / the intent has no denomination.
   */
  spentInDenomScaled?: bigint
  /** Total settled payments across the ledger so far — powers `maxPayments`. */
  paymentCount?: number
  /** Settled payments within the rolling window — powers `maxPaymentsPerWindow`. */
  paymentCountInWindow?: number
}

const ALLOW: PolicyDecision = { allowed: true }
const deny = (code: PolicyDenyCode, reason: string): PolicyDecision => ({
  allowed: false,
  reason,
  code,
})

/**
 * Resolve the session deadline (epoch-ms) from `ttlSeconds` (relative) and/or
 * `expiresAt` (absolute); the EARLIER wins; `null` when neither is set. A
 * non-finite / unsafe-integer ttl-derived deadline is treated as "no expiry"
 * (the client's construction-time guard rejects such a `ttlSeconds` up front, so
 * here we fail SAFE toward not-expiring rather than an accidental instant-expiry).
 *
 * Exported at the MODULE level (not from the package index — not public API) so
 * the client can render the same deadline in its budget/session surfaces.
 */
export function resolveDeadline(policy: PaymentPolicy, sessionStart: number): number | null {
  const fromTtl =
    policy.ttlSeconds != null && Number.isSafeInteger(sessionStart + policy.ttlSeconds * 1000)
      ? sessionStart + policy.ttlSeconds * 1000
      : null
  const fromAbs = policy.expiresAt != null ? policy.expiresAt : null
  if (fromTtl == null) return fromAbs
  if (fromAbs == null) return fromTtl
  return Math.min(fromTtl, fromAbs)
}

/** Does `host` match an allowlist entry (exact or `*.suffix` wildcard)? */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    return host === pattern.slice(2) || host.endsWith(suffix)
  }
  return host === pattern
}

/** Does `intent.chain`/`network` match an allowed selector? */
function chainMatches(intent: PaymentIntent, allowed: ChainSelector): boolean {
  if (typeof allowed === 'string') {
    // String selectors: a non-EVM family name or an EVM preset name. Match the
    // configured selector directly when both are strings.
    if (typeof intent.chain === 'string' && intent.chain === allowed) return true
    return false
  }
  // Object selector (viem Chain or { id, rpcUrl }) → compare by resolved network.
  const id = 'id' in allowed ? allowed.id : undefined
  return id !== undefined && intent.network === `eip155:${id}`
}

/**
 * Evaluate a payment against the policy. `spentForAssetBase` is the running
 * total already spent on THIS (network, asset) — supplied by the client's
 * ledger — and powers the per-asset `maxTotal` cap.
 *
 * The optional `ctx` carries the injected clock + the pre-sliced window total so
 * this function stays PURE (no `Date.now()` inside). Omit `ctx` and no time check
 * runs — behaviour is byte-identical to a time-free policy.
 *
 * Checks run in a pinned, deterministic order, first-failure-wins so the reason
 * is specific: **session expiry → chains → hosts → unknown-token → tokens →
 * maxAmount → maxTotal → maxTotalPerDenom → maxPayments → windowTotal →
 * maxPaymentsPerWindow**. Expiry is first because it's session-global (not
 * asset-scoped) — an expired session must always report expiry, not whichever
 * other gate happens to also fail. The grand-total / count caps come after the
 * per-asset caps so the most-specific money cap is reported first.
 */
export function evaluatePolicy(
  intent: PaymentIntent,
  policy: PaymentPolicy | undefined,
  spentForAssetBase: bigint,
  ctx?: PolicyContext
): PolicyDecision {
  if (!policy) return ALLOW

  // Session expiry — FIRST and amount-blind. An expired session pays nothing,
  // even a zero-amount or under-cap payment. Inclusive: `now >= deadline` is
  // EXPIRED (asymmetric with the strict-`>` caps below — documented + tested).
  if (ctx) {
    const deadline = resolveDeadline(policy, ctx.sessionStart)
    if (deadline != null && ctx.now >= deadline) {
      return deny('SESSION_EXPIRED', 'session expired (TTL elapsed) — refusing to pay.')
    }
  }

  if (policy.chains && !policy.chains.some((c) => chainMatches(intent, c))) {
    return deny(
      'CHAIN',
      `chain ${intent.network} is not in the allowed set (policy.chains).`
    )
  }

  if (policy.hosts && !policy.hosts.some((h) => hostMatches(intent.host, h))) {
    return deny('HOST', `host ${intent.host} is not in the allowed set (policy.hosts).`)
  }

  if (!intent.recognized && !policy.allowUnknownTokens) {
    return deny(
      'UNKNOWN_TOKEN',
      `asset ${intent.asset} on ${intent.network} isn't a token the SDK can price; ` +
        `refusing to pay it on trust. Set policy.allowUnknownTokens to override.`
    )
  }

  if (policy.tokens) {
    const sym = intent.recognized ? intent.symbol : undefined
    const isNative = intent.asset === 'native'
    const matches = policy.tokens.some((t) => {
      // `'native'` matches the chain's coin by ASSET id (works on every family),
      // a chain-agnostic alias for its ticker; otherwise match the TRUE symbol.
      if (isNative && t.toUpperCase() === 'NATIVE') return true
      return sym ? t.toUpperCase() === sym.toUpperCase() : false
    })
    if (!matches) {
      return deny(
        'TOKEN',
        `token ${intent.symbol ?? intent.asset} is not in the allowed set (policy.tokens).`
      )
    }
  }

  if (policy.maxAmount !== undefined) {
    const cap = floorUnits(policy.maxAmount, intent.decimals)
    if (intent.amountBase > cap) {
      return deny(
        'MAX_AMOUNT',
        `payment of ${intent.amountBase} base units exceeds policy.maxAmount ` +
          `(${policy.maxAmount} ${intent.symbol ?? ''}).`.trimEnd()
      )
    }
  }

  if (policy.maxTotal !== undefined) {
    const cap = floorUnits(policy.maxTotal, intent.decimals)
    if (spentForAssetBase + intent.amountBase > cap) {
      return deny(
        'MAX_TOTAL',
        `this payment would push spend on ${intent.symbol ?? intent.asset} past ` +
          `policy.maxTotal (${policy.maxTotal}); already spent ${spentForAssetBase} base units.`
      )
    }
  }

  // Cross-token GRAND TOTAL per declared denomination — the "spend at most $X total,
  // full stop" leash. Sums human-value across every token of this denomination across
  // every chain (NOT a price oracle — see BUILTIN_DENOMS). `ctx.spentInDenomScaled` is
  // the client's running total at DENOM_PRECISION; only runs with a denom cap + ctx.
  if (ctx && policy.maxTotalPerDenom) {
    const denom = denomOf(intent.symbol, intent.asset, policy)
    const capStr = denom ? capForDenom(policy.maxTotalPerDenom, denom) : undefined
    if (denom && capStr !== undefined) {
      const thisScaled = scaleToDenom(intent.amountBase, intent.decimals)
      // FAIL CLOSED: a denomination-capped token that can't be scaled into the accumulator
      // (decimals > DENOM_PRECISION) must be REFUSED, never silently skipped — skipping would
      // let it escape the grand total entirely (a cap bypass). Because DENOM_PRECISION ===
      // MAX_DECIMALS and the client already rejects a quote with decimals > MAX_DECIMALS, this
      // is unreachable for a real quote; it's a belt-and-suspenders guard for any other caller.
      if (thisScaled === null) {
        return deny(
          'MAX_TOTAL_DENOM',
          `token for ${denom} has more than ${DENOM_PRECISION} decimals — refusing to count it ` +
            `toward policy.maxTotalPerDenom.${denom} on trust (it can't be summed safely).`
        )
      }
      const capScaled = floorUnits(capStr, DENOM_PRECISION)
      if ((ctx.spentInDenomScaled ?? 0n) + thisScaled > capScaled) {
        return deny(
          'MAX_TOTAL_DENOM',
          `this payment would push total ${denom} spend past ` +
            `policy.maxTotalPerDenom.${denom} (${capStr}) — summed across every ` +
            `${denom} token and chain.`
        )
      }
    }
  }

  // Lifetime payment-COUNT cap — across every chain + token (counts need no oracle).
  if (ctx && policy.maxPayments !== undefined) {
    if ((ctx.paymentCount ?? 0) + 1 > policy.maxPayments) {
      return deny(
        'MAX_PAYMENTS',
        `this payment would exceed policy.maxPayments (${policy.maxPayments}); ` +
          `already settled ${ctx.paymentCount ?? 0}.`
      )
    }
  }

  // Rolling window — LAST (heaviest), and ONLY when BOTH fields are set (a
  // half-armed leash is forbidden; the client also rejects one-without-the-other
  // at construction). `ctx.spentInWindowBase` is the client's pre-sliced total.
  if (ctx && policy.windowTotal !== undefined && policy.windowSeconds !== undefined) {
    const cap = floorUnits(policy.windowTotal, intent.decimals)
    if (ctx.spentInWindowBase + intent.amountBase > cap) {
      return deny(
        'WINDOW_TOTAL',
        `this payment would exceed policy.windowTotal (${policy.windowTotal}) within the last ` +
          `${policy.windowSeconds}s on ${intent.symbol ?? intent.asset}.`
      )
    }
  }

  // Rolling payment-COUNT cap — a rate limit independent of amount, across every
  // chain + token. Shares `windowSeconds` with `windowTotal`.
  if (ctx && policy.maxPaymentsPerWindow !== undefined && policy.windowSeconds !== undefined) {
    if ((ctx.paymentCountInWindow ?? 0) + 1 > policy.maxPaymentsPerWindow) {
      return deny(
        'WINDOW_COUNT',
        `this payment would exceed policy.maxPaymentsPerWindow ` +
          `(${policy.maxPaymentsPerWindow}) within the last ${policy.windowSeconds}s.`
      )
    }
  }

  return ALLOW
}
