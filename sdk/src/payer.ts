/**
 * MultiChainPayer — one buyer, many wallets, pay whatever the merchant asks.
 *
 * A {@link PipRailClient} is bound to exactly ONE chain and ONE wallet (an EVM key
 * can't sign a Solana tx, and vice-versa — that's enforced at bind time). So a
 * buyer who wants to pay a 402 *whatever chain/token it demands* holds one key per
 * chain. This is the ergonomic object that carries that bundle: give it a
 * `{ chain → wallet }` map and it builds one client per chain, then exposes a single
 * `fetch`/`get`/`post`/`plan`/`quote` that auto-routes to the first funded chain that
 * can settle — no manual "which client owns this rail?" plumbing.
 *
 * It is a thin, chain-agnostic composition over the existing primitives — it adds
 * NO new payment logic:
 *   - `planPayment` → {@link planAcross} (merge every chain's plan, payable-first)
 *   - `fetch`/`get`/`post` → {@link fetchAcross} (pay on the first chain that can settle)
 * Every payment still runs through its owning client's own spend policy,
 * `onBeforePay` hook, retries, and replay-protection. There is no cross-chain
 * custody, no price oracle, and no backend: across chains it pays the FIRST one you
 * list that can settle (your preference order — gas isn't comparable across coins);
 * within a chain it picks the cheapest-gas rail.
 *
 * Because it implements {@link PayingClient}, the agent toolkit ({@link paymentTools})
 * and the MCP server wrap it byte-identically to a single client.
 */
import { PipRailClient, planAcross, fetchAcross } from './client.js'
import type {
  PayingClient,
  PipRailQuote,
  PaymentPlan,
  PaymentScheme,
  PipRailEvent,
  WalletInput,
  SessionBudget,
  DiscoverOptions,
  RegisterOptions,
} from './client.js'
import type { ChainSelector } from './drivers/types.js'
import type { PaymentPolicy } from './policy.js'
import { SpendLedger, type SpendSummary } from './ledger.js'
import type { SpendStore } from './spendstore.js'
import type { DiscoveredResource, RegisterOutcome } from './indexes.js'

/**
 * One wallet per chain you fund, keyed by chain selector. The KEY is a chain
 * string (an EVM preset like `'base'`/`'bnb'`, or a non-EVM family
 * `'solana'|'ton'|'tron'|'near'|'sui'|'aptos'|'algorand'|'stellar'|'xrpl'`); the
 * VALUE is that family's {@link WalletInput}:
 *
 *   every chain → { key }   ·   near → { accountId, key }
 *   (`key` is that chain's secret string — see {@link WalletInput} for the per-chain format)
 *
 * One key per family — this map is how a single buyer carries the keys for every
 * chain it's willing to pay on. (For a CUSTOM EVM chain configured by a viem
 * `Chain` object, build the {@link PipRailClient} yourself and use
 * `new MultiChainPayer([...clients])`.)
 */
export interface MultiChainPayerOptions {
  /** `{ chain → wallet }`. Iteration order is your chain PREFERENCE: across chains the
   *  first one that can settle wins (there's no oracle to compare gas across coins). */
  wallets: Record<string, WalletInput>
  /** Spend policy applied to EVERY chain's client. Because `fromWallets` gives every
   *  client a SHARED ledger, the cross-token grand total (`maxTotalPerDenom`) and the
   *  payment-count caps (`maxPayments`/`maxPaymentsPerWindow`) span ALL chains as ONE
   *  budget — so `{ maxTotalPerDenom: { USD: '20' } }` means "$20 across every chain",
   *  not $20 per chain. The per-asset `maxTotal` stays per (network, asset). */
  policy?: PaymentPolicy
  /** Durable spend store for the SHARED ledger — make the whole cross-chain budget
   *  survive a restart (hydrates once, persists every settle). One file backs every
   *  chain. Use `fileSpendStore('./spend.jsonl')` from `@piprail/sdk/node`. */
  spendStore?: SpendStore
  /** Per-chain RPC overrides, keyed by the same chain selector as `wallets`. */
  rpcUrls?: Record<string, string>
  /** Which schemes every client may settle. Default `['onchain-proof']` (unchanged). */
  schemes?: PaymentScheme[]
  /** Final approval hook applied to every chain's client (fires before any send). */
  onBeforePay?: (quote: PipRailQuote) => boolean | Promise<boolean>
  /** Observability hook applied to every chain's client. */
  onEvent?: (event: PipRailEvent) => void
  /** Retry budget for the post-broadcast leg, per client. Default 3. */
  maxPaymentRetries?: number
  /** Timeout (ms) for the retry leg, per client. Default 30_000. */
  retryTimeoutMs?: number
}

export class MultiChainPayer implements PayingClient {
  private readonly _clients: PipRailClient[]
  /** True when every client shares ONE ledger (the `fromWallets` path) — so spend +
   *  budget are read from that single source, never concatenated (which would
   *  double-count a shared ledger). */
  private readonly _shared: boolean

  /**
   * Wrap an explicit, ordered set of single-chain clients — use this when a client
   * needs full control (e.g. a custom EVM chain configured by a viem `Chain`). The
   * ORDER is your chain preference: across chains the first that can settle wins. Pass
   * at MOST one client per chain — two clients on the SAME network would double-count in
   * `spent()`/`budget()` and waste a plan round-trip (`fromWallets` can't produce this).
   * For the common case, prefer {@link MultiChainPayer.fromWallets}.
   *
   * For a cross-chain grand total / count cap via this path, build the clients with a
   * SHARED `ledger` (`new SpendLedger(store?)` passed to each client's `ledger` option)
   * and set `opts.shared = true` so reads come from that one ledger. `fromWallets` does
   * this for you.
   */
  constructor(clients: PipRailClient[], opts: { shared?: boolean } = {}) {
    if (clients.length === 0) {
      throw new TypeError('MultiChainPayer needs at least one PipRailClient.')
    }
    this._clients = [...clients]
    this._shared = opts.shared ?? false
  }

  /**
   * Build one client per funded chain from a `{ chain → wallet }` map — the
   * ergonomic path. The shared `policy`/`schemes`/`onBeforePay`/`onEvent` apply to
   * every client; `rpcUrls` are matched per chain. Iteration order of `wallets` is
   * the chain preference.
   *
   * ```ts
   * const payer = MultiChainPayer.fromWallets({
   *   wallets: {
   *     base:    { key: process.env.EVM_KEY! },
   *     solana:  { key: process.env.SOLANA_SECRET! },
   *     xrpl:    { key: process.env.XRPL_SEED! },
   *   },
   *   // ONE budget across all three chains: $20 total + at most 100 payments.
   *   policy: { maxAmount: '1.00', maxTotalPerDenom: { USD: '20.00' }, maxPayments: 100 },
   * })
   * const res = await payer.get('https://api.example.com/paid')  // pays on the first funded chain that can settle
   * ```
   *
   * Every client shares ONE {@link SpendLedger} (optionally backed by `spendStore`), so
   * the cross-token grand total + the count caps span all chains as a single budget.
   */
  static fromWallets(opts: MultiChainPayerOptions): MultiChainPayer {
    const entries = Object.entries(opts.wallets)
    if (entries.length === 0) {
      throw new TypeError('MultiChainPayer.fromWallets needs at least one wallet.')
    }
    // ONE shared ledger across every chain — this is what makes maxTotalPerDenom + the
    // count caps a single cross-chain budget (and `spendStore` persists the whole thing).
    const ledger = new SpendLedger(opts.spendStore)
    const clients = entries.map(
      ([chain, wallet]) =>
        new PipRailClient({
          chain: chain as ChainSelector,
          wallet,
          ledger,
          ...(opts.policy ? { policy: opts.policy } : {}),
          ...(opts.schemes ? { schemes: opts.schemes } : {}),
          ...(opts.rpcUrls?.[chain] ? { rpcUrl: opts.rpcUrls[chain] } : {}),
          ...(opts.onBeforePay ? { onBeforePay: opts.onBeforePay } : {}),
          ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          ...(opts.maxPaymentRetries != null ? { maxPaymentRetries: opts.maxPaymentRetries } : {}),
          ...(opts.retryTimeoutMs != null ? { retryTimeoutMs: opts.retryTimeoutMs } : {}),
        })
    )
    return new MultiChainPayer(clients, { shared: true })
  }

  /** The underlying single-chain clients, in preference order. Reach for one of
   *  these for chain-specific reads (`estimateCost`, `discoverySigner`, per-chain
   *  `budget()`) that don't make sense merged. */
  get clients(): readonly PipRailClient[] {
    return this._clients
  }

  /** Plan a 402 across every funded chain — merged + ranked payable-first. `null`
   *  when the URL needs no payment. (Delegates to {@link planAcross}.) */
  planPayment(url: string, init?: RequestInit): Promise<PaymentPlan | null> {
    return planAcross(this._clients, url, init)
  }

  /** Can ANY funded chain settle this URL right now? (A free resource is trivially
   *  "affordable".) No funds move. */
  async canAfford(url: string, init?: RequestInit): Promise<boolean> {
    const plan = await this.planPayment(url, init)
    return plan == null ? true : plan.payable
  }

  /** Price a gated URL across funded chains — the chosen rail's quote (the first
   *  funded chain that can settle), else the first offered rail's. `null` when the URL
   *  needs no payment. When it IS
   *  gated but none of your chains are offered, surfaces the same informative
   *  `NoCompatibleAcceptError` a single client would (it names the chains the 402 is
   *  payable on) rather than a misleading `null`. No funds move. */
  async quote(url: string, init?: RequestInit): Promise<PipRailQuote | null> {
    const plan = await this.planPayment(url, init)
    if (plan == null) return null
    const opt = plan.best ?? plan.options[0]
    if (opt) return opt.quote
    return this._clients[0]!.quote(url, init)
  }

  /** Pay the first funded chain (in your listed order) that can settle this URL.
   *  Delegates to {@link fetchAcross} — full policy / approval / retry / replay path on
   *  the owning client. The owner re-reads balances at pay time, so the rail paid is the
   *  surfaced `best` on a best-effort basis (it can pick another rail on the SAME chain,
   *  or decline, if balances shift between plan and pay). PROBES the URL with `init`
   *  (method + body) per client — prefer GET / idempotent requests. */
  fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetchAcross(this._clients, url, init)
  }

  /** GET that auto-pays across chains. */
  get(url: string, init?: RequestInit): Promise<Response> {
    return this.fetch(url, { ...(init ?? {}), method: 'GET' })
  }

  /**
   * POST that auto-pays across chains. `body` is a string/FormData/URLSearchParams/
   * ArrayBuffer/Blob (sent as-is) or a plain object (serialised as JSON) — mirrors
   * {@link PipRailClient.post}.
   */
  post(url: string, body?: BodyInit | object | undefined, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    let payload: BodyInit | undefined
    // Branch order MIRRORS PipRailClient.post exactly (incl. the String() primitive
    // fallback) so a number/boolean/bigint body doesn't trip NonReplayableBodyError.
    if (body === undefined || body === null) {
      payload = undefined
    } else if (isBodyInit(body)) {
      payload = body
    } else if (typeof body === 'object') {
      payload = JSON.stringify(body)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    } else {
      payload = String(body)
    }
    return this.fetch(url, { ...(init ?? {}), method: 'POST', headers, body: payload })
  }

  /**
   * Find payable resources across every funded chain. With the default
   * `network: 'self'`, each chain's own results are merged + deduped by URL (so
   * "self" means "any chain I can pay"). A network-scoped query (a CAIP-2 id or
   * `'any'`) is chain-independent, so one client answers it. Never throws for a
   * read problem; moves no funds.
   */
  async discover(opts: DiscoverOptions = {}): Promise<DiscoveredResource[]> {
    if (opts.network && opts.network !== 'self') {
      return this._clients[0]!.discover(opts)
    }
    const perChain = await Promise.all(
      this._clients.map((c) => c.discover({ ...opts, network: 'self' }).catch(() => []))
    )
    const seen = new Set<string>()
    const merged: DiscoveredResource[] = []
    for (const r of perChain.flat()) {
      if (seen.has(r.resource)) continue
      seen.add(r.resource)
      merged.push(r)
    }
    return merged
  }

  /** List a resource YOU run on the open indexes. Registration is a merchant action
   *  independent of which chain you pay FROM, so it goes through your first chain's
   *  client; pass `opts.network` to advertise a specific chain. Moves no funds. */
  register(url: string, opts: RegisterOptions = {}): Promise<RegisterOutcome[]> {
    return this._clients[0]!.register(url, opts)
  }

  /**
   * Aggregate spend across every chain. With a SHARED ledger (`fromWallets`), this reads
   * that single ledger ONCE (its records already span every chain) — so the count and the
   * cross-token `byDenom` grand total are correct and never double-counted. With
   * independent clients (the explicit constructor), it concatenates: counts summed,
   * per-(network,asset) `byAsset` + `byDenom` + records concatenated.
   */
  spent(): SpendSummary {
    if (this._shared) return this._clients[0]!.spent()
    const summaries = this._clients.map((c) => c.spent())
    return {
      count: summaries.reduce((n, s) => n + s.count, 0),
      byAsset: summaries.flatMap((s) => s.byAsset),
      byDenom: summaries.flatMap((s) => s.byDenom),
      records: summaries.flatMap((s) => s.records),
    }
  }

  /**
   * A merged budget view. With a SHARED ledger (`fromWallets`) it's the single source of
   * truth — `byAsset`/`byDenom`/`counts` already span every chain, so the grand-total and
   * count leashes read as ONE budget. With independent clients it merges: per-(network,
   * asset) rows + per-denom rows concatenated, counts summed, and the MOST-RESTRICTIVE
   * session time envelope (the soonest deadline wins). Per-chain detail is on each
   * `clients[i].budget()`.
   */
  budget(): SessionBudget {
    if (this._shared) return this._clients[0]!.budget()
    const budgets = this._clients.map((c) => c.budget())
    const session = budgets
      .map((b) => b.session)
      .reduce((soonest, s) => {
        if (soonest.secondsRemaining == null) return s
        if (s.secondsRemaining == null) return soonest
        return s.secondsRemaining < soonest.secondsRemaining ? s : soonest
      })
    return {
      session,
      byAsset: budgets.flatMap((b) => b.byAsset),
      byDenom: budgets.flatMap((b) => b.byDenom),
      counts: { settled: budgets.reduce((n, b) => n + b.counts.settled, 0) },
    }
  }

  /** The CONFIGURED spend policy (the shared policy `fromWallets` applies to every chain;
   *  the first client's for the explicit constructor). `undefined` when none is set. */
  policy(): PaymentPolicy | undefined {
    return this._clients[0]!.policy()
  }
}

/** A replayable BodyInit the SDK can send twice through the 402 flow (a plain
 *  object is NOT — it's serialised to JSON first). */
function isBodyInit(value: unknown): value is BodyInit {
  if (typeof value === 'string') return true
  if (value instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(value)) return true
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return true
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  return false
}
