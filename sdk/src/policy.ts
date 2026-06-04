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
  /** Allowlist of token symbols (matched against the TRUE symbol). An asset the
   *  SDK can't recognise never satisfies this list. */
  tokens?: string[]
  /** Allowlist of hosts. Exact (`api.example.com`) or wildcard (`*.example.com`). */
  hosts?: string[]
  /** Pay an asset the SDK can't price (custom/unknown token)? Default false —
   *  declined, because its true decimals can't be verified. When true, the
   *  server-stated decimals are trusted (the explicit, opt-in risk). */
  allowUnknownTokens?: boolean
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

export interface PolicyDecision {
  allowed: boolean
  /** Why it was refused (only when `allowed === false`). */
  reason?: string
}

const ALLOW: PolicyDecision = { allowed: true }
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason })

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
 * Checks run cheapest-first; the first failure wins so the reason is specific.
 */
export function evaluatePolicy(
  intent: PaymentIntent,
  policy: PaymentPolicy | undefined,
  spentForAssetBase: bigint
): PolicyDecision {
  if (!policy) return ALLOW

  if (policy.chains && !policy.chains.some((c) => chainMatches(intent, c))) {
    return deny(
      `chain ${intent.network} is not in the allowed set (policy.chains).`
    )
  }

  if (policy.hosts && !policy.hosts.some((h) => hostMatches(intent.host, h))) {
    return deny(`host ${intent.host} is not in the allowed set (policy.hosts).`)
  }

  if (!intent.recognized && !policy.allowUnknownTokens) {
    return deny(
      `asset ${intent.asset} on ${intent.network} isn't a token the SDK can price; ` +
        `refusing to pay it on trust. Set policy.allowUnknownTokens to override.`
    )
  }

  if (policy.tokens) {
    const sym = intent.recognized ? intent.symbol : undefined
    if (!sym || !policy.tokens.some((t) => t.toUpperCase() === sym.toUpperCase())) {
      return deny(
        `token ${intent.symbol ?? intent.asset} is not in the allowed set (policy.tokens).`
      )
    }
  }

  if (policy.maxAmount !== undefined) {
    const cap = floorUnits(policy.maxAmount, intent.decimals)
    if (intent.amountBase > cap) {
      return deny(
        `payment of ${intent.amountBase} base units exceeds policy.maxAmount ` +
          `(${policy.maxAmount} ${intent.symbol ?? ''}).`.trimEnd()
      )
    }
  }

  if (policy.maxTotal !== undefined) {
    const cap = floorUnits(policy.maxTotal, intent.decimals)
    if (spentForAssetBase + intent.amountBase > cap) {
      return deny(
        `this payment would push spend on ${intent.symbol ?? intent.asset} past ` +
          `policy.maxTotal (${policy.maxTotal}); already spent ${spentForAssetBase} base units.`
      )
    }
  }

  return ALLOW
}
