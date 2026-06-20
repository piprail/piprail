/**
 * The accept side: gate any endpoint behind a payment with one function.
 *
 *   import { requirePayment } from '@piprail/sdk'
 *
 *   app.get('/report',
 *     requirePayment({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' }),
 *     (req, res) => res.json({ secret: 42 })
 *   )
 *
 * One parameter picks the chain family: 'base'/'bnb'/… → EVM, 'solana' →
 * Solana, 'ton' → TON. Non-EVM drivers auto-mount on first use — no setup
 * call. The payment is verified against the chain's RPC, in-process — no
 * backend, no database.
 *
 * Replay protection is an in-memory used-tx set scoped to the gate —
 * single-process by design; pass your own `isUsed`/`markUsed` to share it.
 */

import { parseUnits, formatUnits, floorUnits } from './util/units.js'
import { resolveNetwork } from './drivers/index.js'
import type { ResolvedNetwork, TokenInput, ChainSelector, WalletHandle } from './drivers/types.js'
import { buildBazaarExtension } from './discovery.js'
import type { ResourceDescription, PaymentRail, DiscoveryDescriptor } from './discovery.js'
import { describeChallenge } from './render.js'
import { buildSelfDescription, buildEndpointInfo } from './selfdescribe.js'
import { renderLandingPage } from './landing.js'
import { SettlementError, PipRailError } from './errors.js'
import { settleViaFacilitator, fetchFacilitatorFeePayer } from './facilitator.js'
import { firstKeylessFacilitator } from './facilitators.js'
import {
  buildChallengeHeader,
  buildReceiptHeader,
  buildReceiptExtension,
  parseSignatureObject,
  parseExactObject,
  parseUptoObject,
  decodeBase64Json,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  HEADER_SIGNATURE_V1,
  HEADER_RESPONSE_V1,
  type AddressId,
  type Caip2,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type X402UptoAcceptEntry,
  type X402AnyAccept,
  type X402Challenge,
  type X402Receipt,
  type PaidReceipt,
  type X402PaymentSignature,
  type ParsedExactPayment,
  type ParsedUptoPayment,
  type VerifyResult,
  type VerifyErrorCode,
} from './x402.js'

export type { TokenInput, ChainSelector }

/**
 * One payment option a gate offers. Pass several to `requirePayment({ accept:
 * [...] })` and the challenge offers them all in `accepts[]` — the agent pays on
 * whichever chain it holds funds for (USDC on Base OR Solana OR …). `payTo`/
 * `rpcUrl` fall back to the top-level option when omitted (per-family payTo is
 * usually given here, since address shapes differ across chains).
 */
export interface AcceptOption {
  /** Which chain. EVM ('bnb'|'base'|…), 'solana', 'ton', 'stellar', 'xrpl',
   *  'tron', 'near', 'sui', 'aptos', or 'algorand'. */
  chain: ChainSelector
  /** Token to be paid in (symbol / 'native' / custom descriptor). */
  token: TokenInput
  /** Human-readable amount for THIS option, e.g. "0.05". */
  amount: string
  /** Recipient for this chain (defaults to the top-level `payTo`). */
  payTo?: AddressId
  /** RPC override for this chain (defaults to the top-level `rpcUrl`). */
  rpcUrl?: string
}

/**
 * Opt into ALSO advertising a standard x402 `exact` rail beside the default
 * `onchain-proof` rail, so ANY standard x402 client can pay this gate (dual-advertise).
 * Supported on **EVM ERC-20** — **EIP-3009** (USDC, EURC) or, for tokens without it, **Permit2**
 * (any ERC-20 — e.g. Binance-Peg USDC on BNB, settled via the canonical x402ExactPermit2Proxy) —
 * and on **Solana** (any SPL token; the buyer partial-signs a `TransferChecked` and your relayer
 * is the fee payer). NOT native coins, NOT families without a standard `exact` scheme. Omitting
 * `exact` leaves the gate byte-identical to today (onchain-proof only).
 *
 * Two settlement modes, both backendless (PipRail hosts nothing):
 *  - `settle: 'self'`  — your own `relayer` key broadcasts the settle (EVM EIP-3009's
 *     `transferWithAuthorization` / the proxy's `settle` for Permit2; on Solana, co-signing the
 *     buyer's transaction as the fee payer). You pay gas to RECEIVE (the inverse of onchain-proof)
 *     and keep the relayer funded. The signature binds the recipient, so there's no redirect risk.
 *     The on-brand backendless default for the rail.
 *  - `settle: { facilitator }` — delegate verify+settle to a third-party x402 facilitator YOU
 *     choose. **The facilitator pays the gas, so neither the buyer nor the merchant pays any** —
 *     fully gasless end to end. On **EVM** use Coinbase CDP, x402.org, PayAI, …; on **Solana** use a
 *     facilitator that sponsors the fee payer (e.g. PayAI's `https://facilitator.payai.network`,
 *     no API key) — the gate reads its fee-payer pubkey from `GET /supported` automatically. No
 *     relayer key needed. (EVM facilitators are also the path onto Coinbase's Bazaar directory.)
 */
export interface ExactRailOption {
  /** How the gate settles an inbound `exact` payment. `'self'` = your own `relayer` broadcasts
   *  (you pay gas). `'keyless'` = auto-pick a known KEYLESS facilitator for the chain (it sponsors
   *  gas — zero-config; the same resolution as the top-level `exact: true` shorthand). `{ facilitator }`
   *  = a specific facilitator you name — pin this in production rather than relying on the auto-pick. */
  settle:
    | 'self'
    | 'keyless'
    | {
        facilitator: string
        authHeaders?: () => Promise<Record<string, string>>
        /** Solana only — the facilitator's fee-payer pubkey, if you'd rather set it than have the
         *  gate read it from the facilitator's `GET /supported`. Optional: omitted, the gate
         *  discovers it automatically (e.g. PayAI). Ignored on EVM. */
        feePayer?: string
      }
  /** Required for `settle: 'self'` — the gas-paying relayer wallet: a `{ key }` (or a
   *  bring-your-own EVM `{ walletClient }` / Solana `{ signer }`). (Distinct from `payTo`, the
   *  receive address — on Solana they MUST be different keys, a scheme MUST-rule.) */
  relayer?: unknown
  /** Which exact transfer method to advertise (EVM). `'auto'` (default) uses EIP-3009 when the
   *  token supports it, else Permit2 — so a non-EIP-3009 token like Binance-Peg USDC on BNB
   *  "just works". Force `'eip3009'` or `'permit2'` to pin one. Ignored on Solana (always SVM). */
  method?: 'eip3009' | 'permit2' | 'auto'
}

/**
 * Opt into ALSO advertising a standard x402 `upto` (metered / variable-amount) rail beside the
 * default `onchain-proof` rail — for usage-billed APIs (pay-per-LLM-token, per-byte, per-query).
 * The buyer signs a Permit2 authorization for `amount` as a **MAXIMUM**; the merchant serves the
 * resource, meters the **actual** usage, then **self-settles** `actual ≤ max` through the
 * canonical `x402UptoPermit2Proxy` from its own `relayer` (which IS the bound `witness.facilitator`
 * — backendless, no third-party facilitator). **EVM-Permit2 ONLY** (the upto spec bans EIP-3009 and
 * has no non-EVM variant); native coins and non-Permit2 chains never carry it. Self-settle ONLY in
 * v1 (no facilitator mode). Omitting `upto` leaves the gate byte-identical to today.
 *
 * **⚠ UNSUPPORTED through the Express `requirePayment` middleware** — it settles BEFORE the route
 * handler serves, so the metered usage isn't known yet; constructing `requirePayment({ upto })`
 * THROWS. The supported handler shape is a **direct `gate.verify(header)` call** where the metering
 * happens INSIDE the `settleAmount` callback: serve/compute enough to know usage → `await
 * gate.verify(header)` whose `settleAmount` returns that usage → write the body + the receipt header.
 */
export interface UptoRailOption {
  /** REQUIRED — the gas-paying relayer wallet that settles AND is the bound `witness.facilitator`
   *  (a `{ key }` or a bring-your-own EVM `{ walletClient }`). Distinct from `payTo`, the receive
   *  address — though here they MAY be the same key (the proxy binds `witness.to` separately). */
  relayer: unknown
  /**
   * REQUIRED — the merchant callback that picks the ACTUAL charge AFTER serving (the
   * deferred-settle lifecycle). Called with the metered context; return a `bigint` (base units),
   * or a string in the x402 SettlementOverrides forms — raw atomic (`"1858"`), `"NN%"` of the max
   * (floored), or `"$X"` (rounded to the token's decimals). `"0"`/`0n` ⇒ a zero-charge receipt with
   * NO on-chain tx. The gate clamps to ≤ the advertised max and rejects-over-max defensively
   * (`upto_settle_exceeds_max`). On the direct `gate.verify()` path this is where you meter usage.
   */
  settleAmount: (ctx: {
    maxAmount: bigint
    asset: string
    network: Caip2
    decimals: number
    request?: unknown
  }) => bigint | string | Promise<bigint | string>
}

/**
 * The merchant-side mirror of {@link PaidReceipt}: what an {@link RequirePaymentOptions.onFailed}
 * hook receives when a SUBMITTED payment proof is REJECTED. It carries the SAME machine-readable
 * `code` the buyer's client is given for that rejection, so both sides are notified of one
 * consistent reason. (A rejection has no settlement, so — unlike a receipt — there is no tx hash
 * or settled amount to report.)
 */
export interface FailedPayment {
  /** The canonical rejection reason — the same {@link VerifyErrorCode} surfaced to the buyer
   *  (e.g. `amount_too_low`, `payment_expired`, `tx_already_used`, `transfer_not_found`). */
  code: VerifyErrorCode
  /** Human-readable detail, e.g. `"Paid 40000, required 500000."`. */
  detail: string
  /**
   * `true` for a **transient** rejection (`tx_not_found` / `insufficient_confirmations`): the proof
   * may still be settling and the buyer's client **retries automatically** — you'll get `onPaid` if
   * it then succeeds. `false` for a **definitive** rejection the buyer must fix (wrong amount,
   * expired, replayed, bad signature, wrong recipient). Alert on `!transient` to avoid false alarms
   * on normal RPC lag; nothing is hidden — every rejected attempt still fires `onFailed`.
   */
  transient: boolean
}

export interface RequirePaymentOptions {
  /**
   * Single-chain form: which chain to accept payment on. EVM ('bnb'|'base'|…),
   * 'solana', 'ton', 'stellar', 'xrpl', 'tron', 'near', 'sui', 'aptos', or
   * 'algorand'. Provide `chain` + `token` + `amount`, OR use the multi-chain
   * `accept` array below.
   */
  chain?: ChainSelector
  /** Override the chain's default RPC URL (recommended in production). */
  rpcUrl?: string
  /**
   * What to be paid in (single-chain form). Use a symbol the chain ships
   * (`'USDC'` / `'USDT'`), the chain's coin (`'native'`), or a custom token:
   * `{ address, decimals }` on EVM/Tron, `{ mint, decimals }` on Solana,
   * `{ master, decimals }` on TON, `{ issuer, code, decimals }` on Stellar,
   * `{ issuer, currencyHex, decimals }` on XRPL, `{ contractId, decimals }` on
   * NEAR, `{ coinType, decimals }` on Sui, `{ metadata, decimals }` on Aptos, or
   * `{ assetId, decimals }` on Algorand. You name the token; the SDK fills in
   * the contract + decimals for built-in symbols. (Note: native USDC doesn't
   * exist on TON/Tron — USDT does; native NEAR is supported via `'native'`.)
   */
  token?: TokenInput
  /** Human-readable amount, e.g. "0.05" (single-chain form). */
  amount?: string
  /**
   * Multi-chain form: offer several payment options in ONE challenge. The agent
   * picks the chain/token it can pay. Mutually exclusive with the single-chain
   * `chain`/`token`/`amount` fields above; provide one form or the other.
   */
  accept?: AcceptOption[]
  /** Address that receives the payment (0x… EVM/Sui, base58 Solana, EQ…/UQ… TON,
   *  G… Stellar, r… XRPL, T… Tron, account id on NEAR, 0x… Aptos, base32 Algorand).
   *  Required for the single form; the per-option fallback for the multi form. */
  payTo?: AddressId
  /** Shown to the agent in the challenge. Also the one-line "what this endpoint does"
   *  in the self-describe block (a `discovery` descriptor's `summary` overrides it). */
  description?: string
  /** Response content-type, e.g. 'application/json'. Emitted at the v2 root `resource.mimeType`
   *  and in the self-describe `endpoint` so an agent knows how to parse the paid response. */
  mimeType?: string
  /** Confirmations required before access is granted. Default 1. */
  minConfirmations?: number
  /** Max age of an accepted payment, in seconds. Default 600. */
  maxTimeoutSeconds?: number
  /** Nonce generator. Default `crypto.randomUUID()`. */
  generateNonce?: () => string
  /** Replay hook — return true if this proof was already redeemed. */
  isUsed?: (ref: string) => boolean | Promise<boolean>
  /** Replay hook — record a redeemed proof. */
  markUsed?: (ref: string) => void | Promise<void>
  /**
   * Fired when a payment verifies successfully, with the enriched {@link PaidReceipt}.
   * May be **sync or async** — a throw OR a rejected promise is isolated (routed to
   * `onPaidError`), so the hook can never break the request or crash the process.
   * Fire-and-forget by default (the response is not blocked on it); set `awaitOnPaid`
   * to record the receipt before the resource is served. `onPaid` is **at-least-once**
   * across instances — dedupe on `receipt.idempotencyKey`. See {@link PaidReceipt}.
   */
  onPaid?: (receipt: PaidReceipt) => void | Promise<void>
  /**
   * Observe a failure inside `onPaid` (sync throw or async rejection). Without it,
   * a failing receipt hook is swallowed silently — set this to log/alert/queue the
   * dropped receipt. Its own throws are also swallowed (it can never break a request).
   */
  onPaidError?: (error: unknown, receipt: PaidReceipt) => void
  /**
   * Await `onPaid` before returning the paid result (and thus before the gated
   * resource is served), so "receipt recorded" is guaranteed on the happy path.
   * Default `false` (fire-and-forget — lower latency). A rejection is still isolated
   * via `onPaidError`; it never turns a settled payment into a 402.
   */
  awaitOnPaid?: boolean
  /**
   * The merchant-side mirror of `onPaid`: fired when a SUBMITTED payment proof is REJECTED — a
   * `kind:'invalid'` verdict (wrong amount, expired, replayed, unknown asset, …). Receives a
   * {@link FailedPayment} carrying the SAME machine `code` the buyer's client is given, so the
   * merchant and the buyer are notified of the same failure with the same reason.
   *
   * Fires ONLY on a rejected attempt — NOT on a normal first-request 402 `challenge` (no proof
   * yet), and NOT on a transient/settlement error that throws (an RPC blip, or a 5xx
   * `SettlementError`): those aren't payment verdicts. Like `onPaid`, it may be **sync or async**
   * and is fully isolated — a throw OR a rejected promise is caught and routed to `onFailedError`,
   * so it can never break the request or crash the process. Fire-and-forget by default; set
   * `awaitOnFailed` to run it before the 402 is returned.
   *
   * NOTE: a failure the merchant never receives a request for — the buyer can't afford it, an
   * `onBeforePay`/`policy` declines it, or the buyer abandons before paying — cannot reach a
   * backendless gate (only the buyer's client sees it). `onFailed` covers every rejection that
   * DOES reach the gate.
   */
  onFailed?: (failure: FailedPayment) => void | Promise<void>
  /**
   * Observe a failure inside `onFailed` (sync throw or async rejection) — the mirror of
   * `onPaidError`. Without it, a throwing `onFailed` is swallowed silently. Its own throws are
   * also swallowed (it can never break a request).
   */
  onFailedError?: (error: unknown, failure: FailedPayment) => void
  /**
   * Await `onFailed` before the 402 rejection is returned (mirror of `awaitOnPaid`), so
   * "failure recorded" is guaranteed before the caller is told. Default `false` (fire-and-forget).
   * A rejection inside the hook is still isolated via `onFailedError`.
   */
  awaitOnFailed?: boolean
  /**
   * ALSO advertise a standard x402 `exact` rail so any standard x402 client can pay this
   * gate — opt-in, EVM (EIP-3009/Permit2) + Solana (SVM). See {@link ExactRailOption}.
   * Shorthand **`exact: true`** === `{ settle: 'keyless' }`: the gate auto-picks a known KEYLESS
   * facilitator for each offered chain (from `KNOWN_FACILITATORS`), so neither buyer nor merchant
   * pays gas, zero-config. It is a SOFT, best-effort flag — a chain with no available keyless
   * facilitator DEGRADES GRACEFULLY to the always-present `onchain-proof` rail (the buyer pays gas,
   * the only option left when no facilitator can sponsor) with a LOUD warning; it never bricks the
   * gate. For guaranteed gasless, pin `settle: { facilitator }` (recommended in production) or
   * self-settle `settle: 'self'`; an EXPLICIT `settle` that can't carry exact throws loudly (a config
   * error you should fix). `false`/omitted keeps the gate exactly as today (`onchain-proof` only —
   * byte-identical).
   */
  exact?: boolean | ExactRailOption
  /**
   * ALSO advertise a standard x402 `upto` (metered / variable-amount) rail — for usage-billed
   * APIs (pay-per-LLM-token, per-byte, …). Opt-in, EVM-Permit2 ONLY, self-settle ONLY. See
   * {@link UptoRailOption}. The buyer signs for a MAX; you meter + settle the ACTUAL after serving
   * via the `settleAmount` callback. **UNSUPPORTED through `requirePayment` (the Express middleware
   * settles before the route handler serves) — constructing `requirePayment({ upto })` THROWS;** use
   * a direct `gate.verify()` call and meter inside `settleAmount`. Omitted ⇒ byte-identical to today.
   */
  upto?: UptoRailOption
  /**
   * Make this gate's 402 self-describing for the open indexes — **x402scan REQUIRES
   * an input schema or it won't list the resource.** Set `true` for a no-input GET,
   * or pass a {@link DiscoveryDescriptor} to describe the request. Emits an
   * `extensions.bazaar` block in the 402 challenge. Opt-in; omitting it leaves the
   * challenge byte-identical to before.
   */
  discovery?: boolean | DiscoveryDescriptor
  /**
   * Self-describe every 402 — stamp an `extensions.piprail` block (identity · per-rail
   * how-to-pay · `npm i @piprail/sdk` + snippet · MCP · docs + discovery pointers) so the
   * instant any human, AI agent, or crawler lands on this endpoint — even the default
   * `onchain-proof` scheme a stock x402 client can't pay — it knows what it is and how to
   * pay it. **Default `true`.** It is purely-additive metadata a standard client ignores
   * (the spec treats `extensions` as opaque), so the pay path, `accepts[]`, headers, and
   * status are byte-identical. Set `false` to omit the block entirely (the literal
   * byte-identical default of before this feature). See {@link buildSelfDescription}.
   */
  selfDescribe?: boolean
  /**
   * Emit a **verifiable receipt** on every settled payment — a self-contained
   * {@link PipRailReceipt} that the buyer keeps and **anyone** re-verifies against the
   * chain with only an RPC (no key, no backend, no PipRail account). It rides in an
   * `extensions['offer-receipt'].info` block on the `PAYMENT-RESPONSE` header (the
   * chain-grounded record at `info.settlement`; the optional Tier-2 SignedReceipt at the
   * spec's `info.receipt` slot) and stamps the challenge `nonce` onto the receipt so the five Template-A
   * (memo/nonce-bound) families re-verify off-chain. **Default off → byte-identical.**
   *
   * - `true` / `{}`        → Tier-1 chain-grounded receipt (the settlement tx is the
   *                          authority — re-verified via the driver's own `verify()`).
   * - `{ includeTxHash }`  → see {@link ReceiptOption}. Default `true` (PipRail inverts
   *                          the official privacy-default; the open chain is the pitch).
   *
   * Purely additive metadata a standard x402 client ignores; the `accepts[]`, status,
   * and pay path are unchanged. {@link PipRailClient.verifyReceipt} re-verifies it.
   */
  receipts?: boolean | ReceiptOption
}

/** Tuning for the {@link RequirePaymentOptions.receipts} verifiable-receipt emission. */
export interface ReceiptOption {
  /**
   * Put the settlement tx hash in the receipt. **Default `true`** — PipRail inverts the
   * official x402 privacy-default (which omits it) because the whole pitch is the open,
   * self-verifiable chain. Set `false` for a privacy-minded merchant: the wire
   * `transaction` becomes the empty string `''` (per spec §5.3, never a missing key) and
   * the Tier-1 receipt is no longer third-party on-chain-verifiable (it carries no tx to
   * re-read) — use Tier-2 attestation for that case.
   */
  includeTxHash?: boolean
  /**
   * The canonical resource URL to embed in the merchant-emitted receipt (what was paid
   * for). The buyer's {@link PipRailClient.lastReceipt} also fills this from the URL it
   * fetched, so set it here only to ground the raw header a third party reads directly.
   * Default `''` (the buyer's client fills it).
   */
  resource?: string
  /**
   * **Tier-2 — service-delivery attestation (OPTIONAL, EVM-only).** When set, the gate
   * ALSO signs the official x402 `offer-receipt` EIP-712 receipt with the merchant's own
   * wallet, attesting the one thing the chain can't: that the resource was actually
   * **served**. A verifier checks `recover(sig) === payTo` — zero new infra, the
   * merchant's existing `payTo` key. The {@link SignedReceipt} rides at the official
   * spec slot `extensions['offer-receipt'].info.receipt` (so a stock `@x402/extensions`
   * reader reads it unchanged); verify with {@link PipRailClient.verifyAttestation}.
   *
   * - `{ wallet }` → the merchant's existing payTo key (EIP-712). EVM-only: on a non-EVM
   *   rail it **degrades to Tier-1 + a one-time warning**, never throws.
   * - `{ jws }`    → a managed JWS signer (did:web/key) — **R3, not yet implemented**
   *   (the type slot is reserved). Supplying it today degrades to Tier-1 + a warning.
   *
   * Signing failures degrade to the unsigned Tier-1 receipt (isolated exactly like
   * `onPaid`) — they never fail the 200.
   */
  attest?: { wallet: unknown } | { jws: unknown }
}

export type VerifyPaymentResult =
  | { kind: 'paid'; receipt: X402Receipt; receiptHeader: string }
  | {
      kind: 'challenge'
      challenge: X402Challenge
      requiredHeader: string
      statusCode: 402
    }
  | {
      /**
       * A submitted proof was rejected. Conformant: this carries a FRESH
       * re-`challenge` (full v2 PaymentRequired with `accepts[]` + the reason in
       * `error` + the machine code in `extensions.piprail`) so a standard x402
       * client can immediately retry. Adapters emit `challenge` + the
       * `PAYMENT-REQUIRED` header — NOT the legacy {@link toInvalidBody}.
       */
      kind: 'invalid'
      error: string
      detail: string
      challenge: X402Challenge
      requiredHeader: string
      statusCode: 402
    }

/** A minimal 402 'invalid' JSON body. @deprecated — see {@link toInvalidBody}. */
export interface X402InvalidBody {
  x402Version: 2
  status: 'invalid'
  error: string
  detail: string
}

/**
 * @deprecated LEGACY minimal rejection body. The gate now returns a fully
 * **conformant** rejection: `gate.verify()`'s `kind:'invalid'` result carries a full
 * v2 PaymentRequired re-`challenge` (with `accepts[]` so a standard x402 client can
 * retry, the reason in `error`, and the machine code in `extensions.piprail`). The
 * built-in `requirePayment` adapter emits `result.challenge` + the `PAYMENT-REQUIRED`
 * header. PREFER that. This helper (a bare `{ status:'invalid', error, detail }` with
 * NO `accepts[]`) remains only for back-compat with hand-rolled adapters; a standard
 * client that receives it can't retry. Migrate to `result.challenge`.
 */
export function toInvalidBody(result: { error: string; detail: string }): X402InvalidBody {
  return { x402Version: 2, status: 'invalid', error: result.error, detail: result.detail }
}

export interface PaymentGate {
  /** Build a fresh 402 challenge (new nonce) for a resource URL. */
  challenge(resourceUrl?: string): Promise<{
    challenge: X402Challenge
    requiredHeader: string
  }>
  /** Verify an incoming `payment-signature` header value. */
  verify(
    paymentSignature: string | string[] | undefined
  ): Promise<VerifyPaymentResult>
  /**
   * Verify an already-decoded PaymentPayload OBJECT (raw JSON, not base64) — the
   * additive seam for non-HTTP transports (A2A carries the payload as raw JSON
   * `metadata`, never a base64 header). Runs the EXACT SAME dispatch as {@link verify}
   * (upto → exact → onchain-proof), reading `sig.payload.nonce` from the object exactly
   * as the HTTP path does — so it adds ZERO new verification state and shares the gate's
   * one replay set. `verify(b64)` is the base64 path and stays byte-identical; this only
   * skips the decode. The same `onPaid`/`onFailed` hooks fire.
   */
  verifyObject(payload: unknown): Promise<VerifyPaymentResult>
  /**
   * Describe this gate's payment options as static, nonce-free discovery
   * metadata — feed it to the emitters in `discovery.ts` (`buildOpenApi` /
   * `buildWellKnownX402`) to make the resource findable. Reuses the same
   * resolved options the challenge is built from (so a `0x…` payTo / decimals
   * are already correct); unlike `challenge()`, it mints no nonce, because
   * discovery metadata is long-lived. Read-only — moves nothing on-chain.
   */
  describe(resourceUrl?: string): Promise<ResourceDescription>
  /**
   * Render a self-describing HTML page for a challenge — for the HUMAN who opens the gated
   * URL in a browser. Pass the challenge you already built with {@link PaymentGate.challenge};
   * serve the result with `content-type: text/html` when the request's `Accept` is `text/html`.
   * The SDK never serves it itself (headless by charter). Agents/crawlers keep the JSON 402.
   */
  landingPage(challenge: X402Challenge): string
}

/** The settle config for a resolved `exact` rail: self (own relayer) or a facilitator. */
type ResolvedExactMode =
  | { kind: 'self'; relayer: WalletHandle }
  | { kind: 'facilitator'; url: string; authHeaders?: () => Promise<Record<string, string>> }

/** A resolved standard `exact` rail bound to one spec — the transfer method + how it
 *  settles. Present when `options.exact` is set and the spec's family can carry it
 *  (EVM ERC-20 via EIP-3009/Permit2, or Solana SPL via the SVM scheme). */
interface ResolvedExactRail {
  /** `'eip3009'`/`'permit2'` (EVM), `'svm'` (Solana), `'algorand'`, `'aptos'`, or `'near'` (NEP-366). */
  method: 'eip3009' | 'permit2' | 'svm' | 'algorand' | 'aptos' | 'near'
  /** Family-specific keys the driver supplies, merged verbatim into the accept's `extra`
   *  (EVM EIP-3009: the token's `name`/`version`; Solana/Algorand: `feePayer`[/`tokenProgram`]). */
  extra?: Record<string, unknown>
  mode: ResolvedExactMode
}

/** A resolved standard `upto` (metered) rail bound to one spec — self-settle ONLY (the
 *  merchant's own relayer is the bound `witness.facilitator`). Present when `options.upto`
 *  is set and the spec's family/asset can carry it (EVM ERC-20 via the Permit2 upto proxy). */
interface ResolvedUptoRail {
  /** Always the PipRail-internal `'permit2-upto'` (upto is EVM-Permit2 only). */
  method: 'permit2-upto'
  /** Driver-supplied keys merged verbatim into the accept's `extra` — `{ facilitatorAddress, name?, version? }`. */
  extra?: Record<string, unknown>
  /** The bound relayer that settles (and is the witness.facilitator). */
  relayer: WalletHandle
}

/** One fully-resolved payment option — its bound network, token, and recipient.
 *  A gate holds an array of these (one per offered chain), resolved once. */
interface ResolvedSpec {
  net: ResolvedNetwork
  asset: string
  decimals: number
  symbol?: string
  amountBase: bigint
  amountFormatted: string
  payTo: AddressId
  /** A standard `exact` rail for this spec, when opted in + supported (EVM or Solana). */
  exact?: ResolvedExactRail
  /** A standard `upto` (metered) rail for this spec, when opted in + supported (EVM-Permit2). */
  upto?: ResolvedUptoRail
}

/**
 * Normalise the single-chain (`chain`/`token`/`amount`) and multi-chain
 * (`accept: [...]`) forms into one list of options. The single form is just a
 * one-element list. Throws a clear error if neither form is fully specified.
 */
function normaliseAccepts(options: RequirePaymentOptions): AcceptOption[] {
  if (options.accept && options.accept.length > 0) {
    if (options.chain !== undefined || options.token !== undefined || options.amount !== undefined) {
      throw new Error(
        'requirePayment: pass EITHER `accept: [...]` (multi-chain) OR ' +
          '`chain`/`token`/`amount` (single) — not both.'
      )
    }
    return options.accept
  }
  if (options.chain !== undefined && options.token !== undefined && options.amount !== undefined) {
    return [{ chain: options.chain, token: options.token, amount: options.amount }]
  }
  throw new Error(
    'requirePayment: provide either { chain, token, amount } or a non-empty ' +
      '`accept: [{ chain, token, amount }, …]`.'
  )
}

/** Expand the `exact` option's `boolean` shorthand: `true` → `{ settle: 'keyless' }` (auto-pick a
 *  known keyless facilitator per chain); `false`/undefined → no exact rail. An object passes through
 *  unchanged. Keeps the default (omit `exact`) path byte-identical — see {@link RequirePaymentOptions.exact}. */
function normaliseExactOption(
  exact: boolean | ExactRailOption | undefined
): ExactRailOption | undefined {
  if (!exact) return undefined
  if (exact === true) return { settle: 'keyless' }
  return exact
}

/**
 * Framework-agnostic core. Build one gate per gated resource and reuse it
 * — its in-memory used-tx set is what stops the same proof being redeemed
 * twice. Wrap it for Express with `requirePayment`, or call it directly
 * from Hono / Fastify / Adonis / Workers / etc.
 *
 * The chain's driver is resolved lazily on first `challenge()`/`verify()`,
 * which is what lets Solana (and future families) auto-mount with no setup.
 */
/** The two TRANSIENT verify codes (ERRORS.md §3): the proof may still be settling (RPC lag /
 *  awaiting confirmations) and the buyer's client retries automatically. Everything else is a
 *  definitive rejection. Used to flag {@link FailedPayment.transient}. */
const TRANSIENT_VERIFY_CODES = new Set<VerifyErrorCode>(['tx_not_found', 'insufficient_confirmations'])

/** Derive the official receipt `issuedAt` (unix SECONDS) for a Tier-2 attestation from the
 *  receipt's `verifiedAt` timestamp. Falls back to "now" when `verifiedAt` is unparseable
 *  (e.g. a driver stub's `'now'` literal) — never NaN, so the EIP-712 `BigInt(issuedAt)` is
 *  always well-defined (spec §5.2 requires an integer unix-seconds `issuedAt`). */
function nowUnixSeconds(verifiedAt?: string): number {
  if (verifiedAt) {
    const t = Date.parse(verifiedAt)
    if (!Number.isNaN(t)) return Math.floor(t / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

export function createPaymentGate(options: RequirePaymentOptions): PaymentGate {
  const minConfirmations = options.minConfirmations ?? 1
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600
  const genNonce = options.generateNonce ?? (() => globalThis.crypto.randomUUID())
  // Expand the `exact: true` shorthand once. ALL exact logic below reads `exactOption`, not
  // `options.exact`, so the default (omit `exact`) path stays byte-identical (onchain-proof only).
  const exactOption = normaliseExactOption(options.exact)
  // Verifiable-receipt emission (default OFF → byte-identical). `buildPaidResult` reads these,
  // never `options.receipts`, so the no-option path is untouched.
  const receiptsOn = options.receipts !== undefined && options.receipts !== false
  const receiptOpt: ReceiptOption =
    typeof options.receipts === 'object' ? options.receipts : {}
  const receiptIncludeTxHash = receiptOpt.includeTxHash !== false // default true
  const receiptResourceUrl = receiptOpt.resource ?? ''
  // Tier-2 attestation (opt-in). A `{ wallet }` enables EVM EIP-712 signing; a `{ jws }`
  // is reserved for R3 (unimplemented) and degrades to Tier-1. Resolved once; the JWS
  // path is recognised here only to warn-and-degrade, never to sign.
  const attestWallet =
    receiptOpt.attest && 'wallet' in receiptOpt.attest ? receiptOpt.attest.wallet : undefined
  const attestJws = receiptOpt.attest && 'jws' in receiptOpt.attest
  // A one-time warning when `attest` is set but the rail can't sign (non-EVM, or the
  // deferred JWS path) — fires at most once per gate, never throws, never logs a secret.
  let attestWarned = false
  function warnAttestDegrade(reason: string): void {
    if (attestWarned) return
    attestWarned = true
    try {
      // eslint-disable-next-line no-console
      console.warn(`[piprail] receipts.attest ${reason}; emitting an unsigned Tier-1 receipt instead.`)
    } catch {
      /* a console shim that throws must never break the request */
    }
  }

  // Lazy, memoized resolution. Auto-mounts each option's driver, validates its
  // payTo, and resolves its token (asset + decimals) exactly once. One element
  // for the single-chain form; one per offered chain for the multi form.
  let resolved: Promise<ResolvedSpec[]> | undefined
  function ready(): Promise<ResolvedSpec[]> {
    if (resolved) return resolved
    const p = (async () => {
      const accepts = normaliseAccepts(options)
      // Actionable reasons a spec couldn't carry `exact` (facilitator unreachable, a
      // facilitator-incompatible token). Surfaced ONLY if NOTHING carries exact — so a
      // graceful per-rail drop stays quiet on a gate that has another working exact rail.
      const exactSkips: string[] = []
      // Specs that couldn't carry `upto` (native / non-Permit2 chain / non-EVM family) — named
      // in the loud throw below when NOTHING carries it (upto is an explicit opt-in).
      const uptoSkips: string[] = []
      const specs = await Promise.all(
        accepts.map(async (a): Promise<ResolvedSpec> => {
          const net = await resolveNetwork({ chain: a.chain, rpcUrl: a.rpcUrl ?? options.rpcUrl })
          const payTo = a.payTo ?? options.payTo
          if (!payTo) {
            throw new Error(
              `requirePayment: no payTo for chain ${net.network}. Set it on the ` +
                `accept entry or pass a top-level payTo.`
            )
          }
          net.assertValidPayTo(payTo)
          const { asset, decimals, symbol } = net.resolveToken(a.token)
          const amountBase = parseUnits(a.amount, decimals)
          const spec: ResolvedSpec = { net, asset, decimals, symbol, amountBase, amountFormatted: a.amount, payTo }
          if (exactOption) {
            const outcome = await resolveExactRail(net, asset)
            if (outcome.rail) spec.exact = outcome.rail
            else if (outcome.skipReason) exactSkips.push(outcome.skipReason)
          }
          if (options.upto) {
            const upto = await resolveUptoRail(net, asset)
            if (upto) spec.upto = upto
            else uptoSkips.push(`${net.network}/${asset}`)
          }
          return spec
        })
      )
      // Upto was requested but NOTHING could carry it (a native coin, a non-Permit2-proxy chain,
      // a non-EVM family). Self-settle only + EVM-Permit2 only — a narrow rail by design. Throw
      // loudly (an explicit opt-in that can't be honoured is a config error), naming the cause.
      if (options.upto && !specs.some((s) => s.upto)) {
        throw new Error(
          'requirePayment: `upto` (the metered rail) was requested but none of the offered rails support it ' +
            `(tried: ${uptoSkips.join(', ') || 'none'}). The \`upto\` scheme is EVM-Permit2 ONLY — an ERC-20 on a ` +
            'chain with the x402UptoPermit2Proxy deployed (Ethereum/Base/Arbitrum/Optimism/Polygon/BNB), NOT a ' +
            'native coin, NOT a non-EVM family. (Native coins + non-Permit2 chains can never carry `upto`.)'
        )
      }
      // Exact was requested but NOTHING could carry it (no keyless facilitator for the chain, a
      // facilitator that's unreachable, a native/non-exact family, …). Two postures, by intent:
      //  • `exact: true` / `settle: 'keyless'` is a SOFT, best-effort "be gasless where I can" flag —
      //    DEGRADE GRACEFULLY to the always-present onchain-proof rail (the buyer pays gas; the only
      //    option left) and warn LOUDLY (never silently — the merchant must know their gate isn't
      //    gasless), but NEVER brick the gate.
      //  • An EXPLICIT `settle: 'self' | { facilitator }` engaged the exact rail deliberately, so a
      //    coverage gap is a config error → throw loudly (surfaces a typo'd URL / wrong token fast).
      // (Hard misconfigs — self-without-relayer, forced permit2 via facilitator — already threw inside
      // resolveExactRail before reaching here, so this branch only ever sees AVAILABILITY gaps.)
      if (exactOption && !specs.some((s) => s.exact)) {
        const why =
          exactSkips.length > 0
            ? exactSkips.join(' ')
            : 'The standard `exact` rail is EVM ERC-20 (EIP-3009 — USDC / EURC — or Permit2, e.g. ' +
              'Binance-Peg USDC on BNB) or a Solana SPL token (SVM) — NOT native coins, NOT families ' +
              'without a standard `exact` scheme.'
        if (exactOption.settle === 'keyless') {
          // SOFT shorthand → graceful fallback to onchain-proof (pay-gas). This warns about a real
          // POSTURE GAP (the merchant asked for gasless; buyers will now pay gas), fires ONCE at gate
          // construction, and stays visible IN PRODUCTION too (a silent prod degrade is the trap) —
          // suppress explicitly with PIPRAIL_NO_HINTS. Browser-safe (no `process` → still warns).
          if (typeof process === 'undefined' || !process?.env?.PIPRAIL_NO_HINTS) {
            console.warn(
              '[piprail] exact: true — no offered chain has a gasless `exact` rail available, so this ' +
                'gate serves ONCHAIN-PROOF ONLY (buyers PAY GAS — the fallback when no facilitator can ' +
                `sponsor). ${why} To be gasless: pin \`exact: { settle: { facilitator } }\` or self-settle ` +
                '`exact: { settle: \'self\', relayer }`. (Suppress with PIPRAIL_NO_HINTS=1.)'
            )
          }
          // fall through — serve onchain-proof only (graceful, never bricks).
        } else {
          throw new Error('requirePayment: `exact` was requested but none of the offered rails support it. ' + why)
        }
      }
      return specs
    })()
    // Don't cache a REJECTED resolution: a transient RPC failure (e.g. the exact-rail
    // domain read) must not permanently brick the gate — the next call retries once the
    // node recovers. The success case stays memoized.
    p.catch(() => { if (resolved === p) resolved = undefined })
    resolved = p
    return p
  }

  /**
   * Resolve a standard `exact` rail for one spec. Family-agnostic: it binds the self-settle
   * relayer (chain-agnostic config), delegates the chain-specific "which method + what `extra`"
   * decision to the driver's {@link ResolvedNetwork.resolveExactRail} SPI (EVM picks EIP-3009/
   * Permit2 + reads the token's EIP-712 domain; Solana returns the SVM method + the `feePayer`),
   * then attaches the settle mode. A family that doesn't implement the SPI offers no exact rail.
   *
   * Returns `{ rail }` when the asset/chain CAN carry exact; `{ skipReason }` to DROP this rail to
   * `onchain-proof`-only with an ACTIONABLE reason the gate surfaces if nothing else carries exact
   * (so a transient facilitator outage / a facilitator-incompatible token degrades gracefully on a
   * multi-rail gate instead of bricking it); or `{}` when the asset simply can't carry exact (a
   * native coin, an unsupported token). THROWS only for a hard, explicit MISCONFIGURATION the
   * developer must fix (a forced method that can't be honoured, a `settle:'self'` without a relayer).
   */
  async function resolveExactRail(
    net: ResolvedNetwork,
    asset: string
  ): Promise<{ rail?: ResolvedExactRail; skipReason?: string }> {
    const cfg = exactOption!
    if (!net.resolveExactRail) return {} // family has no standard `exact` settlement

    // Resolve the `exact: true` / `settle: 'keyless'` shorthand to a concrete facilitator for THIS
    // spec's OWN trusted network — per-spec, so a multi-chain gate auto-picks the right keyless
    // facilitator for each rail (never one global URL). The chosen URL then flows through the exact
    // same facilitator path as a hand-named one, so this adds no new settle behaviour, only selection.
    let settle = cfg.settle
    if (settle === 'keyless') {
      const picked = firstKeylessFacilitator(net.network)
      if (!picked) {
        // Fail closed (don't silently downgrade to onchain-proof when the merchant asked for exact):
        // drop THIS rail with an actionable reason; ready() throws if NOTHING carries exact.
        return {
          skipReason:
            `${net.network}: \`exact: true\` found no known keyless facilitator for this network. ` +
            "Pass `exact: { settle: { facilitator } }`, `exact: { settle: 'self', relayer }`, or see " +
            'the coverage map (KNOWN_FACILITATORS / docs.piprail.com).',
        }
      }
      // Visibility (DEV-ONLY + browser, once at gate construction): name the delegated counterparty so
      // the auto-picked facilitator is observable. This is the HAPPY path (the merchant opted into
      // `exact: true`), so it's PRODUCTION-SILENT to avoid recurring stderr noise on a working gate —
      // the DEGRADE warning above is the one that stays visible in prod. Suppress in dev with
      // PIPRAIL_NO_HINTS. Production gates should pin `settle.facilitator`.
      if (typeof process === 'undefined' || (process?.env?.NODE_ENV !== 'production' && !process?.env?.PIPRAIL_NO_HINTS)) {
        console.warn(
          `[piprail] exact: keyless rail on ${net.network} auto-settles via ${picked.url} ` +
            '(zero-config; pin `exact.settle.facilitator` in production).'
        )
      }
      settle = { facilitator: picked.url }
    }

    // The SVM fee payer comes from one of two places: the merchant's own relayer (self mode), or
    // — in facilitator mode — the FACILITATOR's sponsor pubkey, so neither buyer nor merchant pays
    // gas. Bind the relayer (self) / read a configured fee-payer override (facilitator) up front.
    let relayer: WalletHandle | undefined
    let feePayer: string | undefined
    if (settle === 'self') {
      if (cfg.relayer === undefined) {
        throw new Error(
          "requirePayment: exact `settle: 'self'` needs a `relayer` wallet (the gas-paying key that " +
            'broadcasts the settle), e.g. exact: { settle: ' + "'self', relayer: { key } }."
        )
      }
      relayer = net.bindWallet(cfg.relayer)
    } else {
      feePayer = settle.feePayer // a configured fee-payer override, if any
    }

    const method = cfg.method ?? 'auto'
    let info = await net.resolveExactRail({ asset, method, relayer, feePayer })
    // Facilitator mode + the family couldn't resolve a rail WITHOUT a fee payer (Solana, no
    // override): discover the facilitator's own fee payer from its `GET /supported` and retry — so
    // neither buyer nor merchant pays gas. EVM resolves without a fee payer, so it never does this
    // extra fetch (the discovery is lazy, only when the first resolve came back empty). Native can
    // never carry exact, so don't waste a probe on it.
    if (!info && settle !== 'self' && !feePayer && asset !== 'native') {
      const discovered = await fetchFacilitatorFeePayer(settle.facilitator, net.network)
      if (!discovered) {
        // The facilitator's `/supported` yielded no fee payer for this network — it may be down, or
        // may not sponsor this chain. Drop this rail (don't brick a multi-rail gate) with a clear
        // reason; the merchant can pin it via `exact.settle.feePayer` to remove the runtime dependency.
        return {
          skipReason:
            `${net.network}: couldn't read a fee payer from the facilitator (${settle.facilitator}/supported) ` +
            `— it may be down, or may not sponsor this network. Set \`exact.settle.feePayer\` explicitly to ` +
            `remove the runtime dependency, switch to \`settle: 'self'\` with your own relayer, or retry.`,
        }
      }
      info = await net.resolveExactRail({ asset, method, relayer, feePayer: discovered })
    }
    if (!info) return {} // this asset/chain can't carry exact → onchain-proof only

    // A third-party facilitator settles the STANDARD `exact` schemes — EIP-3009 (EVM) and SVM
    // (Solana) — never PipRail's own Permit2-proxy method (a non-standard payload no facilitator
    // understands). We key off the method the driver ACTUALLY resolved (so this stays family-
    // agnostic — Solana resolves `'svm'`, never `'permit2'`, and is unaffected): a FORCED
    // `method: 'permit2'` + facilitator is an explicit contradiction → refuse loudly; an AUTO-
    // selected Permit2 (a non-EIP-3009 token, e.g. Binance-Peg USDC) is dropped to onchain-proof-only.
    if (settle !== 'self' && info.method === 'permit2') {
      if (cfg.method === 'permit2') {
        throw new Error(
          "requirePayment: exact `method: 'permit2'` can't be settled by a third-party facilitator — " +
            'facilitators settle the standard EIP-3009 (EVM) / SVM (Solana) / Algorand schemes, not PipRail’s ' +
            "Permit2 proxy. Use an EIP-3009 token (USDC / EURC) with the facilitator, or `settle: 'self'` " +
            '(your own relayer) to settle Permit2 yourself.'
        )
      }
      return {
        skipReason:
          `${net.network}: this token isn't EIP-3009 (auto-selected Permit2), which a third-party ` +
          `facilitator can't settle — it would serve onchain-proof only here. Use an EIP-3009 token ` +
          `(USDC / EURC) with the facilitator, or \`settle: 'self'\` to settle Permit2 yourself.`,
      }
    }

    const mode: ResolvedExactMode =
      settle === 'self'
        ? { kind: 'self', relayer: relayer! }
        : {
            kind: 'facilitator',
            url: settle.facilitator,
            ...(settle.authHeaders ? { authHeaders: settle.authHeaders } : {}),
          }
    return { rail: { method: info.method, ...(info.extra ? { extra: info.extra } : {}), mode } }
  }

  /**
   * Resolve a standard `upto` (metered) rail for one spec — the metered sibling of
   * {@link resolveExactRail}, but far simpler (self-settle ONLY, no facilitator mode, no
   * EIP-3009 vs Permit2 choice). Binds the merchant's own `relayer` (which becomes the bound
   * `witness.facilitator`) and delegates the chain-specific "can this asset/chain carry upto +
   * what `extra`" decision to the driver's {@link ResolvedNetwork.resolveUptoRail} SPI (EVM-only;
   * Permit2-proxy-gated, reads the token's EIP-712 domain). Returns the resolved rail, or `null`
   * when the family/asset/chain can't carry upto (a native coin, a non-proxy chain, a non-EVM
   * family). `server.ts` stays chain-agnostic — it never names a family, it just merges `extra`.
   */
  async function resolveUptoRail(
    net: ResolvedNetwork,
    asset: string
  ): Promise<ResolvedUptoRail | null> {
    const cfg = options.upto!
    if (!net.resolveUptoRail) return null // family has no `upto` (metered) settlement
    if (cfg.relayer === undefined) {
      throw new Error(
        "requirePayment: `upto` needs a `relayer` wallet (the gas-paying key that self-settles the " +
          'metered actual AND is the bound witness.facilitator), e.g. upto: { relayer: { key }, settleAmount }.'
      )
    }
    const relayer = net.bindWallet(cfg.relayer)
    const info = await net.resolveUptoRail({ asset, relayer })
    if (!info) return null // this asset/chain can't carry upto → onchain-proof only here
    return { method: info.method, ...(info.extra ? { extra: info.extra } : {}), relayer }
  }

  // Replay protection. The built-in store reserves the proof ref synchronously
  // (its critical section has no await), so two concurrent requests carrying
  // the same proof can't both be redeemed. A reservation is released if
  // verification fails, so submitting someone else's not-yet-confirmed tx
  // can't grief them.
  //
  // BOUNDED: an entry is evicted once it's older than the replay window
  // (`maxTimeoutSeconds`). That's safe because the driver's recency check
  // rejects any proof older than the window anyway (an onchain-proof tx that
  // aged out, an `exact` authorization past `validBefore` / already spent on
  // its on-chain nonce), so a dropped entry can never be replayed — and without
  // it the set would grow forever on a long-lived gate. The map keys by expiry
  // in insertion order (one fixed window), so eviction is an amortized-O(1)
  // front sweep.
  //
  // Provide isUsed/markUsed to share state across instances (e.g. Redis). A
  // custom store is checked, then marked only on success; make the check
  // atomic (SET NX) if you need the same concurrency guarantee, and give it its
  // own TTL (the window) so it stays bounded too.
  // A custom replay store needs BOTH a read (isUsed) and a write (markUsed). Supplying only one
  // would silently disable replay protection — the OR-gate activates the custom-store branch (so the
  // in-memory fallback is bypassed) while the missing half no-ops: only `isUsed` ⇒ nothing is ever
  // recorded (every proof replays); only `markUsed` ⇒ nothing is ever rejected. Fail loudly at
  // construction instead of half-arming a security control. Neither-supplied (default) and
  // both-supplied (intended) paths are unchanged → byte-identical.
  const hasIsUsed = typeof options.isUsed === 'function'
  const hasMarkUsed = typeof options.markUsed === 'function'
  if (hasIsUsed !== hasMarkUsed) {
    throw new Error(
      'requirePayment/createPaymentGate: `isUsed` and `markUsed` must be provided TOGETHER — a custom ' +
        'replay store needs both a read and a write. Supplying only ' +
        (hasIsUsed ? '`isUsed`' : '`markUsed`') +
        ' silently disables replay protection (double-spend). Provide both, or neither (the built-in in-memory store).'
    )
  }
  const hasCustomStore = hasIsUsed && hasMarkUsed
  const localUsed = new Map<string, number>() // ref(lowercased) → expiry epoch-ms
  const replayWindowMs = maxTimeoutSeconds * 1000

  /** Evict entries past the replay window. All share one fixed window, so they
   *  expire in insertion order — sweep from the oldest, stop at the first live one. */
  function pruneUsed(now: number): void {
    for (const [key, expiry] of localUsed) {
      if (expiry > now) break
      localUsed.delete(key)
    }
  }

  /** Reserve a proof ref. Returns true if it was ALREADY taken (→ reject). */
  async function claimTx(ref: string): Promise<boolean> {
    if (hasCustomStore) {
      return options.isUsed ? Boolean(await options.isUsed(ref)) : false
    }
    // EVM tx hashes are case-insensitive hex → normalize for the default store
    // (custom isUsed/markUsed above receive the RAW ref). The reserve below is
    // synchronous (prune + has + set, no await), closing the concurrent double-redeem race.
    const key = ref.toLowerCase()
    const now = Date.now()
    pruneUsed(now)
    if (localUsed.has(key)) return true
    localUsed.set(key, now + replayWindowMs)
    return false
  }

  /** Finalise a claim: keep it on success, release it on failure. */
  async function settleTx(ref: string, ok: boolean): Promise<void> {
    if (hasCustomStore) {
      if (ok && options.markUsed) await options.markUsed(ref)
      return
    }
    if (!ok) localUsed.delete(ref.toLowerCase())
  }

  function buildAccept(s: ResolvedSpec, nonce: string): X402AcceptEntry {
    return {
      scheme: 'onchain-proof',
      network: s.net.network,
      amount: s.amountBase.toString(),
      asset: s.asset,
      payTo: s.payTo,
      maxTimeoutSeconds,
      extra: {
        nonce,
        decimals: s.decimals,
        minConfirmations,
        amountFormatted: s.amountFormatted,
        ...(s.symbol ? { symbol: s.symbol } : {}),
      },
    }
  }

  /** The standard `exact` rail for a spec (only when `spec.exact` is resolved). The driver's
   *  chain-specific `extra` is merged in verbatim: EVM `eip3009` carries the token's EIP-712
   *  `name`/`version` (READ at resolution, never assumed; `permit2` omits them — it signs over
   *  the Permit2 contract's own domain); Solana carries `feePayer`/`tokenProgram`. */
  function buildExactAccept(s: ResolvedSpec): X402ExactAcceptEntry {
    const rail = s.exact!
    return {
      scheme: 'exact',
      network: s.net.network,
      amount: s.amountBase.toString(),
      asset: s.asset,
      payTo: s.payTo,
      maxTimeoutSeconds,
      extra: {
        assetTransferMethod: rail.method,
        minConfirmations,
        decimals: s.decimals,
        amountFormatted: s.amountFormatted,
        ...(s.symbol ? { symbol: s.symbol } : {}),
        ...(rail.extra as Partial<X402ExactAcceptEntry['extra']>),
      },
    }
  }

  /** The standard `upto` (metered) rail for a spec (only when `spec.upto` is resolved).
   *  Advertises `amount` = the MAX ceiling + `extra.facilitatorAddress` (the relayer the buyer
   *  signs into `witness.facilitator`). The driver's `extra` (`{ facilitatorAddress, name?,
   *  version? }`) is merged verbatim. */
  function buildUptoAccept(s: ResolvedSpec): X402UptoAcceptEntry {
    const rail = s.upto!
    return {
      scheme: 'upto',
      network: s.net.network,
      amount: s.amountBase.toString(), // the authorized MAX (base units)
      asset: s.asset,
      payTo: s.payTo,
      maxTimeoutSeconds,
      extra: {
        assetTransferMethod: 'permit2-upto',
        // facilitatorAddress comes from rail.extra; the spread below carries it (+ name/version).
        facilitatorAddress: (rail.extra?.facilitatorAddress as string) ?? '',
        minConfirmations,
        decimals: s.decimals,
        amountFormatted: s.amountFormatted,
        ...(s.symbol ? { symbol: s.symbol } : {}),
        ...(rail.extra as Partial<X402UptoAcceptEntry['extra']>),
      },
    }
  }

  /** Dual-advertise: for each spec, the standard `exact` rail first (when enabled), then the
   *  `upto` (metered) rail (when enabled), then the `onchain-proof` rail. A standard client
   *  picks `exact`/`upto`; a PipRail client picks `onchain-proof`. */
  function buildAccepts(specs: ResolvedSpec[], nonce: string): X402AnyAccept[] {
    const out: X402AnyAccept[] = []
    for (const s of specs) {
      if (s.exact) out.push(buildExactAccept(s))
      if (s.upto) out.push(buildUptoAccept(s))
      out.push(buildAccept(s, nonce))
    }
    return out
  }

  /** Build a fresh v2 challenge (new nonce). `error`/`extensions` are set on a
   *  rejected-proof re-challenge so a standard client can read the reason AND retry. */
  async function makeChallenge(
    resourceUrl: string,
    opts?: { error?: string; extensions?: Record<string, unknown> }
  ): Promise<{ challenge: X402Challenge; requiredHeader: string }> {
    const specs = await ready()
    const nonce = genNonce()
    // Opt-in discovery: emit `extensions.bazaar` so x402scan (which rejects a listing
    // with no input schema) accepts this resource from its 402 alone. Merged with any
    // rejection extensions; omitted entirely when neither is present (byte-identical default).
    const bazaar = options.discovery
      ? { bazaar: buildBazaarExtension(options.discovery === true ? {} : options.discovery) }
      : undefined
    const accepts = buildAccepts(specs, nonce)
    // Self-describe block (default-ON; opt out with `selfDescribe: false`). It rides in the
    // response BODY only — additive metadata in the spec-opaque `extensions` bag a standard
    // client ignores. Even an onchain-proof-only 402 a stock client can't pay becomes
    // self-announcing + actionable (install the SDK and pay).
    // What the endpoint DOES (agent-readability) — derived from the gate's description /
    // mimeType / discovery descriptor. `undefined` on a zero-config gate, so the
    // self-describe block (and the 402) stays byte-identical there.
    const endpointInfo = buildEndpointInfo({
      ...(options.description ? { description: options.description } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(typeof options.discovery === 'object' ? { descriptor: options.discovery } : {}),
    })
    const selfDescribe =
      options.selfDescribe === false
        ? undefined
        : buildSelfDescription({
            accepts,
            instruction: describeChallenge({ x402Version: 2, resource: { url: resourceUrl }, accepts }),
            ...(endpointInfo ? { endpoint: endpointInfo } : {}),
            ...(receiptsOn ? { verifiableReceipts: true } : {}),
          })
    // DEEP-MERGE the `piprail` key: a rejection's { code, detail } (from opts.extensions) and the
    // self-describe fields coexist as SIBLINGS, rejection keys WINNING on collision — `client.ts`
    // `readInvalidReason` reads `extensions.piprail.code`, so a naive top-level spread (one piprail
    // object replacing the other) would silently null every rejection reason on the wire.
    const rejectionExt = opts?.extensions ?? {}
    const rejectionPiprail = (rejectionExt.piprail as Record<string, unknown> | undefined) ?? {}
    // BODY extensions: the FULL block (self-describe + the rejection reason as siblings) + bazaar.
    const bodyPiprail: Record<string, unknown> = { ...(selfDescribe ?? {}), ...rejectionPiprail }
    const bodyExtensions = {
      ...bazaar,
      ...rejectionExt,
      ...(Object.keys(bodyPiprail).length > 0 ? { piprail: bodyPiprail } : {}),
    }
    // HEADER extensions: SLIM. The base64 PAYMENT-REQUIRED header is size-sensitive (proxy/CDN
    // ~8KB caps; Node's 16KB budget) and a client needs only `accepts[]` to pay, so the big
    // self-describe block is OMITTED from the header (it lives in the body). Keep the small
    // `bazaar` block (x402scan reads discovery from the HEADER) + the rejection `{code,detail}`
    // (a client reads the reason) — so the zero-config-path header stays byte-identical.
    const headerExtensions = {
      ...bazaar,
      ...(Object.keys(rejectionPiprail).length > 0 ? { piprail: rejectionPiprail } : {}),
    }
    const challenge: X402Challenge = {
      x402Version: 2,
      resource: {
        url: resourceUrl,
        ...(options.description ? { description: options.description } : {}),
        ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      },
      accepts,
      ...(opts?.error ? { error: opts.error } : {}),
      ...(Object.keys(bodyExtensions).length > 0 ? { extensions: bodyExtensions } : {}),
    }
    // The PAYMENT-REQUIRED header carries the slim challenge — the self-describe block is body-only.
    const headerChallenge: X402Challenge = {
      ...challenge,
      ...(Object.keys(headerExtensions).length > 0 ? { extensions: headerExtensions } : { extensions: undefined }),
    }
    return { challenge, requiredHeader: buildChallengeHeader(headerChallenge) }
  }

  async function challenge(resourceUrl = '') {
    return makeChallenge(resourceUrl)
  }

  /**
   * A self-describing HTML page for a 402 (the merchant serves it when the request's
   * `Accept` is `text/html`). Derived from the SAME challenge the merchant already built —
   * pure + sync; the SDK serves nothing. See `renderLandingPage` / `buildSelfDescription`.
   */
  function landingPage(ch: X402Challenge): string {
    return renderLandingPage(
      buildSelfDescription({ accepts: ch.accepts, instruction: describeChallenge(ch) })
    )
  }

  async function asChallenge(): Promise<VerifyPaymentResult> {
    const { challenge: c, requiredHeader } = await makeChallenge('')
    return { kind: 'challenge', challenge: c, requiredHeader, statusCode: 402 }
  }

  /**
   * A rejected proof, the CONFORMANT way: a fresh v2 PaymentRequired re-challenge
   * (full `accepts[]` so a standard client can retry) carrying the human reason in
   * `error` and the machine code in `extensions.piprail`. Replaces the old
   * non-conformant `{ status:'invalid' }` body.
   */
  async function rejection(code: string, detail: string): Promise<VerifyPaymentResult> {
    const { challenge: c, requiredHeader } = await makeChallenge('', {
      error: `${code}: ${detail}`,
      extensions: { piprail: { code, detail } },
    })
    return { kind: 'invalid', error: code, detail, challenge: c, requiredHeader, statusCode: 402 }
  }

  /** Enrich a wire receipt into the merchant-facing {@link PaidReceipt}: the gate
   *  already resolved the token's decimals/symbol, so format the SETTLED base-unit
   *  amount (never throws — falls back to base units) and surface the dedupe key. */
  function enrichReceipt(spec: ResolvedSpec, receipt: X402Receipt): PaidReceipt {
    let amountFormatted = receipt.amount
    try {
      amountFormatted = formatUnits(BigInt(receipt.amount), spec.decimals)
    } catch {
      /* keep the raw base-unit string if the amount can't be parsed */
    }
    return {
      ...receipt,
      decimals: spec.decimals,
      ...(spec.symbol ? { symbol: spec.symbol } : {}),
      amountFormatted,
      idempotencyKey: receipt.transaction,
    }
  }

  /** Surface a receipt-hook failure through the optional `onPaidError` seam. The
   *  observer is itself isolated — even a throwing error handler can't break a request. */
  function reportOnPaidError(error: unknown, receipt: PaidReceipt): void {
    if (!options.onPaidError) return
    try {
      options.onPaidError(error, receipt)
    } catch {
      /* an observer must never break the request either */
    }
  }

  /**
   * Run `onPaid` with TOTAL isolation. A synchronous throw AND an async rejection
   * are both caught and routed to `onPaidError` — neither can break the request nor
   * escape as an unhandledRejection (the old `try/catch` only caught sync throws, so
   * an `async` handler that rejected could crash the process). Returns the in-flight
   * promise so the caller can `await` it when `awaitOnPaid` is set.
   */
  function fireOnPaid(receipt: PaidReceipt): void | Promise<void> {
    if (!options.onPaid) return
    let outcome: void | Promise<void>
    try {
      outcome = options.onPaid(receipt)
    } catch (err) {
      reportOnPaidError(err, receipt)
      return
    }
    if (outcome != null && typeof (outcome as Promise<void>).then === 'function') {
      return Promise.resolve(outcome).catch((err) => reportOnPaidError(err, receipt))
    }
  }

  /** Fire `onPaid` after a settled payment: await it (record-before-serve) when
   *  `awaitOnPaid`, else fire-and-forget. Either way it can never throw upward. */
  async function deliverOnPaid(spec: ResolvedSpec, receipt: X402Receipt): Promise<void> {
    const paid = enrichReceipt(spec, receipt)
    if (options.awaitOnPaid) await fireOnPaid(paid)
    else void fireOnPaid(paid)
  }

  /**
   * Build the settled `kind:'paid'` result — and, when `receipts` is on, stamp a
   * verifiable-receipt extension onto the `PAYMENT-RESPONSE` header. The `nonce` is the
   * **trusted challenge nonce** the gate bound the rail against (`sig.payload.nonce` for
   * onchain-proof; **omitted** for `exact`, which is digest-bound and carries no challenge
   * nonce — never the per-rail authorization nonce, close-out "Nonce semantics"). When
   * `receipts.attest` is set AND the rail is EVM, it ALSO signs a Tier-2 EIP-712 delivery
   * attestation (`net.signReceipt`) and bundles it at the spec slot `info.receipt`; a non-EVM rail
   * (or the deferred JWS path) degrades to Tier-1 with a one-time warning. It is ISOLATED
   * exactly like `onPaid`: any throw in the receipt builder OR the signer degrades to the
   * plain/unsigned receipt header, never failing the 200.
   */
  async function buildPaidResult(
    spec: ResolvedSpec,
    receipt: X402Receipt,
    nonce?: string
  ): Promise<VerifyPaymentResult> {
    if (!receiptsOn) {
      return { kind: 'paid', receipt, receiptHeader: buildReceiptHeader(receipt) }
    }
    try {
      const stamped: X402Receipt = {
        ...receipt,
        ...(nonce ? { nonce } : {}),
        // §5.3: a suppressed tx is the empty string on the wire, never a missing key.
        ...(receiptIncludeTxHash ? {} : { transaction: '' }),
      }
      // Tier-2 (opt-in): sign the official EIP-712 delivery attestation when an EVM
      // wallet is supplied. The signer is ISOLATED — a failure degrades to the unsigned
      // Tier-1 receipt (never fails the 200), mirroring `onPaid`'s isolation.
      const attestation = await maybeSignAttestation(spec, stamped)
      const extensions = buildReceiptExtension({
        receipt: stamped,
        resource: { url: receiptResourceUrl },
        decimals: spec.decimals,
        ...(attestation ? { attestation } : {}),
      })
      return { kind: 'paid', receipt: stamped, receiptHeader: buildReceiptHeader(stamped, extensions) }
    } catch {
      return { kind: 'paid', receipt, receiptHeader: buildReceiptHeader(receipt) }
    }
  }

  /**
   * Sign the Tier-2 service-delivery attestation, or degrade gracefully. Returns the
   * {@link SignedReceipt} only when `receipts.attest = { wallet }` is set AND the resolved
   * rail's family exposes the optional EVM-only `signReceipt` SPI. A non-EVM rail or the
   * deferred `{ jws }` path warns ONCE and returns `undefined` (Tier-1). NEVER throws —
   * the §5.3 empty-string `transaction` rule is honored (a suppressed tx signs `''`).
   */
  async function maybeSignAttestation(
    spec: ResolvedSpec,
    stamped: X402Receipt
  ): Promise<import('./x402.js').SignedReceipt | undefined> {
    if (attestJws) {
      warnAttestDegrade('JWS attestation is not yet implemented (R3)')
      return undefined
    }
    if (attestWallet === undefined) return undefined
    if (typeof spec.net.signReceipt !== 'function') {
      warnAttestDegrade(`is EVM-only; the ${spec.net.family} rail can't sign an EIP-712 attestation`)
      return undefined
    }
    try {
      const wallet = spec.net.bindWallet(attestWallet)
      return await spec.net.signReceipt(wallet, {
        payTo: spec.payTo,
        network: spec.net.network,
        resourceUrl: receiptResourceUrl,
        payer: stamped.payer,
        issuedAt: nowUnixSeconds(stamped.verifiedAt),
        // §5.3: the signed message carries the empty string for a suppressed tx, never omitted.
        transaction: receiptIncludeTxHash ? stamped.transaction : '',
      })
    } catch {
      // A bad wallet / signer fault degrades to the unsigned Tier-1 receipt (isolated like onPaid).
      warnAttestDegrade('signing failed')
      return undefined
    }
  }

  /** Surface an `onFailed` throw through the optional `onFailedError` seam — itself isolated,
   *  the mirror of {@link reportOnPaidError}. */
  function reportOnFailedError(error: unknown, failure: FailedPayment): void {
    if (!options.onFailedError) return
    try {
      options.onFailedError(error, failure)
    } catch {
      /* an observer must never break the request either */
    }
  }

  /** Run `onFailed` with the SAME total isolation as `onPaid`: a synchronous throw AND an async
   *  rejection are both caught and routed to `onFailedError`, so a failure-notification hook can
   *  never break the request nor escape as an unhandledRejection. Returns the in-flight promise so
   *  the caller can `await` it when `awaitOnFailed` is set. */
  function fireOnFailed(failure: FailedPayment): void | Promise<void> {
    if (!options.onFailed) return
    let outcome: void | Promise<void>
    try {
      outcome = options.onFailed(failure)
    } catch (err) {
      reportOnFailedError(err, failure)
      return
    }
    if (outcome != null && typeof (outcome as Promise<void>).then === 'function') {
      return Promise.resolve(outcome).catch((err) => reportOnFailedError(err, failure))
    }
  }

  /** Fire `onFailed` after a REJECTED proof: await it (record-before-respond) when `awaitOnFailed`,
   *  else fire-and-forget. Builds the {@link FailedPayment} from the SAME `invalid` verdict the buyer
   *  is sent, so both sides see one consistent `code`. Either way it can never throw upward. */
  async function deliverOnFailed(
    result: Extract<VerifyPaymentResult, { kind: 'invalid' }>
  ): Promise<void> {
    const code = result.error as VerifyErrorCode
    const failure: FailedPayment = { code, detail: result.detail, transient: TRANSIENT_VERIFY_CODES.has(code) }
    if (options.awaitOnFailed) await fireOnFailed(failure)
    else void fireOnFailed(failure)
  }

  async function describe(resourceUrl = ''): Promise<ResourceDescription> {
    const specs = await ready()
    const accepts: PaymentRail[] = []
    for (const s of specs) {
      const base = {
        network: s.net.network,
        asset: s.asset,
        payTo: s.payTo,
        amount: s.amountBase.toString(),
        amountFormatted: s.amountFormatted,
        decimals: s.decimals,
        maxTimeoutSeconds,
        ...(s.symbol ? { symbol: s.symbol } : {}),
      }
      if (s.exact) accepts.push({ scheme: 'exact', ...base })
      if (s.upto) accepts.push({ scheme: 'upto', ...base })
      accepts.push({ scheme: 'onchain-proof', ...base })
    }
    return {
      url: resourceUrl,
      ...(options.description ? { description: options.description } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      accepts,
    }
  }

  /** Verify an `onchain-proof` proof (pay-first, prove-with-a-tx-ref). */
  async function verifyOnchainProof(sig: X402PaymentSignature): Promise<VerifyPaymentResult> {
    const specs = await ready()
    // Pick the offered option the proof claims (network + asset). Only used to SELECT;
    // every verified field comes from the server's own spec, so a forged `accepted`
    // can't redirect anything (a wrong asset/network just won't match).
    const spec = specs.find(
      (s) => s.net.network === sig.accepted.network && s.asset === sig.accepted.asset
    )
    if (!spec) {
      return rejection(
        'transfer_not_found',
        `Proof claims ${sig.accepted.asset} on ${sig.accepted.network}, which this resource ` +
          `doesn't accept (offered: ${specs.map((s) => `${s.asset}@${s.net.network}`).join(', ')}).`
      )
    }
    const ref = sig.payload.txHash
    if (await claimTx(ref)) return rejection('tx_already_used', `Proof ${ref} was already redeemed.`)

    let result: VerifyResult
    try {
      result = await spec.net.verify(ref, buildAccept(spec, sig.payload.nonce))
    } catch (err) {
      // A thrown verify (an RPC blip, not a definitive rejection) must NOT burn the
      // proof — release the claim so the still-valid payment can be retried, mirroring
      // the exact path. (Drivers return a VerifyResult; this guards an unexpected throw.)
      await settleTx(ref, false)
      throw err
    }
    if (!result.ok) {
      await settleTx(ref, false)
      return rejection(result.error, result.detail)
    }
    await settleTx(ref, true)
    await deliverOnPaid(spec, result.receipt)
    // onchain-proof is memo/digest-bound by the CHALLENGE nonce the buyer echoed — stamp it
    // so Template-A families re-verify off-chain (the trusted value, never a client-forgeable field).
    return await buildPaidResult(spec, result.receipt, sig.payload.nonce)
  }

  /**
   * Verify + settle a standard `exact` (EIP-3009) payment. Matches the inbound
   * authorization to an offered exact rail, replay-claims its nonce, then settles via
   * the merchant's own relayer (self) or a chosen facilitator. A {@link SettlementError}
   * (server-side settle failure) propagates so the adapter returns 5xx — and the claim
   * is released so the still-valid authorization can be re-presented.
   */
  async function verifyExact(exact: ParsedExactPayment): Promise<VerifyPaymentResult> {
    const specs = await ready()
    const exactSpecs = specs.filter((s) => s.exact)
    if (exactSpecs.length === 0) {
      return rejection('transfer_not_found', 'This resource offers no standard `exact` rail.')
    }
    // v2 clients echo the CAIP-2 network + asset → match precisely (an explicit
    // wrong network/asset must NOT match). A v1 client (flat, slug network, no asset)
    // can't be matched on CAIP-2, so it falls back to the single offered exact rail.
    // CAIP-2 is family-agnostic — `namespace:reference` for EVM (eip155:…) AND non-EVM
    // (solana:… / algorand:… / aptos:…), so a foreign non-EVM v2 payment filters by network
    // exactly like EVM (a v1 flat slug has no `:` and falls through to the slug fallback).
    const isCaip = exact.network.includes(':')
    let candidates = isCaip ? exactSpecs.filter((s) => s.net.network === exact.network) : exactSpecs
    if (exact.asset) {
      candidates = candidates.filter((s) => s.asset.toLowerCase() === exact.asset!.toLowerCase())
    }
    let spec = candidates[0]
    // A v1 slug claim (no CAIP-2 network, no asset) can't disambiguate across MULTIPLE
    // exact rails — picking candidates[0] would mis-route. Drop it so it falls through
    // to a clean transfer_not_found; only a single-exact-rail gate has an unambiguous
    // slug fallback (handled just below). The signature's domain chainId is the real
    // guard, but we shouldn't settle against the wrong rail's payTo/amount.
    if (!isCaip && !exact.asset && exactSpecs.length > 1) spec = undefined
    // v1 fallback ONLY: an ambiguous slug claim (no CAIP-2 network, no asset) on a
    // gate offering exactly one exact rail. A CAIP-2 claim that didn't match is a
    // genuine miss → reject (the signature's domain chainId is the real guard anyway).
    if (!spec && !isCaip && !exact.asset && exactSpecs.length === 1) spec = exactSpecs[0]
    if (!spec || !spec.exact) {
      return rejection(
        'transfer_not_found',
        `No \`exact\` rail offered for ${exact.network}${exact.asset ? `/${exact.asset}` : ''} ` +
          `(offered: ${exactSpecs.map((s) => `${s.asset}@${s.net.network}`).join(', ')}).`
      )
    }

    // Replay-claim the unique authorization id: EIP-3009's `authorization.nonce`, Permit2's
    // `permit2Authorization.nonce`, or — for SVM, which has no separate nonce field — the signed
    // transaction itself (stable per signed tx, the same on every re-presentation). The on-chain
    // nonce / signature state is a second, canonical guard.
    let nonce: string
    let evmAuth: { nonce: string; from: string } | null = null
    if ('senderAuth' in exact.payload && 'transaction' in exact.payload) {
      // Aptos: no separate nonce field (like SVM/Algorand). Canonicalize the signed tx + the sender
      // authenticator (decode → re-encode) and join — so malleable encodings of the SAME payment
      // collapse to one key. The sender's monotonic on-chain SEQUENCE NUMBER is the canonical second
      // backstop (Aptos rejects a reused sequence). Checked BEFORE the SVM branch (Aptos also has
      // `transaction`). Chain-agnostic — server.ts never BCS-decodes the tx.
      nonce = [exact.payload.transaction, exact.payload.senderAuth]
        .map((t) => {
          try {
            return Buffer.from(t, 'base64').toString('base64')
          } catch {
            return t
          }
        })
        .join('|')
    } else if ('transaction' in exact.payload) {
      // CANONICALIZE the base64 (decode → re-encode) before using it as the replay key — two
      // malleable encodings of the SAME signed tx (whitespace / missing padding / base64url) must
      // collapse to one key, so a mutated re-submission can't slip past the claim. Chain-agnostic;
      // the deterministic on-chain txid is the second backstop. A non-base64 string keys as-is.
      try {
        nonce = Buffer.from(exact.payload.transaction, 'base64').toString('base64')
      } catch {
        nonce = exact.payload.transaction
      }
    } else if ('paymentGroup' in exact.payload) {
      // Algorand: no separate nonce field (like SVM). Canonicalize EACH base64 element (decode →
      // re-encode) and join — so malleable encodings of the SAME group collapse to one key. The
      // group's atomic, deterministic on-chain txids are the canonical second backstop (algod
      // rejects a duplicate txid). Chain-agnostic — server.ts never msgpack-decodes the group.
      nonce = exact.payload.paymentGroup
        .map((t) => {
          try {
            return Buffer.from(t, 'base64').toString('base64')
          } catch {
            return t
          }
        })
        .join('|')
    } else if ('signedDelegateAction' in exact.payload) {
      // NEAR: no separate nonce field (the dedupe key is the signed delegate action itself).
      // Canonicalize the base64 (decode → re-encode) so malleable encodings of the SAME signed
      // action collapse to one key; the on-chain access-key nonce (single-use) is the second
      // backstop. Chain-agnostic — server.ts never Borsh-decodes the delegate action.
      try {
        nonce = Buffer.from(exact.payload.signedDelegateAction, 'base64').toString('base64')
      } catch {
        nonce = exact.payload.signedDelegateAction
      }
    } else if ('permit2Authorization' in exact.payload) {
      evmAuth = exact.payload.permit2Authorization
      nonce = evmAuth.nonce
    } else {
      evmAuth = exact.payload.authorization
      nonce = evmAuth.nonce
    }
    if (await claimTx(nonce)) {
      return rejection('tx_already_used', `Authorization ${evmAuth ? `nonce ${nonce}` : 'transaction'} was already redeemed.`)
    }

    const accept = buildExactAccept(spec)
    const mode = spec.exact.mode
    let result: VerifyResult
    try {
      if (mode.kind === 'self') {
        result = await spec.net.settleExactSelf!({ relayer: mode.relayer, payload: exact.payload, accept })
      } else {
        // SVM / Algorand / Aptos / NEAR rails carry the facilitator's `feePayer` (the gas sponsor);
        // EVM carries the token's EIP-712 domain. A fee-payer rail can't even be ADVERTISED without a
        // sponsor (resolveExactRail returns null, or the gate drops the rail when /supported yields
        // none), so a missing feePayer here is an invariant violation — fail loudly with a clear
        // SettlementError (gate 5xx) rather than forwarding an empty string to the facilitator.
        const ftMethod = accept.extra.assetTransferMethod
        const needsFeePayer =
          ftMethod === 'svm' || ftMethod === 'algorand' || ftMethod === 'aptos' || ftMethod === 'near'
        if (needsFeePayer && !accept.extra.feePayer) {
          throw new SettlementError(
            `exact settle: the ${ftMethod} facilitator rail is missing extra.feePayer (the gas sponsor) — cannot settle.`
          )
        }
        result = await settleViaFacilitator({
          url: mode.url,
          ...(mode.authHeaders ? { authHeaders: mode.authHeaders } : {}),
          // PipRail always builds a v2-shaped paymentRequirements (CAIP-2 network + `amount`),
          // so force x402Version:2 — echoing a v1 client's version here would hand the facilitator
          // a self-inconsistent request (v1 envelope, v2 requirements). The inner payload is
          // byte-identical across versions, so forwarding it verbatim is fine.
          x402Version: 2,
          paymentPayload: exact.raw,
          paymentRequirements: {
            scheme: 'exact',
            network: accept.network,
            asset: accept.asset,
            amount: accept.amount,
            payTo: accept.payTo,
            maxTimeoutSeconds: accept.maxTimeoutSeconds,
            extra: needsFeePayer
              ? { feePayer: accept.extra.feePayer! }
              : { name: accept.extra.name ?? '', version: accept.extra.version ?? '' },
          },
          receipt: { network: accept.network, asset: accept.asset, payTo: accept.payTo, amount: accept.amount },
          // The buyer address, for the receipt's `payer` fallback. EVM carries it in the
          // authorization; SVM doesn't (the facilitator returns the settled payer) → omit it.
          ...(evmAuth ? { payerHint: evmAuth.from } : {}),
        })
      }
    } catch (err) {
      // SettlementError (server-side) → release the claim so the still-valid
      // authorization can retry once the relayer/facilitator is fixed, then rethrow.
      await settleTx(nonce, false)
      throw err
    }

    if (!result.ok) {
      await settleTx(nonce, false)
      return rejection(result.error, result.detail)
    }
    await settleTx(nonce, true)
    await deliverOnPaid(spec, result.receipt)
    // `exact` is digest-bound (verified by tx/digest, not a memo nonce) and carries NO challenge
    // nonce — pass none. The in-scope `nonce` here is the per-rail AUTHORIZATION/dedupe key, which
    // must NOT be stamped as the receipt's challenge nonce (close-out "Nonce semantics").
    return await buildPaidResult(spec, result.receipt)
  }

  /**
   * Resolve the merchant's `settleAmount` return into a base-unit `bigint` clamped to `[0, max]`.
   * Accepts the x402 SettlementOverrides forms for ergonomic parity with the reference:
   *   • a `bigint`     — raw base units, used verbatim;
   *   • `"NN%"`        — that percent of the max, FLOORED (e.g. `"50%"` of 50000 → 25000);
   *   • `"$X"`         — a fiat-style decimal rounded to the token's decimals (`"$0.02"` @ 6dp → 20000);
   *   • a raw atomic   — a plain integer string (`"1858"`), used verbatim;
   *   • a decimal      — a plain decimal string (`"0.02"`), scaled by decimals.
   * Returns `null` for an UNPARSEABLE form (a merchant bug → the caller releases the nonce + rejects).
   * Negative or NaN never escapes; the final clamp-over-max is enforced in the driver (and re-checked
   * here defensively isn't needed — the driver rejects `> max` with `upto_settle_exceeds_max`).
   */
  function resolveSettleAmount(raw: bigint | string, maxAmount: bigint, decimals: number): bigint | null {
    if (typeof raw === 'bigint') return raw < 0n ? null : raw
    const s = raw.trim()
    if (s.length === 0) return null
    try {
      if (s.endsWith('%')) {
        const pct = s.slice(0, -1).trim()
        if (!/^\d+(\.\d+)?$/.test(pct)) return null
        // floor( max * pct / 100 ) — integer math via base-unit scaling to avoid float drift.
        // Scale the percentage to 4 dp, FLOORING excess precision (e.g. "33.333333%" → 33.3333%) —
        // `floorUnits` truncates rather than throwing, matching the "$X"/decimal branches below and
        // the documented "FLOORED" semantics (parseUnits would throw on >4dp → a misleading reject).
        const pctScaled = floorUnits(pct, 4) // e.g. "50" → 500000 (50.0000)
        return (maxAmount * pctScaled) / (100n * 10n ** 4n)
      }
      if (s.startsWith('$')) {
        const amt = s.slice(1).trim()
        return floorUnits(amt, decimals) // a "$X" fiat-style figure at the token's decimals
      }
      // A plain integer is raw atomic units; a plain decimal is scaled by decimals.
      if (/^\d+$/.test(s)) return BigInt(s)
      return floorUnits(s, decimals)
    } catch {
      return null
    }
  }

  /**
   * Verify + SELF-SETTLE a standard `upto` (metered) payment — Shape (A), callback-meter, inside
   * one `verify()` call (zero persistence, backendless). The metered sibling of {@link verifyExact}.
   * Lifecycle (§3.4): match the rail → CLAIM the Permit2 nonce (before metering, so even a
   * zero-charge burns it) → call the merchant's `settleAmount(ctx)` to get the metered actual →
   * `settleUptoSelf` the actual (≤ max; `0n` ⇒ a zero-charge receipt, no broadcast).
   *
   * AUDIT B3: the `settleAmount(ctx)` call AND `settleUptoSelf` are wrapped in ONE try/catch after
   * the nonce is claimed — on ANY throw `settleTx(nonce, false)` RELEASES the nonce (so the buyer's
   * still-valid authorization can be re-presented), rejects + fires onFailed, and rethrows ONLY
   * `SettlementError` (a genuine broadcast failure → gate 5xx); on a non-ok result also releases.
   * A SUCCESSFUL settle burns the nonce (at-most-once); a failure releases it.
   */
  async function verifyUpto(upto: ParsedUptoPayment): Promise<VerifyPaymentResult> {
    const specs = await ready()
    const uptoSpecs = specs.filter((s) => s.upto)
    if (uptoSpecs.length === 0) {
      return rejection('transfer_not_found', 'This resource offers no standard `upto` (metered) rail.')
    }
    // Match the rail exactly like exact: v2 echoes CAIP-2 network + asset; a v1 flat slug falls
    // back to the single offered upto rail (and is dropped if ambiguous across multiple).
    const isCaip = upto.network.includes(':')
    let candidates = isCaip ? uptoSpecs.filter((s) => s.net.network === upto.network) : uptoSpecs
    if (upto.asset) {
      candidates = candidates.filter((s) => s.asset.toLowerCase() === upto.asset!.toLowerCase())
    }
    let spec = candidates[0]
    if (!isCaip && !upto.asset && uptoSpecs.length > 1) spec = undefined
    if (!spec && !isCaip && !upto.asset && uptoSpecs.length === 1) spec = uptoSpecs[0]
    if (!spec || !spec.upto) {
      return rejection(
        'transfer_not_found',
        `No \`upto\` rail offered for ${upto.network}${upto.asset ? `/${upto.asset}` : ''} ` +
          `(offered: ${uptoSpecs.map((s) => `${s.asset}@${s.net.network}`).join(', ')}).`
      )
    }

    // Replay-claim the Permit2 nonce — BEFORE metering, so even a zero-charge burns it (at-most-once).
    const nonce = upto.payload.permit2Authorization.nonce
    if (await claimTx(nonce)) {
      return rejection('tx_already_used', `Authorization nonce ${nonce} was already redeemed.`)
    }

    const accept = buildUptoAccept(spec)
    const relayer = spec.upto.relayer
    let result: VerifyResult
    try {
      // 1) METER — the merchant callback picks the actual charge (this is where usage is read on
      //    the direct gate.verify() path). It's arbitrary merchant code → inside the guarded region.
      const rawAmount = await options.upto!.settleAmount({
        maxAmount: spec.amountBase,
        asset: spec.asset,
        network: spec.net.network,
        decimals: spec.decimals,
        ...(upto.raw ? { request: upto.raw } : {}),
      })
      const settleAmount = resolveSettleAmount(rawAmount, spec.amountBase, spec.decimals)
      if (settleAmount === null) {
        // An unparseable settleAmount form is a merchant bug — release the nonce + reject (the
        // buyer's auth survives for a corrected re-present), do NOT rethrow as a SettlementError.
        await settleTx(nonce, false)
        return rejection(
          'upto_settle_exceeds_max',
          `The settleAmount callback returned an unparseable amount (${String(rawAmount)}). Return a bigint, ` +
            `a raw/"NN%"/"$X" string, or 0.`
        )
      }
      // 2) SETTLE — verify vs the signed MAX + self-settle the actual (0n ⇒ zero receipt, no broadcast).
      result = await spec.net.settleUptoSelf!({ relayer, payload: upto.payload, accept, settleAmount })
    } catch (err) {
      // AUDIT B3: any throw after the nonce was claimed RELEASES it (the buyer's authorization is
      // still valid + re-presentable), then rethrow ONLY a SettlementError (a real broadcast failure
      // → gate 5xx). A non-SettlementError throw (e.g. the merchant's settleAmount callback threw) is
      // NOT a settlement failure — the release + a rejection lets the still-valid auth be re-presented.
      await settleTx(nonce, false)
      if (err instanceof SettlementError) throw err
      return rejection(
        'tx_reverted',
        `upto: metering/settle failed (${err instanceof Error ? err.message : String(err)}).`
      )
    }

    if (!result.ok) {
      await settleTx(nonce, false)
      return rejection(result.error, result.detail)
    }
    await settleTx(nonce, true)
    await deliverOnPaid(spec, result.receipt)
    // `upto` is digest-bound (verified by the Permit2 signature, not a memo nonce) and carries NO
    // challenge nonce — pass none (the in-scope `nonce` is the per-rail Permit2 dedupe key).
    return await buildPaidResult(spec, result.receipt)
  }

  /**
   * Verify an incoming `payment-signature` header value AND fire the merchant-side notification
   * for the verdict. On a settled proof, `onPaid` has already fired inside (record-before-serve);
   * here we fire `onFailed` on a REJECTED proof — so the merchant is notified of a failure exactly
   * as the buyer's client is. A no-proof `challenge` is the normal first leg, not a failure, so it
   * fires neither hook.
   */
  async function verify(
    paymentSignature: string | string[] | undefined
  ): Promise<VerifyPaymentResult> {
    const raw = normaliseHeader(paymentSignature)
    // The base64 path: decode once, then run the SAME object-dispatch as verifyObject.
    // `decodeBase64Json` returns null on garbage / a missing header — both fall through
    // to a fresh challenge inside resolveVerdictObject, byte-identical to before this split.
    const result = await resolveVerdictObject(raw === undefined ? undefined : decodeBase64Json(raw))
    if (result.kind === 'invalid') await deliverOnFailed(result)
    return result
  }

  /**
   * Verify an already-decoded PaymentPayload OBJECT (raw JSON, not base64) — the non-HTTP
   * transport seam (§3.7). Runs the SAME dispatch as {@link verify} on a plain object,
   * skipping only the base64 decode, and fires `onFailed` on a rejection exactly as the
   * HTTP path does. NO new verification state: the dispatch reads `sig.payload.nonce` from
   * the object, the gate re-derives every trusted field from its own config, and the one
   * replay set (`localUsed` / injected `isUsed`/`markUsed`) is shared across transports.
   */
  async function verifyObject(payload: unknown): Promise<VerifyPaymentResult> {
    const result = await resolveVerdictObject(payload)
    if (result.kind === 'invalid') await deliverOnFailed(result)
    return result
  }

  /**
   * Route an already-decoded PaymentPayload OBJECT to the right verifier (or a fresh
   * challenge). The pure dispatch over the object-accepting parser cores — shared by the
   * base64 `verify()` path (which decodes first) and the raw-JSON `verifyObject()` path.
   * `verify()`/`verifyObject()` wrap it to fire the failure hook so EVERY rejection path
   * is covered by one seam. `undefined`/`null` (no payload) → a fresh 402.
   */
  async function resolveVerdictObject(obj: unknown): Promise<VerifyPaymentResult> {
    if (obj === undefined || obj === null) return asChallenge()

    // 1) onchain-proof? A usable proof carries a v2 `accepted` with the network + asset
    //    it claims. parseSignatureObject stays lenient for transitional callers (a
    //    legacy top-level `scheme` with no `accepted`), so guard the missing field here.
    const sig = parseSignatureObject(obj)
    if (
      sig &&
      sig.accepted &&
      typeof sig.accepted.network === 'string' &&
      typeof sig.accepted.asset === 'string'
    ) {
      return verifyOnchainProof(sig)
    }

    // 2) standard `upto` (metered)? Checked BEFORE exact — its parser is gated strictly on
    //    `scheme === 'upto'` + a `witness.facilitator` string, so it never matches an exact
    //    Permit2 payload (no facilitator) and vice-versa. Scheme-discriminated, no ambiguity.
    const upto = parseUptoObject(obj)
    if (upto) return verifyUpto(upto)

    // 3) standard `exact` (EIP-3009)? The inner payload is identical across v1/v2 wire shapes.
    const exact = parseExactObject(obj)
    if (exact) return verifyExact(exact)

    // Unparseable / legacy-with-no-`accepted` → a fresh 402, never a 500.
    return asChallenge()
  }

  return { challenge, verify, verifyObject, describe, landingPage }
}

/* ----------------------------- Express middleware ----------------------------- */

export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>
  originalUrl?: string
  url?: string
}

export interface ExpressLikeResponse {
  setHeader: (name: string, value: string) => void
  status: (code: number) => unknown
  json: (body: unknown) => unknown
}

export type ExpressLikeNext = (err?: unknown) => void

export type ExpressLikeMiddleware = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressLikeNext
) => Promise<void> | void

/**
 * Express/Connect-style middleware. The 80% case — drop it in front of a
 * route handler and the route is paid-only. The driver auto-mounts on the
 * first request; config/driver errors are forwarded to `next(err)`.
 */
export function requirePayment(
  options: RequirePaymentOptions
): ExpressLikeMiddleware {
  // AUDIT B2: the `upto` (metered) rail is UNSUPPORTED through this Express middleware — it calls
  // `gate.verify()` then `next()` to the route handler, so settlement (inside `verifyUpto`) happens
  // BEFORE the handler serves and the metered usage isn't known yet. There is NO post-serve hook
  // (a `res.on('finish')` settle would fire after the body is flushed, can't influence it, and
  // re-introduces cross-call state — Shape (B), a permanent non-goal). Fail LOUD at construction
  // rather than silently mis-settle. Onchain-proof/exact gates are unaffected (no `upto`).
  if (options.upto) {
    throw new (class extends PipRailError {
      readonly code = 'UNSUPPORTED_SCHEME'
    })(
      "requirePayment: the 'upto' (metered) rail is unsupported through the Express middleware — it " +
        'settles before the route handler serves, so metered usage is unknown at settle time. Call ' +
        'gate.verify() directly (createPaymentGate) and meter inside settleAmount; see ' +
        'docs/accepting-payments/upto-rail-seller.md.'
    )
  }
  const gate = createPaymentGate(options)
  return async (req, res, next) => {
    let result: VerifyPaymentResult
    try {
      // Accept the v2 `PAYMENT-SIGNATURE` header OR the legacy v1 `X-PAYMENT` header
      // (a deprecated-but-common `exact` client sends the latter).
      result = await gate.verify(req.headers[HEADER_SIGNATURE] ?? req.headers[HEADER_SIGNATURE_V1])
    } catch (err) {
      // A server-side settle failure (relayer out of gas / facilitator down) is NOT
      // the payer's fault — return 5xx, never a 402 (which would tell them to re-pay).
      // Their signed authorization stays valid + unused. The gate ALWAYS also offers the
      // `onchain-proof` scheme, so name it as the explicit fallback: the buyer's one
      // remaining option is to pay that rail themselves (broadcasting the transfer + paying
      // the gas) — the graceful last resort when no facilitator can sponsor the gasless rail.
      if (err instanceof SettlementError) {
        res.status(502)
        res.json({
          x402Version: 2,
          error: 'settlement_failed',
          detail: err.message,
          fallback:
            'The gasless `exact` settlement failed. This resource also accepts the `onchain-proof` ' +
            'scheme — retry by paying that rail yourself (you broadcast the transfer and pay the gas). ' +
            'It is the fallback when no facilitator can sponsor the gas.',
        })
        return
      }
      next(err)
      return
    }

    switch (result.kind) {
      case 'paid':
        // Emit BOTH the v2 and v1 settlement headers so either client reads it.
        res.setHeader(HEADER_RESPONSE, result.receiptHeader)
        res.setHeader(HEADER_RESPONSE_V1, result.receiptHeader)
        return next()

      case 'challenge':
        res.setHeader(HEADER_REQUIRED, result.requiredHeader)
        res.status(result.statusCode)
        res.json(result.challenge)
        return

      case 'invalid':
        // Conformant rejection: a full v2 PaymentRequired re-challenge (with `accepts[]`
        // so a standard client can retry), reason in `error` + `extensions.piprail`.
        res.setHeader(HEADER_REQUIRED, result.requiredHeader)
        res.status(result.statusCode)
        res.json(result.challenge)
        return
    }
  }
}

/* ----------------------------- helpers ----------------------------- */

function normaliseHeader(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
