import { resolveNetwork } from './drivers/index.js'
import type {
  ResolvedNetwork,
  WalletHandle,
  ChainSelector,
  CostEstimate,
  RecipientReason,
  WalletBalance,
  DiscoverySigner,
} from './drivers/types.js'
import {
  searchOpenIndexes,
  register402Index,
  registerX402Scan,
  claim402IndexDomain,
  verify402IndexDomain,
  decorateOutcome,
  normalizeNetwork,
  type DiscoveredResource,
  type DiscoveredRail,
  type DiscoverySource,
  type DiscoverySort,
  type RegisterOutcome,
  type DomainClaim,
  type DomainVerification,
} from './indexes.js'
import {
  HEADER_SIGNATURE,
  buildSignatureHeader,
  buildExactSignatureHeader,
  parseChallenge,
  parseReceipt,
  parseSettleResponse,
  type Caip2,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type X402AnyAccept,
  type X402Challenge,
  type X402PaymentSignature,
  type X402Receipt,
  type SettleOutcome,
} from './x402.js'
import {
  InvalidEnvelopeError,
  MaxRetriesExceededError,
  NoCompatibleAcceptError,
  NonReplayableBodyError,
  PaymentDeclinedError,
  PaymentTimeoutError,
  UnsupportedSchemeError,
  WalletRequiredError,
  WrongChainError,
  type DeclineReasonCode,
} from './errors.js'

/** The payment schemes a client can settle: PipRail's native `onchain-proof` (the
 *  default) and the standard x402 `exact` rail (EVM EIP-3009/Permit2 + Solana SVM + Algorand, opt-in). */
export type PaymentScheme = 'onchain-proof' | 'exact'

/** The scheme set when none is configured — `onchain-proof` only, so the zero-config
 *  path is byte-identical to before the `exact` buyer rail existed (defaults never change). */
const DEFAULT_SCHEMES: readonly PaymentScheme[] = ['onchain-proof']
import {
  evaluatePolicy,
  resolveDeadline,
  type PaymentIntent,
  type PaymentPolicy,
  type PolicyDenyCode,
} from './policy.js'
import { SpendLedger, type SpendSummary } from './ledger.js'
import { formatUnits, floorUnits } from './util/units.js'

/** Observability events. `ref` is the proof — a chain-specific id (EVM tx hash, Solana signature, TON locator, Stellar tx hash). */
export type PipRailEvent =
  | { kind: 'payment-required'; challenge: X402Challenge; accept: X402AnyAccept }
  | { kind: 'payment-broadcast'; ref: string }
  | { kind: 'payment-confirmed'; ref: string; blockNumber: bigint }
  /**
   * Broadcast succeeded (we hold `ref`) but LOCAL confirmation timed out — the
   * RPC was likely lagging/throttled while the tx is in fact on-chain. The proof
   * is NOT discarded: the client submits it to the server (whose own on-chain
   * verify is the authority) instead of throwing, so a real payment is never
   * orphaned into a double-pay. `reason` is the confirm error's message.
   */
  | { kind: 'payment-unconfirmed'; ref: string; reason: string }
  /**
   * The payment settled. `receipt` is PipRail's rich {@link X402Receipt} when the
   * server returns one (its own gate, or a facilitator that echoes the full shape);
   * `settle` is the standard x402 SettleResponse (`{ success, transaction, … }`) on
   * conformant third-party-facilitator interop, where the lean SettleResponse has no
   * rich receipt — read `settle.transaction` for the on-chain settle tx there.
   */
  | { kind: 'payment-settled'; receipt: X402Receipt | null; settle?: SettleOutcome }
  | { kind: 'payment-failed'; reason: string }

/**
 * Wallet for the chosen chain family. **One field, every chain: `{ key }`** — the
 * chain's secret as a string (the `chain` selector routes; each driver validates the
 * format). NEAR also needs `{ accountId }`. What `key` is, per chain:
 *   - EVM / Tron     → a 0x… hex private key (secp256k1; Tron also accepts it without the 0x prefix)
 *   - Sui            → a `suiprivkey1…` bech32 secret
 *   - Aptos          → an AIP-80 `ed25519-priv-0x…` (or raw `0x…`) secret
 *   - Solana         → a base58 secret key (or a `Uint8Array`)
 *   - TON            → a 24-word mnemonic  (optional `version: 'v4' | 'v5r1'`, default v4)
 *   - Algorand       → a 25-word mnemonic
 *   - Stellar        → an `S…` secret seed
 *   - XRPL           → an `s…` secret seed
 *   - NEAR           → `{ accountId, key }`, where `key` is an `ed25519:…` secret
 *
 * Advanced (bring your own native signer object — type-specific): EVM `{ walletClient }`,
 * Solana `{ signer }`, TON `{ keyPair }`, Stellar/Sui `{ keypair }`, XRPL `{ wallet }`,
 * Aptos/Algorand `{ account }`.
 */
export type WalletInput =
  // The simple, universal way — the chain's secret as a string. NEAR also needs `accountId`.
  | { key: string; version?: 'v4' | 'v5r1' } // `version` applies to TON only (wallet contract version)
  | { accountId: string; key: string } // NEAR (an account id can't be derived from the key)
  // Advanced: bring your own native signer object (type-specific to each family).
  | { walletClient: unknown } // EVM (a viem WalletClient with an attached account)
  | { signer: unknown } // Solana (a @solana/web3.js Keypair)
  | { keyPair: unknown; version?: 'v4' | 'v5r1' } // TON (@ton/crypto KeyPair)
  | { keypair: unknown } // Stellar / Sui
  | { wallet: unknown } // XRPL (an xrpl.js Wallet)
  | { account: unknown } // Aptos / Algorand

/**
 * A priced payment requirement — what `client.quote(url)` returns and what an
 * `onBeforePay` hook receives, so an agent can decide BEFORE any funds move.
 * `amount`/`decimals`/`symbol` reflect the TRUE token (the SDK's, via
 * `describeAsset`) when recognised, falling back to the server's stated values.
 */
export interface PipRailQuote {
  /** The gated URL. */
  url: string
  /** The chain the client is configured for. */
  chain: ChainSelector
  network: Caip2
  /** On-chain asset id (0x… / mint / jetton master / CODE:ISSUER / 'native'). */
  asset: string
  /** Amount in base units (what actually transfers). */
  amount: string
  /** Human-readable amount, e.g. '0.05'. */
  amountFormatted: string
  decimals: number
  symbol?: string
  payTo: string
  description?: string
  maxTimeoutSeconds: number
  /** Did the SDK recognise the asset (and so trust its decimals/symbol)? */
  recognized: boolean
  /** True if the challenge's stated symbol disagrees with the SDK's real one — a
   *  red flag worth surfacing to the agent. */
  symbolMismatch: boolean
  /** Would the configured `policy` allow paying this? (true when no policy set.) */
  withinPolicy: boolean
  /** Why the policy would refuse it (only when `withinPolicy === false`). */
  policyReason?: string
  /** The TYPED reason the policy refused it (only when `withinPolicy === false`) —
   *  routes the denial to the right blocker/`reasonCode` without parsing prose. */
  policyCode?: PolicyDenyCode
}

/**
 * What `client.estimateCost(url)` returns: the priced payment requirement plus
 * the estimated NETWORK FEE (gas) to settle it, in the chain's native coin.
 * Two distinct numbers an agent weighs before paying — `quote.amountFormatted`
 * is what leaves the wallet as payment; `cost.feeFormatted` is the native-coin
 * gas burned to send it (you pay USDC but spend ETH/SOL/TRX/… on gas).
 */
export interface PipRailCostQuote {
  /** The priced payment requirement (amount/token/chain/recipient/policy). */
  quote: PipRailQuote
  /** Estimated network fee (gas) in the chain's native coin. */
  cost: CostEstimate
}

/* ----------------------- planPayment (affordability + readiness) ----------------------- */

/** A hard reason a rail can't be settled right now — each maps to a concrete fix. */
export type PayBlocker =
  | 'INSUFFICIENT_TOKEN' // wallet holds < the payment amount of the token (or, for native, amount+gas)
  | 'INSUFFICIENT_GAS' // wallet holds < the native-coin gas to send a token payment
  | 'RECIPIENT_NOT_READY' // payTo can't receive yet (no trustline/registration/opt-in/activation)
  | 'OUTSIDE_POLICY' // the client's spend policy refuses it (amount/total/chain/token/host/unknown)
  | 'OUTSIDE_WINDOW' // the session's TIME envelope refuses it (rolling window exhausted, or the session expired)

/** A soft flag — never blocks, always worth surfacing to the agent. */
export type PayWarning =
  | 'SYMBOL_MISMATCH' // the challenge's stated symbol disagrees with the SDK's true one (scam smell)
  | 'BALANCE_UNREADABLE' // a balance read failed (transient) — payability is uncertain, not "broke"
  | 'RECIPIENT_READINESS_UNKNOWN' // the readiness probe failed (transient) — the payment may still bounce
  | 'GAS_HEURISTIC' // gas is a typical-cost constant, not a live RPC estimate (cost.basis)
  | 'THIN_GAS_MARGIN' // has gas, but < 1.5× the estimate — a fee spike could fail the send

/** One offered rail, fully analysed against the bound wallet's own holdings. */
export interface PayOption {
  /** The rail this analyses (one entry from the 402's accepts[]) — an
   *  `onchain-proof` rail or, when `schemes` enables it, a standard `exact` rail. */
  accept: X402AnyAccept
  /** The priced requirement — TRUE decimals/symbol + the policy verdict. */
  quote: PipRailQuote
  /** Estimated native-coin gas to send it (cost.basis surfaced). */
  cost: CostEstimate
  /** The verdict for THIS rail. 'unknown' = a read failed, so payability can't be confirmed. */
  state: 'payable' | 'blocked' | 'unknown'
  /** Hard reasons it's blocked (empty when payable). */
  blockers: PayBlocker[]
  /** Soft flags (may be present even when payable). */
  warnings: PayWarning[]
  /** Live wallet holdings, human units; null = the read was unavailable (NOT zero). */
  balance: { token: string | null; native: string | null }
  /** What this rail needs: the payment amount + the estimated gas, human units. */
  need: { token: string; native: string }
  /** How much MORE is needed to clear a funds blocker, human units (omitted when funded). */
  shortfall?: { token?: string; native?: string }
  /** Can payTo receive this asset right now, and if not, what fixes it. */
  recipient: { ready: boolean | 'n/a' | 'unknown'; reason?: RecipientReason; fix?: string }
}

/** The plan for ONE 402 across every rail this client can pay (its bound network). */
export interface PaymentPlan {
  url: string
  /** The network this client is bound to (the rails it can settle). */
  network: Caip2
  /** Top-level verdict for instant branching. */
  status: 'ready' | 'blocked' | 'unknown'
  /** True iff at least one rail is payable now (best !== null). */
  payable: boolean
  /** The rail to use: the cheapest (within native coin) payable option, or null. */
  best: PayOption | null
  /** Every offered+supported rail, ranked: payable → unknown → blocked. */
  options: PayOption[]
  /** When NOT payable: one human, actionable sentence on exactly what to do. */
  fundingHint: string | null
  /**
   * Read-only TIME envelope — present ONLY when the policy configures one
   * (`ttlSeconds`/`expiresAt`). Lets a headless (Mode A) agent SEE its remaining
   * time leash before paying, rather than discovering it by hitting a decline.
   *
   * PROCESS-SCOPED: resets to a fresh window on restart; for crash-loop-resistant
   * limits supply a pluggable durable store (the `isUsed`/`markUsed` analogue).
   * `secondsRemaining` is a best-effort host wall-clock estimate, clamped ≥ 0.
   */
  session?: { expiresAt: number | null; secondsRemaining: number | null }
}

/**
 * A read-only view of the spend leash for a Mode-A agent — `client.budget()`.
 * Composes the in-memory ledger + the configured policy WITHOUT coupling them.
 *
 * PROCESS-SCOPED: every figure resets on restart — the session IS the process.
 * For crash-loop-resistant limits supply a pluggable durable store (the
 * `isUsed`/`markUsed` analogue). `secondsRemaining` is clamped ≥ 0.
 */
export interface SessionBudget {
  /** The session's time envelope (null fields when no `ttlSeconds`/`expiresAt`). */
  session: {
    /** Session start, ISO. */
    start: string
    /** Deadline as ISO, or null when no time limit is configured. */
    expiresAt: string | null
    /** Seconds until expiry (clamped ≥ 0), or null when no time limit. */
    secondsRemaining: number | null
  }
  /** Per-(network, asset) money leash — ONE row per pair the ledger has seen. */
  byAsset: SpendRemaining[]
}

/**
 * Per-(network, asset) remaining budget — the money half of the leash. One row
 * per pair the LEDGER already holds (decimals are known only after the first
 * spend), so a never-spent pair simply isn't a row. `cap`/`remaining` are
 * `undefined` when no `policy.maxTotal` is set (unbounded). Never a cross-token
 * sum — there is no price oracle.
 */
export interface SpendRemaining {
  network: Caip2
  asset: string
  symbol?: string
  decimals: number
  /** Base units spent so far on this pair. */
  spentBase: string
  /** The `maxTotal` cap in base units; undefined when unbounded. */
  capBase?: string
  /** `max(0, cap − spent)` in base units; undefined when unbounded. */
  remainingBase?: string
  /** `remainingBase` in human units; undefined when unbounded. */
  remainingFormatted?: string
}

/** Plain-language fix per receive-prerequisite, surfaced in PayOption.recipient.fix. */
const RECIPIENT_FIX: Record<RecipientReason, string> = {
  NO_TRUSTLINE: 'the recipient needs a one-time trustline for this asset before it can receive',
  NOT_REGISTERED: 'the recipient must be storage_deposit-registered on this token (NEP-145, one-time)',
  NOT_OPTED_IN: 'the recipient must opt into this asset once (a 0-amount self-transfer)',
  INACTIVE: "the recipient account doesn't exist yet — fund it with the chain's base reserve to activate it",
}

export interface PipRailClientOptions {
  /**
   * Wallet for the chosen chain family. **Optional** — omit it for a READ-ONLY
   * client that can `quote`, `discover`, `estimateCost`, and `register` (402 Index)
   * with no key. Paying, planning, or signing then throws {@link WalletRequiredError}
   * until a wallet is provided. Supplying a wallet is byte-identical to before.
   */
  wallet?: WalletInput
  /** Which chain to pay on. EVM ('bnb'|'base'|…), 'solana', 'ton', 'stellar',
   *  'xrpl', 'tron', 'sui', 'near', 'aptos', or 'algorand'. */
  chain: ChainSelector
  /** Override the chain's default RPC URL (recommended in production). */
  rpcUrl?: string
  /**
   * Spend guardrails for autonomous payment — per-payment + lifetime ceilings
   * and chain/token/host allowlists. A 402 that violates the policy is refused
   * with {@link PaymentDeclinedError} BEFORE any on-chain send. Omit for the
   * (unguarded) default. See {@link PaymentPolicy}.
   */
  policy?: PaymentPolicy
  /**
   * Final approval hook, called with the {@link PipRailQuote} after the policy
   * passes but before paying. Return `false` (or a rejected promise resolving
   * false) to refuse — the client throws {@link PaymentDeclinedError} and no
   * funds move. Use for human-in-the-loop or custom per-payment logic.
   */
  onBeforePay?: (quote: PipRailQuote) => boolean | Promise<boolean>
  /**
   * After paying, how many times to re-send the request with proof before
   * giving up. Default 3, with a short backoff between attempts — this
   * absorbs RPC propagation lag (the server's node briefly trailing the
   * client's, so it hasn't seen the confirmation yet). If the server still
   * returns 402 on the last attempt the SDK throws `MaxRetriesExceededError`
   * (which carries `.ref` — re-verify, never re-pay).
   *
   * If the broadcast succeeded but the client's OWN confirmation timed out
   * (a throttled RPC), the proof is NOT discarded: the client submits it
   * anyway and automatically uses MORE patient retries (a floor of 6, longer
   * backoff), since the on-chain tx may still be settling.
   */
  maxPaymentRetries?: number
  /** Timeout (ms) for the retry leg after broadcast. Default 30_000. */
  retryTimeoutMs?: number
  /**
   * Balance-aware routing: when true, `fetch()` runs `planPayment` on a 402 and
   * pays the cheapest rail the wallet can ACTUALLY settle (token + native gas +
   * recipient-ready), instead of the first policy-passing accept. If none is
   * settleable it throws {@link PaymentDeclinedError} carrying the funding hint —
   * before any send. Default **false** (defaults never change): the zero-config
   * path keeps its existing selection. Recommended for multi-rail 402s. Override
   * per call with `fetch(url, { autoRoute: true })`.
   */
  autoRoute?: boolean
  /**
   * Which payment SCHEMES this client may settle. Default **`['onchain-proof']`**
   * (defaults never change): the zero-config client pays only PipRail's native
   * backendless rail, exactly as before. Add `'exact'` to ALSO pay standard x402
   * `exact` rails — letting the agent pay ANY standard x402 server (the dominant
   * `exact`-on-Base-via-CDP web), not just PipRail's own gates:
   *
   *   new PipRailClient({ chain: 'base', wallet, schemes: ['onchain-proof', 'exact'] })
   *
   * `exact` is **EVM (EIP-3009/Permit2) + Solana (SVM)** today (USDC/EURC); it's
   * silently ignored on a family without an `exact` rail, for native, or for a token the
   * SDK can't price — those keep `onchain-proof`. The agent signs the authorization (an
   * EIP-3009 message on EVM, a partial-signed transaction on Solana) with its OWN wallet
   * and the server / merchant-chosen facilitator broadcasts it (the buyer pays ~0
   * gas; PipRail hosts/settles nothing). The same `policy` + `onBeforePay` gate it
   * BEFORE signing. **Verify against your target facilitator before production.**
   * Override per call with `fetch(url, { schemes })`.
   */
  schemes?: PaymentScheme[]
  /** Logger hook. Default no-op. */
  onEvent?: (event: PipRailEvent) => void
}

/** Options for {@link PipRailClient.discover}. */
export interface DiscoverOptions {
  /** Free-text query, matched against name/description/resource. */
  query?: string
  /**
   * Which network's resources to return: a CAIP-2 id (or a chain slug like
   * `'base'` — normalized to CAIP-2 before matching), `'self'` (the client's
   * bound chain — the default, so results are payable by THIS client), or
   * `'any'` (every chain — the agent filters later).
   */
  // eslint-disable-next-line @typescript-eslint/ban-types
  network?: Caip2 | 'self' | 'any' | (string & {})
  /**
   * Coarse pre-filter: drop results whose advertised USD price exceeds this.
   * Results with no advertised price pass through — use `quote()` for the exact
   * figure before paying.
   */
  maxPrice?: number
  /** Keep ONLY this category, e.g. `'ai'` (prefix match) — strict: results the index
   *  didn't categorize are dropped, so real category matches aren't drowned by un-tagged ones. */
  category?: string
  /** Keep only resources paying in this asset symbol, e.g. `'USDC'` (keeps results whose
   *  asset the index didn't report — confirm with `quote()`). */
  asset?: string
  /** Drop results whose reliability score (0–100) is below this. Results with no reported
   *  score pass through (Bazaar doesn't measure it); inspect `result.reliabilityScore`. */
  minReliability?: number
  /** Prefer verified listings (402 Index server-side). Its `verified` flag differs from the
   *  per-record `domain_verified`, so it's applied at the index; inspect `result.verified`. */
  verified?: boolean
  /** Restrict to listings the index confirmed are payable x402 (402 Index `payment_valid`). */
  paymentValid?: boolean
  /**
   * Result ordering. Default `'relevance'` when a `query` is given (best matches first),
   * else first-seen order. `'reliability'`/`'price'`/`'uptime'`/`'name'` sort by that field.
   */
  sort?: DiscoverySort
  /** Direction for a non-relevance `sort`. Default `'desc'`. */
  order?: 'asc' | 'desc'
  /** Which open indexes to read. Default `['bazaar', '402index']` (both free). */
  sources?: DiscoverySource[]
  /** Max results to fetch per index request. Default 20. */
  limit?: number
}

/** Options for {@link PipRailClient.register}. */
export interface RegisterOptions {
  /** Display name for the listing (defaults to the URL's host). */
  name?: string
  description?: string
  /** Advertised price in USD (metadata only). */
  priceUsd?: number
  /** Payment asset symbol, e.g. `'USDC'` (metadata). */
  asset?: string
  /** Payment network slug, e.g. `'base'` (defaults to the client's `chain` when it's a slug). */
  network?: string
  /** HTTP method the resource answers on. Default 'GET'. */
  method?: string
  /**
   * A category for the listing, e.g. `'ai'`, `'finance'`, `'data'`. The highest-leverage
   * findability field — most of 402 Index's catalog is `uncategorized`, so a real category
   * makes a resource rank + filter where almost nothing else does.
   */
  category?: string
  /**
   * Keywords for the listing. Folded into the description as a searchable tail (402 Index
   * search is literal — a term must appear in the text to match) and sent as a `tags` field.
   */
  tags?: string[]
  /** Who runs the resource (provider/org name). */
  provider?: string
  /** Contact email for the listing. */
  contactEmail?: string
  /** A JSON request body the index should send when health-checking a POST/PUT resource. */
  probeBody?: unknown
  /**
   * Which open indexes to list on. Default `['402index']` — no auth, no
   * signature. Add `'x402scan'` for the SIWX path (needs an EVM `discoverySigner`
   * and a Base/Solana rail). `'bazaar'` can't be written to (facilitator-only).
   */
  targets?: DiscoverySource[]
  /**
   * Attribute the listing to PipRail. **Default ON** (set `false` to opt out). When on, the
   * listing gets a `via: '@piprail/sdk'` provenance field plus a compact `· Built with
   * @piprail/sdk` suffix on the description — the same unobtrusive "Made with X" marker as the
   * `/openapi.json` `x-generator`. Metadata only: it never changes how the resource is paid or
   * ranked, never double-stamps a description that already names PipRail, and never fabricates
   * one. The request `User-Agent` carries PipRail regardless.
   */
  attribution?: boolean
}

/**
 * The read-+-pay surface an agent toolkit needs — the methods {@link paymentTools}
 * calls. BOTH {@link PipRailClient} (one chain) and {@link MultiChainPayer} (many
 * chains, one per wallet) satisfy it, so `paymentTools` wraps either unchanged:
 * point an MCP/LLM at one wallet or at a whole bundle without touching the tools.
 */
export interface PayingClient {
  discover(opts?: DiscoverOptions): Promise<DiscoveredResource[]>
  quote(url: string, init?: RequestInit): Promise<PipRailQuote | null>
  planPayment(url: string, init?: RequestInit): Promise<PaymentPlan | null>
  get(url: string, init?: RequestInit): Promise<Response>
  fetch(url: string, init?: RequestInit): Promise<Response>
  register(url: string, opts?: RegisterOptions): Promise<RegisterOutcome[]>
  spent(): SpendSummary
  budget(): SessionBudget
}

export class PipRailClient {
  private readonly opts: PipRailClientOptions
  private readonly maxRetries: number
  private readonly retryTimeoutMs: number
  private readonly onEvent: (event: PipRailEvent) => void

  // Per-asset tally of everything this client has paid (powers spent() and the
  // policy's maxTotal cap).
  private readonly ledger = new SpendLedger()

  // Resolved lazily on first request — this is what lets Solana (and future
  // families) auto-mount with no setup call.
  private bound?: Promise<{ net: ResolvedNetwork; wallet: WalletHandle | undefined }>

  constructor(opts: PipRailClientOptions) {
    this.opts = opts
    this.maxRetries = Math.max(1, opts.maxPaymentRetries ?? 3)
    this.retryTimeoutMs = opts.retryTimeoutMs ?? 30_000
    this.onEvent = opts.onEvent ?? (() => undefined)
    this.assertPolicyAmountCaps(opts.policy)
    this.assertPolicyTimeOptions(opts.policy)
  }

  /**
   * Fail LOUDLY at construction on a malformed amount cap — a security boundary
   * must never silently half-arm, and a misconfigured cap is a programmer error
   * (→ `TypeError`, no new SDK code). Each cap (`maxAmount` / `maxTotal` /
   * `windowTotal`) must be a non-negative decimal STRING (the same grammar
   * {@link floorUnits} accepts), so a typo like `'0.01abc'` fails fast here instead
   * of lazily throwing a raw `floorUnits` error out of the never-throw read methods.
   */
  private assertPolicyAmountCaps(policy: PaymentPolicy | undefined): void {
    if (!policy) return
    for (const field of ['maxAmount', 'maxTotal', 'windowTotal'] as const) {
      const v = policy[field]
      if (v === undefined) continue
      if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) {
        throw new TypeError(
          `policy.${field} must be a non-negative decimal string (e.g. '0.10'); got ${JSON.stringify(v)}.`
        )
      }
    }
  }

  /**
   * Fail LOUDLY at construction on a misconfigured time policy — a security
   * boundary must never silently half-arm. Two invariants (a misconfiguration is
   * a programmer error → `TypeError`, no new SDK error code):
   *   - the rolling window needs BOTH `windowTotal` and `windowSeconds`, or NEITHER
   *     (one alone is a leash that silently doesn't bite);
   *   - `ttlSeconds` must be a positive, safe integer whose `*1000` deadline stays
   *     within `Number.MAX_SAFE_INTEGER` (else the arithmetic would lose precision).
   */
  private assertPolicyTimeOptions(policy: PaymentPolicy | undefined): void {
    if (!policy) return
    const hasWindowTotal = policy.windowTotal !== undefined
    const hasWindowSeconds = policy.windowSeconds !== undefined
    if (hasWindowTotal !== hasWindowSeconds) {
      throw new TypeError(
        'policy.windowTotal and policy.windowSeconds must be set together — a rolling-window ' +
          'cap can\'t be half-armed (set both, or neither).'
      )
    }
    if (hasWindowSeconds && !(Number.isSafeInteger(policy.windowSeconds) && policy.windowSeconds! > 0)) {
      throw new TypeError('policy.windowSeconds must be a positive integer number of seconds.')
    }
    if (policy.ttlSeconds !== undefined) {
      const ttl = policy.ttlSeconds
      if (
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        !Number.isSafeInteger(this.ledger.sessionStart + ttl * 1000)
      ) {
        throw new TypeError(
          'policy.ttlSeconds must be a positive integer number of seconds small enough that ' +
            'the resulting deadline stays a safe integer.'
        )
      }
    }
  }

  /** Emit an observability event, never letting a throwing handler break the
   * payment flow (mirrors the server gate's `onPaid` isolation). */
  private safeEmit(event: PipRailEvent): void {
    try {
      this.onEvent(event)
    } catch {
      /* a logging hook must never abort a payment */
    }
  }

  /** Auto-mount the chain's driver, resolve the network, and bind the wallet — once. */
  private ensure(): Promise<{ net: ResolvedNetwork; wallet: WalletHandle | undefined }> {
    return (this.bound ??= (async () => {
      const net = await resolveNetwork({
        chain: this.opts.chain,
        rpcUrl: this.opts.rpcUrl,
      })
      // Read-only client: no wallet supplied ⇒ bind none. quote/discover/estimateCost/
      // register(402index) work; pay/plan/sign throw WalletRequiredError via their guards.
      // With a wallet, this is the exact same bindWallet call as before.
      const wallet = this.opts.wallet !== undefined ? net.bindWallet(this.opts.wallet) : undefined
      return { net, wallet }
    })())
  }

  /** Resolve the effective scheme set: a per-call override, else the constructor's
   *  `schemes`, else the `onchain-proof`-only default. */
  private resolveSchemes(perCall?: PaymentScheme[]): readonly PaymentScheme[] {
    return perCall ?? this.opts.schemes ?? DEFAULT_SCHEMES
  }

  /** GET that auto-handles 402. Pass a full URL to any x402-gated endpoint. */
  get(url: string, init?: RequestInit): Promise<Response> {
    return this.fetch(url, { ...(init ?? {}), method: 'GET' })
  }

  /**
   * POST that auto-handles 402.
   *
   * `body` can be a string/FormData/URLSearchParams/ArrayBuffer/Blob (sent
   * as-is) or a plain object (serialised as JSON).
   */
  post(
    url: string,
    body?: BodyInit | object | undefined,
    init?: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init?.headers)
    let payload: BodyInit | undefined

    if (body === undefined || body === null) {
      payload = undefined
    } else if (isReplayableBodyInit(body)) {
      payload = body
    } else if (typeof body === 'object') {
      payload = JSON.stringify(body)
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }
    } else {
      payload = String(body)
    }

    return this.fetch(url, {
      ...(init ?? {}),
      method: 'POST',
      headers,
      body: payload,
    })
  }

  /**
   * Price a gated URL WITHOUT paying. Does the initial request, and if it's a
   * 402, returns a {@link PipRailQuote} — the amount (in the token's TRUE
   * decimals), token, chain, recipient, and whether the configured `policy`
   * would allow it. Returns `null` when the URL isn't payment-gated (no 402).
   *
   * This is what lets an agent (or its planner) decide *before* spending —
   * "0.05 USDC on Base, within budget → pay it." No funds move.
   */
  async quote(url: string, init?: RequestInit): Promise<PipRailQuote | null> {
    const res = await fetch(url, { ...(init ?? {}), method: init?.method ?? 'GET' })
    if (res.status !== 402) return null
    const { quote } = await this.resolveChallenge(url, res, this.resolveSchemes())
    return quote
  }

  /**
   * Estimate the network fee (gas) to pay a gated URL — WITHOUT paying. Returns
   * the {@link PipRailQuote} (what the payment is) plus a {@link CostEstimate}
   * (the gas it will burn, in the chain's NATIVE coin), so an agent can budget
   * the *total* — payment + gas — before any funds move. Returns `null` when the
   * URL isn't payment-gated (no 402).
   *
   * The estimate is best-effort and labelled (`cost.basis`): live-RPC ('estimated')
   * where cheap (EVM gas price, XRPL fee), a typical-cost constant ('heuristic')
   * otherwise. It never throws for a transient RPC issue. Gas is in the native
   * coin (ETH/SOL/TON/XLM/XRP/TRX), distinct from the payment token — most useful
   * on Tron, where a USD₮ transfer can cost real TRX.
   */
  async estimateCost(
    url: string,
    init?: RequestInit
  ): Promise<PipRailCostQuote | null> {
    const res = await fetch(url, { ...(init ?? {}), method: init?.method ?? 'GET' })
    if (res.status !== 402) return null
    const { net, accept, quote } = await this.resolveChallenge(url, res, this.resolveSchemes())
    const cost = await net.estimateCost(accept)
    return { quote, cost }
  }

  /** Aggregated snapshot of every payment this client has settled — total
   *  count, cumulative spend per token, and the individual records. */
  spent(): SpendSummary {
    return this.ledger.summary()
  }

  /**
   * Read-only budget + time leash for a Mode-A (headless) agent — the policy IS
   * the consent, and this is how the agent SEES what's left of it before paying.
   * Composes the in-memory ledger with the configured policy; never throws, moves
   * no funds. PROCESS-SCOPED — every figure resets on restart (see {@link SessionBudget}).
   */
  budget(): SessionBudget {
    const view = this.sessionView()
    const start = new Date(this.ledger.sessionStart).toISOString()
    return {
      session: {
        start,
        expiresAt: view?.expiresAt != null ? new Date(view.expiresAt).toISOString() : null,
        secondsRemaining: view?.secondsRemaining ?? null,
      },
      byAsset: this.remaining(),
    }
  }

  /**
   * Per-(network, asset) remaining budget — ONE row per pair the ledger already
   * holds (decimals are known only after the first spend), so a fresh client with
   * a `maxTotal` set returns `[]` until its first payment. `cap`/`remaining` are
   * `undefined` when no `maxTotal` is configured (unbounded). Pure + in-memory;
   * never throws, never sums across tokens (no price oracle). PROCESS-SCOPED.
   */
  remaining(): SpendRemaining[] {
    const maxTotal = this.opts.policy?.maxTotal
    return this.ledger.assetBuckets().map((b) => {
      const base: SpendRemaining = {
        network: b.network,
        asset: b.asset,
        ...(b.symbol ? { symbol: b.symbol } : {}),
        decimals: b.decimals,
        spentBase: b.totalBase.toString(),
      }
      if (maxTotal === undefined) return base
      const capBase = floorUnits(maxTotal, b.decimals)
      const remainingBase = capBase > b.totalBase ? capBase - b.totalBase : 0n
      return {
        ...base,
        capBase: capBase.toString(),
        remainingBase: remainingBase.toString(),
        remainingFormatted: formatUnits(remainingBase, b.decimals),
      }
    })
  }

  /** The read-only TIME envelope for the plan/budget surfaces, or `undefined`
   *  when no session deadline (`ttlSeconds`/`expiresAt`) is set. `secondsRemaining`
   *  is clamped ≥ 0 — a best-effort host wall-clock estimate. */
  private sessionView(
    now = Date.now()
  ): { expiresAt: number | null; secondsRemaining: number | null } | undefined {
    const policy = this.opts.policy
    if (!policy || (policy.ttlSeconds == null && policy.expiresAt == null)) return undefined
    const deadline = resolveDeadline(policy, this.ledger.sessionStart)
    return {
      expiresAt: deadline,
      secondsRemaining: deadline == null ? null : Math.max(0, Math.floor((deadline - now) / 1000)),
    }
  }

  /**
   * Plan a payment for a gated URL — WITHOUT paying. The read-only completion of
   * the `quote()` → `estimateCost()` → **`planPayment()`** trio: it surveys every
   * rail the 402 offers on this client's chain against the wallet's OWN holdings —
   * token balance, native-coin gas, and recipient-readiness (trustline / ATA /
   * storage_deposit / ASA opt-in) — and returns, crystal-clear:
   *   - `payable` + `best`   — the cheapest rail the wallet can actually settle
   *   - `options[]`          — every rail with typed `blockers` + soft `warnings`
   *   - `fundingHint`        — one human sentence on exactly what to top up
   *
   * NEVER throws for a read problem (a transient/RPC failure surfaces as a rail in
   * `state: 'unknown'` + a warning, never a false "unaffordable"); returns `null`
   * when the URL isn't payment-gated (no 402); and when the 402 offers no rail on
   * this client's chain it EXPLAINS that (status `blocked` + a hint), rather than
   * throwing. Throws `InvalidEnvelopeError` only on an unparseable challenge.
   *
   * Then pay the chosen rail with `fetch(url, { autoRoute: true })`, or branch on
   * the plan yourself. No funds move.
   */
  async planPayment(url: string, init?: RequestInit): Promise<PaymentPlan | null> {
    const res = await fetch(url, { ...(init ?? {}), method: init?.method ?? 'GET' })
    if (res.status !== 402) return null
    const challenge = await parseChallenge(res)
    if (!challenge) {
      throw new InvalidEnvelopeError('402 response did not include a parseable x402 challenge.')
    }
    const { net, wallet } = await this.ensure()
    if (!wallet) {
      throw new WalletRequiredError(
        'planPayment needs a wallet (it checks YOUR balance, gas, and recipient-readiness). ' +
          'This client is read-only — construct it with a `wallet` to plan or pay.'
      )
    }
    return this.planFromChallenge(net, wallet, challenge, url, this.resolveSchemes())
  }

  /**
   * Convenience over {@link planPayment}: can the wallet settle this URL right now?
   * `true` when at least one rail is payable — or when the URL isn't gated (a free
   * resource is trivially "affordable"). No funds move.
   */
  async canAfford(url: string, init?: RequestInit): Promise<boolean> {
    const plan = await this.planPayment(url, init)
    return plan == null ? true : plan.payable
  }

  /* ------------------------- discovery (find + list) ------------------------- */

  /**
   * Find payable resources on the OPEN x402 indexes — WITHOUT paying. Reads the
   * free indexes (CDP Bazaar + 402 Index by default), merges + dedupes them, and
   * by default returns only resources payable on THIS client's chain
   * (`network: 'self'`). Each result carries its advertised `rails[]`; feed a
   * chosen `resource` straight into `quote()` → `planPayment()` → `fetch()`.
   *
   * Nothing PipRail-hosted: these are third-party open directories. Never throws
   * for a read problem — an index that's down or changed simply contributes
   * nothing. Honest caveats (see {@link DIRECTORY_INFO}):
   * - Reads **`bazaar` + `402index`** only — **NOT `x402scan`** (its reads are paid). A
   *   resource you registered on x402scan is live there but will NOT appear here; don't
   *   read that absence as failure. (Passing `sources:['x402scan']` explicitly yields `[]`.)
   * - A resource just listed via {@link register} may not appear yet — 402 Index reviews
   *   before publishing, so retry with a brief backoff if a fresh listing is missing.
   * - Results are cross-scheme (mostly the mainstream `exact` scheme); `fetch()` pays
   *   `onchain-proof` rails by default, and standard `exact` rails too once you opt in
   *   with `schemes: ['onchain-proof', 'exact']` (EVM EIP-3009/Permit2 + Solana SVM + Algorand).
   */
  async discover(opts: DiscoverOptions = {}): Promise<DiscoveredResource[]> {
    // searchOpenIndexes does the fan-out, server-side + client-side filters, and ranking;
    // the client only adds the chain-aware `network` scoping it alone can resolve.
    const found = await searchOpenIndexes({
      ...(opts.query !== undefined ? { query: opts.query } : {}),
      ...(opts.sources ? { sources: opts.sources } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.maxPrice !== undefined ? { maxPrice: opts.maxPrice } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.asset ? { asset: opts.asset } : {}),
      ...(opts.minReliability !== undefined ? { minReliability: opts.minReliability } : {}),
      ...(opts.verified !== undefined ? { verified: opts.verified } : {}),
      ...(opts.paymentValid !== undefined ? { paymentValid: opts.paymentValid } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
      ...(opts.order ? { order: opts.order } : {}),
    })
    const scope = opts.network ?? 'self'
    if (scope === 'any') return found
    if (scope === 'self') {
      // Match via the bound driver's own `supports()` — robust on EVERY chain family,
      // including custom chains. `railOnNetwork` keeps any rail whose network we can't
      // resolve (see below), so discovery is never silently empty on an unmapped chain.
      const { net } = await this.ensure()
      return found.filter((r) => r.rails.some((rail) => railOnNetwork(rail, (n) => net.supports(n))))
    }
    // Normalize the scope too, so a slug ('base') matches a rail that resolves to
    // the same CAIP-2 — honoring the JSDoc and the every-chain "never hide" intent.
    const target = normalizeNetwork(scope)
    return found.filter((r) => r.rails.some((rail) => railOnNetwork(rail, (n) => n === target)))
  }

  /**
   * List a resource you run on the OPEN x402 registries, so agents can find it.
   * Default target is **402 Index** — one POST, no auth, no signature, no payment.
   * Add `'x402scan'` to also register via SIWX (one wallet signature; EVM + a
   * Base/Solana rail). Returns one {@link RegisterOutcome} per target — a target the
   * chain can't satisfy comes back `{ ok:false, detail }`, never a throw. An explicit,
   * developer-invoked action; it moves no funds, and nothing is PipRail-hosted —
   * you're listing on third-party open directories.
   *
   * **Listing is asynchronous — each outcome carries a `visibility` + `note` so an
   * agent knows when/where the resource is findable (don't assume `ok:true` means
   * "searchable now"):**
   * - **402 Index** → `visibility:'pending-review'`. It probes your URL on submit, then lists it
   *   PENDING REVIEW — not searchable until approved (verify your domain on 402index.io for instant
   *   approval), so `discover()` returns nothing for a fresh listing until then. Retry later.
   * - **x402scan** → `visibility:'live'`, but **`discover()` does NOT read x402scan** — the
   *   listing is real on x402scan.com yet won't show up in `discover()`. Base/Solana only;
   *   needs a resolvable input schema (`/openapi.json` or the `extensions.bazaar` block).
   * - **Bazaar** → `visibility:'not-listable'` for PipRail (it lists only what its facilitator
   *   settles; PipRail uses none). You can still READ Bazaar via {@link discover} to find others.
   *
   * The per-source facts live in {@link DIRECTORY_INFO} (importable) if you'd rather branch
   * on them before calling.
   */
  async register(url: string, opts: RegisterOptions = {}): Promise<RegisterOutcome[]> {
    const targets = opts.targets ?? ['402index']
    const networkSlug =
      opts.network ?? (typeof this.opts.chain === 'string' ? this.opts.chain : undefined)
    const outcomes: RegisterOutcome[] = []
    for (const target of targets) {
      if (target === '402index') {
        outcomes.push(
          await register402Index({
            url,
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.description ? { description: opts.description } : {}),
            ...(opts.priceUsd !== undefined ? { priceUsd: opts.priceUsd } : {}),
            ...(opts.asset ? { asset: opts.asset } : {}),
            ...(networkSlug ? { network: networkSlug } : {}),
            ...(opts.method ? { method: opts.method } : {}),
            ...(opts.category ? { category: opts.category } : {}),
            ...(opts.tags ? { tags: opts.tags } : {}),
            ...(opts.provider ? { provider: opts.provider } : {}),
            ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
            ...(opts.probeBody !== undefined ? { probeBody: opts.probeBody } : {}),
            // Attribution is default-ON; forward an explicit opt-out, else let register402Index default it.
            ...(opts.attribution === false ? { attribution: false } : {}),
          })
        )
      } else if (target === 'x402scan') {
        const signer = await this.discoverySigner()
        if (!signer) {
          outcomes.push({
            source: 'x402scan',
            ok: false,
            detail:
              'x402scan registration needs an EVM signer; this chain family has no discoverySigner. ' +
              'Use 402 Index (the default), which needs no signature.',
          })
          continue
        }
        outcomes.push(await registerX402Scan({ url }, signer))
      } else {
        outcomes.push({
          source: 'bazaar',
          ok: false,
          detail:
            'CDP Bazaar has no register endpoint — it catalogs a resource only when its facilitator ' +
            'settles a payment (PipRail uses no facilitator). List on 402 Index / x402scan instead.',
        })
      }
    }
    // Project each index's lifecycle facts (visibility + note) onto the outcome,
    // so an agent reads the caveat right where it already is.
    return outcomes.map(decorateOutcome)
  }

  /**
   * **402 Index domain verification, step 1 of 2.** A self-registered 402 Index
   * listing is `pending-review` (see {@link register}); verifying your domain flips
   * it — and every other pending listing on that domain — to APPROVED/searchable.
   * Pass the resource URL or a bare domain; returns the `verificationHash` to serve
   * as the entire body of `verificationUrl` (your `/.well-known/402index-verify.txt`).
   * Then serve it and call {@link verifyDomain}. Moves no funds; never throws.
   *
   * ```ts
   * const claim = await client.claimDomain('https://api.example.com/report')
   * // serve claim.verificationHash at claim.verificationUrl, then:
   * const res = await client.verifyDomain('api.example.com')  // → { ok:true, status:'verified' }
   * ```
   */
  async claimDomain(urlOrDomain: string, opts: { contactEmail?: string } = {}): Promise<DomainClaim> {
    return claim402IndexDomain(urlOrDomain, opts)
  }

  /**
   * **402 Index domain verification, step 2 of 2.** After {@link claimDomain} and
   * serving the hash at your `/.well-known/402index-verify.txt`, this tells 402 Index
   * to re-fetch + approve. On success the domain's pending listings become searchable
   * (`{ ok:true, status:'verified', servicesCount }`). Moves no funds; never throws.
   */
  async verifyDomain(urlOrDomain: string): Promise<DomainVerification> {
    return verify402IndexDomain(urlOrDomain)
  }

  /**
   * The discovery signer for the bound wallet (its address + a message signer),
   * or `null` if the chain family doesn't support it (EVM does today). For
   * discovery only — ownership proofs (sign the bare origin string and pass it to
   * `buildOpenApi({ ownershipProofs })`) and SIWX registration. Never signs a
   * payment.
   */
  async discoverySigner(): Promise<DiscoverySigner | null> {
    const { net, wallet } = await this.ensure()
    if (!wallet) return null // read-only client: no key to sign discovery proofs / SIWX
    return net.discoverySigner ? net.discoverySigner(wallet) : null
  }

  /**
   * Lower-level: drive any HTTP method through the 402 flow.
   *
   * `init.body` (if any) must be replayable — the SDK may send the request
   * twice (once to fetch the 402, once with the proof attached). One-shot
   * streams throw `NonReplayableBodyError`.
   */
  async fetch(
    url: string,
    init?: RequestInit & { autoRoute?: boolean; schemes?: PaymentScheme[] }
  ): Promise<Response> {
    const body = init?.body
    if (body !== undefined && body !== null && !isReplayableBodyInit(body)) {
      throw new NonReplayableBodyError(
        'fetch(): init.body is not replayable. Pass a string, FormData, ' +
          'URLSearchParams, ArrayBuffer, or Blob — not a ReadableStream.'
      )
    }

    const firstResponse = await fetch(url, init)
    if (firstResponse.status !== 402) return firstResponse

    const schemes = this.resolveSchemes(init?.schemes)
    const resolved = await this.resolveChallenge(url, firstResponse, schemes)
    const { net, wallet, challenge } = resolved
    if (!wallet) {
      throw new WalletRequiredError(
        'Paying a 402 needs a wallet to sign + settle. This client is read-only — ' +
          'construct it with a `wallet` to pay (quote/discover/register still work without one).'
      )
    }
    let accept: X402AnyAccept = resolved.accept
    let quote = resolved.quote

    // Balance-aware routing (opt-in): pay the cheapest rail the wallet can ACTUALLY
    // settle, not just the first policy-passing one. Refuses (before any send) with the
    // funding hint if nothing is settleable.
    const autoRoute = init?.autoRoute ?? this.opts.autoRoute ?? false
    if (autoRoute) {
      const plan = await this.planFromChallenge(net, wallet, challenge, url, schemes)
      if (!plan.best) {
        throw new PaymentDeclinedError(plan.fundingHint ?? 'No rail is settleable for this payment.')
      }
      accept = plan.best.accept
      quote = plan.best.quote
    }

    this.safeEmit({ kind: 'payment-required', challenge, accept })

    // Budget + approval gate — both refuse BEFORE any on-chain send OR any signature.
    await this.authorize(quote)

    // Standard `exact` rail: a separate, conservative pay path — the buyer SIGNS an
    // EIP-3009 authorization and the server/facilitator broadcasts it (never payAndConfirm).
    if (accept.scheme === 'exact') {
      return this.payExactRail(net, wallet, accept, url, init, quote)
    }

    // PipRail's native `onchain-proof` rail — BYTE-IDENTICAL to before.
    const { ref, confirmed } = await this.payAndConfirm(net, wallet, accept)
    const response = await this.retryWithProof(url, init, accept, ref, confirmed)
    this.recordSpend(quote, ref)
    return response
  }

  /* ------------------------- internals ------------------------- */

  /**
   * From a confirmed-402 response: parse the challenge, mount + bind the
   * network, pick the accept the client can pay, and build its quote. Shared by
   * `quote()` (read-only) and `fetch()` (which then authorises + pays).
   */
  private async resolveChallenge(
    url: string,
    response: Response,
    schemes: readonly PaymentScheme[]
  ): Promise<{
    net: ResolvedNetwork
    wallet: WalletHandle | undefined
    accept: X402AnyAccept
    challenge: X402Challenge
    quote: PipRailQuote
  }> {
    const challenge = await parseChallenge(response)
    if (!challenge) {
      throw new InvalidEnvelopeError(
        '402 response did not include a parseable x402 challenge.'
      )
    }

    const { net, wallet } = await this.ensure()

    // Every accept this client could pay (enabled schemes, on the bound network). A
    // multi-chain challenge may offer several — including the same network more than
    // once (e.g. USDC and native, or an onchain-proof + exact dual-rail) — so gather
    // them all, then let policy choose.
    const candidates = this.gatherCandidates(net, challenge, schemes)
    if (candidates.length === 0) {
      // Distinguish "this family can't pay the only scheme offered" (a scheme gap)
      // from "no rail for this network at all" — different fixes for the agent.
      const exactOnNet = challenge.accepts.some(
        (a) => a.scheme === 'exact' && this.supportsNetwork(net, a.network)
      )
      if (schemes.includes('exact') && exactOnNet && typeof net.payExact !== 'function') {
        throw new UnsupportedSchemeError(
          `This 402 offers a standard 'exact' rail on ${net.network}, but the ${net.family} ` +
            `family can't pay 'exact' (supported on EVM, Solana, Algorand + NEAR today), and no 'onchain-proof' rail was offered.`
        )
      }
      // The dominant agent journey: a default (onchain-proof-only) client hits an exact-only
      // 402 it COULD pay — point it straight at the one-line remedy instead of a dead end.
      if (!schemes.includes('exact') && exactOnNet && typeof net.payExact === 'function') {
        const payable = challenge.accepts.some(
          (a) => a.scheme === 'exact' && this.supportsNetwork(net, a.network) && net.describeAsset(a.asset) != null
        )
        if (payable) {
          throw new NoCompatibleAcceptError(
            `This 402 is payable only via the standard 'exact' rail on ${net.network}, which is ` +
              `OFF by default. Enable it: new PipRailClient({ …, schemes: ['onchain-proof', 'exact'] }) ` +
              `or per call fetch(url, { schemes: ['exact'] }) (MCP: PIPRAIL_SCHEMES=onchain-proof,exact).`
          )
        }
      }
      const networks = [...new Set(challenge.accepts.map((a) => a.network))].join(', ')
      throw new NoCompatibleAcceptError(
        `No accepts[] entry payable by this client on ${net.network} ` +
          `(schemes: ${schemes.join(', ')}; challenge offered: ${networks || 'none'}).`
      )
    }

    // Prefer the first candidate the policy allows; if none pass, keep the first
    // so authorize() refuses with its specific policy reason.
    const priced = candidates.map((accept) => ({
      accept,
      quote: this.buildQuote(net, accept, url, challenge.resource.description),
    }))
    const chosen = priced.find((p) => p.quote.withinPolicy) ?? priced[0]!
    return { net, wallet, accept: chosen.accept, challenge, quote: chosen.quote }
  }

  /** Match a foreign-supplied network string against the bound driver, tolerating a
   *  SLUG ('bsc', 'base', '56') the SAME way discovery's `railOnNetwork` already does —
   *  normalize to CAIP-2 first, since a foreign/AEON/community 402 may label the network
   *  with a slug (AEON serves v1 duplicate kinds '56'/'bsc'). ADDITIVE: a value that's
   *  already CAIP-2 passes through `normalizeNetwork` UNCHANGED, so every existing
   *  exact-CAIP-2 match is byte-identical; only slugs resolving to the bound chain become
   *  newly matchable (an unknown slug stays unresolved → still unmatched; a different
   *  chain's slug resolves elsewhere → still unmatched). */
  private supportsNetwork(net: ResolvedNetwork, network: string): boolean {
    return net.supports(normalizeNetwork(network))
  }

  /** The candidate accepts this client could pay, on the bound network. Always the
   *  backendless `onchain-proof` rails; PLUS standard `exact` rails when `schemes`
   *  enables them AND the driver can settle them (EVM `payExact` + a recognised
   *  EIP-3009 token). `onchain-proof` is gathered FIRST so default selection is
   *  unchanged when `exact` is off. */
  private gatherCandidates(
    net: ResolvedNetwork,
    challenge: X402Challenge,
    schemes: readonly PaymentScheme[]
  ): X402AnyAccept[] {
    const out: X402AnyAccept[] = []
    // `onchain-proof` FIRST (when enabled — it's the default) so the default selection
    // and the dual-rail tiebreak are byte-identical to before the `exact` rail existed.
    if (schemes.includes('onchain-proof')) {
      out.push(
        ...challenge.accepts.filter(
          (a): a is X402AcceptEntry => a.scheme === 'onchain-proof' && this.supportsNetwork(net, a.network)
        )
      )
    }
    // Standard `exact` rails, AFTER onchain-proof. Gathered only when the bound driver
    // can actually pay them: it exposes the EVM-only `payExact` SPI, supports the rail's
    // network, AND recognises the token — so the true decimals power the policy cap and a
    // USDT / native / unknown token is never signed for.
    if (schemes.includes('exact')) {
      out.push(
        ...challenge.accepts.filter(
          (a): a is X402ExactAcceptEntry =>
            a.scheme === 'exact' &&
            this.supportsNetwork(net, a.network) &&
            typeof net.payExact === 'function' &&
            net.describeAsset(a.asset) != null &&
            // a foreign rail's maxTimeoutSeconds must be a usable positive integer, or
            // signing it would build a NaN/garbage validBefore — drop it silently
            // (symmetric with an unrecognised token) rather than leak a raw SyntaxError.
            Number.isInteger(a.maxTimeoutSeconds) &&
            a.maxTimeoutSeconds > 0
        )
      )
    }
    return out
  }

  /** Build the full {@link PaymentPlan} from an already-parsed challenge + bound
   *  net/wallet. Shared by `planPayment` (read-only) and `fetch`'s autoRoute. */
  private async planFromChallenge(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    challenge: X402Challenge,
    url: string,
    schemes: readonly PaymentScheme[]
  ): Promise<PaymentPlan> {
    const chainLabel = typeof this.opts.chain === 'string' ? this.opts.chain : net.network
    const session = this.sessionView()
    const candidates = this.gatherCandidates(net, challenge, schemes)
    if (candidates.length === 0) {
      const offered = [...new Set(challenge.accepts.map((a) => a.network))].join(', ') || 'none'
      return {
        url,
        network: net.network,
        status: 'blocked',
        payable: false,
        best: null,
        options: [],
        fundingHint: `This 402 isn't offered on your chain (${chainLabel}); it's payable on: ${offered}.`,
        ...(session ? { session } : {}),
      }
    }
    // Analyse every rail in parallel; one rail's read failure never sinks the others
    // (analyzeRail catches its own reads → 'unknown', never throws for an RPC hiccup).
    const analysed = await Promise.all(
      candidates.map((accept) =>
        this.analyzeRail(net, wallet, accept, url, challenge.resource.description)
      )
    )
    const options = rankOptions(analysed)
    const best = options.find((o) => o.state === 'payable') ?? null
    const status: PaymentPlan['status'] = best
      ? 'ready'
      : options.some((o) => o.state === 'unknown')
        ? 'unknown'
        : 'blocked'
    return {
      url,
      network: net.network,
      status,
      payable: best !== null,
      best,
      options,
      fundingHint: best ? null : buildFundingHint(options, chainLabel),
      ...(session ? { session } : {}),
    }
  }

  /** Analyse ONE rail against the wallet's holdings — quote (existing) + gas
   *  (estimateCost, existing) + balanceOf + recipientReady → a {@link PayOption}. */
  private async analyzeRail(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402AnyAccept,
    url: string,
    description?: string
  ): Promise<PayOption> {
    const quote = this.buildQuote(net, accept, url, description)
    const cost = await net.estimateCost(accept)
    const bal: WalletBalance = await net
      .balanceOf(wallet, accept.asset)
      .catch(() => ({ token: null, native: null }))
    const rr = await net
      .recipientReady(accept.payTo, accept.asset)
      .catch(() => ({ ready: 'unknown' as const }))

    const amount = BigInt(accept.amount)
    const fee = safeBig(cost.fee)
    // A standard `exact` rail: the buyer SIGNS an EIP-3009 authorization and the
    // server/facilitator BROADCASTS it, so the buyer spends ~0 gas — only the token
    // funds it, and native-coin gas is irrelevant to payability.
    const isExact = accept.scheme === 'exact'
    const isNative = accept.asset === 'native'
    const blockers: PayBlocker[] = []
    const warnings: PayWarning[] = []
    const shortfall: { token?: string; native?: string } = {}

    if (!quote.withinPolicy) {
      // Route the time-envelope denials to their own blocker (the typed code + the
      // `session` block tell "wait for the window to slide" from "session is over").
      blockers.push(
        quote.policyCode === 'SESSION_EXPIRED' || quote.policyCode === 'WINDOW_TOTAL'
          ? 'OUTSIDE_WINDOW'
          : 'OUTSIDE_POLICY'
      )
    }
    if (quote.symbolMismatch) warnings.push('SYMBOL_MISMATCH')
    // Gas-basis is meaningless for exact (no buyer gas) — never warn about it there.
    if (!isExact && cost.basis === 'heuristic') warnings.push('GAS_HEURISTIC')

    const tokenKnown = bal.token != null
    const nativeKnown = bal.native != null
    // For exact only the TOKEN balance gates payability; the onchain-proof rails need
    // the native gas coin too, so an unreadable native there is genuinely uncertain.
    if (isExact ? !tokenKnown : !tokenKnown || !nativeKnown) warnings.push('BALANCE_UNREADABLE')

    if (isExact) {
      if (tokenKnown && bal.token! < amount) {
        blockers.push('INSUFFICIENT_TOKEN')
        shortfall.token = formatUnits(amount - bal.token!, quote.decimals)
      }
    } else if (isNative) {
      // The native coin is BOTH the payment and the gas — need amount + gas.
      if (nativeKnown && bal.native! < amount + fee) {
        blockers.push('INSUFFICIENT_TOKEN')
        shortfall.token = formatUnits(amount + fee - bal.native!, quote.decimals)
      }
    } else {
      if (tokenKnown && bal.token! < amount) {
        blockers.push('INSUFFICIENT_TOKEN')
        shortfall.token = formatUnits(amount - bal.token!, quote.decimals)
      }
      if (nativeKnown && bal.native! < fee) {
        blockers.push('INSUFFICIENT_GAS')
        shortfall.native = formatUnits(fee - bal.native!, cost.feeDecimals)
      } else if (nativeKnown && fee > 0n && bal.native! < (fee * 3n) / 2n) {
        warnings.push('THIN_GAS_MARGIN')
      }
    }

    let recipient: PayOption['recipient']
    if (rr.ready === false) {
      blockers.push('RECIPIENT_NOT_READY')
      recipient = rr.reason
        ? { ready: false, reason: rr.reason, fix: RECIPIENT_FIX[rr.reason] }
        : { ready: false }
    } else if (rr.ready === 'unknown') {
      warnings.push('RECIPIENT_READINESS_UNKNOWN')
      recipient = { ready: 'unknown' }
    } else {
      recipient = { ready: rr.ready } // true | 'n/a'
    }

    const unreadable = isExact ? !tokenKnown : isNative ? !nativeKnown : !tokenKnown || !nativeKnown
    const state: PayOption['state'] = blockers.length
      ? 'blocked'
      : unreadable || rr.ready === 'unknown'
        ? 'unknown'
        : 'payable'

    return {
      accept,
      quote,
      cost,
      state,
      blockers,
      warnings,
      balance: {
        token: bal.token != null ? formatUnits(bal.token, quote.decimals) : null,
        native: bal.native != null ? formatUnits(bal.native, cost.feeDecimals) : null,
      },
      need: { token: quote.amountFormatted, native: cost.feeFormatted },
      ...(shortfall.token || shortfall.native ? { shortfall } : {}),
      recipient,
    }
  }

  /** Build the agent-facing quote for an accept: TRUE decimals/symbol (via the
   *  driver's describeAsset) + the policy verdict + a symbol-mismatch flag. */
  private buildQuote(
    net: ResolvedNetwork,
    accept: X402AnyAccept,
    url: string,
    description?: string
  ): PipRailQuote {
    // A base-unit amount must be a non-negative integer STRING. A malformed one
    // (a buggy/hostile server) becomes a typed InvalidEnvelopeError, never a raw
    // BigInt SyntaxError — or a number leaking into the `string` amount field
    // (RegExp.test coerces to string, so a numeric amount would otherwise pass).
    if (typeof accept.amount !== 'string' || !/^\d+$/.test(accept.amount)) {
      throw new InvalidEnvelopeError(
        `challenge amount "${String(accept.amount)}" is not a base-unit integer string.`
      )
    }
    // `asset` is the on-chain token id every downstream step keys on; a structurally
    // incomplete accept (no/blank/non-string asset) can't be priced or paid.
    if (typeof accept.asset !== 'string' || accept.asset.length === 0) {
      throw new InvalidEnvelopeError(
        `challenge on ${accept.network} states no (string) asset — refusing to price it.`
      )
    }
    const amountBase = BigInt(accept.amount)
    const described = net.describeAsset(accept.asset)
    // onchain-proof always carries extra.decimals; an exact rail's is optional but is
    // only ever gathered when describeAsset recognises the token (so `described` is
    // non-null there). A hostile/buggy 402 may omit `extra` entirely — optional-chain
    // it so a missing block routes to the typed InvalidEnvelopeError below (when the
    // token is also unrecognised), never a raw `Cannot read properties of undefined`.
    const decimals = described?.decimals ?? accept.extra?.decimals
    // For a RECOGNISED token `decimals` is the SDK's trusted number. For an UNRECOGNISED
    // token it's whatever the server put in `extra.decimals` — validate it's a real
    // non-negative integer so a string like "6" can't corrupt formatUnits (→ a wildly
    // wrong amountFormatted) or leak a non-number into the `decimals: number` quote field.
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
      throw new InvalidEnvelopeError(
        `challenge for ${accept.asset} on ${accept.network} states no valid decimals and the SDK ` +
          `doesn't recognise the token — refusing to price it.`
      )
    }
    const symbol = described?.symbol ?? accept.extra?.symbol
    // Derive the human amount from the amount + the decimals we TRUST (the SDK's
    // own when recognised), so a server can't display a misleading amountFormatted
    // for a token we know. For an honest server this equals extra.amountFormatted.
    const amountFormatted = formatUnits(amountBase, decimals)
    const intent: PaymentIntent = {
      host: hostOf(url),
      chain: this.opts.chain,
      network: accept.network,
      asset: accept.asset,
      amountBase,
      decimals,
      symbol,
      recognized: described != null,
    }
    // Build the time context ONLY when a time policy is configured — otherwise
    // pass `undefined` so the zero-config path runs no clock and no ledger scan
    // (byte-identical to before). ONE `Date.now()` per quote feeds BOTH the
    // expiry check and the rolling-window edge (same instant for one decision).
    const policy = this.opts.policy
    const hasWindow = !!policy && policy.windowTotal != null && policy.windowSeconds != null
    const hasTimePolicy =
      !!policy && (policy.ttlSeconds != null || policy.expiresAt != null || hasWindow)
    const now = Date.now()
    const ctx = hasTimePolicy
      ? {
          now,
          sessionStart: this.ledger.sessionStart,
          // Window slice ONLY when BOTH fields are set — never a `?? 0` width.
          spentInWindowBase: hasWindow
            ? this.ledger.totalSince(
                accept.network,
                accept.asset,
                now - policy!.windowSeconds! * 1000
              )
            : 0n,
        }
      : undefined
    const decision = evaluatePolicy(
      intent,
      this.opts.policy,
      this.ledger.totalFor(accept.network, accept.asset),
      ctx
    )
    const serverSymbol = accept.extra?.symbol
    const symbolMismatch =
      intent.recognized &&
      !!serverSymbol &&
      !!symbol &&
      serverSymbol.toUpperCase() !== symbol.toUpperCase()

    return {
      url,
      chain: this.opts.chain,
      network: accept.network,
      asset: accept.asset,
      amount: accept.amount,
      amountFormatted,
      decimals,
      symbol,
      payTo: accept.payTo,
      ...(description ? { description } : {}),
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
      recognized: intent.recognized,
      symbolMismatch,
      withinPolicy: decision.allowed,
      ...(decision.reason ? { policyReason: decision.reason } : {}),
      ...(decision.code ? { policyCode: decision.code } : {}),
    }
  }

  /** Enforce the spend policy and the onBeforePay hook — both refuse by
   *  throwing PaymentDeclinedError, before any funds move. Every refusal carries
   *  a typed `reasonCode` so an agent can branch on the cause (and spot a
   *  TERMINAL expiry/approval decline it must not retry) without parsing prose. */
  private async authorize(quote: PipRailQuote): Promise<void> {
    if (!quote.withinPolicy) {
      throw new PaymentDeclinedError(
        `Payment refused by policy: ${quote.policyReason ?? 'not allowed'}`,
        { reasonCode: reasonCodeForPolicy(quote.policyCode) }
      )
    }
    const hook = this.opts.onBeforePay
    if (!hook) return
    let approved: boolean
    try {
      approved = await hook(quote)
    } catch (err) {
      // A throwing decision hook means "do not pay" — fail safe, never pay.
      throw new PaymentDeclinedError('onBeforePay threw — refusing to pay.', {
        cause: err,
        reasonCode: 'APPROVAL',
      })
    }
    if (!approved) {
      throw new PaymentDeclinedError(
        `onBeforePay declined ${quote.amountFormatted} ${quote.symbol ?? ''}`.trimEnd() +
          ` on ${quote.network}.`,
        { reasonCode: 'APPROVAL' }
      )
    }
  }

  /** Record a settled payment in the ledger (true decimals for the running total). */
  private recordSpend(quote: PipRailQuote, ref: string): void {
    this.ledger.record(
      {
        url: quote.url,
        host: hostOf(quote.url),
        network: quote.network,
        asset: quote.asset,
        amountBase: quote.amount,
        amountFormatted: quote.amountFormatted,
        ...(quote.symbol ? { symbol: quote.symbol } : {}),
        ref,
        at: new Date().toISOString(),
      },
      quote.decimals
    )
  }

  private async payAndConfirm(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402AcceptEntry
  ): Promise<{ ref: string; confirmed: boolean }> {
    if (!this.supportsNetwork(net, accept.network)) {
      throw new WrongChainError(
        `Challenge expects ${accept.network} but client is on ${net.network}.`
      )
    }

    // The driver maps chain-specific failures (e.g. insufficient funds) to
    // the SDK's typed errors before they reach us. Once send() returns, the
    // transaction is BROADCAST and funds may already have moved.
    const ref = await net.send(wallet, accept)

    this.safeEmit({ kind: 'payment-broadcast', ref })

    try {
      const { height } = await net.confirm(ref, accept.extra?.minConfirmations ?? 1)
      this.safeEmit({
        kind: 'payment-confirmed',
        ref,
        blockNumber: BigInt(height),
      })
      return { ref, confirmed: true }
    } catch (err) {
      // Confirmation timed out — but the broadcast SUCCEEDED, so we hold `ref`
      // and the payment may well be on-chain (a free/throttled RPC that 429s its
      // status polls past the validity window is the classic case: the tx lands,
      // the read-back fails). Discarding the proof here would orphan a real
      // payment, and a naive caller retry would DOUBLE-PAY. So we DON'T re-throw
      // and we NEVER re-broadcast: we hand the proof to retryWithProof, deferring
      // to the server's own on-chain verify (the authority). If it truly never
      // settled, the server rejects and we surface `ref` so the caller can
      // re-verify — never blindly re-pay.
      this.safeEmit({
        kind: 'payment-unconfirmed',
        ref,
        reason: err instanceof Error ? err.message : String(err),
      })
      return { ref, confirmed: false }
    }
  }

  private async retryWithProof(
    url: string,
    originalInit: RequestInit | undefined,
    accept: X402AcceptEntry,
    ref: string,
    confirmed: boolean
  ): Promise<Response> {
    const signature: X402PaymentSignature = {
      x402Version: 2,
      accepted: accept,
      payload: { nonce: accept.extra?.nonce, txHash: ref },
    }

    const headers = new Headers(originalInit?.headers)
    headers.set(HEADER_SIGNATURE, buildSignatureHeader(signature))

    let lastResponse: Response | null = null
    let lastReason: { error: string; detail: string } | null = null

    // When the payment was NOT locally confirmed (the RPC timed out post-broadcast),
    // be more patient: the tx may still be settling and the server's node needs time
    // to see it. Spread more attempts over a longer window before giving up — this
    // is the difference between absorbing the lag and a false "it failed".
    const attempts = confirmed ? this.maxRetries : Math.max(this.maxRetries, 6)
    const backoffCap = confirmed ? 2000 : 5000

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Short backoff before re-trying, so a server whose RPC node is a beat
      // behind the client's gets time to see the confirmation. None on the
      // first attempt — the client already waited for minConfirmations.
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, Math.min(backoffCap, 400 * 2 ** (attempt - 1))))
      }

      const timeoutController = new AbortController()
      const timeoutId = setTimeout(
        () => timeoutController.abort(),
        this.retryTimeoutMs
      )
      const signal: AbortSignal =
        originalInit?.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([timeoutController.signal, originalInit.signal])
          : timeoutController.signal

      try {
        lastResponse = await fetch(url, {
          ...(originalInit ?? {}),
          headers,
          signal,
        })
      } catch (err) {
        if (timeoutController.signal.aborted) {
          throw new PaymentTimeoutError(
            `Server did not respond within ${this.retryTimeoutMs}ms ` +
              `after broadcasting payment ${ref}. Re-verify or re-submit ref=${ref} — do NOT re-pay.`,
            { cause: err, ref }
          )
        }
        throw err
      } finally {
        clearTimeout(timeoutId)
      }

      if (lastResponse.status !== 402) {
        const receipt = parseReceipt(lastResponse)
        this.safeEmit({ kind: 'payment-settled', receipt })
        return lastResponse
      }

      // Still 402: the server rejected the proof. Capture WHY so we can tell
      // the agent the reason if we ultimately give up — it may be transient
      // (e.g. tx_not_found from RPC lag), which the next attempt clears.
      lastReason = (await readInvalidReason(lastResponse)) ?? lastReason
    }

    const why = lastReason
      ? `${lastReason.error}${lastReason.detail ? ` — ${lastReason.detail}` : ''}`
      : 'server gave no reason'
    const unconfirmedNote = confirmed
      ? ''
      : ' (broadcast but NOT locally confirmed — it may still have settled on-chain)'
    this.safeEmit({
      kind: 'payment-failed',
      reason: `server returned 402 after broadcasting payment ${ref}${unconfirmedNote} (${why})`,
    })
    throw new MaxRetriesExceededError(
      `Server still returned 402 after ${attempts} attempt(s) with on-chain proof ` +
        `ref=${ref}${unconfirmedNote}. Last server rejection: ${why}. ` +
        `Re-verify or re-submit ref=${ref} before retrying — never re-pay (it would double-spend).`,
      { ref }
    )
  }

  /**
   * Pay a standard x402 `exact` rail — a SEPARATE, fundamentally more conservative
   * path than {@link retryWithProof}. The buyer SIGNS an EIP-3009 authorization ONCE
   * (the driver's `payExact`) and the server / merchant-chosen facilitator BROADCASTS
   * it synchronously, so a blind re-POST of a still-in-flight authorization could
   * double-BROADCAST it. Hence, unlike the onchain-proof loop:
   *
   *   • sign exactly once — reuse the SAME header on every retry, never re-sign;
   *   • retry ONLY an explicit 402 (a definitive pre-broadcast rejection), bounded
   *     well under `maxTimeoutSeconds` so the loop can't outlive the authorization;
   *   • a post-POST transport error/timeout → {@link PaymentTimeoutError} carrying the
   *     nonce (the facilitator MAY have settled — verify on-chain, NEVER re-pay);
   *   • a 5xx → return as-is (server settle failure; the authorization stays valid +
   *     its nonce unused) — no settled event, no spend;
   *   • a 200 whose SettleResponse says `success:false` → a rejection, NEVER a spend;
   *   • the spend is recorded EXACTLY ONCE, on an affirmative settlement only.
   */
  private async payExactRail(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402ExactAcceptEntry,
    url: string,
    init: (RequestInit & { autoRoute?: boolean; schemes?: PaymentScheme[] }) | undefined,
    quote: PipRailQuote
  ): Promise<Response> {
    if (!net.payExact) {
      // gatherCandidates only yields an exact rail when payExact exists — defensive.
      throw new UnsupportedSchemeError(
        `the ${net.family} family can't pay a standard 'exact' rail (supported on EVM, Solana, Algorand + NEAR today).`
      )
    }
    // A caller who aborts BEFORE we sign/send hasn't moved any funds — surface their
    // AbortError verbatim, never the "may have settled" ambiguity, and don't waste a signature.
    throwIfAborted(init?.signal)

    // Sign ONCE — a fresh nonce is generated here and reused on every retry below.
    const { payload, accepted, payerFrom, nonce } = await net.payExact(wallet, accept)
    const headers = new Headers(init?.headers)
    headers.set(HEADER_SIGNATURE, buildExactSignatureHeader({ accepted, payload }))

    // A DEFINITIVE facilitator rejection — an explicit `success:false` (the spec's
    // settlement-failure verdict, carried in the PAYMENT-RESPONSE header on a 402 OR a
    // non-5xx), or a persistent transient 402. Never re-present, never a spend; the
    // `errorReason` tells the agent the real fix (e.g. `insufficient_funds` → top up).
    const rejectDefinitive = (why: string): never => {
      this.safeEmit({ kind: 'payment-failed', reason: `exact: facilitator rejected nonce=${nonce} (${why})` })
      throw new MaxRetriesExceededError(
        `exact: the facilitator rejected the payment (${why}). Fix the cause, then re-present the ` +
          `SAME signed authorization (nonce=${nonce}) — do NOT re-sign a fresh nonce. ref=${nonce}.`,
        { ref: nonce }
      )
    }

    // Bound the loop under the authorization's validity window (= now + maxTimeoutSeconds)
    // so it can never outlive `validBefore`, with a small attempt cap on top.
    const deadline = Date.now() + Math.max(1, Math.floor(accept.maxTimeoutSeconds / 2)) * 1000
    const maxAttempts = Math.min(this.maxRetries, 3)
    let lastReason: { error: string; detail: string } | null = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, Math.min(2000, 400 * 2 ** (attempt - 1))))
      }
      throwIfAborted(init?.signal) // a pre-flight caller abort: nothing sent this attempt.

      // Per-attempt timeout, CLAMPED to the deadline so a generous retryTimeoutMs can't let
      // an attempt outlive the authorization's validity window.
      const budget = Math.min(this.retryTimeoutMs, deadline - Date.now())
      if (budget <= 0) break
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(), budget)
      const signal: AbortSignal =
        init?.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([timeoutController.signal, init.signal])
          : timeoutController.signal

      let response: Response
      try {
        response = await fetch(url, { ...(init ?? {}), headers, signal })
      } catch (err) {
        // The authorization was POSTed; the facilitator MAY have broadcast it (a mid/post-
        // flight caller abort is the same hazard). NEVER re-POST blindly (double-broadcast) —
        // surface the nonce so the caller verifies on-chain before doing anything else.
        throw new PaymentTimeoutError(
          `exact: no response after submitting the authorization (nonce=${nonce}) to ` +
            `${hostOf(url)}. The facilitator may have already settled it — verify on-chain with ` +
            `authorizationState(${payerFrom}, ${nonce}) before re-presenting; do NOT re-pay.`,
          { cause: err, ref: nonce }
        )
      } finally {
        clearTimeout(timeoutId)
      }

      // The SettleResponse rides in the base64 PAYMENT-RESPONSE header on BOTH a 200 success
      // AND the spec's canonical 402 settlement-FAILURE shape ({success:false, errorReason}).
      const settle = parseSettleResponse(response)

      if (response.status === 402) {
        // A definitive settlement/verification failure (402 + success:false) must NOT be
        // retried — re-presenting an insufficient-funds auth is futile.
        if (settle && settle.success === false) rejectDefinitive(settle.errorReason ?? 'the facilitator reported success:false')
        // A 402 with no success:false verdict is a transient "still verifying" / RPC-lag
        // 402 — safe to re-present the SAME signed header.
        lastReason = (await readInvalidReason(response)) ?? lastReason
        continue
      }

      // Non-402. Settled iff it's a 2xx whose SettleResponse does NOT say success:false
      // (a receipt-less 2xx counts as affirmative).
      if (response.ok && !(settle && settle.success === false)) {
        const receipt = parseReceipt(response)
        this.safeEmit({ kind: 'payment-settled', receipt, ...(settle ? { settle } : {}) })
        // Record the spend EXACTLY ONCE, on this affirmative-settle path only. Prefer the
        // facilitator's on-chain settle tx; fall back to the nonce when it echoes none (`||`,
        // so a misbehaving `transaction:''` doesn't become the audit ref).
        const ref = settle?.transaction || receipt?.transaction || `eip3009-nonce:${nonce}`
        this.recordSpend(quote, ref)
        return response
      }

      // A 5xx is a SERVER settle failure (the authorization stays valid + its nonce unused):
      // return it as-is, never a spend — even if it carries success:false (re-presentable later).
      if (response.status >= 500) {
        this.safeEmit({ kind: 'payment-failed', reason: `exact: server ${response.status} — authorization nonce=${nonce} not settled` })
        return response
      }
      // A non-5xx, non-2xx with an explicit success:false is a definitive rejection.
      if (settle && settle.success === false) rejectDefinitive(settle.errorReason ?? 'the facilitator reported success:false')
      // Any other non-2xx (e.g. a 4xx unrelated to payment): return as-is, never a spend.
      this.safeEmit({ kind: 'payment-failed', reason: `exact: server ${response.status} — authorization nonce=${nonce} not settled` })
      return response
    }

    // Persistent transient 402 across the attempt/deadline budget.
    const why = lastReason
      ? `${lastReason.error}${lastReason.detail ? ` — ${lastReason.detail}` : ''}`
      : 'server gave no reason'
    this.safeEmit({
      kind: 'payment-failed',
      reason: `exact: 402 after submitting authorization nonce=${nonce} (${why})`,
    })
    throw new MaxRetriesExceededError(
      `exact: server still returned 402 after submitting the signed authorization ` +
        `(nonce=${nonce}). Last rejection: ${why}. Re-present the SAME authorization — do NOT ` +
        `re-sign a fresh nonce; verify authorizationState(${payerFrom}, ${nonce}) first. ref=${nonce}.`,
      { ref: nonce }
    )
  }
}

/* ----------------------------- helpers ----------------------------- */

/** Throw the caller's abort reason if their signal has ALREADY fired — so a pre-flight
 *  caller abort surfaces verbatim (an AbortError), never the exact path's "may have
 *  settled — verify on-chain" warning (which is only for a mid/post-send drop). */
function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')
  }
}

/** Parse a base-unit string to bigint, tolerating a malformed value (→ 0n). */
function safeBig(s: string): bigint {
  try {
    return BigInt(s)
  } catch {
    return 0n
  }
}

/** Shorten an address for a human hint: `0x1234…cdef`. */
function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a
}

/** Rank rails: payable → unknown → blocked; within payable, cheapest gas first
 *  (valid — one client is one network, so all rails share one native coin; never
 *  compared across coins, which would need a price oracle). Stable otherwise. */
function rankOptions(options: PayOption[]): PayOption[] {
  const rank = { payable: 0, unknown: 1, blocked: 2 } as const
  return [...options].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state]
    if (a.state === 'payable') {
      const fa = safeBig(a.cost.fee)
      const fb = safeBig(b.cost.fee)
      if (fa !== fb) return fa < fb ? -1 : 1
    }
    return 0
  })
}

/**
 * Merge already-within-chain-ranked plans across clients into one ordered list.
 * Each plan's `options` are ALREADY ranked on their own (single) native coin —
 * payable-first, cheapest-gas first ({@link rankOptions} in `planFromChallenge`). We
 * concatenate them in CLIENT order, then stable-partition by state only. We never
 * compare gas fees ACROSS coins — base-unit magnitudes aren't comparable between
 * different native coins (and there's no price oracle), so doing so would let a
 * small-base-unit coin win regardless of real cost. The result: `best` is the
 * FIRST chain you listed that can settle (your preference), and within a chain the
 * cheapest-gas rail. A valid, transitive comparator (state rank only) → stable.
 */
function rankAcross(plans: PaymentPlan[]): PayOption[] {
  const rank = { payable: 0, unknown: 1, blocked: 2 } as const
  return plans.flatMap((p) => p.options).sort((a, b) => rank[a.state] - rank[b.state])
}

/**
 * Plan a URL on every client, KEEPING the client↔plan association. Distinguishes a
 * PER-CLIENT failure (one chain's RPC is down → swallowed, contributes nothing) from
 * a TOTAL outage (every client threw and none returned) — the latter is RE-THROWN, so
 * `canAfford`/`quote` surface a real error instead of a false "affordable"/"not-gated"
 * (a single client throws on a dead RPC; the across-helpers must too). A client that
 * returns `null` (a clean non-402) counts as a reachable "not gated" answer.
 */
async function planEachClient(
  clients: PipRailClient[],
  url: string,
  init?: RequestInit
): Promise<{ client: PipRailClient; plan: PaymentPlan }[]> {
  const settled = await Promise.allSettled(clients.map((c) => c.planPayment(url, init)))
  const live: { client: PipRailClient; plan: PaymentPlan }[] = []
  let anyReached = false
  let firstError: unknown
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      anyReached = true // reached the server (a plan, or null = not gated)
      if (s.value != null) live.push({ client: clients[i]!, plan: s.value })
    } else if (firstError === undefined) {
      firstError = s.reason
    }
  })
  // Every client threw (e.g. total RPC/network outage) ⇒ propagate, don't fake "not gated".
  if (live.length === 0 && !anyReached) {
    throw firstError ?? new Error('planAcross: every client failed to reach the resource.')
  }
  return live
}

/**
 * Merge several single-chain plans' funding hints into ONE clear cross-chain decline
 * message — used when NO funded chain can settle (multi-chain `planAcross`/`fetchAcross`).
 * The single-chain `buildFundingHint` already names its own chain in each sentence; this
 * just decides which to show so an agent (or human) sees exactly what's blocking EVERY
 * funded chain, not only the first:
 *   - If any funded chain actually OFFERED a rail but couldn't settle it (insufficient
 *     token/gas, recipient-not-ready, outside-policy), show ALL of those — deduped, joined
 *     with ` · ` — so the reader sees each chain to top up and by how much. The bare
 *     "not offered on this chain" notes from chains the 402 never listed are dropped as
 *     noise (they aren't actionable when another chain is close).
 *   - If NO funded chain even offered a rail (the 402 wants chains you don't hold), fall
 *     back to those "payable on: …" notes (deduped) so the reader learns which chains the
 *     402 actually accepts.
 */
function mergeDeclineHint(plans: PaymentPlan[]): string | null {
  const actionable = plans
    .filter((p) => p.options.length > 0 && p.fundingHint)
    .map((p) => p.fundingHint as string)
  const chosen = actionable.length ? actionable : plans.map((p) => p.fundingHint).filter(Boolean)
  return chosen.length ? [...new Set(chosen)].join(' · ') : null
}

/** One actionable, human sentence on exactly what to do when no rail is payable —
 *  built from the least-blocked option (the closest to settleable). */
function buildFundingHint(options: PayOption[], chainLabel: string): string | null {
  if (options.length === 0) return null
  const target = [...options].sort((a, b) => a.blockers.length - b.blockers.length)[0]!
  const sym = target.quote.symbol ?? 'the token'
  if (target.blockers.includes('RECIPIENT_NOT_READY')) {
    return `Recipient ${shortAddr(target.accept.payTo)} can't receive on ${chainLabel} yet — ${target.recipient.fix ?? 'recipient not ready'}.`
  }
  if (target.blockers.includes('OUTSIDE_WINDOW')) {
    return target.quote.policyCode === 'SESSION_EXPIRED'
      ? `Session is over on ${chainLabel} — restart the process or extend the TTL; no retry will succeed.`
      : `Budget window exhausted on ${chainLabel} — wait for it to free, or raise policy.windowTotal.`
  }
  if (target.blockers.includes('OUTSIDE_POLICY')) {
    return `Refused by spend policy: ${target.quote.policyReason ?? 'not allowed'}.`
  }
  if (target.state === 'unknown') {
    return `Couldn't fully read your wallet on ${chainLabel} (RPC throttled) — retry; you may already be able to pay ${target.quote.amountFormatted} ${sym}.`
  }
  const parts: string[] = []
  if (target.blockers.includes('INSUFFICIENT_TOKEN') && target.shortfall?.token) {
    parts.push(`top up ${target.shortfall.token} ${sym}`)
  }
  if (target.blockers.includes('INSUFFICIENT_GAS') && target.shortfall?.native) {
    parts.push(`add ~${target.shortfall.native} ${target.cost.feeSymbol} for gas`)
  }
  return parts.length
    ? `Can't settle on ${chainLabel}: ${parts.join(' and ')} (to pay ${target.quote.amountFormatted} ${sym}).`
    : `Can't settle on ${chainLabel} for ${target.quote.amountFormatted} ${sym}.`
}

/**
 * Plan a payment ACROSS several single-chain clients — the cross-chain brain.
 * A {@link PipRailClient} is bound to one chain (its wallet); give this one client
 * per chain the agent funds and it runs each client's {@link PipRailClient.planPayment}
 * in parallel and merges the rails into one plan, ranked payable-first. `best` is a
 * payable rail. Across different native coins there's no oracle to compare gas costs,
 * so it does NOT rank chains by fee against each other: `best` is the FIRST chain you
 * pass in `clients` that can settle (your preference order); within a single chain it
 * still prefers the cheapest-gas rail. Returns `null` only if the URL isn't gated for
 * any client. Throws only if EVERY client fails to reach the resource (a total outage),
 * mirroring a single client — a single chain being down just drops that chain.
 */
export async function planAcross(
  clients: PipRailClient[],
  url: string,
  init?: RequestInit
): Promise<PaymentPlan | null> {
  if (clients.length === 0) return null
  const live = (await planEachClient(clients, url, init)).map((p) => p.plan)
  if (live.length === 0) return null
  // Concatenate options in client order, then partition by state only (NEVER compare
  // gas fees across coins — see rankAcross). `best` = first-listed chain that can settle.
  const options = rankAcross(live)
  const best = options.find((o) => o.state === 'payable') ?? null
  const status: PaymentPlan['status'] = best
    ? 'ready'
    : options.some((o) => o.state === 'unknown')
      ? 'unknown'
      : 'blocked'
  return {
    url,
    network: best?.accept.network ?? live[0]!.network,
    status,
    payable: best !== null,
    best,
    options,
    // Merge EVERY funded chain's blocker into one clear sentence (not just the first) —
    // see mergeDeclineHint. `null` when a rail is payable.
    fundingHint: best ? null : mergeDeclineHint(live),
  }
}

/**
 * PAY across several single-chain clients — the EXECUTION counterpart to
 * {@link planAcross}. Plans the URL on every client in parallel (keeping which
 * client owns which rail), picks the rail `planAcross` names as `best` (the first
 * funded chain you listed that can settle RIGHT NOW), and pays it on its owning
 * client. So an agent that holds one wallet
 * per chain pays whichever chain/token the merchant's 402 asks for — with no
 * manual routing — while every payment still goes through that client's own
 * spend policy, `onBeforePay` hook, retries, and replay-protection (this just
 * calls the chosen client's {@link PipRailClient.fetch}).
 *
 * - A URL that needs no payment (no 402) is returned straight through.
 * - When NO funded chain can settle it, throws {@link PaymentDeclinedError} with a
 *   merged, per-chain funding hint — BEFORE any on-chain send.
 *
 * Selection matches {@link planAcross}: payable-first, and across different native
 * coins (no price oracle) the FIRST chain you pass in `clients` that can settle wins
 * (your preference); within a chain, the cheapest-gas rail. It normally pays the rail
 * `planAcross` reports as `best`, but on a BEST-EFFORT basis — the owning client
 * re-reads its balances/gas at pay time, so a change between planning and paying (a
 * concurrent payment, RPC drift, the merchant returning a different 402) can make it
 * pick another settleable rail ON THE SAME CHAIN, or decline; its spend policy +
 * `onBeforePay` still gate whatever is actually paid. For the ergonomic object form,
 * see {@link MultiChainPayer}.
 *
 * NOTE: this PROBES the URL with the caller's `init` (method + body) on each client to
 * read the 402, so prefer it for GET / idempotent requests — a non-idempotent POST is
 * sent once per client before the pay leg (the x402 gate returns 402 without acting,
 * but the body is re-sent).
 */
export async function fetchAcross(
  clients: PipRailClient[],
  url: string,
  init?: RequestInit
): Promise<Response> {
  if (clients.length === 0) {
    throw new TypeError('fetchAcross needs at least one PipRailClient.')
  }
  // Plan on each client, KEEPING the client↔plan association (planAcross discards it).
  // A read-only / single-chain-down client contributes nothing; a TOTAL outage throws.
  const live = await planEachClient(clients, url, init)
  // Not gated for ANY reachable client ⇒ a free resource: pass it straight through.
  if (live.length === 0) return clients[0]!.fetch(url, init)
  // Merge across chains EXACTLY as planAcross does (state-stable, client order — never a
  // cross-coin fee compare); `best` is reference-identical to a rail in one client's own
  // plan, so it maps straight back to the client that owns it.
  const best = rankAcross(live.map((p) => p.plan)).find((o) => o.state === 'payable')
  if (!best) {
    // Same clear, every-chain decline message planAcross reports — names what's blocking
    // each funded chain (top up X here, add gas there), not just the first.
    const hint = mergeDeclineHint(live.map((p) => p.plan))
    throw new PaymentDeclinedError(hint || 'No funded chain can settle this payment right now.')
  }
  const owner = live.find((p) => p.plan.options.includes(best))!.client
  // Pay on the owning client. `autoRoute` re-selects the cheapest settleable rail on its
  // own chain — normally `best` (it lives on this client) — running the client's full
  // policy / approval / retry / replay path against the rail it actually pays.
  return owner.fetch(url, { ...(init ?? {}), autoRoute: true })
}

/**
 * Does a discovered rail belong to a network the caller wants? Single-sources the
 * every-chain invariant for `discover()`: a rail whose network we CAN resolve to
 * CAIP-2 must satisfy `matches`; a rail we CAN'T resolve (an unknown slug) is
 * KEPT, not silently hidden — the agent re-checks it at quote time. This is why
 * discovery is never empty on a custom or unmapped chain.
 */
function railOnNetwork(rail: DiscoveredRail, matches: (caip2: string) => boolean): boolean {
  const n = normalizeNetwork(rail.network)
  return !n.includes(':') || matches(n)
}

/** Map a typed policy-deny code to the error's typed `reasonCode` — so an agent
 *  branches on a stable enum, never a prose substring. Expiry/window are their own
 *  channels; the lifetime cap is `BUDGET`; everything else is plain `POLICY`. */
function reasonCodeForPolicy(code: PolicyDenyCode | undefined): DeclineReasonCode | undefined {
  switch (code) {
    case 'SESSION_EXPIRED':
      return 'SESSION_EXPIRED'
    case 'WINDOW_TOTAL':
      return 'OUTSIDE_WINDOW'
    case 'MAX_TOTAL':
      return 'BUDGET'
    case undefined:
      return undefined
    default:
      return 'POLICY'
  }
}

/** Hostname of a URL for the policy host-allowlist + ledger — no port, so an
 *  allowlist entry (`api.example.com`, `127.0.0.1`) matches regardless of port.
 *  Tolerant of a non-URL string (returns it unchanged). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function isReplayableBodyInit(value: unknown): value is BodyInit {
  if (typeof value === 'string') return true
  if (value instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(value)) return true
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams)
    return true
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  return false
}

/**
 * Read a server's 402 rejection reason. PipRail's conformant gate re-issues a full
 * v2 PaymentRequired challenge on a rejected proof, stamping the machine-readable
 * `{ code, detail }` under `extensions.piprail` (and a human `error` string). We
 * prefer that; we also accept the legacy `{ status:'invalid', error, detail }` body
 * and any standard 402 with a top-level `error` string. Returns null when the body
 * carries no reason (so the caller keeps the previous one).
 */
async function readInvalidReason(
  response: Response
): Promise<{ error: string; detail: string } | null> {
  try {
    const body = (await response.clone().json()) as Record<string, unknown>
    // Preferred: PipRail's structured reason in extensions.piprail.{code,detail}.
    const ext = body?.extensions as Record<string, unknown> | undefined
    const piprail = ext?.piprail as Record<string, unknown> | undefined
    if (piprail && typeof piprail.code === 'string') {
      return {
        error: piprail.code,
        detail: typeof piprail.detail === 'string' ? piprail.detail : '',
      }
    }
    // Legacy minimal body, or any 402 carrying a top-level `error` string.
    if (body && (body.status === 'invalid' || typeof body.error === 'string')) {
      return {
        error: typeof body.error === 'string' ? body.error : 'no error code',
        detail: typeof body.detail === 'string' ? body.detail : '',
      }
    }
    // A standard (non-PipRail) facilitator's VerifyResponse rejection shape:
    // `{ isValid: false, invalidReason, invalidMessage }` — surfaced on an exact 402.
    if (body && body.isValid === false && typeof body.invalidReason === 'string') {
      return {
        error: body.invalidReason,
        detail: typeof body.invalidMessage === 'string' ? body.invalidMessage : '',
      }
    }
  } catch {
    /* body wasn't JSON in the expected shape — fall back to the header / prior reason */
  }
  // Foreign exact facilitator: the reason rides in the base64 PAYMENT-RESPONSE HEADER
  // ({ success:false, errorReason }), not the body — so it's never "server gave no reason".
  const settle = parseSettleResponse(response)
  if (settle?.errorReason) return { error: settle.errorReason, detail: '' }
  return null
}
