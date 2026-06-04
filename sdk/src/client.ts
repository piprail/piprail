import { resolveNetwork } from './drivers/index.js'
import type {
  ResolvedNetwork,
  WalletHandle,
  ChainSelector,
  CostEstimate,
  RecipientReason,
  WalletBalance,
} from './drivers/types.js'
import {
  HEADER_SIGNATURE,
  buildSignatureHeader,
  parseChallenge,
  parseReceipt,
  type Caip2,
  type X402AcceptEntry,
  type X402Challenge,
  type X402PaymentSignature,
  type X402Receipt,
} from './x402.js'
import {
  InvalidEnvelopeError,
  MaxRetriesExceededError,
  NoCompatibleAcceptError,
  NonReplayableBodyError,
  PaymentDeclinedError,
  PaymentTimeoutError,
  WrongChainError,
} from './errors.js'
import { evaluatePolicy, type PaymentIntent, type PaymentPolicy } from './policy.js'
import { SpendLedger, type SpendSummary } from './ledger.js'
import { formatUnits } from './util/units.js'

/** Observability events. `ref` is the proof — a chain-specific id (EVM tx hash, Solana signature, TON locator, Stellar tx hash). */
export type PipRailEvent =
  | { kind: 'payment-required'; challenge: X402Challenge; accept: X402AcceptEntry }
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
  | { kind: 'payment-settled'; receipt: X402Receipt | null }
  | { kind: 'payment-failed'; reason: string }

/**
 * Wallet for the chosen chain family (the `chain` selector routes; each driver
 * validates its own key format):
 *   - EVM     → `{ privateKey }` (0x… hex) or a viem `{ walletClient }`
 *   - Tron    → `{ privateKey }` (32-byte hex — secp256k1, like EVM)
 *   - Sui     → `{ privateKey }` (suiprivkey1… bech32) or a ready `{ keypair }`
 *   - Solana  → `{ secretKey }` (Uint8Array | base58) or `{ signer }`
 *   - TON     → `{ mnemonic }` (24 words) or a ready `{ keyPair }`
 *   - Stellar → `{ secret }` (S… seed) or a ready `{ keypair }`
 *   - XRPL    → `{ seed }` (s… seed) or a ready `{ wallet }`
 *   - NEAR    → `{ accountId, privateKey }` (privateKey = ed25519:… secret)
 */
export type WalletInput =
  | { privateKey: string }
  | { walletClient: unknown }
  | { secretKey: Uint8Array | string }
  | { signer: unknown }
  | { mnemonic: string | string[]; version?: 'v4' | 'v5r1' }
  | { keyPair: unknown; version?: 'v4' | 'v5r1' }
  | { secret: string }
  | { keypair: unknown }
  | { seed: string }
  | { wallet: unknown }
  | { accountId: string; privateKey: string }

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

/** A soft flag — never blocks, always worth surfacing to the agent. */
export type PayWarning =
  | 'SYMBOL_MISMATCH' // the challenge's stated symbol disagrees with the SDK's true one (scam smell)
  | 'BALANCE_UNREADABLE' // a balance read failed (transient) — payability is uncertain, not "broke"
  | 'RECIPIENT_READINESS_UNKNOWN' // the readiness probe failed (transient) — the payment may still bounce
  | 'GAS_HEURISTIC' // gas is a typical-cost constant, not a live RPC estimate (cost.basis)
  | 'THIN_GAS_MARGIN' // has gas, but < 1.5× the estimate — a fee spike could fail the send

/** One offered rail, fully analysed against the bound wallet's own holdings. */
export interface PayOption {
  /** The rail this analyses (one entry from the 402's accepts[]). */
  accept: X402AcceptEntry
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
}

/** Plain-language fix per receive-prerequisite, surfaced in PayOption.recipient.fix. */
const RECIPIENT_FIX: Record<RecipientReason, string> = {
  NO_TRUSTLINE: 'the recipient needs a one-time trustline for this asset before it can receive',
  NOT_REGISTERED: 'the recipient must be storage_deposit-registered on this token (NEP-145, one-time)',
  NOT_OPTED_IN: 'the recipient must opt into this asset once (a 0-amount self-transfer)',
  INACTIVE: "the recipient account doesn't exist yet — fund it with the chain's base reserve to activate it",
}

export interface PipRailClientOptions {
  /** Wallet for the chosen chain family. */
  wallet: WalletInput
  /** Which chain to pay on. EVM ('bnb'|'base'|…), 'solana', 'ton', 'stellar',
   *  'xrpl', 'tron', 'sui', or 'near'. */
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
  /** Logger hook. Default no-op. */
  onEvent?: (event: PipRailEvent) => void
}

export class PipRailClient {
  private readonly opts: PipRailClientOptions
  private readonly maxRetries: number
  private readonly retryTimeoutMs: number
  private readonly onEvent: (event: PipRailEvent) => void

  // Per-asset tally of everything this client has paid (powers spent() and the
  // policy's maxTotal cap).
  private readonly ledger = new SpendLedger()

  // Resolved lazily on first request — this is what lets Solana (and future
  // families) auto-mount with no setup call.
  private bound?: Promise<{ net: ResolvedNetwork; wallet: WalletHandle }>

  constructor(opts: PipRailClientOptions) {
    this.opts = opts
    this.maxRetries = Math.max(1, opts.maxPaymentRetries ?? 3)
    this.retryTimeoutMs = opts.retryTimeoutMs ?? 30_000
    this.onEvent = opts.onEvent ?? (() => undefined)
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

  /** Auto-mount the chain's driver, resolve the network, and bind the wallet — once. */
  private ensure(): Promise<{ net: ResolvedNetwork; wallet: WalletHandle }> {
    return (this.bound ??= (async () => {
      const net = await resolveNetwork({
        chain: this.opts.chain,
        rpcUrl: this.opts.rpcUrl,
      })
      const wallet = net.bindWallet(this.opts.wallet)
      return { net, wallet }
    })())
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
    const { quote } = await this.resolveChallenge(url, res)
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
    const { net, accept, quote } = await this.resolveChallenge(url, res)
    const cost = await net.estimateCost(accept)
    return { quote, cost }
  }

  /** Aggregated snapshot of every payment this client has settled — total
   *  count, cumulative spend per token, and the individual records. */
  spent(): SpendSummary {
    return this.ledger.summary()
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
    return this.planFromChallenge(net, wallet, challenge, url)
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

  /**
   * Lower-level: drive any HTTP method through the 402 flow.
   *
   * `init.body` (if any) must be replayable — the SDK may send the request
   * twice (once to fetch the 402, once with the proof attached). One-shot
   * streams throw `NonReplayableBodyError`.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const body = init?.body
    if (body !== undefined && body !== null && !isReplayableBodyInit(body)) {
      throw new NonReplayableBodyError(
        'fetch(): init.body is not replayable. Pass a string, FormData, ' +
          'URLSearchParams, ArrayBuffer, or Blob — not a ReadableStream.'
      )
    }

    const firstResponse = await fetch(url, init)
    if (firstResponse.status !== 402) return firstResponse

    const resolved = await this.resolveChallenge(url, firstResponse)
    const { net, wallet, challenge } = resolved
    let accept = resolved.accept
    let quote = resolved.quote

    // Balance-aware routing (opt-in): pay the cheapest rail the wallet can ACTUALLY
    // settle, not just the first policy-passing one. Refuses (before any send) with the
    // funding hint if nothing is settleable.
    const autoRoute =
      (init as { autoRoute?: boolean } | undefined)?.autoRoute ?? this.opts.autoRoute ?? false
    if (autoRoute) {
      const plan = await this.planFromChallenge(net, wallet, challenge, url)
      if (!plan.best) {
        throw new PaymentDeclinedError(plan.fundingHint ?? 'No rail is settleable for this payment.')
      }
      accept = plan.best.accept
      quote = plan.best.quote
    }

    this.safeEmit({ kind: 'payment-required', challenge, accept })

    // Budget + approval gate — both refuse BEFORE any on-chain send.
    await this.authorize(quote)

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
    response: Response
  ): Promise<{
    net: ResolvedNetwork
    wallet: WalletHandle
    accept: X402AcceptEntry
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

    // Every accept this client could pay: our scheme, on the bound network. A
    // multi-chain challenge may offer several — including the same network more
    // than once (e.g. USDC and native) — so gather them all, then let policy choose.
    const candidates = this.gatherCandidates(net, challenge)
    if (candidates.length === 0) {
      const networks = challenge.accepts.map((a) => a.network).join(', ')
      throw new NoCompatibleAcceptError(
        `No accepts[] entry for ${net.network} ` +
          `(challenge offered: ${networks || 'none'}).`
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

  /** The candidate accepts this client could pay: our scheme, on the bound network. */
  private gatherCandidates(
    net: ResolvedNetwork,
    challenge: X402Challenge
  ): X402AcceptEntry[] {
    return challenge.accepts.filter(
      (a) => a.scheme === 'onchain-proof' && net.supports(a.network)
    )
  }

  /** Build the full {@link PaymentPlan} from an already-parsed challenge + bound
   *  net/wallet. Shared by `planPayment` (read-only) and `fetch`'s autoRoute. */
  private async planFromChallenge(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    challenge: X402Challenge,
    url: string
  ): Promise<PaymentPlan> {
    const chainLabel = typeof this.opts.chain === 'string' ? this.opts.chain : net.network
    const candidates = this.gatherCandidates(net, challenge)
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
      }
    }
    // Analyse every rail in parallel; one rail's read failure never sinks the others
    // (analyzeRail catches its own reads → 'unknown', never throws for an RPC hiccup).
    const analysed = await Promise.all(
      candidates.map((accept) =>
        this.analyzeRail(net, wallet, accept, url, challenge.resource.description)
      )
    )
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
    }
  }

  /** Analyse ONE rail against the wallet's holdings — quote (existing) + gas
   *  (estimateCost, existing) + balanceOf + recipientReady → a {@link PayOption}. */
  private async analyzeRail(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402AcceptEntry,
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
    const isNative = accept.asset === 'native'
    const blockers: PayBlocker[] = []
    const warnings: PayWarning[] = []
    const shortfall: { token?: string; native?: string } = {}

    if (!quote.withinPolicy) blockers.push('OUTSIDE_POLICY')
    if (quote.symbolMismatch) warnings.push('SYMBOL_MISMATCH')
    if (cost.basis === 'heuristic') warnings.push('GAS_HEURISTIC')

    const tokenKnown = bal.token != null
    const nativeKnown = bal.native != null
    if (!tokenKnown || !nativeKnown) warnings.push('BALANCE_UNREADABLE')

    if (isNative) {
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

    const unreadable = isNative ? !nativeKnown : !tokenKnown || !nativeKnown
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
    accept: X402AcceptEntry,
    url: string,
    description?: string
  ): PipRailQuote {
    // A base-unit amount must be a non-negative integer string. A malformed one
    // (a buggy/hostile server) becomes a typed InvalidEnvelopeError, never a raw
    // BigInt SyntaxError leaking out of quote()/fetch().
    if (!/^\d+$/.test(accept.amount)) {
      throw new InvalidEnvelopeError(
        `challenge amount "${accept.amount}" is not a base-unit integer.`
      )
    }
    const amountBase = BigInt(accept.amount)
    const described = net.describeAsset(accept.asset)
    const decimals = described?.decimals ?? accept.extra.decimals
    const symbol = described?.symbol ?? accept.extra.symbol
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
    const decision = evaluatePolicy(
      intent,
      this.opts.policy,
      this.ledger.totalFor(accept.network, accept.asset)
    )
    const serverSymbol = accept.extra.symbol
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
    }
  }

  /** Enforce the spend policy and the onBeforePay hook — both refuse by
   *  throwing PaymentDeclinedError, before any funds move. */
  private async authorize(quote: PipRailQuote): Promise<void> {
    if (!quote.withinPolicy) {
      throw new PaymentDeclinedError(
        `Payment refused by policy: ${quote.policyReason ?? 'not allowed'}`
      )
    }
    const hook = this.opts.onBeforePay
    if (!hook) return
    let approved: boolean
    try {
      approved = await hook(quote)
    } catch (err) {
      // A throwing decision hook means "do not pay" — fail safe, never pay.
      throw new PaymentDeclinedError('onBeforePay threw — refusing to pay.', {
        cause: err,
      })
    }
    if (!approved) {
      throw new PaymentDeclinedError(
        `onBeforePay declined ${quote.amountFormatted} ${quote.symbol ?? ''}`.trimEnd() +
          ` on ${quote.network}.`
      )
    }
  }

  /** Record a settled payment in the ledger (true decimals for the running total). */
  private recordSpend(quote: PipRailQuote, ref: string): void {
    this.ledger.record(
      {
        url: quote.url,
        host: hostOf(quote.url),
        network: quote.network,
        asset: quote.asset,
        amountBase: quote.amount,
        amountFormatted: quote.amountFormatted,
        ...(quote.symbol ? { symbol: quote.symbol } : {}),
        ref,
        at: new Date().toISOString(),
      },
      quote.decimals
    )
  }

  private async payAndConfirm(
    net: ResolvedNetwork,
    wallet: WalletHandle,
    accept: X402AcceptEntry
  ): Promise<{ ref: string; confirmed: boolean }> {
    if (!net.supports(accept.network)) {
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
      const { height } = await net.confirm(ref, accept.extra.minConfirmations ?? 1)
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
      payload: { nonce: accept.extra.nonce, txHash: ref },
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
    })
    throw new MaxRetriesExceededError(
      `Server still returned 402 after ${attempts} attempt(s) with on-chain proof ` +
        `ref=${ref}${unconfirmedNote}. Last server rejection: ${why}. ` +
        `Re-verify or re-submit ref=${ref} before retrying — never re-pay (it would double-spend).`,
      { ref }
    )
  }
}

/* ----------------------------- helpers ----------------------------- */

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

/** One actionable, human sentence on exactly what to do when no rail is payable —
 *  built from the least-blocked option (the closest to settleable). */
function buildFundingHint(options: PayOption[], chainLabel: string): string | null {
  if (options.length === 0) return null
  const target = [...options].sort((a, b) => a.blockers.length - b.blockers.length)[0]!
  const sym = target.quote.symbol ?? 'the token'
  if (target.blockers.includes('RECIPIENT_NOT_READY')) {
    return `Recipient ${shortAddr(target.accept.payTo)} can't receive on ${chainLabel} yet — ${target.recipient.fix ?? 'recipient not ready'}.`
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
 * payable rail; across different native coins there's no oracle to pick the
 * fiat-cheapest, so the tiebreak is the order `clients` were given (the agent's own
 * chain preference). Returns `null` only if the URL isn't gated for any client.
 */
export async function planAcross(
  clients: PipRailClient[],
  url: string,
  init?: RequestInit
): Promise<PaymentPlan | null> {
  const plans = await Promise.all(clients.map((c) => c.planPayment(url, init).catch(() => null)))
  const live = plans.filter((p): p is PaymentPlan => p != null)
  if (live.length === 0) return null
  // Concatenate options in client order, then re-rank payable-first (stable keeps
  // the agent's client preference as the cross-coin tiebreak).
  const options = rankOptions(live.flatMap((p) => p.options))
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
    // First non-null hint across clients — each already names its chain.
    fundingHint: best ? null : (live.map((p) => p.fundingHint).find(Boolean) ?? null),
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
 * Read a server's 402 rejection reason. The gate returns
 * `{ status: 'invalid', error, detail }` when it refuses a proof; we relay that
 * `error` (a `VerifyErrorCode`) + `detail` to the agent. Returns null when the
 * body isn't that shape (e.g. a re-issued challenge), so the caller keeps the
 * previous reason.
 */
async function readInvalidReason(
  response: Response
): Promise<{ error: string; detail: string } | null> {
  try {
    const body = (await response.clone().json()) as Record<string, unknown>
    if (body && (body.status === 'invalid' || typeof body.error === 'string')) {
      return {
        error: typeof body.error === 'string' ? body.error : 'no error code',
        detail: typeof body.detail === 'string' ? body.detail : '',
      }
    }
  } catch {
    /* body wasn't JSON in the expected shape — fall back to the prior reason */
  }
  return null
}
