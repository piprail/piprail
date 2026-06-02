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
 * The user got their tokens debited but the gated content is unreachable —
 * retry manually with the receipt nonce.
 */
export class PaymentTimeoutError extends PipRailError {
  readonly code = 'PAYMENT_TIMEOUT'
}

/** Paid, retried, still got 402. Means the server rejected our proof. */
export class MaxRetriesExceededError extends PipRailError {
  readonly code = 'MAX_RETRIES_EXCEEDED'
}

/**
 * The client refused to pay BEFORE any on-chain send — the quoted payment
 * exceeded the configured {@link PaymentPolicy} (amount/total ceiling, or a
 * chain/token/host outside the allowlist), or an `onBeforePay` hook returned
 * `false`. No funds moved. The message names which guard fired; inspect the
 * `quote` via `client.quote(url)` to see the full breakdown.
 */
export class PaymentDeclinedError extends PipRailError {
  readonly code = 'PAYMENT_DECLINED'
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

/** init.body was provided but isn't replayable (e.g. a one-shot ReadableStream). */
export class NonReplayableBodyError extends PipRailError {
  readonly code = 'NON_REPLAYABLE_BODY'
}

/**
 * The chosen chain belongs to one family (EVM, Solana, TON, Stellar, XRPL, Tron,
 * Sui, NEAR) but the wallet, payTo, or token was given in another family's form
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
 * { contractId, decimals } NEAR).
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
 * `npm install near-api-js`.
 */
export class MissingDriverError extends PipRailError {
  readonly code = 'MISSING_DRIVER'
}

/** No registered driver recognised the given `chain` value. */
export class UnsupportedNetworkError extends PipRailError {
  readonly code = 'UNSUPPORTED_NETWORK'
}
