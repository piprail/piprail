/**
 * ── The PipRail error model (the SDK-wide standard) ───────────────────────
 * Full standard: `sdk/ERRORS.md`. In short, errors surface through exactly two
 * channels, both chain-agnostic — an EVM, Solana, TON or Stellar failure looks
 * identical to the caller:
 *
 *   1. THROWN — a typed {@link PipRailError} subclass, each with a stable
 *      SCREAMING_SNAKE `.code`. For config / flow / wallet / registry problems
 *      the caller can act on (wrong-family wallet, missing driver, insufficient
 *      funds, retries exhausted, …). Catch with `err instanceof PipRailError`.
 *   2. RETURNED — `verify()` returns a `VerifyResult` `{ ok: false, error,
 *      detail }`, where `error` is a closed `VerifyErrorCode` (see x402.ts).
 *      This is how server-side proof verification rejects; the gate turns it
 *      into a 402 body `{ status: 'invalid', error, detail }` (built once by
 *      {@link toInvalidBody}), and the client relays that reason to the agent.
 *
 * Affordability ("wallet can't pay") always converges on ONE typed
 * {@link InsufficientFundsError}, by two mechanisms: message-regex drivers
 * (Solana, TON) call {@link toInsufficientFundsError}; structured-error drivers
 * (EVM via viem's `BaseError` walk, Stellar via Horizon `result_codes`) detect
 * it from typed data — but every one throws the same InsufficientFundsError.
 *
 * So whoever hits an error — a human, the merchant server, or an AI agent —
 * gets a typed `.code` (thrown) or a `VerifyErrorCode` (returned) plus a
 * human-readable message, never an opaque chain-library error.
 *
 * Base class: every error the SDK throws extends this, so consumers can filter
 * SDK-originated errors from arbitrary ones with:
 *
 *   catch (err) {
 *     if (err instanceof PipRailError) ...
 *   }
 */
export abstract class PipRailError extends Error {
  abstract readonly code: string
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}

/** Wallet balance too low for the quoted amount + gas. */
export class InsufficientFundsError extends PipRailError {
  readonly code = 'INSUFFICIENT_FUNDS'
}

/**
 * The payment can't be delivered because the RECIPIENT (`payTo`) isn't set up to
 * receive on this chain yet — a chain-level *state* requirement, NOT the payer's
 * balance. It's deliberately distinct from {@link InsufficientFundsError} so a
 * caller (especially an AI agent) can tell the two fixes apart:
 *
 *   - `INSUFFICIENT_FUNDS`  → fund the **payer** (more token, native gas, or reserve).
 *   - `RECIPIENT_NOT_READY` → set up the **recipient**, e.g.
 *       · XRPL    — activate the account (it must hold ≥1 XRP base reserve to exist);
 *       · Stellar — the account must exist (≥1 XLM reserve) and hold a trustline for the asset;
 *       · NEAR    — `storage_deposit`-register the recipient on the NEP-141 token (~0.00125 NEAR).
 *
 * The message states the requirement and the fix in plain language **and echoes
 * the raw chain code** (e.g. `(XRPL: tecNO_DST_INSUF_XRP)`), while the untouched
 * chain error is preserved on `.cause` for deeper debugging. Chains with no
 * receive prerequisite (EVM, Solana, Sui, Aptos, Tron, and native TON/NEAR) never throw it.
 */
export class RecipientNotReadyError extends PipRailError {
  readonly code = 'RECIPIENT_NOT_READY'
}

/**
 * Best-effort: turn a chain library's "wallet can't afford it" error into the
 * SDK's typed {@link InsufficientFundsError}, by matching its message. Drivers
 * WITHOUT structured error data (Solana, TON) call this in their `send()` catch
 * and rethrow the original on a miss:
 *
 *   catch (err) { throw toInsufficientFundsError(err) ?? err }
 *
 * Drivers WITH structured data (EVM via viem `BaseError.walk`, Stellar via
 * Horizon `result_codes`) detect affordability from that data but still throw
 * the SAME InsufficientFundsError, and fall through to this as a message-level
 * backstop so the two paths can't drift. A miss returns null, so the original
 * (still descriptive) error propagates unchanged — never swallowed.
 */
export function toInsufficientFundsError(
  err: unknown
): InsufficientFundsError | null {
  const message = err instanceof Error ? err.message : String(err)
  if (
    /insufficient (funds|balance|lamports|fee)|not enough|exceeds (the )?balance|underfunded|low[_ ]?reserve|debit the account/i.test(
      message
    )
  ) {
    return new InsufficientFundsError(
      err instanceof Error ? err.message : 'Insufficient funds for the payment.',
      { cause: err }
    )
  }
  return null
}

/** Paywall is on chain X, client wallet is on chain Y. */
export class WrongChainError extends PipRailError {
  readonly code = 'WRONG_CHAIN'
}

/**
 * Broadcast confirmed on-chain but server didn't return 200 within timeout.
 * The user got their tokens debited but the gated content is unreachable.
 *
 * `.ref` is the on-chain proof (tx hash / signature / locator) that was already
 * broadcast. **Re-verify or re-submit `ref` — never re-pay** (a fresh payment
 * would double-spend). The same proof stays valid until the server's
 * `maxTimeoutSeconds` recency window elapses (default 600s).
 */
export class PaymentTimeoutError extends PipRailError {
  readonly code = 'PAYMENT_TIMEOUT'
  /** The already-broadcast proof ref — recover with it, don't re-pay. */
  readonly ref?: string
  constructor(message: string, options?: ErrorOptions & { ref?: string }) {
    super(message, options)
    this.ref = options?.ref
  }
}

/**
 * Paid, retried, still got 402 — the server rejected our proof on every attempt.
 *
 * `.ref` is the on-chain proof that was broadcast. The rejection may be transient
 * (the server's RPC node lagging/throttled and not yet seeing the tx) — so
 * **re-verify or re-submit `ref` before doing anything else; never re-pay**, or
 * you risk a double payment. The proof stays redeemable until the server's
 * `maxTimeoutSeconds` recency window elapses (default 600s). A persistent
 * rejection with a definitive code (`amount_too_low`, `wrong_recipient`, …)
 * means the proof genuinely doesn't satisfy the challenge.
 */
export class MaxRetriesExceededError extends PipRailError {
  readonly code = 'MAX_RETRIES_EXCEEDED'
  /**
   * The proof ref — recover with it, don't re-pay. Its meaning depends on the
   * scheme: for `onchain-proof` it's the already-broadcast transaction ref
   * (re-verify or re-submit it). For a standard `exact` rail it's the EIP-3009
   * authorization NONCE (a `0x…` 32-byte value, NOT a tx hash) — re-PRESENT the
   * same signed authorization, never re-sign a fresh nonce; check the token's
   * `authorizationState(from, nonce)` before assuming it didn't settle.
   */
  readonly ref?: string
  constructor(message: string, options?: ErrorOptions & { ref?: string }) {
    super(message, options)
    this.ref = options?.ref
  }
}

/**
 * A typed, machine-readable discriminator on a {@link PaymentDeclinedError} so an
 * agent can branch on WHY a payment was refused WITHOUT regexing the human
 * message. It's a HINT layered on top of the always-reliable `.code`
 * (`'PAYMENT_DECLINED'`) — the two-channel error model is unchanged; this adds NO
 * new `.code`. Values:
 *   - `'POLICY'`         — a chain/host/token/per-payment cap refused it.
 *   - `'BUDGET'`         — the per-(network,asset) lifetime `maxTotal` cap.
 *   - `'OUTSIDE_WINDOW'` — the rolling `windowTotal` cap (wait for it to slide).
 *   - `'SESSION_EXPIRED'`— the session TTL elapsed. **TERMINAL** — every payment
 *                          this process is now refused; do NOT retry, restart/extend the TTL.
 *   - `'APPROVAL'`       — an `onBeforePay` approval hook said no (e.g. an MCP
 *                          human-in-the-loop decline). Terminal for this pay — do NOT auto-retry.
 */
export type DeclineReasonCode =
  | 'POLICY'
  | 'BUDGET'
  | 'OUTSIDE_WINDOW'
  | 'SESSION_EXPIRED'
  | 'APPROVAL'

/**
 * The client refused to pay BEFORE any on-chain send — the quoted payment
 * exceeded the configured {@link PaymentPolicy} (amount/total ceiling, a
 * chain/token/host outside the allowlist, or the session's time envelope), or an
 * `onBeforePay` hook returned `false`. No funds moved. The message names which
 * guard fired; inspect the `quote` via `client.quote(url)` to see the full
 * breakdown.
 *
 * `.reasonCode` is an optional, typed {@link DeclineReasonCode} the client stamps
 * so an agent can branch on the cause (and spot a TERMINAL `'SESSION_EXPIRED'` /
 * `'APPROVAL'` it must not retry) without parsing the prose. `.code` stays
 * `'PAYMENT_DECLINED'`.
 */
export class PaymentDeclinedError extends PipRailError {
  readonly code = 'PAYMENT_DECLINED'
  /** Why it was declined, as a typed enum (a hint; `.code` is the reliable channel). */
  readonly reasonCode?: DeclineReasonCode
  constructor(
    message: string,
    options?: ErrorOptions & { reasonCode?: DeclineReasonCode }
  ) {
    super(message, options)
    this.reasonCode = options?.reasonCode
  }
}

/**
 * The payment broadcast but didn't confirm within the driver's polling window
 * (EVM: minConfirmations; Solana: commitment; TON: seqno; Stellar: ledger
 * visibility). The tx may still confirm — re-check the proof ref. Distinct from
 * {@link PaymentTimeoutError}, which is the SERVER not responding *after* a
 * confirmed payment.
 */
export class ConfirmationTimeoutError extends PipRailError {
  readonly code = 'CONFIRMATION_TIMEOUT'
}

/**
 * A standard `exact` payment was VALID (signature recovered, params checked,
 * simulation passed) but SETTLEMENT failed for a SERVER-side reason — the
 * merchant's own relayer couldn't broadcast `transferWithAuthorization` (out of
 * gas, RPC down, dropped tx), or a Mode-B facilitator returned a transport/auth
 * error. This is NOT the payer's fault: their signed EIP-3009 authorization is
 * still valid and its nonce UNUSED, so it can be re-presented once the merchant
 * fixes their relayer/facilitator. The gate THROWS this (it's an operational
 * problem to fix, not a proof to reject), so a framework adapter returns 5xx —
 * never a 402, which would wrongly tell the payer to re-pay. `.cause` carries the
 * raw chain/HTTP error. (Server-side; the `onchain-proof` rail can't raise it —
 * there the payer broadcasts, so there's nothing for the merchant to settle.)
 */
export class SettlementError extends PipRailError {
  readonly code = 'SETTLEMENT_FAILED'
}

/** Server returned 402 but the PAYMENT-REQUIRED envelope was missing or malformed. */
export class InvalidEnvelopeError extends PipRailError {
  readonly code = 'INVALID_ENVELOPE'
}

/**
 * The envelope didn't include any accepts[] entry compatible with the
 * client's chain id (or all entries used unsupported schemes).
 */
export class NoCompatibleAcceptError extends PipRailError {
  readonly code = 'NO_COMPATIBLE_ACCEPT'
}

/**
 * The client was asked to pay a SCHEME the bound chain family/asset/signer can't
 * settle, and no fallback rail was offered. Specifically: a standard `exact` rail
 * on a non-EVM family (only EVM ships the buyer `payExact`); an `exact` rail for a
 * token that isn't EIP-3009 (USDT needs Permit2, native isn't exact-payable, a
 * plain ERC-20 has no `transferWithAuthorization`); or an `exact` rail whose signer
 * is a contract / EIP-1271 / EIP-7702-delegated account (no recoverable ECDSA sig).
 *
 * Distinct from {@link NoCompatibleAcceptError} (no rail for the network at all)
 * and {@link WrongFamilyError} (the wallet/payTo/token was given in another
 * family's shape). The fix is usually "enable/keep an `onchain-proof` rail" or
 * "pay with a supported chain/token". Thrown by the client / the EVM driver.
 */
export class UnsupportedSchemeError extends PipRailError {
  readonly code = 'UNSUPPORTED_SCHEME'
}

/** init.body was provided but isn't replayable (e.g. a one-shot ReadableStream). */
export class NonReplayableBodyError extends PipRailError {
  readonly code = 'NON_REPLAYABLE_BODY'
}

/**
 * The chosen chain belongs to one family (EVM, Solana, TON, Stellar, XRPL, Tron,
 * Sui, NEAR, Aptos, Algorand) but the wallet, payTo, or token was given in another family's form
 * (e.g. an `0x…` payTo on Solana, or a `{ mint }` token on a Stellar chain).
 */
export class WrongFamilyError extends PipRailError {
  readonly code = 'WRONG_FAMILY'
}

/**
 * A built-in token symbol was requested that the chosen chain doesn't ship
 * (e.g. `token: 'DOGE'`). Use a symbol the chain ships, `'native'`, or pass the
 * token by full descriptor ({ address, decimals } EVM/Tron · { mint, decimals }
 * Solana · { master, decimals } TON · { issuer, code, decimals } Stellar ·
 * { issuer, currencyHex, decimals } XRPL · { coinType, decimals } Sui ·
 * { contractId, decimals } NEAR · { metadata, decimals } Aptos ·
 * { assetId, decimals } Algorand).
 */
export class UnknownTokenError extends PipRailError {
  readonly code = 'UNKNOWN_TOKEN'
}

/**
 * The requested chain family couldn't be mounted. Drivers auto-mount on first
 * use, so this means its optional peer deps aren't installed — Solana:
 * `npm install @solana/web3.js @solana/spl-token bs58`; TON:
 * `npm install @ton/ton @ton/core @ton/crypto`; Stellar:
 * `npm install @stellar/stellar-sdk`; XRPL: `npm install xrpl`; Tron:
 * `npm install tronweb`; Sui: `npm install @mysten/sui`; NEAR:
 * `npm install near-api-js`; Aptos: `npm install @aptos-labs/ts-sdk`;
 * Algorand: `npm install algosdk`.
 */
export class MissingDriverError extends PipRailError {
  readonly code = 'MISSING_DRIVER'
}

/** No registered driver recognised the given `chain` value. */
export class UnsupportedNetworkError extends PipRailError {
  readonly code = 'UNSUPPORTED_NETWORK'
}
