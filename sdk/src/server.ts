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

import { parseUnits, formatUnits } from './util/units.js'
import { resolveNetwork } from './drivers/index.js'
import type { ResolvedNetwork, TokenInput, ChainSelector, WalletHandle } from './drivers/types.js'
import { buildBazaarExtension } from './discovery.js'
import type { ResourceDescription, PaymentRail, DiscoveryDescriptor } from './discovery.js'
import { SettlementError } from './errors.js'
import { settleViaFacilitator, fetchFacilitatorFeePayer } from './facilitator.js'
import {
  buildChallengeHeader,
  buildReceiptHeader,
  parseSignatureHeader,
  parseExactPaymentHeader,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  HEADER_SIGNATURE_V1,
  HEADER_RESPONSE_V1,
  type AddressId,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type X402AnyAccept,
  type X402Challenge,
  type X402Receipt,
  type PaidReceipt,
  type X402PaymentSignature,
  type ParsedExactPayment,
  type VerifyResult,
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
  settle:
    | 'self'
    | {
        facilitator: string
        authHeaders?: () => Promise<Record<string, string>>
        /** Solana only — the facilitator's fee-payer pubkey, if you'd rather set it than have the
         *  gate read it from the facilitator's `GET /supported`. Optional: omitted, the gate
         *  discovers it automatically (e.g. PayAI). Ignored on EVM. */
        feePayer?: string
      }
  /** Required for `settle: 'self'` — the gas-paying relayer wallet: EVM `{ privateKey }` /
   *  `{ walletClient }`, or Solana `{ secretKey }` / `{ signer }`. (Distinct from `payTo`, the
   *  receive address — on Solana they MUST be different keys, a scheme MUST-rule.) */
  relayer?: unknown
  /** Which exact transfer method to advertise (EVM). `'auto'` (default) uses EIP-3009 when the
   *  token supports it, else Permit2 — so a non-EIP-3009 token like Binance-Peg USDC on BNB
   *  "just works". Force `'eip3009'` or `'permit2'` to pin one. Ignored on Solana (always SVM). */
  method?: 'eip3009' | 'permit2' | 'auto'
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
   * ALSO advertise a standard x402 `exact` rail so any standard x402 client can pay this
   * gate — opt-in, EVM (EIP-3009/Permit2) + Solana (SVM). See {@link ExactRailOption}.
   * Omit to keep the gate exactly as today (`onchain-proof` only).
   */
  exact?: ExactRailOption
  /**
   * Make this gate's 402 self-describing for the open indexes — **x402scan REQUIRES
   * an input schema or it won't list the resource.** Set `true` for a no-input GET,
   * or pass a {@link DiscoveryDescriptor} to describe the request. Emits an
   * `extensions.bazaar` block in the 402 challenge. Opt-in; omitting it leaves the
   * challenge byte-identical to before.
   */
  discovery?: boolean | DiscoveryDescriptor
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
   * Describe this gate's payment options as static, nonce-free discovery
   * metadata — feed it to the emitters in `discovery.ts` (`buildOpenApi` /
   * `buildWellKnownX402`) to make the resource findable. Reuses the same
   * resolved options the challenge is built from (so a `0x…` payTo / decimals
   * are already correct); unlike `challenge()`, it mints no nonce, because
   * discovery metadata is long-lived. Read-only — moves nothing on-chain.
   */
  describe(resourceUrl?: string): Promise<ResourceDescription>
}

/** The settle config for a resolved `exact` rail: self (own relayer) or a facilitator. */
type ResolvedExactMode =
  | { kind: 'self'; relayer: WalletHandle }
  | { kind: 'facilitator'; url: string; authHeaders?: () => Promise<Record<string, string>> }

/** A resolved standard `exact` rail bound to one spec — the transfer method + how it
 *  settles. Present when `options.exact` is set and the spec's family can carry it
 *  (EVM ERC-20 via EIP-3009/Permit2, or Solana SPL via the SVM scheme). */
interface ResolvedExactRail {
  /** `'eip3009'`/`'permit2'` (EVM) or `'svm'` (Solana). */
  method: 'eip3009' | 'permit2' | 'svm'
  /** Family-specific keys the driver supplies, merged verbatim into the accept's `extra`
   *  (EVM EIP-3009: the token's `name`/`version`; Solana: `feePayer`/`tokenProgram`). */
  extra?: Record<string, unknown>
  mode: ResolvedExactMode
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
    if (resolved) return resolved
    const p = (async () => {
      const accepts = normaliseAccepts(options)
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
          if (options.exact) spec.exact = await resolveExactRail(net, asset)
          return spec
        })
      )
      // If exact was requested but NOTHING could carry it (e.g. a single non-EVM /
      // native gate), say so loudly rather than silently shipping onchain-proof only.
      if (options.exact && !specs.some((s) => s.exact)) {
        throw new Error(
          'requirePayment: `exact` was requested but none of the offered rails support it. ' +
            'The standard `exact` rail is EVM ERC-20 (EIP-3009 — USDC / EURC — or Permit2, e.g. ' +
            'Binance-Peg USDC on BNB) or a Solana SPL token (SVM) — NOT native coins, NOT families ' +
            'without a standard `exact` scheme. Offer an EVM ERC-20 / Solana SPL token, or drop `exact`.'
        )
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
   * Resolve a standard `exact` rail for one spec, or `undefined` when its family/asset can't
   * carry one. Family-agnostic: it binds the self-settle relayer (chain-agnostic config),
   * delegates the chain-specific "which method + what `extra`" decision to the driver's
   * {@link ResolvedNetwork.resolveExactRail} SPI (EVM picks EIP-3009/Permit2 + reads the token's
   * EIP-712 domain; Solana returns the SVM method + the merchant `feePayer`), then attaches the
   * settle mode. A family that doesn't implement the SPI offers no exact rail.
   */
  async function resolveExactRail(
    net: ResolvedNetwork,
    asset: string
  ): Promise<ResolvedExactRail | undefined> {
    const cfg = options.exact!
    if (!net.resolveExactRail) return undefined // family has no standard `exact` settlement

    // The SVM fee payer comes from one of two places: the merchant's own relayer (self mode), or
    // — in facilitator mode — the FACILITATOR's sponsor pubkey, so neither buyer nor merchant pays
    // gas. Bind the relayer (self) / discover the facilitator's fee payer (facilitator) up front.
    let relayer: WalletHandle | undefined
    let feePayer: string | undefined
    if (cfg.settle === 'self') {
      if (cfg.relayer === undefined) {
        throw new Error(
          "requirePayment: exact `settle: 'self'` needs a `relayer` wallet (the gas-paying key that " +
            'broadcasts the settle), e.g. exact: { settle: ' + "'self', relayer: { privateKey } }."
        )
      }
      relayer = net.bindWallet(cfg.relayer)
    } else {
      feePayer = cfg.settle.feePayer // a configured fee-payer override, if any
    }

    const method = cfg.method ?? 'auto'
    let info = await net.resolveExactRail({ asset, method, relayer, feePayer })
    // Facilitator mode + the family couldn't resolve a rail WITHOUT a fee payer (Solana, no
    // override): discover the facilitator's own fee payer from its `GET /supported` and retry — so
    // neither buyer nor merchant pays gas. EVM resolves without a fee payer, so it never does this
    // extra fetch (the discovery is lazy, only when the first resolve came back empty).
    if (!info && cfg.settle !== 'self' && !feePayer) {
      const discovered = await fetchFacilitatorFeePayer(cfg.settle.facilitator, net.network)
      if (discovered) info = await net.resolveExactRail({ asset, method, relayer, feePayer: discovered })
    }
    if (!info) return undefined // this asset/chain can't carry exact → onchain-proof only

    const mode: ResolvedExactMode =
      cfg.settle === 'self'
        ? { kind: 'self', relayer: relayer! }
        : {
            kind: 'facilitator',
            url: cfg.settle.facilitator,
            ...(cfg.settle.authHeaders ? { authHeaders: cfg.settle.authHeaders } : {}),
          }
    return { method: info.method, ...(info.extra ? { extra: info.extra } : {}), mode }
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
  const hasCustomStore = Boolean(options.isUsed || options.markUsed)
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

  /** Dual-advertise: for each spec, the standard `exact` rail first (when enabled),
   *  then the `onchain-proof` rail. A standard client picks `exact`; a PipRail client
   *  picks `onchain-proof`. */
  function buildAccepts(specs: ResolvedSpec[], nonce: string): X402AnyAccept[] {
    const out: X402AnyAccept[] = []
    for (const s of specs) {
      if (s.exact) out.push(buildExactAccept(s))
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
    const extensions = { ...bazaar, ...opts?.extensions }
    const challenge: X402Challenge = {
      x402Version: 2,
      resource: {
        url: resourceUrl,
        ...(options.description ? { description: options.description } : {}),
      },
      accepts: buildAccepts(specs, nonce),
      ...(opts?.error ? { error: opts.error } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    }
    return { challenge, requiredHeader: buildChallengeHeader(challenge) }
  }

  async function challenge(resourceUrl = '') {
    return makeChallenge(resourceUrl)
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
      accepts.push({ scheme: 'onchain-proof', ...base })
    }
    return {
      url: resourceUrl,
      ...(options.description ? { description: options.description } : {}),
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
    return { kind: 'paid', receipt: result.receipt, receiptHeader: buildReceiptHeader(result.receipt) }
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
    const isCaip = exact.network.startsWith('eip155:')
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
    if ('transaction' in exact.payload) {
      // CANONICALIZE the base64 (decode → re-encode) before using it as the replay key — two
      // malleable encodings of the SAME signed tx (whitespace / missing padding / base64url) must
      // collapse to one key, so a mutated re-submission can't slip past the claim. Chain-agnostic;
      // the deterministic on-chain txid is the second backstop. A non-base64 string keys as-is.
      try {
        nonce = Buffer.from(exact.payload.transaction, 'base64').toString('base64')
      } catch {
        nonce = exact.payload.transaction
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
            // The scheme's chain-specific `extra`, from the gate's OWN trusted rail: SVM forwards the
            // facilitator's `feePayer` (the gas sponsor); EVM forwards the token's EIP-712 domain.
            extra:
              accept.extra.assetTransferMethod === 'svm'
                ? { feePayer: accept.extra.feePayer ?? '' }
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
    return { kind: 'paid', receipt: result.receipt, receiptHeader: buildReceiptHeader(result.receipt) }
  }

  async function verify(
    paymentSignature: string | string[] | undefined
  ): Promise<VerifyPaymentResult> {
    const raw = normaliseHeader(paymentSignature)
    if (!raw) return asChallenge()

    // 1) onchain-proof? A usable proof carries a v2 `accepted` with the network + asset
    //    it claims. parseSignatureHeader stays lenient for transitional callers (a
    //    legacy top-level `scheme` with no `accepted`), so guard the missing field here.
    const sig = parseSignatureHeader(raw)
    if (
      sig &&
      sig.accepted &&
      typeof sig.accepted.network === 'string' &&
      typeof sig.accepted.asset === 'string'
    ) {
      return verifyOnchainProof(sig)
    }

    // 2) standard `exact` (EIP-3009)? Accepts either the `PAYMENT-SIGNATURE` (v2) or
    //    `X-PAYMENT` (v1) header value — the inner payload is identical.
    const exact = parseExactPaymentHeader(raw)
    if (exact) return verifyExact(exact)

    // Unparseable / legacy-with-no-`accepted` → a fresh 402, never a 500.
    return asChallenge()
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
      // Accept the v2 `PAYMENT-SIGNATURE` header OR the legacy v1 `X-PAYMENT` header
      // (a deprecated-but-common `exact` client sends the latter).
      result = await gate.verify(req.headers[HEADER_SIGNATURE] ?? req.headers[HEADER_SIGNATURE_V1])
    } catch (err) {
      // A server-side settle failure (relayer out of gas / facilitator down) is NOT
      // the payer's fault — return 5xx, never a 402 (which would tell them to re-pay).
      // Their signed authorization stays valid + unused.
      if (err instanceof SettlementError) {
        res.status(502)
        res.json({ x402Version: 2, error: 'settlement_failed', detail: err.message })
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
