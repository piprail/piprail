import { resolveNetwork, familyForChain } from './drivers/index.js'
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
  buildUptoSignatureHeader,
  parseChallenge,
  parseReceipt,
  parseReceiptExtension,
  parseSettleResponse,
  chainIdFromNetwork,
  type Caip2,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type X402UptoAcceptEntry,
  type X402AnyAccept,
  type X402Challenge,
  type X402PaymentSignature,
  type X402Receipt,
  type PipRailReceipt,
  type VerifyErrorCode,
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
 *  default), the standard x402 `exact` rail (EVM EIP-3009/Permit2 + Solana SVM + Algorand,
 *  opt-in), and the standard x402 `upto` (metered) rail (EVM-Permit2, opt-in). */
export type PaymentScheme = 'onchain-proof' | 'exact' | 'upto'

/** The scheme set when none is configured — `onchain-proof` only, so the zero-config
 *  path is byte-identical to before the `exact` buyer rail existed (defaults never change). */
const DEFAULT_SCHEMES: readonly PaymentScheme[] = ['onchain-proof']
import {
  evaluatePolicy,
  resolveDeadline,
  denomOf,
  scaleToDenom,
  DENOM_PRECISION,
  type PaymentIntent,
  type PaymentPolicy,
  type PolicyDenyCode,
} from './policy.js'
import { SpendLedger, type SpendSummary, type SpendRecord } from './ledger.js'
import type { SpendStore } from './spendstore.js'
import { formatUnits, floorUnits, MAX_DECIMALS } from './util/units.js'

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
  /**
   * The payment settled. `receipt` is PipRail's rich {@link X402Receipt} when the
   * server returns one (its own gate, or a facilitator that echoes the full shape);
   * `settle` is the standard x402 SettleResponse (`{ success, transaction, … }`) on
   * conformant third-party-facilitator interop, where the lean SettleResponse has no
   * rich receipt — read `settle.transaction` for the on-chain settle tx there. (For the
   * spend RECORD + remaining budget after a settle, use the `onSpend` callback or
   * `client.spent()`/`budget()`.)
   */
  | { kind: 'payment-settled'; receipt: X402Receipt | null; settle?: SettleOutcome }
  | {
      kind: 'payment-failed'
      reason: string
      /** A machine-readable failure code when one is known. For a SERVER rejection it's the SAME
       *  code the merchant's `onFailed` hook receives (a canonical {@link VerifyErrorCode} from a
       *  PipRail gate, or a foreign facilitator's reason string); for a pre-send client DECLINE
       *  (policy / budget / approval) it's that decline reason (e.g. `'BUDGET'`, `'APPROVAL'`).
       *  Absent when no structured code was given. */
      code?: string
      /** Human-readable detail, when present (e.g. `"Paid 40000, required 500000."`). */
      detail?: string
    }
  /**
   * The client REFUSED to pay before any on-chain send — the spend policy or an
   * `onBeforePay` hook said no. A dedicated, richer companion to `payment-failed`
   * (which ALSO still fires on a decline, unchanged): `reasonCode` is the typed
   * {@link DeclineReasonCode}, `code` the fine-grained {@link PolicyDenyCode}, `quote`
   * the priced requirement that was refused, and `budget` the spend leash at refusal.
   * Listen for this to distinguish "I hit my cap" from a server-side failure cleanly.
   */
  | {
      kind: 'payment-declined'
      reason: string
      reasonCode?: DeclineReasonCode
      code?: PolicyDenyCode
      quote?: PipRailQuote
      budget: SessionBudget
    }
  /**
   * Cumulative spend crossed `policy.warnAtFraction` (e.g. 0.8 = 80%) of a configured
   * cap, BEFORE any hard decline — the early-warning signal. `scope` says which cap:
   * `'asset'` (per-(network,asset) `maxTotal`), `'denom'` (`maxTotalPerDenom`), `'count'`
   * (`maxPayments`), `'window'` (`windowTotal`), or `'window-count'` (`maxPaymentsPerWindow`).
   * `label` names the specific cap (the symbol/network, the denomination, or the cap name);
   * `fraction` is how far in (≥ warnAtFraction). Fires once per crossing per cap. Purely
   * observational — it never blocks a payment.
   */
  | {
      kind: 'budget-threshold'
      scope: 'asset' | 'denom' | 'count' | 'window' | 'window-count'
      label: string
      spentFormatted: string
      capFormatted: string
      fraction: number
    }

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
  /**
   * The cross-token GRAND TOTAL leash, one row per DENOMINATION the policy caps
   * (`maxTotalPerDenom`). Unlike `byAsset`, these rows are present from the START
   * (before any spend) because the cap is a single declared number — so an agent can
   * preview "how much USD can I still spend, across everything" up front. Empty when
   * no `maxTotalPerDenom` is configured.
   */
  byDenom: DenomRemaining[]
  /**
   * The payment-COUNT leash — settled count so far + the lifetime/window caps and
   * what's left. `lifetimeCap`/`windowCap` are undefined when not configured.
   */
  counts: CountStatus
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

/**
 * The cross-token GRAND-TOTAL leash for one DENOMINATION (e.g. `USD`) — the sum of
 * every stablecoin of that unit across every chain, vs the `maxTotalPerDenom` cap.
 * NOT a price-converted figure: tokens grouped as one unit, each counted 1:1.
 */
export interface DenomRemaining {
  /** The denomination, e.g. `'USD'`. */
  denom: string
  /** Human-readable spend so far in this denomination, e.g. '12.34'. */
  spentFormatted: string
  /** The cap (human units), e.g. '20.00'. */
  capFormatted: string
  /** `max(0, cap − spent)` in human units. */
  remainingFormatted: string
  /** Fraction of the cap used so far (0–1+, clamped ≥ 0). */
  fraction: number
}

/** The payment-COUNT leash — settled count + the configured lifetime/window caps. */
export interface CountStatus {
  /** Settled payments so far (across every chain + token). */
  settled: number
  /** Lifetime cap (`maxPayments`), or undefined when unbounded. */
  lifetimeCap?: number
  /** `max(0, lifetimeCap − settled)`, or undefined when unbounded. */
  lifetimeRemaining?: number
  /** Rolling-window cap (`maxPaymentsPerWindow`), or undefined when unset. */
  windowCap?: number
  /** Payments within the current window, or undefined when no window count cap. */
  windowSettled?: number
  /** `max(0, windowCap − windowSettled)`, or undefined when unset. */
  windowRemaining?: number
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
  /**
   * Durable spend store — make the budget SURVIVE a restart. By default the spend
   * ledger is in-memory and process-scoped (a restart zeroes `maxTotal` /
   * `maxTotalPerDenom` / the count caps, so a crash-loop could re-spend). Pass a
   * {@link SpendStore} and the ledger HYDRATES from it at construction and persists
   * every settled payment, so caps resume where they left off — with NO PipRail
   * backend (you own the store, like the gate's `isUsed`/`markUsed` replay set).
   * One line for local persistence: `spendStore: fileSpendStore('./spend.jsonl')`
   * from `@piprail/sdk/node`. The rolling window + session TTL stay process-scoped.
   */
  spendStore?: SpendStore
  /**
   * Advanced: share ONE {@link SpendLedger} across several single-chain clients so the
   * cross-token grand total (`maxTotalPerDenom`) and the payment-count caps span ALL of
   * them. `MultiChainPayer.fromWallets` sets this for you; reach for it directly only when
   * composing clients by hand. Mutually exclusive with `spendStore` (the shared ledger
   * owns the store) — passing both throws. Pass at most one client per (network, asset)
   * into a shared ledger or `spent()` double-counts.
   */
  ledger?: SpendLedger
  /**
   * Fire-and-forget callback after EACH settled payment — the one-liner for "append my
   * spend to a local log / push it somewhere". Receives the {@link SpendRecord} just
   * written and the spend leash AFTER it. Isolated like `onEvent`: a throw is swallowed
   * and can never abort a payment. (Same data also rides the `payment-settled` event.)
   */
  onSpend?: (record: SpendRecord, budget: SessionBudget) => void
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
  /** The CONFIGURED spend policy, read back (so an agent can self-check its whole leash
   *  without hitting a decline). `undefined` when no policy is set. */
  policy(): PaymentPolicy | undefined
}

/**
 * The verdict from {@link PipRailClient.verifyReceipt} — a {@link PipRailReceipt}
 * re-verified against the chain, never trusting the receipt's claims. `ok` is the
 * chain's confirmation that the settlement is real (≥`amount` of `asset` moved to
 * `payTo`); `onChain` is RE-DERIVED from the tx (`payer` genuinely so; `amount` is a
 * VERIFIED LOWER BOUND — drivers threshold-check `paid >= required` then echo the
 * accept amount); `matchesClaims` is whether the re-derived `payer` equals the
 * receipt's claimed `payer` (a forged payer → `false` even when `ok` is `true`).
 *
 * Re-verification is **durable** for digest-bound (Template-B) families (EVM, Solana,
 * Tron, Sui, Aptos, native coins — the driver reads the tx by hash/digest) and
 * **recency-bounded / best-effort** for the account-watch families (Stellar, XRPL,
 * Algorand, TON), whose drivers scan only recent merchant-account history — an old
 * receipt there can return `transfer_not_found` even though it once settled.
 */
export interface ReceiptVerification {
  /** The chain confirms the settlement (≥`amount` moved to `payTo`). */
  ok: boolean
  /** Fields RE-DERIVED from the on-chain tx. `payer` is genuinely re-derived; `amount`
   *  is a verified LOWER BOUND (the chain confirms at least this much moved). */
  onChain: { payTo: string; asset: string; amount: string; payer: string }
  /** Does the re-derived on-chain `payer` match the receipt's claimed `payer`? */
  matchesClaims: boolean
  /** Informational age of the receipt (seconds since `verifiedAt`); NOT a validity gate. */
  ageSeconds: number
  /** The closed verification code when `ok` is false (reuses the driver vocabulary). */
  error?: VerifyErrorCode
}

/** The synthetic-accept window for {@link PipRailClient.verifyReceipt}: a large but
 *  FINITE sentinel so a driver's `payment_expired` branch can't fire on a legitimately
 *  old receipt (age is reported via `ageSeconds`, never a validity gate for Template-B).
 *  Finite (not `Infinity`) so a driver's `Number`/`BigInt` math stays well-defined. */
const RECEIPT_VERIFY_WINDOW_SECONDS = 100 * 365 * 24 * 60 * 60 // ~100 years

export class PipRailClient {
  private readonly opts: PipRailClientOptions
  private readonly maxRetries: number
  private readonly retryTimeoutMs: number
  private readonly onEvent: (event: PipRailEvent) => void

  // Per-asset (+ per-denomination + count) tally of everything this client has paid —
  // powers spent()/budget() and the maxTotal/maxTotalPerDenom/maxPayments caps. Either
  // its own (optionally store-backed) ledger, or a SHARED one injected so the grand
  // total + count caps span several chains (MultiChainPayer.fromWallets).
  private readonly ledger: SpendLedger

  // `warnAtFraction` threshold dedup lives on the LEDGER (`ledger.markWarned`), so clients
  // sharing one ledger (a cross-chain MultiChainPayer) fire each threshold once for the whole
  // shared budget — not once per chain.

  // Resolved lazily on first request — this is what lets Solana (and future
  // families) auto-mount with no setup call.
  private bound?: Promise<{ net: ResolvedNetwork; wallet: WalletHandle | undefined }>

  // The verifiable receipt from the most recent settled fetch (null if the server emitted
  // none). Captured pure (no chain read) and surfaced via lastReceipt(); the resource URL is
  // stamped from the URL this client actually fetched (authoritative over the gate's default).
  private lastReceiptValue: PipRailReceipt | null = null

  constructor(opts: PipRailClientOptions) {
    this.opts = opts
    this.maxRetries = Math.max(1, opts.maxPaymentRetries ?? 3)
    this.retryTimeoutMs = opts.retryTimeoutMs ?? 30_000
    this.onEvent = opts.onEvent ?? (() => undefined)
    if (opts.ledger && opts.spendStore) {
      throw new TypeError(
        'Pass either `ledger` (a shared SpendLedger) or `spendStore`, not both — a shared ' +
          'ledger already owns its store.'
      )
    }
    // A shared ledger (cross-chain grand total) wins; else build our own, hydrating from
    // the durable store when one is supplied (so caps survive a restart).
    this.ledger = opts.ledger ?? new SpendLedger(opts.spendStore)
    this.assertPolicyAmountCaps(opts.policy)
    this.assertPolicyTimeOptions(opts.policy)
    this.assertPolicySpendControls(opts.policy)
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
    // Each grand-total cap must be a non-negative decimal string too. The container must be
    // a PLAIN object — an array or a Map/Set is `typeof 'object'` but its entries would be
    // silently lost (Object.entries(map) === []), disarming the cap without a peep.
    if (policy.maxTotalPerDenom !== undefined) {
      const m = policy.maxTotalPerDenom as unknown
      const proto = m && typeof m === 'object' ? Object.getPrototypeOf(m) : false
      if (!m || typeof m !== 'object' || Array.isArray(m) || (proto !== Object.prototype && proto !== null)) {
        throw new TypeError(
          `policy.maxTotalPerDenom must be a plain { DENOM: amount } object (e.g. { USD: '20.00' }); ` +
            `got ${JSON.stringify(policy.maxTotalPerDenom)}.`
        )
      }
      for (const [denom, v] of Object.entries(policy.maxTotalPerDenom)) {
        if (denom.trim() === '') {
          throw new TypeError('policy.maxTotalPerDenom has a blank denomination key.')
        }
        if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) {
          throw new TypeError(
            `policy.maxTotalPerDenom.${denom} must be a non-negative decimal string (e.g. '20.00'); ` +
              `got ${JSON.stringify(v)}.`
          )
        }
      }
    }
    // `denomFor` values must be strings — a non-string would throw `.toUpperCase()` out of
    // denomOf at PAY time (after the payment settled), so reject it loudly at construction.
    if (policy.denomFor !== undefined) {
      const m = policy.denomFor as unknown
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        throw new TypeError(`policy.denomFor must be a { token: DENOM } object; got ${JSON.stringify(m)}.`)
      }
      for (const [k, v] of Object.entries(policy.denomFor)) {
        if (typeof v !== 'string' || v.trim() === '') {
          throw new TypeError(`policy.denomFor.${k} must be a non-empty denomination string; got ${JSON.stringify(v)}.`)
        }
      }
    }
  }

  /**
   * Fail LOUDLY at construction on a misconfigured count / threshold control (a
   * programmer error → `TypeError`): payment counts must be positive safe integers,
   * `maxPaymentsPerWindow` needs `windowSeconds` (it shares the window), and
   * `warnAtFraction` must be in (0, 1].
   */
  private assertPolicySpendControls(policy: PaymentPolicy | undefined): void {
    if (!policy) return
    for (const field of ['maxPayments', 'maxPaymentsPerWindow'] as const) {
      const v = policy[field]
      if (v === undefined) continue
      if (!Number.isSafeInteger(v) || v <= 0) {
        throw new TypeError(`policy.${field} must be a positive integer; got ${JSON.stringify(v)}.`)
      }
    }
    if (policy.maxPaymentsPerWindow !== undefined && policy.windowSeconds === undefined) {
      throw new TypeError(
        'policy.maxPaymentsPerWindow needs policy.windowSeconds (the rolling window it counts ' +
          'within) — set both, or neither.'
      )
    }
    if (policy.warnAtFraction !== undefined) {
      const f = policy.warnAtFraction
      if (typeof f !== 'number' || !(f > 0 && f <= 1)) {
        throw new TypeError(
          `policy.warnAtFraction must be a number in (0, 1] (e.g. 0.8); got ${JSON.stringify(f)}.`
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
    const hasWindowCount = policy.maxPaymentsPerWindow !== undefined
    // `windowSeconds` is the shared width for BOTH the rolling money cap (`windowTotal`)
    // and the rolling count cap (`maxPaymentsPerWindow`). A money window needs the width;
    // a width alone (bounding neither) is a half-armed leash.
    if (hasWindowTotal && !hasWindowSeconds) {
      throw new TypeError(
        'policy.windowTotal and policy.windowSeconds must be set together — a rolling-window ' +
          'cap can\'t be half-armed (set both, or neither).'
      )
    }
    if (hasWindowSeconds && !hasWindowTotal && !hasWindowCount) {
      throw new TypeError(
        'policy.windowSeconds must be set together with policy.windowTotal and/or ' +
          'policy.maxPaymentsPerWindow — a window width alone bounds nothing.'
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
    // `expiresAt` is an absolute epoch-ms deadline. A NaN / non-finite / non-integer / string
    // value would silently DISARM the time leash (`now >= NaN` is always false) AND, via
    // `Math.min(ttlDeadline, NaN) === NaN`, destroy a co-set `ttlSeconds`; a value outside the
    // representable Date range would also throw `new Date(...).toISOString()` out of the
    // never-throw budget() read. Require a safe-integer epoch-ms a Date can represent (±8.64e15).
    if (policy.expiresAt !== undefined) {
      const at = policy.expiresAt
      if (!Number.isSafeInteger(at) || Math.abs(at) > 8.64e15) {
        throw new TypeError(
          `policy.expiresAt must be an absolute epoch-MILLISECONDS integer (like Date.now()); ` +
            `got ${JSON.stringify(at)}.`
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

  /**
   * Capture the verifiable receipt from a settled response (pure — no chain read), stamping
   * the resource URL this client actually fetched (authoritative over the gate's default ''). A
   * settled fetch with no receipt extension sets it to `null` so {@link lastReceipt} reflects the
   * latest fetch. Never throws — a malformed header just yields `null`.
   */
  private captureReceipt(response: Response, url: string): void {
    try {
      const parsed = parseReceiptExtension(response)
      this.lastReceiptValue = parsed ? { ...parsed, resource: { url } } : null
    } catch {
      this.lastReceiptValue = null
    }
  }

  /**
   * The verifiable {@link PipRailReceipt} from the most recent settled `fetch` — the
   * self-contained record the buyer KEEPS and anyone re-verifies against the chain
   * (see {@link PipRailClient.verifyReceipt}). `null` when the last settled fetch carried
   * no receipt (the gate's `receipts` option was off) or no payment has settled yet. Pure.
   */
  lastReceipt(): PipRailReceipt | null {
    return this.lastReceiptValue
  }

  /**
   * Re-verify ANY {@link PipRailReceipt} against the chain — the anyone-can-run primitive.
   * Re-reads `receipt.transaction` via the receipt's own network driver and re-derives
   * `payTo`/`asset`/`payer` from the tx, **never trusting the receipt's claims**: a forged
   * `payTo`/`asset`/over-stated `amount` makes the driver's `verify()` fail (`ok:false`); a
   * forged `payer` surfaces as `matchesClaims:false`. Static + WALLET-FREE — a third party
   * verifies with only a chain + RPC, no PipRail account. **Never throws** (an RPC error or a
   * malformed receipt → `{ ok:false, error }`). Viem-free here — the chain read happens inside
   * the lazily-mounted family driver (the protocol layer pulls no chain libs). Durable for
   * digest-bound families; recency-bounded for the account-watch families (see
   * {@link ReceiptVerification}).
   */
  static async verifyReceipt(
    receipt: PipRailReceipt,
    opts?: { rpcUrl?: string }
  ): Promise<ReceiptVerification> {
    // Guard the bundle shape BEFORE any deref — a malformed/foreign receipt must yield a
    // structured verdict, never throw (the never-throw contract; ERRORS.md read-method rule).
    const r = receipt?.receipt as X402Receipt | undefined
    if (!r || typeof r !== 'object') {
      return { ok: false, onChain: { payTo: '', asset: '', amount: '', payer: '' }, matchesClaims: false, ageSeconds: 0, error: 'tx_not_found' }
    }
    const claimed = { payTo: r.payTo ?? '', asset: r.asset ?? '', amount: r.amount ?? '', payer: r.payer ?? '' }
    const ageSeconds = receiptAgeSeconds(r.verifiedAt)
    try {
      const chain = chainSelectorForNetwork(r.network, opts?.rpcUrl)
      const net = await resolveNetwork({
        chain,
        ...(opts?.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
      })
      // A SYNTHETIC trusted accept rebuilt from the receipt's claims — `verify()` re-derives
      // every field from the chain and checks the tx paid AT LEAST this amount to this payTo.
      const accept: X402AcceptEntry = {
        scheme: 'onchain-proof',
        network: r.network,
        amount: r.amount,
        asset: r.asset,
        payTo: r.payTo,
        maxTimeoutSeconds: RECEIPT_VERIFY_WINDOW_SECONDS,
        extra: {
          nonce: r.nonce ?? '', // the challenge/memo nonce — REQUIRED for Template-A re-verify
          decimals: receipt.decimals ?? 6, // B10c — Stellar/XRPL/TON re-scale by it; 6 = USDC fallback
          minConfirmations: 0,
          amountFormatted: '',
        },
      }
      // B10b — NEAR's verify() decodes `<senderId>:<hash>`; a bare hash → senderId='' → spurious
      // miss. Reconstruct the composite ref from the receipt's payer (the NEAR account) + tx hash.
      const ref =
        familyForChain(chain) === 'near' ? `${r.payer}:${r.transaction}` : r.transaction
      const result = await net.verify(ref, accept)
      if (!result.ok) {
        return { ok: false, onChain: claimed, matchesClaims: false, ageSeconds, error: result.error }
      }
      const oc = result.receipt
      const onChain = { payTo: oc.payTo, asset: oc.asset, amount: oc.amount, payer: oc.payer }
      // `payer` is the one field genuinely re-derived from the tx (the rest are pinned by the
      // synthetic accept the chain already validated against). A forged claimed payer → false.
      const matchesClaims = sameAddress(oc.payer, r.payer)
      return { ok: true, onChain, matchesClaims, ageSeconds }
    } catch {
      // An unknown network, unmounted driver, or RPC failure — never throw (ERRORS.md).
      return { ok: false, onChain: claimed, matchesClaims: false, ageSeconds, error: 'tx_not_found' }
    }
  }

  /**
   * Verify the OPTIONAL Tier-2 service-delivery attestation on a {@link PipRailReceipt}
   * — the merchant's signed proof that the resource was actually SERVED (the one thing
   * the chain can't attest). For an EVM EIP-712 attestation this re-recovers the signer
   * from the signature over the official `offer-receipt` typed data and checks
   * `recover === receipt.payTo` (spec §4.5.1 / §5.5) — the classic EIP-712 footgun made
   * safe (`recoverTypedDataAddress` returns a WRONG address rather than throwing on a bad
   * signature, so the equality check is the real verification). A tampered signature →
   * `{ ok:false }`, never a throw.
   *
   * Static + wallet-free. **Never throws** (a malformed/absent attestation, an unsupported
   * format, or a recovery fault → `{ ok:false, reason }`). Viem-free HERE — the recover runs
   * inside the lazily-imported EVM receipt driver (a lazy chunk), so the protocol layer pulls
   * no chain libs. The JWS format defers to R3 (`{ ok:false, reason:'jws-not-loaded' }`).
   */
  static async verifyAttestation(
    receipt: PipRailReceipt
  ): Promise<{ ok: boolean; signer?: string; reason?: string }> {
    const att = receipt?.attestation
    if (!att || typeof att !== 'object' || typeof att.signature !== 'string') {
      return { ok: false, reason: 'no-attestation' }
    }
    // R3: a JWS attestation needs `jose`/DID resolution behind the lazy `receipts-jws`
    // subpath — not loaded in the base bundle. Defer rather than throw.
    if ((att as { format?: unknown }).format === 'jws') {
      return { ok: false, reason: 'jws-not-loaded' }
    }
    const r = receipt.receipt as X402Receipt | undefined
    if (!r || typeof r !== 'object') return { ok: false, reason: 'no-receipt' }
    // Per §5.5: verify over the payload EXACTLY as transmitted. Prefer the attestation's
    // own signed `payload`; fall back to the receipt's fields for a payload-less attestation.
    const payload = (att as { payload?: Record<string, unknown> }).payload ?? {}
    const network = typeof payload.network === 'string' ? payload.network : r.network
    const resourceUrl =
      typeof payload.resourceUrl === 'string' ? payload.resourceUrl : receipt.resource?.url ?? ''
    const payer = typeof payload.payer === 'string' ? payload.payer : r.payer
    const issuedAt =
      typeof payload.issuedAt === 'number' ? payload.issuedAt : receiptIssuedAtSeconds(r.verifiedAt)
    const transaction =
      typeof payload.transaction === 'string' ? payload.transaction : r.transaction ?? ''
    try {
      // Lazy chunk: viem-based recovery lives ONLY in the EVM receipt driver. A dynamic
      // import keeps the protocol layer viem-free + the lazy-chunk grep green.
      const { verifyReceiptAttestationEvm } = await import('./drivers/evm/receipt.js')
      return await verifyReceiptAttestationEvm({
        payTo: r.payTo,
        network,
        resourceUrl,
        payer,
        issuedAt,
        transaction,
        signature: att.signature,
      })
    } catch {
      return { ok: false, reason: 'verify-failed' }
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
    try {
      const { net, accept, quote } = await this.resolveChallenge(url, res, this.resolveSchemes())
      const cost = await net.estimateCost(accept)
      return { quote, cost }
    } catch (err) {
      // A parseable-but-malformed rail (buildQuote → InvalidEnvelopeError on a bad amount/asset/
      // decimals), or an unparseable challenge, leaves nothing to estimate — return null rather than
      // throw out of a read method. (UnsupportedScheme/NoCompatibleAccept stay the resolveChallenge
      // contract — "this client can't pay this scheme" is a real signal, not a cost-read failure.)
      if (err instanceof InvalidEnvelopeError) return null
      throw err
    }
  }

  /** Aggregated snapshot of every payment this client has settled — total
   *  count, cumulative spend per token, cumulative spend per denomination (the
   *  cross-token grand total), and the individual records. */
  spent(): SpendSummary {
    return this.ledger.summary()
  }

  /** The CONFIGURED spend policy, read back unchanged — so an agent can self-check
   *  its WHOLE leash (caps, allowlists, time, denom + count limits) without hitting a
   *  decline. `undefined` when no policy is set. Pure; never throws. */
  policy(): PaymentPolicy | undefined {
    return this.opts.policy
  }

  /**
   * Read-only budget + time leash for a Mode-A (headless) agent — the policy IS
   * the consent, and this is how the agent SEES what's left of it before paying.
   * Composes the ledger with the configured policy: the per-asset money leash
   * (`byAsset`), the cross-token GRAND TOTAL per denomination (`byDenom`, present
   * from the start), and the payment-COUNT leash (`counts`). Never throws, moves no
   * funds. The money/count figures persist if a `spendStore` is set; the time
   * envelope is process-scoped (see {@link SessionBudget}).
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
      byDenom: this.denomRemaining(),
      counts: this.countStatus(),
    }
  }

  /**
   * The cross-token GRAND-TOTAL leash — one row per denomination capped by
   * `policy.maxTotalPerDenom`. Unlike `remaining()`, rows exist from the START
   * (the cap is a single declared number, so headroom is previewable before any
   * spend). `[]` when no `maxTotalPerDenom` is set. Pure; never throws; never a
   * price-converted figure (tokens grouped as one unit, each 1:1).
   */
  denomRemaining(): DenomRemaining[] {
    const caps = this.opts.policy?.maxTotalPerDenom
    if (!caps) return []
    return Object.entries(caps).map(([rawDenom, capStr]) => {
      const denom = rawDenom.toUpperCase()
      const spentScaled = this.ledger.totalForDenom(denom)
      const capScaled = floorUnits(capStr, DENOM_PRECISION)
      const remainingScaled = capScaled > spentScaled ? capScaled - spentScaled : 0n
      const fraction =
        capScaled === 0n
          ? spentScaled > 0n
            ? 1
            : 0
          : Number((spentScaled * 1_000_000n) / capScaled) / 1_000_000
      return {
        denom,
        spentFormatted: formatUnits(spentScaled, DENOM_PRECISION),
        capFormatted: formatUnits(capScaled, DENOM_PRECISION),
        remainingFormatted: formatUnits(remainingScaled, DENOM_PRECISION),
        fraction,
      }
    })
  }

  /** The payment-COUNT leash — settled count so far + the configured lifetime/window
   *  caps and what's left. Pure; never throws. */
  countStatus(): CountStatus {
    const policy = this.opts.policy
    const settled = this.ledger.count()
    const out: CountStatus = { settled }
    if (policy?.maxPayments !== undefined) {
      out.lifetimeCap = policy.maxPayments
      out.lifetimeRemaining = Math.max(0, policy.maxPayments - settled)
    }
    if (policy?.maxPaymentsPerWindow !== undefined && policy.windowSeconds !== undefined) {
      const windowSettled = this.ledger.countSince(Date.now() - policy.windowSeconds * 1000)
      out.windowCap = policy.maxPaymentsPerWindow
      out.windowSettled = windowSettled
      out.windowRemaining = Math.max(0, policy.maxPaymentsPerWindow - windowSettled)
    }
    return out
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
        const reason = plan.fundingHint ?? 'No rail is settleable for this payment.'
        // autoRoute refused before any send — surface it on the event stream too, not only the throw.
        this.safeEmit({ kind: 'payment-failed', reason })
        throw new PaymentDeclinedError(reason)
      }
      accept = plan.best.accept
      quote = plan.best.quote
    }

    this.safeEmit({ kind: 'payment-required', challenge, accept })

    // Budget + approval gate — both refuse BEFORE any on-chain send OR any signature.
    await this.authorize(quote)

    // Standard `upto` (metered) rail: route BEFORE exact (AUDIT B9 — the compiler can't catch an
    // unhandled upto case in if/else form, so an unrouted upto accept would otherwise reach the
    // onchain-proof fall-through below and be mis-paid). The buyer SIGNS a Permit2 authorization
    // for the MAX; the server settles the ACTUAL after serving.
    if (accept.scheme === 'upto') {
      return this.payUptoRail(net, wallet, accept, url, init, quote)
    }

    // Standard `exact` rail: a separate, conservative pay path — the buyer SIGNS an
    // EIP-3009 authorization and the server/facilitator broadcasts it (never payAndConfirm).
    if (accept.scheme === 'exact') {
      return this.payExactRail(net, wallet, accept, url, init, quote)
    }

    // PipRail's native `onchain-proof` rail — BYTE-IDENTICAL to before. AUDIT B9: ASSERT the
    // fall-through is genuinely onchain-proof so a stray scheme can't be paid as onchain-proof.
    if (accept.scheme !== 'onchain-proof') {
      throw new UnsupportedSchemeError(
        `internal: unrouted accept scheme '${(accept as { scheme: string }).scheme}' reached the onchain-proof pay path.`
      )
    }
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
    // Standard `upto` (metered) rails — opt-in (OFF by default), gathered only when the bound
    // driver can pay them (the EVM-only `payUpto` SPI), supports the network, recognises the
    // token (true decimals power the MAX-budget cap), and the rail carries a facilitatorAddress
    // to bind. Same shape as the exact gather; the buyer budgets the MAX (§3.5).
    if (schemes.includes('upto')) {
      out.push(
        ...challenge.accepts.filter(
          (a): a is X402UptoAcceptEntry =>
            a.scheme === 'upto' &&
            this.supportsNetwork(net, a.network) &&
            typeof net.payUpto === 'function' &&
            net.describeAsset(a.asset) != null &&
            typeof a.extra?.facilitatorAddress === 'string' &&
            a.extra.facilitatorAddress.length > 0 &&
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
    // (analyzeRail catches its own reads → 'unknown'). A rail whose accept is PARSEABLE-but-malformed
    // (bad amount/asset/decimals → buildQuote throws) is DROPPED here rather than thrown — planPayment/
    // canAfford must NEVER throw on a hostile/buggy merchant's 402 (ERRORS.md read-method contract; the
    // only sanctioned throw is on an UNPARSEABLE challenge). A dropped rail simply isn't a payable option.
    const analysed = (
      await Promise.all(
        candidates.map((accept) =>
          this.analyzeRail(net, wallet, accept, url, challenge.resource.description).catch(() => null)
        )
      )
    ).filter((o): o is PayOption => o !== null)
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
    // A standard `exact` OR `upto` rail: the buyer SIGNS an authorization and the
    // server/facilitator BROADCASTS it, so the buyer spends ~0 gas — only the token
    // funds it, and native-coin gas is irrelevant to payability. For `upto`, `amount`
    // is the MAX (the budget/affordability ceiling — the server MAY charge up to it).
    const isExact = accept.scheme === 'exact' || accept.scheme === 'upto'
    const isNative = accept.asset === 'native'
    const blockers: PayBlocker[] = []
    const warnings: PayWarning[] = []
    const shortfall: { token?: string; native?: string } = {}

    if (!quote.withinPolicy) {
      // Route the time-envelope denials to their own blocker (the typed code + the
      // `session` block tell "wait for the window to slide" from "session is over").
      blockers.push(
        quote.policyCode === 'SESSION_EXPIRED' ||
          quote.policyCode === 'WINDOW_TOTAL' ||
          quote.policyCode === 'WINDOW_COUNT'
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
    // Upper bound: a hostile/buggy 402 could state an absurd `decimals` (e.g. 1e9) for an
    // unrecognised token; pricing it would make floorUnits/formatUnits allocate a multi-GB
    // string (an OOM-DoS). Reject it as a malformed envelope before any amount math runs.
    if (decimals > MAX_DECIMALS) {
      throw new InvalidEnvelopeError(
        `challenge for ${accept.asset} on ${accept.network} states ${decimals} decimals ` +
          `(> ${MAX_DECIMALS}) — refusing to price it (no real token is that deep).`
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
    // Build the policy context ONLY when a cap that needs running totals is configured —
    // otherwise pass `undefined` so the zero-config path runs no clock and no ledger scan
    // (byte-identical to before). ONE `Date.now()` per quote feeds the expiry check, the
    // rolling-window edge, AND the window count edge (same instant for one decision).
    const policy = this.opts.policy
    const hasWindow = !!policy && policy.windowTotal != null && policy.windowSeconds != null
    const hasWindowCount =
      !!policy && policy.maxPaymentsPerWindow != null && policy.windowSeconds != null
    const hasDenomCap =
      !!policy && policy.maxTotalPerDenom != null && Object.keys(policy.maxTotalPerDenom).length > 0
    const hasCountCap = !!policy && policy.maxPayments != null
    const hasTimePolicy =
      !!policy && (policy.ttlSeconds != null || policy.expiresAt != null || hasWindow)
    const needsCtx = hasTimePolicy || hasWindowCount || hasDenomCap || hasCountCap
    // The intent's denomination (USD/EUR/…) for the cross-token grand total — pure, no oracle.
    const denom = hasDenomCap ? denomOf(intent.symbol, intent.asset, policy) : undefined
    const now = Date.now()
    const ctx = needsCtx
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
          // Running grand total on this intent's denomination, across the (shared) ledger.
          spentInDenomScaled: denom ? this.ledger.totalForDenom(denom) : 0n,
          // Settled-payment counts (lifetime + window) for the count caps.
          paymentCount: hasCountCap ? this.ledger.count() : 0,
          paymentCountInWindow: hasWindowCount
            ? this.ledger.countSince(now - policy!.windowSeconds! * 1000)
            : 0,
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
      const reason = `Payment refused by policy: ${quote.policyReason ?? 'not allowed'}`
      this.refuse(reason, {
        reasonCode: reasonCodeForPolicy(quote.policyCode),
        policyCode: quote.policyCode,
        quote,
      })
    }
    const hook = this.opts.onBeforePay
    if (!hook) return
    let approved: boolean
    try {
      approved = await hook(quote)
    } catch (err) {
      // A throwing decision hook means "do not pay" — fail safe, never pay.
      this.refuse('onBeforePay threw — refusing to pay.', { reasonCode: 'APPROVAL', quote, cause: err })
    }
    if (!approved) {
      const reason =
        `onBeforePay declined ${quote.amountFormatted} ${quote.symbol ?? ''}`.trimEnd() +
        ` on ${quote.network}.`
      this.refuse(reason, { reasonCode: 'APPROVAL', quote })
    }
  }

  /**
   * Refuse a payment BEFORE any send: emit BOTH the legacy `payment-failed` (so existing
   * `onEvent` consumers are unaffected) AND the richer, dedicated `payment-declined`
   * (typed reasonCode + fine PolicyDenyCode + the quote + a budget snapshot), then throw
   * the typed {@link PaymentDeclinedError}. Returns `never` so callers' control flow is
   * exhaustive.
   */
  private refuse(
    reason: string,
    opts: {
      reasonCode?: DeclineReasonCode
      policyCode?: PolicyDenyCode
      quote?: PipRailQuote
      cause?: unknown
    }
  ): never {
    this.safeEmit({ kind: 'payment-failed', reason, ...(opts.reasonCode ? { code: opts.reasonCode } : {}) })
    this.safeEmit({
      kind: 'payment-declined',
      reason,
      ...(opts.reasonCode ? { reasonCode: opts.reasonCode } : {}),
      ...(opts.policyCode ? { code: opts.policyCode } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
      budget: this.budget(),
    })
    throw new PaymentDeclinedError(reason, {
      ...(opts.reasonCode ? { reasonCode: opts.reasonCode } : {}),
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    })
  }

  /** Record a settled payment in the ledger (TRUE decimals for the running total + the
   *  denomination it counts toward in the grand total). Then fire the `onSpend` callback
   *  with the record + the post-payment budget, and emit any `warnAtFraction` thresholds
   *  this payment just crossed. All observability is isolated — a throwing hook never
   *  affects the (already-settled) payment.
   *
   *  `settledAmountBase` is the SINGLE upto ledger-reconciliation seam: the quote (and thus
   *  the policy/budget) gates on the MAX, and for the metered `upto` rail the budgeted amount
   *  RECORDED is ALSO the authorized MAX — the only buyer-provable bound. The merchant's
   *  claimed actual is UNTRUSTED (a malicious merchant can settle the MAX on-chain yet report
   *  a tiny `SettleOutcome.amount`); recording it would let an under-report silently loosen a
   *  cumulative cap (`maxTotal`/`maxTotalPerDenom`/`windowTotal`) past the buyer's real on-chain
   *  spend (POL-1). So the cap-bearing `amountBase` is the MAX; the clamped actual is surfaced
   *  separately on `settledBase`/`settledFormatted` for transparency (it equals the receipt's
   *  amount). When absent (onchain-proof/exact) this is byte-identical to before. */
  private recordSpend(quote: PipRailQuote, ref: string, settledAmountBase?: string): void {
    const denom = denomOf(quote.symbol, quote.asset, this.opts.policy)
    // The budget always debits the authorized MAX (quote.amount) — for upto that keeps the
    // cumulative caps merchant-proof; for onchain-proof/exact the MAX *is* the paid amount.
    const amountBase = quote.amount
    const amountFormatted = quote.amountFormatted
    // METERED upto: also surface the merchant-claimed settled ACTUAL, clamped to ≤ the MAX so a
    // hostile/non-conformant server cannot inflate even the informational figure. Display-only.
    let settledBase: string | undefined
    let settledFormatted: string | undefined
    if (settledAmountBase !== undefined && /^\d+$/.test(settledAmountBase)) {
      try {
        const claimed = BigInt(settledAmountBase)
        const max = BigInt(quote.amount)
        const shown = claimed < max ? claimed : max
        settledBase = shown.toString()
        settledFormatted = formatUnits(shown, quote.decimals)
      } catch {
        /* a parse miss simply omits the informational actual — the MAX is still budgeted */
      }
    }
    const record: SpendRecord = {
      url: quote.url,
      host: hostOf(quote.url),
      network: quote.network,
      asset: quote.asset,
      amountBase,
      amountFormatted,
      ...(settledBase !== undefined ? { settledBase, settledFormatted } : {}),
      ...(quote.symbol ? { symbol: quote.symbol } : {}),
      decimals: quote.decimals,
      ...(denom ? { denom } : {}),
      ref,
      at: new Date().toISOString(),
    }
    this.ledger.record(record, quote.decimals, denom)
    const budget = this.budget()
    if (this.opts.onSpend) {
      try {
        this.opts.onSpend(record, budget)
      } catch {
        /* a spend hook must never affect an already-settled payment */
      }
    }
    this.emitThresholds(budget)
  }

  /**
   * Emit a `budget-threshold` event for each cap whose used-fraction just reached
   * `policy.warnAtFraction` — the early warning before a hard decline. Fires ONCE per
   * crossing per cap (deduped on the shared ledger via `markWarned`, so a cross-chain
   * threshold fires once for the whole budget, not once per chain). No-op when no
   * `warnAtFraction` is set. Reads the just-computed {@link SessionBudget}; isolated (safeEmit).
   */
  private emitThresholds(budget: SessionBudget): void {
    const frac = this.opts.policy?.warnAtFraction
    if (frac === undefined) return
    const fire = (
      scope: 'asset' | 'denom' | 'count' | 'window' | 'window-count',
      label: string,
      spentFormatted: string,
      capFormatted: string,
      fraction: number
    ): void => {
      if (fraction < frac) return
      // Dedup on the (possibly shared) ledger so clients on one cross-chain budget warn once.
      if (!this.ledger.markWarned(`${scope}:${label}`)) return
      this.safeEmit({ kind: 'budget-threshold', scope, label, spentFormatted, capFormatted, fraction })
    }
    // Per-(network, asset) maxTotal
    for (const r of budget.byAsset) {
      if (r.capBase === undefined) continue
      const cap = BigInt(r.capBase)
      const spent = BigInt(r.spentBase)
      const fraction = cap === 0n ? (spent > 0n ? 1 : 0) : Number((spent * 1_000_000n) / cap) / 1_000_000
      fire(
        'asset',
        `${r.symbol ?? r.asset} on ${r.network}`,
        formatUnits(spent, r.decimals),
        formatUnits(cap, r.decimals),
        fraction
      )
    }
    // Cross-token grand total per denomination
    for (const d of budget.byDenom) {
      fire('denom', d.denom, d.spentFormatted, d.capFormatted, d.fraction)
    }
    // Rolling-window money cap (per spent (network, asset) — uses the live window slice).
    const policy = this.opts.policy
    if (policy?.windowTotal !== undefined && policy.windowSeconds !== undefined) {
      const since = Date.now() - policy.windowSeconds * 1000
      for (const r of budget.byAsset) {
        const cap = floorUnits(policy.windowTotal, r.decimals)
        const spent = this.ledger.totalSince(r.network, r.asset, since)
        const fraction =
          cap === 0n ? (spent > 0n ? 1 : 0) : Number((spent * 1_000_000n) / cap) / 1_000_000
        fire(
          'window',
          `${r.symbol ?? r.asset} on ${r.network}`,
          formatUnits(spent, r.decimals),
          formatUnits(cap, r.decimals),
          fraction
        )
      }
    }
    // Lifetime payment count
    const c = budget.counts
    if (c.lifetimeCap !== undefined && c.lifetimeCap > 0) {
      fire('count', 'maxPayments', String(c.settled), String(c.lifetimeCap), c.settled / c.lifetimeCap)
    }
    if (c.windowCap !== undefined && c.windowCap > 0 && c.windowSettled !== undefined) {
      fire(
        'window-count',
        'maxPaymentsPerWindow',
        String(c.windowSettled),
        String(c.windowCap),
        c.windowSettled / c.windowCap
      )
    }
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
        this.captureReceipt(lastResponse, url)
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
      ...(lastReason ? { code: lastReason.error, detail: lastReason.detail } : {}),
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
      // `why` is the facilitator's structured errorReason — surface it as the event `code` too, so the
      // buyer learns the reason on the exact rail's most common failure (parity with the merchant).
      this.safeEmit({ kind: 'payment-failed', reason: `exact: facilitator rejected nonce=${nonce} (${why})`, code: why })
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
        this.captureReceipt(response, url)
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
      ...(lastReason ? { code: lastReason.error, detail: lastReason.detail } : {}),
    })
    throw new MaxRetriesExceededError(
      `exact: server still returned 402 after submitting the signed authorization ` +
        `(nonce=${nonce}). Last rejection: ${why}. Re-present the SAME authorization — do NOT ` +
        `re-sign a fresh nonce; verify authorizationState(${payerFrom}, ${nonce}) first. ref=${nonce}.`,
      { ref: nonce }
    )
  }

  /**
   * The standard `upto` (metered) buyer path — a near-clone of {@link payExactRail} with TWO
   * deltas: (1) it signs a Permit2-upto authorization for the MAX via `payUpto` + frames it
   * with `buildUptoSignatureHeader`; (2) it records the ACTUAL settled amount (read off the
   * SettleResponse's required `amount` field, via `recordSpend(quote, ref, settle.amount)`) in
   * the ledger — the budget gated on the MAX, the ledger records the ACTUAL. A server that omits
   * `settle.amount` FAILS SAFE to the MAX (over-counts, never under-counts). The buyer SIGNS, the
   * merchant self-settles — the buyer never broadcasts.
   */
  private async payUptoRail(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402UptoAcceptEntry,
    url: string,
    init: (RequestInit & { autoRoute?: boolean; schemes?: PaymentScheme[] }) | undefined,
    quote: PipRailQuote
  ): Promise<Response> {
    if (!net.payUpto) {
      // gatherCandidates only yields an upto rail when payUpto exists — defensive.
      throw new UnsupportedSchemeError(
        `the ${net.family} family can't pay a standard 'upto' rail (EVM-Permit2 only today).`
      )
    }
    // A caller who aborts BEFORE we sign/send hasn't moved any funds — surface their AbortError.
    throwIfAborted(init?.signal)

    // Sign ONCE — a fresh Permit2 nonce is generated here and reused on every retry below.
    const { payload, accepted, payerFrom, nonce } = await net.payUpto(wallet, accept)
    const headers = new Headers(init?.headers)
    headers.set(HEADER_SIGNATURE, buildUptoSignatureHeader({ accepted, payload }))

    const rejectDefinitive = (why: string): never => {
      this.safeEmit({ kind: 'payment-failed', reason: `upto: facilitator rejected nonce=${nonce} (${why})`, code: why })
      throw new MaxRetriesExceededError(
        `upto: the server rejected the payment (${why}). Fix the cause, then re-present the ` +
          `SAME signed authorization (nonce=${nonce}) — do NOT re-sign a fresh nonce. ref=${nonce}.`,
        { ref: nonce }
      )
    }

    const deadline = Date.now() + Math.max(1, Math.floor(accept.maxTimeoutSeconds / 2)) * 1000
    const maxAttempts = Math.min(this.maxRetries, 3)
    let lastReason: { error: string; detail: string } | null = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, Math.min(2000, 400 * 2 ** (attempt - 1))))
      }
      throwIfAborted(init?.signal)

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
        throw new PaymentTimeoutError(
          `upto: no response after submitting the authorization (nonce=${nonce}) to ` +
            `${hostOf(url)}. The merchant may have already settled it — verify on-chain before ` +
            `re-presenting; do NOT re-pay.`,
          { cause: err, ref: nonce }
        )
      } finally {
        clearTimeout(timeoutId)
      }

      const settle = parseSettleResponse(response)

      if (response.status === 402) {
        if (settle && settle.success === false) rejectDefinitive(settle.errorReason ?? 'the server reported success:false')
        lastReason = (await readInvalidReason(response)) ?? lastReason
        continue
      }

      // Non-402. Settled iff it's a 2xx whose SettleResponse does NOT say success:false.
      if (response.ok && !(settle && settle.success === false)) {
        const receipt = parseReceipt(response)
        this.captureReceipt(response, url)
        this.safeEmit({ kind: 'payment-settled', receipt, ...(settle ? { settle } : {}) })
        // A $0 metered settle has transaction "" — `||` falls through to a nonce ref for the audit
        // trail. The budget debits the authorized MAX (merchant-proof, POL-1); the merchant-claimed
        // settled actual (settle.amount, or the receipt's) is passed only to be surfaced — clamped
        // ≤ the MAX — on the record's informational settledBase/settledFormatted.
        const ref = settle?.transaction || receipt?.transaction || `upto-nonce:${nonce}`
        const settledAmount = settle?.amount ?? receipt?.amount
        this.recordSpend(quote, ref, settledAmount)
        return response
      }

      if (response.status >= 500) {
        this.safeEmit({ kind: 'payment-failed', reason: `upto: server ${response.status} — authorization nonce=${nonce} not settled` })
        return response
      }
      if (settle && settle.success === false) rejectDefinitive(settle.errorReason ?? 'the server reported success:false')
      this.safeEmit({ kind: 'payment-failed', reason: `upto: server ${response.status} — authorization nonce=${nonce} not settled` })
      return response
    }

    const why = lastReason
      ? `${lastReason.error}${lastReason.detail ? ` — ${lastReason.detail}` : ''}`
      : 'server gave no reason'
    this.safeEmit({
      kind: 'payment-failed',
      reason: `upto: 402 after submitting authorization nonce=${nonce} (${why})`,
      ...(lastReason ? { code: lastReason.error, detail: lastReason.detail } : {}),
    })
    throw new MaxRetriesExceededError(
      `upto: server still returned 402 after submitting the signed authorization ` +
        `(nonce=${nonce}). Last rejection: ${why}. Re-present the SAME authorization — do NOT ` +
        `re-sign a fresh nonce. ref=${nonce}.`,
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
    case 'WINDOW_COUNT':
      return 'OUTSIDE_WINDOW'
    case 'MAX_TOTAL':
    case 'MAX_TOTAL_DENOM':
    case 'MAX_PAYMENTS':
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

/* ----------------------------- receipt re-verification helpers ----------------------------- */

/** The common EVM chains whose receipts re-verify with NO caller-supplied RPC — chainId →
 *  preset name (the preset carries a default RPC; `opts.rpcUrl` still overrides). PURE data:
 *  just strings, NO viem/preset-object import, so the protocol layer stays viem-free and the
 *  lazy-chunk grep green. A receipt on any other EVM chain needs `verifyReceipt(_, { rpcUrl })`. */
const EVM_PRESET_FOR_CHAINID: Readonly<Record<number, string>> = {
  1: 'ethereum',
  8453: 'base',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
  43114: 'avalanche',
  56: 'bnb',
}

/** Map a receipt's CAIP-2 `network` to a `chain` selector `resolveNetwork` accepts. EVM
 *  (`eip155:N`) → a common-preset name (default RPC) or `{ id, rpcUrl }` for a custom chain;
 *  every non-EVM namespace IS its family slug — except TON's `tvm`, which maps to `ton`
 *  (the chain-agnostic registry has no `ton` namespace). Pure/synchronous. */
function chainSelectorForNetwork(network: string, rpcUrl?: string): ChainSelector {
  const chainId = chainIdFromNetwork(network)
  if (chainId !== null) {
    const preset = EVM_PRESET_FOR_CHAINID[chainId]
    if (preset) return preset as ChainSelector
    return { id: chainId, rpcUrl: rpcUrl ?? '' } as ChainSelector
  }
  const namespace = network.split(':')[0] ?? ''
  return (namespace === 'tvm' ? 'ton' : namespace) as ChainSelector
}

/** Informational receipt age in seconds (never a validity gate). 0 on an unparseable `verifiedAt`. */
function receiptAgeSeconds(verifiedAt: string): number {
  const t = Date.parse(verifiedAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.round((Date.now() - t) / 1000))
}

/** The receipt's `issuedAt` in unix SECONDS — derived from `verifiedAt` for a Tier-2
 *  attestation that carries no signed `payload.issuedAt` (fallback). 0 on unparseable input;
 *  the EVM verifier treats it as a literal field, so a mismatch just fails recovery cleanly. */
function receiptIssuedAtSeconds(verifiedAt: string): number {
  const t = Date.parse(verifiedAt)
  if (Number.isNaN(t)) return 0
  return Math.floor(t / 1000)
}

/** Compare two on-chain addresses tolerantly (EVM checksum-insensitive; non-EVM addresses
 *  don't collide on case, so lowercasing is safe). Used to cross-check the re-derived payer. */
function sameAddress(a: string, b: string): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}
