/**
 * ── EVM SECTION: x402 `exact` scheme (EIP-3009) — BUYER + SELLER ───────────
 *
 * PipRail's own gates default to the `onchain-proof` scheme (client pays first,
 * proves with a tx ref, server verifies locally). This module is the standard
 * x402 `exact` interop, in BOTH directions, EVM + EIP-3009 only, on the existing
 * `viem` peer (no new dep):
 *
 *   • BUYER side (client) — {@link payExactEvm} re-derives the token's EIP-712 domain
 *     ON-CHAIN, signs the EIP-3009 authorization, and is wired into `PipRailClient`'s
 *     pay path via the EVM driver's `payExact` SPI (OPT-IN through `schemes: ['exact']`;
 *     the default is unchanged). The lower-level `buildExactAuthorization` /
 *     `encodeXPaymentHeader` codecs remain for hand-rolled/v1 clients. See
 *     `.claude/plans/exact-client/IMPLEMENTATION.md`.
 *
 *   • SELLER side (gate) — {@link readExactDomain} (read the token's true EIP-712
 *     domain so the gate can advertise + verify it) and {@link verifyAndSettleExactEvm}
 *     (verify an inbound EIP-3009 authorization locally, then SELF-SETTLE it by
 *     broadcasting `transferWithAuthorization` from the merchant's own relayer key —
 *     no third-party facilitator). This is what lets a PipRail gate get PAID by ANY
 *     standard x402 client. See `.claude/plans/compliance/`.
 *
 * Self-settle uses `transferWithAuthorization` (NOT `receiveWithAuthorization`,
 * which requires `msg.sender == payTo` and so can't be broadcast by a separate
 * relayer key). The signature binds `to`=payTo, so a front-runner can only push
 * the same funds to the same payTo and waste their own gas — no redirect risk.
 */
import {
  getAddress,
  parseSignature,
  recoverTypedDataAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { SettlementError, UnsupportedSchemeError } from '../../errors.js'
import type { VerifyResult, X402ExactAcceptEntry, ExactPaymentPayload } from '../../x402.js'

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
 *
 * @deprecated Low-level primitive — prefer {@link payExactEvm}, which the client's
 * `payExact` SPI uses. This helper TRUSTS the server-supplied `accept.extra.{name,
 * version}` for the EIP-712 domain (a lying/absent value yields a silently-invalid
 * signature) and calls `account.signTypedData` directly (which is `undefined` on a
 * bring-your-own JsonRpcAccount). `payExactEvm` re-derives the domain on-chain and
 * signs via the wallet client. Kept exported as a deterministic test/codec building block.
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
  // UTF-8 safe — prefer Buffer (modern Node's global `btoa` is Latin1-only).
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function' && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }
  throw new Error('No base64 encoder available in this runtime.')
}

/**
 * Encode an x402 `exact` PaymentPayload into an `X-PAYMENT` header value — the
 * **v1 flat shape** (`{ x402Version, scheme, network, payload }`). This is a
 * client-side UTILITY (PipRail's own client pays only `onchain-proof`, never this);
 * the v1 flat shape is what Coinbase's original reference emits and is still accepted
 * by every x402 gate + facilitator, so `x402Version` defaults to `1` to stay
 * INTERNALLY CONSISTENT with that shape (emitting `2` here would mislabel a v1 body —
 * a proper v2 `exact` payload is the nested `accepted`-envelope shape instead). See
 * the version-posture note in `x402.ts`.
 */
export function encodeXPaymentHeader(input: {
  network: string
  authorization: ExactAuthorization
  signature: Hex
  /** x402 envelope version. Defaults to `1` — consistent with this flat shape. */
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

/**
 * BUYER, production path — build + EIP-712-sign an EIP-3009 `transferWithAuthorization`
 * for a standard x402 `exact` rail, returning the signed `{ signature, authorization }`
 * payload for {@link buildExactSignatureHeader} to frame. This is what the EVM driver's
 * `payExact` SPI calls. Unlike {@link buildExactAuthorization}, it:
 *
 *   • RE-DERIVES the token's EIP-712 domain `{ name, version }` ON-CHAIN ({@link readExactDomain}),
 *     never trusting the server's `extra.{name,version}` — so a lying/absent value can't
 *     produce a silently-invalid signature. A `null` domain (not an EIP-3009 token — USDT/
 *     native/plain ERC-20) throws {@link UnsupportedSchemeError}.
 *   • Refuses a CONTRACT / EIP-1271 / EIP-7702-delegated signer (code at `from`) — it can't
 *     produce a recoverable ECDSA signature — with {@link UnsupportedSchemeError}, BEFORE signing.
 *   • Generates a CSPRNG 32-byte authorization nonce (Web Crypto) + the current unix time.
 *   • Signs via `walletClient.signTypedData` (NOT `account.signTypedData`, which is undefined
 *     on a bring-your-own JsonRpcAccount).
 *
 * The buyer NEVER broadcasts: the server / merchant-chosen facilitator broadcasts the
 * authorization. `validAfter` is `'0'` (maximally compatible; the contract enforces only
 * `now >= validAfter`); `validBefore` is `now + maxTimeoutSeconds`.
 */
export async function payExactEvm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chainId: number
  accept: X402ExactAcceptEntry
}): Promise<{ payload: ExactPaymentPayload; payerFrom: string; nonce: Hex }> {
  const { publicClient, walletClient, account, chainId, accept } = input

  // EOA-only: a contract / EIP-1271 / EIP-7702-delegated account can't produce a
  // recoverable ECDSA signature for transferWithAuthorization. Refuse BEFORE signing.
  // A transient getCode failure is treated as EOA — the facilitator's own verify is
  // the backstop, and refusing on a flaky RPC read would be worse than letting it try.
  let code: string | undefined
  try {
    code = await publicClient.getCode({ address: account.address })
  } catch {
    code = undefined
  }
  if (code && code !== '0x') {
    throw new UnsupportedSchemeError(
      `exact buyer rail requires an EOA signer; ${account.address} is a contract / ` +
        `EIP-1271 / EIP-7702-delegated account (no recoverable ECDSA signature). Pay via onchain-proof.`
    )
  }

  // Re-derive the EIP-712 domain ON-CHAIN — never trust the server's extra.{name,version}.
  // null ⇒ not an EIP-3009 token (USDT needs Permit2; native/plain ERC-20 aren't exact-payable).
  const domain = await readExactDomain(publicClient, accept.asset)
  if (!domain) {
    throw new UnsupportedSchemeError(
      `exact: ${accept.asset} on ${accept.network} isn't an EIP-3009 token ` +
        `(USDT needs Permit2; native coin and plain ERC-20s aren't exact-payable). Pay via onchain-proof.`
    )
  }

  // CSPRNG 32-byte authorization nonce — Web Crypto (headless + browser parity).
  const g = globalThis.crypto
  if (!g?.getRandomValues) {
    throw new UnsupportedSchemeError(
      'this runtime lacks Web Crypto (globalThis.crypto.getRandomValues); the exact rail needs a CSPRNG nonce.'
    )
  }
  const raw = new Uint8Array(32)
  g.getRandomValues(raw)
  const nonce = `0x${[...raw].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex

  const now = Math.floor(Date.now() / 1000)
  const from = account.address
  const to = getAddress(accept.payTo)
  const value = accept.amount // base units, already scaled by decimals
  const validAfter = '0'
  const validBefore = String(now + accept.maxTimeoutSeconds)

  // Sign via the WALLET CLIENT, not account.signTypedData (a bring-your-own
  // { walletClient } carries a JsonRpcAccount whose account.signTypedData is undefined).
  const signature = await walletClient.signTypedData({
    account,
    domain: { name: domain.name, version: domain.version, chainId, verifyingContract: getAddress(accept.asset) },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from, to, value: BigInt(value), validAfter: 0n, validBefore: BigInt(validBefore), nonce },
  })

  return {
    payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } },
    payerFrom: from,
    nonce,
  }
}

/* ───────────────────────── SELLER SIDE (gate) ─────────────────────────── */

/**
 * The minimal EIP-3009 ABI the seller needs: both `transferWithAuthorization`
 * overloads (the 65-byte `(v,r,s)` form and the `(bytes signature)` ERC-1271 form),
 * the `authorizationState` replay check, and `name()`/`version()` for the EIP-712
 * domain. Mirrors Circle's deployed FiatToken.
 */
export const eip3009Abi = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
  },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const
const ZERO_NONCE = `0x${'00'.repeat(32)}` as const

/**
 * Read an EIP-3009 token's true EIP-712 domain `{ name, version }` from the
 * contract — what a payer must sign over. Returns `null` if the asset is NOT an
 * EIP-3009 token (no `authorizationState`/`version` — e.g. USDT, native coin, a
 * plain ERC-20), so the gate refuses to advertise a standard `exact` rail for it.
 *
 * The name is NEVER assumed from the symbol: canonical USDC's domain name is
 * "USD Coin" (not "USDC"), and EURC's is "Euro Coin" on Ethereum/Avalanche but "EURC"
 * on Base — proof that only the on-chain read is authoritative. `eip712Domain()`
 * (EIP-5267) reverts on these proxies, so we read `name()`+`version()` and probe
 * `authorizationState` to confirm EIP-3009 support.
 */
export async function readExactDomain(
  publicClient: PublicClient,
  asset: string
): Promise<{ name: string; version: string } | null> {
  if (asset === 'native') return null
  let token: `0x${string}`
  try {
    token = getAddress(asset)
  } catch {
    return null
  }
  try {
    const [name, version] = await Promise.all([
      publicClient.readContract({ address: token, abi: eip3009Abi, functionName: 'name' }),
      publicClient.readContract({ address: token, abi: eip3009Abi, functionName: 'version' }),
      // The EIP-3009 probe: this view exists only on EIP-3009 tokens; it reverts on
      // a plain ERC-20 / USDT, marking the token as not exact-payable.
      publicClient.readContract({
        address: token,
        abi: eip3009Abi,
        functionName: 'authorizationState',
        args: [ZERO_ADDR, ZERO_NONCE],
      }),
    ])
    if (typeof name !== 'string' || typeof version !== 'string' || !name || !version) return null
    return { name, version }
  } catch {
    // version()/authorizationState reverted (not EIP-3009), or a transient read.
    return null
  }
}

/** Shorten a long revert/error message for a `detail` field. */
function shorten(msg: string): string {
  const oneLine = msg.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/**
 * Verify an inbound x402 `exact` (EIP-3009) payment locally, then SELF-SETTLE it
 * by broadcasting `transferWithAuthorization` from the merchant's `relayer`. The
 * trusted `accept` (the gate's own rail) is the source of truth for payTo / amount
 * / asset / network / domain — the client-supplied authorization is only matched
 * and recovered against it, never trusted.
 *
 * RETURNS a {@link VerifyResult}: `{ ok:false, error }` for a CLIENT-fixable fault
 * (the gate replies 402, the payer can re-pay correctly); `{ ok:true, receipt }`
 * once the settle tx mines. THROWS {@link SettlementError} for a SERVER-side
 * settle failure (relayer can't broadcast a valid+simulated payment) — the gate
 * replies 5xx, and the payer's authorization stays valid + its nonce unused.
 */
export async function verifyAndSettleExactEvm(input: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chain: Chain
  payload: ExactPaymentPayload
  accept: X402ExactAcceptEntry
}): Promise<VerifyResult> {
  const { publicClient, walletClient, account, chain, payload, accept } = input
  const token = getAddress(accept.asset)
  const payTo = getAddress(accept.payTo)
  const requiredAmount = BigInt(accept.amount)

  // --- normalise the client-supplied authorization (validated, not trusted) ---
  let from: `0x${string}`
  let to: `0x${string}`
  let value: bigint
  let validAfter: bigint
  let validBefore: bigint
  let nonce: `0x${string}`
  try {
    from = getAddress(payload.authorization.from)
    to = getAddress(payload.authorization.to)
    value = BigInt(payload.authorization.value)
    validAfter = BigInt(payload.authorization.validAfter)
    validBefore = BigInt(payload.authorization.validBefore)
    nonce = payload.authorization.nonce as `0x${string}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error('nonce must be 32-byte hex')
    if (!/^0x[0-9a-fA-F]+$/.test(payload.signature)) throw new Error('signature must be hex')
  } catch (err) {
    return {
      ok: false,
      error: 'signature_invalid',
      detail: `Malformed exact authorization: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }

  // --- field checks vs the TRUSTED accept (never the client's echo) ---
  if (to !== payTo) {
    return { ok: false, error: 'wrong_recipient', detail: `Authorization pays ${to}, not ${payTo}.` }
  }
  if (value < requiredAmount) {
    return { ok: false, error: 'amount_too_low', detail: `Authorized ${value}, required ${requiredAmount}.` }
  }
  // Cheap early-out for a clearly-expired authorization (the common replay-of-an-old-auth
  // case). The contract enforces `now < validBefore` strictly at settle time; we only
  // pre-reject when it's already at/past validBefore — the simulateContract below is the
  // authoritative time check.
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (validBefore <= now) {
    return { ok: false, error: 'payment_expired', detail: `Authorization expired: validBefore ${validBefore} <= now ${now}.` }
  }
  // NB: we do NOT pre-check `validAfter` off-chain. Standard clients (e.g. @x402/evm) set
  // `validAfter` to ~signing-time, which can equal our wall-clock `now` for a beat even though
  // the contract's `now > validAfter` passes at the next block. The `simulateContract` below
  // runs the contract's own time checks authoritatively (a genuinely not-yet-valid auth reverts
  // there → mapped to payment_expired), so an off-chain guard would only add false rejections.

  // Smart-wallet payers (EIP-1271 contract wallets, or EIP-7702-delegated EOAs) have CODE
  // at `from`: the token validates their signature ON-CHAIN via SignatureChecker
  // (isValidSignature), NOT via plain ECDSA recovery. So we recover off-chain ONLY for a
  // bare EOA; for a contract `from` we defer authenticity to the simulateContract below
  // (the bytes overload runs isValidSignature). Every trusted-accept field check
  // (to/value/expiry) and the replay check already ran, so deferring can't redirect funds.
  let fromCode: string | undefined
  try {
    fromCode = await publicClient.getCode({ address: from })
  } catch {
    return { ok: false, error: 'tx_not_found', detail: `Could not read code at ${from} (transient RPC) — retry.` }
  }
  const isContractWallet = Boolean(fromCode && fromCode !== '0x')

  if (!isContractWallet) {
    // --- recover the EIP-712 signer against the token's REAL domain (server-read name/version) ---
    let recovered: `0x${string}`
    try {
      recovered = await recoverTypedDataAddress({
        domain: {
          name: accept.extra.name,
          version: accept.extra.version,
          chainId: chain.id,
          verifyingContract: token,
        },
        types: EIP3009_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: { from, to, value, validAfter, validBefore, nonce },
        signature: payload.signature as `0x${string}`,
      })
    } catch (err) {
      return { ok: false, error: 'signature_invalid', detail: `Not a valid EIP-712 signature: ${shorten(err instanceof Error ? err.message : String(err))}.` }
    }
    if (recovered !== from) {
      return { ok: false, error: 'signature_invalid', detail: `Signature recovered to ${recovered}, not the authorizer ${from}.` }
    }
  }

  // --- on-chain replay check (the token's own single-use nonce) ---
  try {
    const used = (await publicClient.readContract({
      address: token,
      abi: eip3009Abi,
      functionName: 'authorizationState',
      args: [from, nonce],
    })) as boolean
    if (used) {
      return { ok: false, error: 'tx_already_used', detail: `Authorization nonce ${nonce} already used or canceled on-chain.` }
    }
  } catch {
    return { ok: false, error: 'tx_not_found', detail: 'Could not read authorizationState (transient RPC) — retry.' }
  }

  // --- build the call args (split a 65-byte EOA sig; contract-wallet / non-65-byte sig
  //     goes to the bytes overload so the token runs isValidSignature on-chain) ---
  const baseArgs = [from, to, value, validAfter, validBefore, nonce] as const
  const isEcdsa = !isContractWallet && payload.signature.length - 2 === 130
  let writeArgs: readonly unknown[]
  if (isEcdsa) {
    // ALWAYS derive v from yParity (+27). Standard clients differ on the recovery byte
    // encoding: PipRail/viem `signTypedData` writes v=27/28 (0x1b/0x1c), but @x402/evm
    // writes yParity=0/1 (0x00/0x01). The contract's `ecrecover` requires 27/28, so a
    // naive `v ?? yParity` would pass 0/1 and revert "invalid signature". yParity is
    // 0/1 in BOTH encodings, so yParity+27 normalises every standard client.
    const { r, s, yParity } = parseSignature(payload.signature as `0x${string}`)
    writeArgs = [...baseArgs, BigInt(yParity + 27), r, s]
  } else {
    writeArgs = [...baseArgs, payload.signature]
  }

  // --- simulate BEFORE spending gas (catches blacklist / paused / low payer balance) ---
  try {
    await publicClient.simulateContract({
      account,
      address: token,
      abi: eip3009Abi,
      functionName: 'transferWithAuthorization',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: writeArgs as any,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/used or canceled/i.test(msg)) return { ok: false, error: 'tx_already_used', detail: 'Authorization is used or canceled.' }
    if (/expired|not yet valid/i.test(msg)) return { ok: false, error: 'payment_expired', detail: shorten(msg) }
    if (/invalid signature/i.test(msg)) return { ok: false, error: 'signature_invalid', detail: shorten(msg) }
    return { ok: false, error: 'tx_reverted', detail: `transferWithAuthorization would revert: ${shorten(msg)}` }
  }

  // --- BROADCAST (settle). Failure here is SERVER-side → throw SettlementError. ---
  let txHash: `0x${string}`
  try {
    txHash = await walletClient.writeContract({
      account,
      chain,
      address: token,
      abi: eip3009Abi,
      functionName: 'transferWithAuthorization',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: writeArgs as any,
    })
  } catch (err) {
    throw new SettlementError(
      `exact settle: the merchant relayer failed to broadcast transferWithAuthorization ` +
        `(${shorten(err instanceof Error ? err.message : String(err))}). The payer's authorization ` +
        `is still valid and unused — fund/fix the relayer and the payer can retry.`,
      { cause: err }
    )
  }
  try {
    // Honour the gate's minConfirmations (the server-trusted accept carries it), so the
    // exact rail grants access at the SAME reorg depth as onchain-proof — not always 1.
    const confirmations = accept.extra.minConfirmations ?? 1
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations })
    if (receipt.status !== 'success') {
      // Mined but reverted after a passing simulate — a rare race (e.g. the nonce got
      // used between simulate and broadcast). Client-retryable, not a relayer fault.
      return { ok: false, error: 'tx_reverted', detail: `Settlement tx ${txHash} reverted on-chain.` }
    }
  } catch (err) {
    throw new SettlementError(
      `exact settle: broadcast ${txHash} but couldn't confirm it (${shorten(err instanceof Error ? err.message : String(err))}).`,
      { cause: err }
    )
  }

  return {
    ok: true,
    receipt: {
      scheme: 'exact',
      success: true,
      network: accept.network,
      transaction: txHash,
      asset: accept.asset,
      amount: accept.amount,
      payer: from,
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }
}
