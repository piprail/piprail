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
  /** The resource's response content-type, e.g. 'application/json' (v2 ResourceInfo, optional). */
  mimeType?: string
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

/**
 * A standard x402 `exact` rail (EVM / EIP-3009) — the interop rail a PipRail gate
 * advertises ALONGSIDE its `onchain-proof` rail (dual-advertise) so any standard
 * x402 client can pay it. Same v2 PaymentRequirements skeleton as
 * {@link X402AcceptEntry}; only `scheme` and `extra` differ. The `extra` carries
 * the EIP-712 domain a payer signs over — `name`/`version` are READ from the token
 * contract by the gate (never assumed), since e.g. USDC's domain name is "USD Coin",
 * not the "USDC" symbol.
 */
export interface X402ExactAcceptEntry {
  scheme: 'exact'
  network: Caip2
  amount: string
  asset: AssetId
  payTo: AddressId
  maxTimeoutSeconds: number
  extra: {
    /** The exact-EVM transfer method. PipRail self-settles EIP-3009 today. */
    assetTransferMethod: 'eip3009'
    /** EIP-712 domain name of the token. OPTIONAL per the exact-EVM scheme (only
     *  `assetTransferMethod` is required) — a foreign rail may omit it. NEVER assumed
     *  from the symbol (USDC's on-chain name() is "USD Coin", not "USDC"); a PipRail gate
     *  READS it on-chain, and the PipRail buyer RE-DERIVES it on-chain and ignores this. */
    name?: string
    /** EIP-712 domain version of the token (USDC: "2"). OPTIONAL (see `name`); read/re-derived on-chain. */
    version?: string
    /** Confirmations the gate waits for before granting access — mirrors the gate's
     *  `minConfirmations`, so the exact rail honours the same reorg safety as onchain-proof.
     *  A PipRail convenience (standard clients ignore unknown keys). */
    minConfirmations?: number
    /** Token decimals — a PipRail convenience (standard clients ignore unknown keys). */
    decimals?: number
    /** Human-readable amount, e.g. "0.05" — a PipRail convenience. */
    amountFormatted?: string
    symbol?: string
  }
}

/** A challenge `accepts[]` entry — either PipRail's `onchain-proof` rail or a standard `exact` rail. */
export type X402AnyAccept = X402AcceptEntry | X402ExactAcceptEntry

export interface X402Challenge {
  x402Version: 2
  /**
   * Optional human-readable reason (v2 `error?: string`). PipRail EMITS it only on a
   * rejected-proof re-challenge (omitted on a fresh challenge). Typed to also tolerate
   * `null` when PARSING a foreign challenge — some deployed servers send `error: null`.
   */
  error?: string | null
  resource: X402ResourceObject
  accepts: X402AnyAccept[]
  /** v2 optional extensions. PipRail stamps the machine-readable rejection reason here on a
   *  rejected-proof re-challenge: `{ piprail: { code, detail } }`. Omitted otherwise. */
  extensions?: Record<string, unknown>
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

/**
 * The EIP-3009 authorization a payer signs for a standard `exact` rail. All
 * numeric fields are DECIMAL strings on the wire (value, validAfter, validBefore);
 * `nonce` is a 0x-prefixed 32-byte hex. Identical shape across x402 v1 and v2.
 */
export interface ExactAuthorizationWire {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

/** The `payload` a client sends for an `exact` rail: an EIP-3009 signature + its authorization. */
export interface ExactPaymentPayload {
  signature: string
  authorization: ExactAuthorizationWire
}

/**
 * What {@link parseExactPaymentHeader} extracts from an inbound `exact` payment,
 * normalised across the v1 (`X-PAYMENT`, flat `{scheme,network,payload}`, network
 * slug) and v2 (`PAYMENT-SIGNATURE`, `{accepted,payload}`, CAIP-2 network) wire
 * shapes. `network`/`asset` are the CLIENT's claim — used only to MATCH an offered
 * rail; the gate re-derives every verified field from its own trusted rail.
 */
export interface ParsedExactPayment {
  x402Version: number
  /** The client's claimed network (slug or CAIP-2) — for matching, not trust. */
  network: string
  /** The client's claimed asset, if present (v2 `accepted.asset`). */
  asset?: string
  payload: ExactPaymentPayload
  /** The full decoded PaymentPayload, for verbatim forwarding to a facilitator (Mode B). */
  raw: Record<string, unknown>
}

export interface X402Receipt {
  scheme: 'onchain-proof' | 'exact'
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
  | 'signature_invalid' // exact rail: the EIP-712 authorization signature didn't recover to the payer — definitive (EVM exact)

/** The shape every driver's `verify()` returns. Shared by drivers + protocol. */
export type VerifyResult =
  | { ok: true; receipt: X402Receipt }
  | { ok: false; error: VerifyErrorCode; detail: string }

export const HEADER_REQUIRED = 'payment-required'
export const HEADER_SIGNATURE = 'payment-signature'
export const HEADER_RESPONSE = 'payment-response'

/*
 * ── x402 protocol version posture (read this before touching anything v1) ──────
 *
 * x402 **v2 REPLACED v1** on the wire — it is not a layer over it: the payment
 * header moved `X-PAYMENT` → `payment-signature`, the 402 challenge moved from a
 * plain JSON body (`maxAmountRequired`, network *slugs* like `base`) into a base64
 * `payment-required` header (`amount`, CAIP-2 `eip155:8453`), and `x402Version`
 * went 1 → 2. The v2 spec is silent on v1; the reference SDKs keep v1 alive only
 * as backward-compat. There is no announced end-of-life.
 *
 * PipRail's stance is **Postel's law — emit strict v2, accept liberal v1 + v2:**
 *   • EMIT  → only v2. Challenges, receipts, and the primary response header are v2.
 *   • ACCEPT → v2 AND v1. The gate also reads the v1 `x-payment` header, the v1 flat
 *              payload shape, `maxAmountRequired`, slug networks, and the v1 `txHash`
 *              receipt field — and echoes the v1 response header too.
 *
 * Why keep v1 *accept* (it is NOT dead weight): the current reference client
 * `@x402/fetch` is v2, but the still-deployed original `x402-fetch` / `x402-express`
 * / `x402-next` / umbrella `x402` packages — and agents pinned to v1 — send v1, and
 * facilitators (e.g. PayAI) still advertise a v1 rail. Dropping v1 *accept* would
 * silently break those payers for zero benefit. It is a sunsettable compat shim,
 * not removable today. (PipRail emits no v1 *body* on its own paths — the v1
 * `x-payment-response` header it sets carries the same v2 receipt body, a header-NAME
 * echo, not a v1-shaped receipt; the lone emitter of a true v1-shape payload is the
 * `encodeXPaymentHeader` UTILITY, whose flat shape every gate + facilitator still accepts.)
 */
export const HEADER_SIGNATURE_V1 = 'x-payment'
export const HEADER_RESPONSE_V1 = 'x-payment-response'

/* ----------------------------- base64 ----------------------------- */
//
// UTF-8 SAFE in every runtime. `btoa`/`atob` are Latin1-only — and modern Node
// defines them globally, so a naive `btoa`-first path silently breaks on any
// non-ASCII byte (a chain error `detail`, a token symbol, an `…` in a viem
// message). We prefer `Buffer` (UTF-8 native) and, where only `btoa`/`atob`
// exist (the browser), bridge through `TextEncoder`/`TextDecoder`.

function encodeBase64(str: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function' && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }
  throw new Error('No base64 encoder available in this runtime.')
}

function decodeBase64(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  if (typeof atob === 'function' && typeof TextDecoder !== 'undefined') {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }
  throw new Error('No base64 decoder available in this runtime.')
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

/**
 * Build the v2 PAYMENT-SIGNATURE header value for a standard x402 `exact` payment:
 * base64 of `{ x402Version: 2, accepted, payload }`. `accepted` is the chosen rail
 * echoed back VERBATIM from the challenge's `accepts[]` (preserving any extra keys a
 * facilitator needs); `payload` is the EIP-3009 `{ signature, authorization }` the
 * buyer's EVM driver produced. Chain-agnostic (pure JSON/base64) — the driver owns
 * the signing, this only frames it for the wire. Round-trips through
 * {@link parseExactPaymentHeader}. (The `onchain-proof` counterpart is
 * {@link buildSignatureHeader}; the v1 flat-shape utility is `encodeXPaymentHeader`.)
 */
export function buildExactSignatureHeader(input: {
  accepted: X402ExactAcceptEntry
  payload: ExactPaymentPayload
}): string {
  return toBase64Json({ x402Version: 2, accepted: input.accepted, payload: input.payload })
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

/** Parse the PAYMENT-RESPONSE receipt header on a 200 settlement. Reads the v2
 *  `payment-response` header, falling back to the v1 `x-payment-response` a foreign
 *  server may set. Returns a fully-formed {@link X402Receipt} only (a bare foreign
 *  exact SettleResponse without a `payer` is read by {@link parseSettleResponse}). */
export function parseReceipt(response: Response): X402Receipt | null {
  const headerValue =
    response.headers.get(HEADER_RESPONSE) ?? response.headers.get(HEADER_RESPONSE_V1)
  if (!headerValue) return null
  const parsed = fromBase64Json<unknown>(headerValue)
  return isValidReceipt(parsed) ? parsed : null
}

/**
 * A standard x402 SettleResponse as the BUYER reads it off a settled (non-402)
 * response. The `success` flag is authoritative: `false` is an EXPLICIT facilitator/
 * server REJECTION (the buyer must NOT record a spend), `true` is an affirmative
 * settlement. `transaction` is the on-chain settle tx the facilitator broadcast.
 */
export interface SettleOutcome {
  success: boolean
  transaction?: string
  network?: string
  payer?: string
  errorReason?: string
}

/**
 * Read a standard x402 SettleResponse for the BUYER, from the v2 `payment-response`
 * header (or the v1 `x-payment-response` fallback). Returns `null` when neither
 * header is present, unparseable, or carries no boolean `success` — i.e. when the
 * server served the resource WITHOUT echoing a settle result, which the exact buyer
 * treats as an affirmative 2xx settlement (receipt-less). When a body IS present with
 * a boolean `success`, that flag is returned verbatim: ONLY an explicit
 * `success: false` is a rejection. Used by the exact pay path to tell a real
 * settlement from a phantom one (never record a spend on `success:false`).
 */
export function parseSettleResponse(response: Response): SettleOutcome | null {
  const headerValue =
    response.headers.get(HEADER_RESPONSE) ?? response.headers.get(HEADER_RESPONSE_V1)
  if (!headerValue) return null
  const parsed = fromBase64Json<Record<string, unknown>>(headerValue)
  if (!parsed || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') return null
  return {
    success: parsed.success,
    ...(typeof parsed.transaction === 'string' ? { transaction: parsed.transaction } : {}),
    ...(typeof parsed.network === 'string' ? { network: parsed.network } : {}),
    ...(typeof parsed.payer === 'string' ? { payer: parsed.payer } : {}),
    ...(typeof parsed.errorReason === 'string' ? { errorReason: parsed.errorReason } : {}),
  }
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

/**
 * Parse an inbound `exact` payment from a base64 header value (`PAYMENT-SIGNATURE`
 * v2 or `X-PAYMENT` v1). Tolerant of BOTH wire shapes — the inner
 * `{ signature, authorization }` payload is identical across versions, so we read
 * `scheme`/`network` from either the v2 `accepted` object or the v1 flat fields.
 * Returns null when the value isn't a recognisable `exact` payment (e.g. it's an
 * `onchain-proof` proof, or malformed).
 */
export function parseExactPaymentHeader(value: string): ParsedExactPayment | null {
  const parsed = fromBase64Json<unknown>(value)
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Record<string, unknown>

  // v2 carries the chosen rail in `accepted`; v1 is flat (scheme/network at top).
  const accepted = (v.accepted ?? null) as Record<string, unknown> | null
  const scheme = (accepted?.scheme ?? v.scheme) as unknown
  if (scheme !== 'exact') return null

  const network = (accepted?.network ?? v.network) as unknown
  if (typeof network !== 'string') return null

  const payload = v.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return null
  const signature = payload.signature
  const authorization = payload.authorization as Record<string, unknown> | undefined
  if (typeof signature !== 'string' || !authorization || typeof authorization !== 'object') return null
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof authorization[k] !== 'string') return null
  }

  const x402Version =
    typeof v.x402Version === 'number' ? v.x402Version : 2
  const asset = accepted && typeof accepted.asset === 'string' ? accepted.asset : undefined

  return {
    x402Version,
    network,
    ...(asset ? { asset } : {}),
    payload: {
      signature,
      authorization: authorization as unknown as ExactAuthorizationWire,
    },
    raw: v,
  }
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
  if (v.scheme !== 'onchain-proof' && v.scheme !== 'exact') return false
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
