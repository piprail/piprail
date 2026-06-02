/**
 * The on-the-wire payment protocol. Self-contained — it runs entirely
 * between the agent and your server, with nothing hosted in between.
 *
 * Lowercase headers, no `X-` prefix:
 *   - payment-required   (server → client, base64 JSON challenge)
 *   - payment-signature  (client → server, base64 JSON proof)
 *   - payment-response   (server → client, base64 JSON receipt on 200)
 *
 * Scheme is `onchain-proof`: the agent pays on-chain and hands back a proof
 * reference (an EVM tx hash, a Solana signature, …); the server verifies
 * that transaction itself, locally, against its own RPC. No third party.
 *
 * This file is CHAIN-AGNOSTIC. Identifiers are plain strings in CAIP-2 /
 * base-unit form so any family (EVM, Solana, …) round-trips through the same
 * envelopes. Each PaymentDriver interprets them for its own chain.
 *
 * Wire format targets x402 v2 — github.com/coinbase/x402, specs/x402-specification-v2.md
 * (v2.0, 2025-12-9) + specs/transports-v2/http.md. The ENVELOPE is v2-conformant
 * (PaymentPayload carries `accepted`; SettlementResponse has `success` + `transaction`).
 * The SETTLEMENT SCHEME is our own `onchain-proof` (client pays on-chain first, proves
 * with a tx ref, server verifies locally) — permitted by spec §6 (a scheme owns its
 * `payload`) + §7 (self-hosted verification), but it does NOT interoperate with the
 * built-in `exact` scheme (which is signature + facilitator-broadcast). Deliberate.
 */

/** A CAIP-2 network id, e.g. `eip155:8453` or `solana:5eykt4Us…`. */
export type Caip2 = `${string}:${string}`
/** An asset id — chain-specific: an EVM `0x…` address, a Solana base58 mint, a
 * TON jetton master, a Stellar `CODE:ISSUER`, or `'native'`. */
export type AssetId = string
/** An account id — chain-specific: an EVM `0x…` address, a Solana base58 pubkey,
 * a TON address, or a Stellar `G…` account. */
export type AddressId = string

export interface X402ResourceObject {
  url: string
  description?: string
}

export interface X402AcceptEntry {
  scheme: 'onchain-proof'
  network: Caip2
  /** Amount in the token's base units (already scaled by decimals). */
  amount: string
  /** ERC-20 address / SPL mint, or 'native' for the chain's native coin. */
  asset: AssetId
  payTo: AddressId
  /** Payment is only accepted if mined within this many seconds of now. */
  maxTimeoutSeconds: number
  extra: {
    /** Single-use id echoed back in the proof. */
    nonce: string
    /** Token decimals, so the client can render the amount. */
    decimals: number
    /** Confirmations the client should wait before retrying. */
    minConfirmations: number
    /** Human-readable amount, e.g. "0.05". */
    amountFormatted: string
    symbol?: string
  }
}

export interface X402Challenge {
  x402Version: 2
  error: string | null
  resource: X402ResourceObject
  accepts: X402AcceptEntry[]
}

export interface X402PaymentSignature {
  x402Version: 2
  /**
   * x402 v2 PaymentPayload: the full PaymentRequirements entry the client chose
   * (carries `scheme` + `network`), echoed back from the challenge's `accepts[]`.
   */
  accepted: X402AcceptEntry
  /**
   * Scheme-defined payload. For `onchain-proof`: the challenge nonce + the proof
   * ref (`txHash` — a chain-specific id: an EVM tx hash, a Solana signature, a
   * TON locator, or a Stellar tx hash).
   */
  payload: { nonce: string; txHash: string }
}

export interface X402Receipt {
  scheme: 'onchain-proof'
  /**
   * x402 v2 SettlementResponse: settlement succeeded. Always `true` here — a
   * failed verification returns a 402, never a receipt.
   */
  success: true
  network: Caip2
  /**
   * x402 v2 SettlementResponse: the on-chain transaction id of the SETTLED
   * payment — a chain-specific id (an EVM/Tron/Stellar/XRPL/NEAR tx hash, a
   * Solana signature, or a Sui digest). This is the verified tx itself, NOT the
   * submit-time proof ref in `payload.txHash` (which can be a composite locator
   * on TON/NEAR). (Was `txHash` before v2 envelope conformance.)
   */
  transaction: string
  asset: AssetId
  amount: string
  payer: AddressId
  payTo: AddressId
  verifiedAt: string
}

/**
 * Why a verification failed — a closed, chain-agnostic vocabulary. Every code a
 * driver returns is in this union; a client/agent branches on it rather than
 * parsing prose. Surfaced to the agent in the 402 body's `error` field with a
 * human-readable `detail`. Some codes are family-specific (annotated below):
 * e.g. account-watch chains (TON, Stellar) can't distinguish "wrong recipient"
 * from "no payment", so both collapse to `transfer_not_found`.
 *
 * `transient` = the proof may simply not have propagated to the server's RPC
 * node yet; `definitive` = retrying won't change it. These labels are
 * informational for consumers — the built-in client retries EVERY code up to
 * `maxPaymentRetries` (a short backoff absorbs RPC lag); it does not branch on
 * the code.
 */
export type VerifyErrorCode =
  | 'tx_not_found' // proof tx not on chain yet — transient (RPC lag)
  | 'insufficient_confirmations' // mined, not enough confirmations yet — transient (EVM)
  | 'tx_reverted' // tx is on chain but failed / reverted — definitive
  | 'no_meta' // tx carries no metadata to inspect — definitive (Solana)
  | 'wrong_recipient' // paid, but not to payTo — definitive (EVM/Solana native path)
  | 'amount_too_low' // paid to payTo, but less than required — definitive
  | 'transfer_not_found' // no matching transfer (asset/amount/nonce) to payTo — definitive
  | 'payment_expired' // older than maxTimeoutSeconds (replay window) — definitive
  | 'tx_already_used' // proof already redeemed (replay) — definitive (gate-enforced)

/** The shape every driver's `verify()` returns. Shared by drivers + protocol. */
export type VerifyResult =
  | { ok: true; receipt: X402Receipt }
  | { ok: false; error: VerifyErrorCode; detail: string }

export const HEADER_REQUIRED = 'payment-required'
export const HEADER_SIGNATURE = 'payment-signature'
export const HEADER_RESPONSE = 'payment-response'

/* ----------------------------- base64 ----------------------------- */

function decodeBase64(b64: string): string {
  if (typeof atob === 'function') return atob(b64)
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  throw new Error('No base64 decoder available in this runtime.')
}

function encodeBase64(str: string): string {
  if (typeof btoa === 'function') return btoa(str)
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  throw new Error('No base64 encoder available in this runtime.')
}

function fromBase64Json<T>(b64: string): T | null {
  try {
    return JSON.parse(decodeBase64(b64)) as T
  } catch {
    return null
  }
}

function toBase64Json(value: object): string {
  return encodeBase64(JSON.stringify(value))
}

/* ----------------------------- network ids ----------------------------- */

/** EVM helper: 56 → "eip155:56". */
export function networkForChain(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`
}

/** EVM helper: "eip155:56" → 56. Returns null on anything else. */
export function chainIdFromNetwork(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network)
  if (!match || !match[1]) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) ? n : null
}

/* ----------------------------- build (server) ----------------------------- */

export function buildChallengeHeader(challenge: X402Challenge): string {
  return toBase64Json(challenge)
}

export function buildReceiptHeader(receipt: X402Receipt): string {
  return toBase64Json(receipt)
}

/* ----------------------------- build (client) ----------------------------- */

export function buildSignatureHeader(signature: X402PaymentSignature): string {
  return toBase64Json(signature)
}

/* ----------------------------- parse ----------------------------- */

/**
 * Parse the PAYMENT-REQUIRED challenge from a 402 response. Prefers the
 * `payment-required` header, falls back to the JSON body.
 */
export async function parseChallenge(
  response: Response
): Promise<X402Challenge | null> {
  const headerValue = response.headers.get(HEADER_REQUIRED)
  if (headerValue) {
    const parsed = fromBase64Json<unknown>(headerValue)
    if (isValidChallenge(parsed)) return parsed
  }
  try {
    const body = (await response.clone().json()) as unknown
    if (isValidChallenge(body)) return body
  } catch {
    /* body wasn't JSON */
  }
  return null
}

/** Parse the PAYMENT-RESPONSE receipt header on a 200 settlement. */
export function parseReceipt(response: Response): X402Receipt | null {
  const headerValue = response.headers.get(HEADER_RESPONSE)
  if (!headerValue) return null
  const parsed = fromBase64Json<unknown>(headerValue)
  return isValidReceipt(parsed) ? parsed : null
}

/** Parse a PAYMENT-SIGNATURE header value (server side). */
export function parseSignatureHeader(value: string): X402PaymentSignature | null {
  const parsed = fromBase64Json<unknown>(value)
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Record<string, unknown>
  // x402 v2 carries the chosen requirement in `accepted`; tolerate the legacy
  // top-level `scheme` shape too so older callers keep parsing.
  const accepted = v.accepted as Record<string, unknown> | undefined
  const scheme = accepted?.scheme ?? v.scheme
  if (scheme !== 'onchain-proof') return null
  const payload = v.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.txHash !== 'string' || typeof payload.nonce !== 'string') {
    return null
  }
  return parsed as X402PaymentSignature
}

function isValidChallenge(value: unknown): value is X402Challenge {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.x402Version !== 2) return false
  if (!Array.isArray(v.accepts) || v.accepts.length === 0) return false
  if (!v.resource || typeof v.resource !== 'object') return false
  return true
}

function isValidReceipt(value: unknown): value is X402Receipt {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.scheme !== 'onchain-proof') return false
  // v2 SettlementResponse names the proof ref `transaction`; tolerate legacy `txHash`.
  if (typeof v.transaction !== 'string' && typeof v.txHash !== 'string') return false
  if (typeof v.payer !== 'string') return false
  return true
}

/* ----------------------------- selection ----------------------------- */

/**
 * Pick the first accepts[] entry on the `onchain-proof` scheme whose network
 * satisfies `matches` (any chain family). Returns null if none match.
 */
export function pickAccept(
  challenge: X402Challenge,
  matches: (network: string) => boolean
): X402AcceptEntry | null {
  for (const accept of challenge.accepts) {
    if (accept.scheme === 'onchain-proof' && matches(accept.network)) return accept
  }
  return null
}
