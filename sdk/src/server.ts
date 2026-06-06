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

import { parseUnits } from './util/units.js'
import { resolveNetwork } from './drivers/index.js'
import type { ResolvedNetwork, TokenInput, ChainSelector } from './drivers/types.js'
import type { ResourceDescription, PaymentRail } from './discovery.js'
import {
  buildChallengeHeader,
  buildReceiptHeader,
  parseSignatureHeader,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  type AddressId,
  type X402AcceptEntry,
  type X402Challenge,
  type X402Receipt,
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
  /** Shown to the agent in the challenge. */
  description?: string
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
  /** Fired when a payment verifies successfully. */
  onPaid?: (receipt: X402Receipt) => void
}

export type VerifyPaymentResult =
  | { kind: 'paid'; receipt: X402Receipt; receiptHeader: string }
  | {
      kind: 'challenge'
      challenge: X402Challenge
      requiredHeader: string
      statusCode: 402
    }
  | { kind: 'invalid'; error: string; detail: string; statusCode: 402 }

/** The canonical x402 v2 JSON body for a rejected proof (a 402 'invalid'). */
export interface X402InvalidBody {
  x402Version: 2
  status: 'invalid'
  error: string
  detail: string
}

/**
 * Build the canonical 402 'invalid' body. Use this in EVERY framework adapter
 * (Express, Hono, Fastify, Workers, …) so a rejected proof returns the IDENTICAL
 * envelope everywhere — `verify()` produces the reason, this shapes the body.
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
   * Describe this gate's payment options as static, nonce-free discovery
   * metadata — feed it to the emitters in `discovery.ts` (`buildOpenApi` /
   * `buildWellKnownX402`) to make the resource findable. Reuses the same
   * resolved options the challenge is built from (so a `0x…` payTo / decimals
   * are already correct); unlike `challenge()`, it mints no nonce, because
   * discovery metadata is long-lived. Read-only — moves nothing on-chain.
   */
  describe(resourceUrl?: string): Promise<ResourceDescription>
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

/**
 * Framework-agnostic core. Build one gate per gated resource and reuse it
 * — its in-memory used-tx set is what stops the same proof being redeemed
 * twice. Wrap it for Express with `requirePayment`, or call it directly
 * from Hono / Fastify / Adonis / Workers / etc.
 *
 * The chain's driver is resolved lazily on first `challenge()`/`verify()`,
 * which is what lets Solana (and future families) auto-mount with no setup.
 */
export function createPaymentGate(options: RequirePaymentOptions): PaymentGate {
  const minConfirmations = options.minConfirmations ?? 1
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600
  const genNonce = options.generateNonce ?? (() => globalThis.crypto.randomUUID())

  // Lazy, memoized resolution. Auto-mounts each option's driver, validates its
  // payTo, and resolves its token (asset + decimals) exactly once. One element
  // for the single-chain form; one per offered chain for the multi form.
  let resolved: Promise<ResolvedSpec[]> | undefined
  function ready(): Promise<ResolvedSpec[]> {
    return (resolved ??= (async () => {
      const accepts = normaliseAccepts(options)
      return Promise.all(
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
          return { net, asset, decimals, symbol, amountBase, amountFormatted: a.amount, payTo }
        })
      )
    })())
  }

  // Replay protection. The built-in store reserves the proof ref synchronously
  // (its critical section has no await), so two concurrent requests carrying
  // the same proof can't both be redeemed. A reservation is released if
  // verification fails, so submitting someone else's not-yet-confirmed tx
  // can't grief them.
  //
  // Provide isUsed/markUsed to share state across instances (e.g. Redis). A
  // custom store is checked, then marked only on success; make the check
  // atomic (SET NX) if you need the same concurrency guarantee.
  const hasCustomStore = Boolean(options.isUsed || options.markUsed)
  const localUsed = new Set<string>()

  /** Reserve a proof ref. Returns true if it was ALREADY taken (→ reject). */
  async function claimTx(ref: string): Promise<boolean> {
    if (hasCustomStore) {
      return options.isUsed ? Boolean(await options.isUsed(ref)) : false
    }
    // EVM tx hashes are case-insensitive hex → normalize for the default store
    // (custom isUsed/markUsed above receive the RAW ref). Synchronous reserve
    // before any await closes the concurrent double-redeem race.
    const key = ref.toLowerCase()
    if (localUsed.has(key)) return true
    localUsed.add(key)
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

  async function challenge(resourceUrl = '') {
    const specs = await ready()
    // One nonce per challenge, shared across every offered accept. The agent
    // pays ONE of them and echoes this nonce; verify() rebuilds the matching
    // spec's accept from the SERVER's trusted data (never the client's echo).
    const nonce = genNonce()
    const challenge: X402Challenge = {
      x402Version: 2,
      error: null,
      resource: {
        url: resourceUrl,
        ...(options.description ? { description: options.description } : {}),
      },
      accepts: specs.map((s) => buildAccept(s, nonce)),
    }
    return { challenge, requiredHeader: buildChallengeHeader(challenge) }
  }

  async function asChallenge(): Promise<VerifyPaymentResult> {
    const { challenge: c, requiredHeader } = await challenge()
    return { kind: 'challenge', challenge: c, requiredHeader, statusCode: 402 }
  }

  async function describe(resourceUrl = ''): Promise<ResourceDescription> {
    const specs = await ready()
    const accepts: PaymentRail[] = specs.map((s) => ({
      scheme: 'onchain-proof',
      network: s.net.network,
      asset: s.asset,
      payTo: s.payTo,
      amount: s.amountBase.toString(),
      amountFormatted: s.amountFormatted,
      decimals: s.decimals,
      maxTimeoutSeconds,
      ...(s.symbol ? { symbol: s.symbol } : {}),
    }))
    return {
      url: resourceUrl,
      ...(options.description ? { description: options.description } : {}),
      accepts,
    }
  }

  async function verify(
    paymentSignature: string | string[] | undefined
  ): Promise<VerifyPaymentResult> {
    const raw = normaliseHeader(paymentSignature)
    if (!raw) return asChallenge()

    const sig = parseSignatureHeader(raw)
    // A usable proof must carry a v2 `accepted` with the network + asset it
    // claims, so we can match it to an offered option. parseSignatureHeader stays
    // lenient for transitional callers (it tolerates a legacy top-level `scheme`
    // with no `accepted`), so guard here: an unmatchable proof re-issues a fresh
    // challenge instead of dereferencing a missing field (which would 500 a
    // hostile/legacy request rather than returning a clean 402).
    if (
      !sig ||
      !sig.accepted ||
      typeof sig.accepted.network !== 'string' ||
      typeof sig.accepted.asset !== 'string'
    ) {
      return asChallenge()
    }

    const specs = await ready()
    // Select the offered option the proof claims (network + asset — a gate may
    // offer the same chain in two tokens). Only used to PICK which spec to verify
    // against; every verified field comes from the server's own spec, so a forged
    // `accepted` can't redirect anything (a wrong asset/network just won't match).
    const spec = specs.find(
      (s) => s.net.network === sig.accepted.network && s.asset === sig.accepted.asset
    )
    if (!spec) {
      return {
        kind: 'invalid',
        error: 'transfer_not_found',
        detail:
          `Proof claims ${sig.accepted.asset} on ${sig.accepted.network}, which this resource ` +
          `doesn't accept (offered: ${specs.map((s) => `${s.asset}@${s.net.network}`).join(', ')}).`,
        statusCode: 402,
      }
    }

    const ref = sig.payload.txHash
    if (await claimTx(ref)) {
      return {
        kind: 'invalid',
        error: 'tx_already_used',
        detail: `Proof ${ref} was already redeemed.`,
        statusCode: 402,
      }
    }

    const result = await spec.net.verify(ref, buildAccept(spec, sig.payload.nonce))
    if (!result.ok) {
      await settleTx(ref, false)
      return {
        kind: 'invalid',
        error: result.error,
        detail: result.detail,
        statusCode: 402,
      }
    }

    await settleTx(ref, true)
    if (options.onPaid) {
      try {
        options.onPaid(result.receipt)
      } catch {
        /* never let a logging hook break the request */
      }
    }
    return {
      kind: 'paid',
      receipt: result.receipt,
      receiptHeader: buildReceiptHeader(result.receipt),
    }
  }

  return { challenge, verify, describe }
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
  const gate = createPaymentGate(options)
  return async (req, res, next) => {
    let result: VerifyPaymentResult
    try {
      result = await gate.verify(req.headers[HEADER_SIGNATURE])
    } catch (err) {
      next(err)
      return
    }

    switch (result.kind) {
      case 'paid':
        res.setHeader(HEADER_RESPONSE, result.receiptHeader)
        return next()

      case 'challenge':
        res.setHeader(HEADER_REQUIRED, result.requiredHeader)
        res.status(result.statusCode)
        res.json(result.challenge)
        return

      case 'invalid':
        res.status(result.statusCode)
        res.json(toInvalidBody(result))
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
