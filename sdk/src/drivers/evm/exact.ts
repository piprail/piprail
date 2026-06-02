/**
 * ── EVM SECTION: x402 `exact` scheme (interop building block) ──────────────
 *
 * EXPERIMENTAL / ADVANCED. PipRail's own gates use the `onchain-proof` scheme
 * (client pays first, proves with a tx ref, server verifies locally — no
 * facilitator). This module is the opposite end: the building blocks to PAY a
 * server that speaks the mainstream x402 `exact` scheme (Coinbase-style), where
 * the client signs an EIP-3009 `transferWithAuthorization` and a third-party
 * facilitator broadcasts it. It lets a PipRail agent buy from `exact` servers
 * too — making PipRail a *universal* x402 client — while our servers stay
 * backendless.
 *
 * What's here is the deterministic, unit-testable core: parse an `exact`
 * requirement, build + EIP-712-sign the authorization, and encode the
 * `X-PAYMENT` header. It is intentionally NOT wired into `PipRailClient.fetch`'s
 * default flow: `exact` is a cross-vendor wire protocol whose live acceptance
 * can only be confirmed against a real facilitator, and bolting a second
 * payment protocol into the core would cut against PipRail's keep-it-simple
 * design. Use these helpers to hand-roll an `exact` payment, and validate
 * against your target facilitator before production. See
 * `.claude/plans/agent-readiness/04-universal-exact.md`.
 *
 * EVM + EIP-3009 only (USDC and kin). Uses the existing `viem` peer — no new dep.
 */
import { type Account, type Hex } from 'viem'

/** x402 network slug → EVM chain id, for the chains PipRail ships with EIP-3009
 *  USDC. Extend as needed; an unknown slug just won't be selected. */
export const EXACT_NETWORK_SLUGS: Readonly<Record<string, number>> = {
  ethereum: 1,
  base: 8453,
  'base-sepolia': 84532,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  avalanche: 43114,
}

/** Resolve an x402 `exact` network slug (e.g. "base") to its EVM chain id. */
export function chainIdForExactNetwork(slug: string): number | null {
  return EXACT_NETWORK_SLUGS[slug] ?? null
}

/** A parsed x402 `exact` PaymentRequirements entry (the fields we consume). */
export interface ExactAccept {
  scheme: 'exact'
  network: string
  /** Amount in base units (x402 names this `maxAmountRequired`). */
  maxAmountRequired: string
  /** EIP-3009 token contract. */
  asset: `0x${string}`
  payTo: `0x${string}`
  maxTimeoutSeconds: number
  /** EIP-712 domain of the token (USDC: name 'USD Coin', version '2'). */
  extra?: { name?: string; version?: string }
  description?: string
  resource?: string
}

/** The EIP-3009 authorization the payer signs. */
export interface ExactAuthorization {
  from: `0x${string}`
  to: `0x${string}`
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
}

/** EIP-712 type set for `transferWithAuthorization` (EIP-3009). */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/**
 * Parse a standard x402 challenge body into its `exact` requirements. Tolerant
 * of x402Version 1 or 2 and of the `maxAmountRequired`/`amount` field name.
 * Returns `[]` when there are no `exact` entries, `null` when the body isn't a
 * recognisable x402 challenge.
 */
export function parseExactRequirements(body: unknown): ExactAccept[] | null {
  if (!body || typeof body !== 'object') return null
  const accepts = (body as { accepts?: unknown }).accepts
  if (!Array.isArray(accepts)) return null
  const out: ExactAccept[] = []
  for (const raw of accepts) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (a.scheme !== 'exact') continue
    const amount = a.maxAmountRequired ?? a.amount
    if (
      typeof a.network !== 'string' ||
      typeof amount !== 'string' ||
      typeof a.asset !== 'string' ||
      typeof a.payTo !== 'string'
    ) {
      continue
    }
    out.push({
      scheme: 'exact',
      network: a.network,
      maxAmountRequired: amount,
      asset: a.asset as `0x${string}`,
      payTo: a.payTo as `0x${string}`,
      maxTimeoutSeconds: typeof a.maxTimeoutSeconds === 'number' ? a.maxTimeoutSeconds : 600,
      ...(a.extra && typeof a.extra === 'object' ? { extra: a.extra as ExactAccept['extra'] } : {}),
      ...(typeof a.description === 'string' ? { description: a.description } : {}),
      ...(typeof a.resource === 'string' ? { resource: a.resource } : {}),
    })
  }
  return out
}

export interface BuildExactParams {
  /** A viem account able to sign EIP-712 typed data. */
  account: Account
  accept: ExactAccept
  /** EVM chain id (must match the token's deployment / EIP-712 domain). */
  chainId: number
  /** Unix seconds 'now' — injectable for deterministic tests. */
  now: number
  /** 32-byte hex authorization nonce — injectable for deterministic tests
   *  (use a CSPRNG value in production). */
  nonce: Hex
}

/**
 * Build + EIP-712-sign an EIP-3009 `transferWithAuthorization` for an `exact`
 * requirement. Returns the authorization and its signature; pass both to
 * {@link encodeXPaymentHeader} to produce the `X-PAYMENT` header value.
 */
export async function buildExactAuthorization(
  params: BuildExactParams
): Promise<{ authorization: ExactAuthorization; signature: Hex }> {
  const { account, accept, chainId, now, nonce } = params
  if (!account.signTypedData) {
    throw new Error('buildExactAuthorization: the account cannot sign EIP-712 typed data.')
  }
  const authorization: ExactAuthorization = {
    from: account.address,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    validAfter: '0',
    validBefore: String(now + accept.maxTimeoutSeconds),
    nonce,
  }
  const signature = await account.signTypedData({
    domain: {
      name: accept.extra?.name ?? 'USD Coin',
      version: accept.extra?.version ?? '2',
      chainId,
      verifyingContract: accept.asset,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
  return { authorization, signature }
}

function base64(str: string): string {
  if (typeof btoa === 'function') return btoa(str)
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  throw new Error('No base64 encoder available in this runtime.')
}

/** Encode an x402 `exact` PaymentPayload into an `X-PAYMENT` header value. */
export function encodeXPaymentHeader(input: {
  network: string
  authorization: ExactAuthorization
  signature: Hex
  /** x402 envelope version (Coinbase's reference uses 1). */
  x402Version?: number
}): string {
  const payload = {
    x402Version: input.x402Version ?? 1,
    scheme: 'exact',
    network: input.network,
    payload: { signature: input.signature, authorization: input.authorization },
  }
  return base64(JSON.stringify(payload))
}
