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
import { floorUnits } from './util/units.js'
import type { Caip2 } from './x402.js'
import type { ChainSelector } from './drivers/types.js'

export interface PaymentPolicy {
  /** Per-payment ceiling, human-readable (e.g. '0.10'). Compared using the
   *  token's TRUE decimals, so a server can't understate the price. */
  maxAmount?: string
  /** Lifetime ceiling for this client, PER DISTINCT ASSET (network+asset).
   *  Summing across different tokens is unit-meaningless without a price
   *  oracle (which the SDK deliberately doesn't add), so each token gets its
   *  own running cap. Pair with `tokens: ['USDC']` for a single-currency budget. */
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
  /** Rolling-window width in seconds for {@link windowTotal}. REQUIRED together with it. */
  windowSeconds?: number
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
  | 'SESSION_EXPIRED'
  | 'WINDOW_TOTAL'

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
 * maxAmount → maxTotal → windowTotal**. Expiry is first because it's
 * session-global (not asset-scoped) — an expired session must always report
 * expiry, not whichever other gate happens to also fail.
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

  return ALLOW
}
