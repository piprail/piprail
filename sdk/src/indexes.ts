/**
 * Open-index adapters — the ONLY place the open x402 directories' URLs and
 * payload shapes live. PipRail hosts none of these; we read from and write to
 * the open infra that already exists (see `.claude/research/x402-discovery.md`):
 *
 *   - CDP Bazaar  — free, no-key READ of the facilitator catalog.
 *   - 402 Index   — free READ + no-auth WRITE (the primary register target).
 *   - x402scan    — SIWX WRITE (one wallet signature; Base/Solana only).
 *
 * Protocol layer (STANDARDS §1): imports only `x402.ts` types + the global
 * `fetch`. ZERO chain libraries. Reads are best-effort and NEVER throw — a dead
 * or changed index resolves to `[]` (search) or `{ ok:false, detail }` (register),
 * mirroring the SDK's read-only methods. The chain-aware orchestration (network
 * filtering, signing) lives on the client; this file is pure transport + shape.
 */
import type { Caip2 } from './x402.js'
import type { DiscoverySigner } from './drivers/types.js'

/** The open directories PipRail can read from / write to. */
export type DiscoverySource = 'bazaar' | '402index' | 'x402scan'

/** One payment option as an index reports it — looser than a live `accepts[]`
 *  entry (indexes are cross-scheme: `exact` is the norm, `onchain-proof` is ours). */
export interface DiscoveredRail {
  scheme: string
  network: string
  asset?: string
  amount?: string
  payTo?: string
  symbol?: string
}

/** A resource as returned by an open index, normalized to one shape. */
export interface DiscoveredResource {
  /** The gated resource URL (what an agent then quotes/pays). */
  resource: string
  /** Which open index surfaced it. */
  source: DiscoverySource
  name?: string
  description?: string
  category?: string
  /** Free-text tags/keywords, when the index reports them. */
  tags?: string[]
  /** Advertised price in USD, when the index reports one (402 Index). */
  priceUsd?: number
  /** Health/uptime score 0–100, when the index reports one (402 Index `reliability_score`).
   *  Higher = a more reliable, consistently-probeable endpoint — sort/filter on it to
   *  skip flaky resources. Absent for indexes that don't measure it (Bazaar). */
  reliabilityScore?: number
  /** Liveness as the index last probed it, e.g. `'healthy'` / `'degraded'` / `'down'`
   *  (402 Index `health_status`). Absent where unmeasured. */
  health?: string
  /** Whether the listing's domain is verified at the index (402 Index `domain_verified`).
   *  A verified resource is a stronger trust + relevance signal. Absent where the index
   *  has no such concept (Bazaar). */
  verified?: boolean
  /** Relevance score for the active query (set by {@link rankResources}); higher ranks
   *  first. Absent when no query was given (results keep first-seen / sort order). */
  score?: number
  /** The payment options the index advertises (best-effort, cross-scheme). */
  rails: DiscoveredRail[]
}

/** Where a listing stands after a register attempt — a branchable lifecycle
 *  state so an agent doesn't have to re-derive each index's behaviour:
 *  - `'live'`           — findable now (search it immediately).
 *  - `'pending-review'` — accepted, but the index reviews/propagates before it's
 *                         publicly findable; allow a short delay before `discover()`.
 *  - `'not-listable'`   — it didn't list (a failure, or this index structurally
 *                         can't list a PipRail resource). See `detail` + `note`. */
export type ListingVisibility = 'live' | 'pending-review' | 'not-listable'

/** The result of trying to list a resource on one open index. */
export interface RegisterOutcome {
  source: DiscoverySource
  ok: boolean
  /** HTTP status, when a request was made. */
  status?: number
  /** Human note — success summary or the reason it didn't list. */
  detail?: string
  /** A link to the listing, when the index returns one. */
  listingUrl?: string
  /** The lifecycle state of this listing — `'live'`, `'pending-review'`, or
   *  `'not-listable'`. Projected from {@link DIRECTORY_INFO}; branch on this
   *  instead of guessing how soon `discover()` will find the resource. */
  visibility?: ListingVisibility
  /** A one-line, agent-readable caveat for this source (from {@link DIRECTORY_INFO})
   *  — e.g. "402 Index reviews before publishing" or "discover() doesn't read
   *  x402scan, so a live listing there won't appear in discover() results". */
  note?: string
}

/** How to order results. `'relevance'` (the default when a {@link SearchOpenIndexesOptions.query}
 *  is given) ranks by query match via {@link rankResources}; the rest sort by a single field
 *  (descending unless `order:'asc'`), using each index's reported value (unknowns sort last). */
export type DiscoverySort = 'relevance' | 'reliability' | 'price' | 'uptime' | 'name'

export interface SearchOpenIndexesOptions {
  /**
   * Free-text query. Tokenized and matched across name / description / category / URL:
   * 402 Index is searched server-side (one request per token, unioned — so a multi-word
   * query like `"piprail demo"` still finds a resource that matches each word, which the
   * index's own AND-tokenized `?q=` would miss), the Bazaar list is filtered client-side,
   * and the merged set is ranked by relevance ({@link rankResources}).
   */
  query?: string
  /** Which indexes to read. Default `['bazaar', '402index']` (both free). */
  sources?: DiscoverySource[]
  /** Max results to FETCH per index request. Default 20. */
  limit?: number
  /** Keep ONLY this category (prefix match, case-insensitive) — strict: a resource the
   *  index didn't categorize is dropped (pushed to 402 Index server-side too). */
  category?: string
  /** Keep only resources paying in this asset symbol, e.g. `'USDC'` (pushed to 402 Index;
   *  applied client-side elsewhere, keeping items whose asset the index didn't report). */
  asset?: string
  /** Drop results advertised above this USD price (results with no advertised price pass). */
  maxPrice?: number
  /** Drop results whose reliability score is BELOW this (0–100). Results with no reported
   *  score pass through — use {@link DiscoveredResource.reliabilityScore} to inspect. */
  minReliability?: number
  /** Prefer verified listings (402 Index `verified=true`, server-side). NOTE: 402 Index's
   *  `verified` flag and its per-record `domain_verified` differ, so this is applied at the
   *  index, not re-filtered client-side; sources without a verified concept pass through.
   *  Inspect {@link DiscoveredResource.verified} for the per-record ownership signal. */
  verified?: boolean
  /** Restrict to listings the index confirmed are payable x402 (402 Index `payment_valid=true`). */
  paymentValid?: boolean
  /** Result ordering — see {@link DiscoverySort}. Default `'relevance'` with a query, else
   *  first-seen order (source priority). */
  sort?: DiscoverySort
  /** Sort direction for a non-relevance {@link sort}. Default `'desc'`. */
  order?: 'asc' | 'desc'
  signal?: AbortSignal
}

/** Server-side filters 402 Index understands (a subset of {@link SearchOpenIndexesOptions}). */
interface Index402Filters {
  category?: string
  asset?: string
  maxPrice?: number
  verified?: boolean
  paymentValid?: boolean
  sort?: DiscoverySort
  order?: 'asc' | 'desc'
}

/** What a merchant submits to register one resource on the open indexes. */
export interface RegisterInput {
  url: string
  name?: string
  description?: string
  priceUsd?: number
  /** Payment asset symbol, e.g. 'USDC' (402 Index metadata). */
  asset?: string
  /** Payment network slug, e.g. 'base' (402 Index metadata). */
  network?: string
  /** HTTP method the resource answers on. Default 'GET'. */
  method?: string
  /**
   * A category for the listing, e.g. `'ai'`, `'finance'`, `'data'`. The single
   * highest-leverage field for findability: most of 402 Index's catalog is
   * `uncategorized`, so a real category makes a resource rank + filter where almost
   * nothing else does. Free-text; pick the obvious bucket for what the endpoint does.
   */
  category?: string
  /**
   * Keywords for the listing. 402 Index search is literal (a term must appear in the
   * name or description to match), so these are folded into the description as a compact
   * keyword tail — making the resource findable by each term — and also sent as a `tags`
   * field for any index that indexes them natively. Skipped if already present / over the
   * length cap (same tasteful rules as the attribution suffix).
   */
  tags?: string[]
  /** Who runs the resource (provider/org name) — 402 Index `provider` metadata. */
  provider?: string
  /** Contact email for the listing (402 Index `contact_email`) — also used by domain claim. */
  contactEmail?: string
  /** A JSON request body 402 Index should send when health-checking a POST/PUT resource
   *  (402 Index `probe_body`), so probes succeed and the reliability score stays high. */
  probeBody?: unknown
  /**
   * Attribute the listing to PipRail. **Default ON** (set `false` to opt out). When on, the
   * payload gets a `via: '@piprail/sdk'` provenance field AND a compact `· Built with
   * @piprail/sdk` suffix on the description (see {@link appendAttribution}) — the one field an
   * index displays, so the listing is *visibly* built with PipRail as it spreads, the same
   * unobtrusive "Made with X" marker as the `/openapi.json` `x-generator`. It's metadata only:
   * never changes how the resource is paid or ranked, never double-stamps a description that
   * already mentions PipRail, and never fabricates one you didn't provide. The `User-Agent`
   * carries PipRail on every request regardless.
   */
  attribution?: boolean
}

/* ----------------------- directory lifecycle facts ----------------------- */

/**
 * Static, agent-readable lifecycle facts about one open index — the SINGLE source
 * of truth that {@link RegisterOutcome.visibility}/`note` are projected from, and
 * that an agent can also query directly (via {@link getDirectoryInfo}) to reason
 * about an index BEFORE calling. Best-effort: an index can change its behaviour,
 * so treat the timing as guidance, not an SLA.
 */
export interface DirectoryInfo {
  source: DiscoverySource
  /** How a new listing is gated: a synchronous URL probe (`402index`, `x402scan`),
   *  or coupled to a facilitator settling a payment (`bazaar`). */
  review: 'probe-sync' | 'settle-coupled'
  /** Auth needed to WRITE a listing. */
  auth: 'none' | 'siwx' | 'facilitator-only'
  /** Chains (CAIP-2) this index will list. `null` = any chain the resource advertises. */
  chains: readonly string[] | null
  /** Visibility a SUCCESSFUL listing reaches here (the steady state a non-failed
   *  outcome maps to). */
  onSuccess: ListingVisibility
  /** Whether THIS SDK's {@link PipRailClient.discover} reads this index. It reads
   *  `bazaar` + `402index`; it does NOT read `x402scan` — so a live x402scan listing
   *  won't appear in `discover()` results. Don't read that absence as failure. */
  readByDiscover: boolean
  /** One-line caveat: why a register might fail, or what to expect afterwards. */
  caveat: string
}

/**
 * The open directories' lifecycle, as one queryable map. An agent can branch on
 * this without embedding directory knowledge: `DIRECTORY_INFO[source].readByDiscover`,
 * `.chains`, `.onSuccess`, etc. {@link PipRailClient.register} projects the relevant
 * entry onto every {@link RegisterOutcome} (`visibility` + `note`).
 */
export const DIRECTORY_INFO: Readonly<Record<DiscoverySource, DirectoryInfo>> = Object.freeze({
  '402index': {
    source: '402index',
    review: 'probe-sync',
    auth: 'none',
    chains: null,
    onSuccess: 'pending-review',
    readByDiscover: true,
    caveat:
      '402 Index probes your URL on submit (rejecting anything that does not return a real 402), then ' +
      'lists it — a self-registered resource becomes searchable once it passes automated health + ' +
      'payment-validity checks, with NO domain verification required (observed live: searchable within ' +
      '~2 days for a healthy endpoint). Verify your domain on 402index.io for instant, guaranteed approval ' +
      '+ a verified badge, which also flips every pending listing on that domain live at once.',
  },
  x402scan: {
    source: 'x402scan',
    review: 'probe-sync',
    auth: 'siwx',
    chains: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    onSuccess: 'live',
    readByDiscover: false,
    caveat:
      'x402scan lists Base/Solana only, needs one wallet signature (SIWX), and requires a resolvable ' +
      'input schema (from /openapi.json or the bazaar extension in the 402 body). It goes live on ' +
      "x402scan.com immediately on success — but discover() does NOT read x402scan, so the listing " +
      "won't appear in discover() results.",
  },
  bazaar: {
    source: 'bazaar',
    review: 'settle-coupled',
    auth: 'facilitator-only',
    chains: null,
    onSuccess: 'not-listable',
    readByDiscover: true,
    caveat:
      'CDP Bazaar has no register endpoint — it catalogs a resource only when its own facilitator ' +
      'settles a payment. PipRail verifies locally with no facilitator, so a PipRail resource cannot be ' +
      'listed here (you can still READ Bazaar to find others). List on 402 Index or x402scan instead.',
  },
})

/** Lifecycle facts for one open index (auth, chains, how soon a listing is
 *  findable, whether `discover()` reads it). See {@link DIRECTORY_INFO}. The param
 *  is the closed {@link DiscoverySource} union (TS callers are safe); a string
 *  outside it returns `undefined` at runtime. */
export function getDirectoryInfo(source: DiscoverySource): DirectoryInfo {
  return DIRECTORY_INFO[source]
}

/** Project the static {@link DIRECTORY_INFO} lifecycle facts onto a register
 *  outcome, so an agent gets `visibility` + `note` in the result it already holds —
 *  no second lookup. A failed outcome is always `'not-listable'`. Idempotent. */
export function decorateOutcome(o: RegisterOutcome): RegisterOutcome {
  const info = DIRECTORY_INFO[o.source]
  // Respect a visibility the adapter already set (e.g. 402 Index reports a verified-domain
  // listing as 'live'); otherwise project the directory's steady-state.
  return { ...o, visibility: o.visibility ?? (o.ok ? info.onSuccess : 'not-listable'), note: info.caveat }
}

/* ----------------------------- endpoints ----------------------------- */

const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'
const INDEX402_SEARCH = 'https://402index.io/api/v1/services'
const INDEX402_REGISTER = 'https://402index.io/api/v1/register'
const INDEX402_CLAIM = 'https://402index.io/api/v1/claim'
const INDEX402_VERIFY = 'https://402index.io/api/v1/claim/verify'
const X402SCAN_REGISTER = 'https://www.x402scan.com/api/x402/registry/register'

/**
 * Identifies PipRail-driven traffic to the open indexes — a standard bot User-Agent with a
 * contact URL (the `+https://…` convention crawlers use). It's a request HEADER, so it can't
 * affect an index's body validation (no risk of breaking a register), and the browser keeps
 * its own UA where it must — always safe to send. A polite, honest "this came from PipRail."
 */
const USER_AGENT = '@piprail/sdk (+https://piprail.com)'

/** Headers for every outbound index request — always carries the PipRail User-Agent. */
function clientHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'user-agent': USER_AGENT, ...extra }
}

/* ----------------------------- network slugs ----------------------------- */

/** Slug ⇿ CAIP-2 for the chains the open indexes name by slug. Just data (no
 *  driver import — keeps this protocol-layer file chain-agnostic). The non-EVM
 *  values MUST match each family driver's own `caip2`, so a client's `'self'`
 *  filter lines up (Solana's reference is truncated to 32 chars per CAIP-2, the
 *  exact string the Solana driver binds). EVM chains beyond these resolve via
 *  the client's own `net.supports()`; an unrecognised slug is never silently
 *  dropped (see {@link PipRailClient.discover}). */
const SLUG_TO_CAIP2: Readonly<Record<string, Caip2>> = {
  // EVM (the common index-reported slugs; others fall through to net.supports)
  ethereum: 'eip155:1',
  base: 'eip155:8453',
  polygon: 'eip155:137',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  avalanche: 'eip155:43114',
  bnb: 'eip155:56',
  bsc: 'eip155:56',
  // non-EVM families — values mirror each driver's bound caip2 exactly
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  ton: 'tvm:-239',
  tron: 'tron:mainnet',
  near: 'near:mainnet',
  sui: 'sui:mainnet',
  aptos: 'aptos:1',
  algorand: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  stellar: 'stellar:pubnet',
  xrpl: 'xrpl:0',
}

/** Legacy CAIP-2 ids superseded by a corrected canonical id. PARSE-side only:
 *  we still accept an inbound/foreign challenge that uses the old id, but we
 *  EMIT the canonical one. (TON moved `ton:-239` → `tvm:-239`: the chainagnostic
 *  registry has no `ton` namespace; the foundation TON scheme mandates `tvm`.) */
const LEGACY_CAIP2_ALIAS: Readonly<Record<string, Caip2>> = {
  'ton:-239': 'tvm:-239',
}

/** Normalize an index's network field to CAIP-2 when we recognise the slug;
 *  pass a value that's already CAIP-2 (`namespace:reference`) through unchanged.
 *  A legacy/superseded CAIP-2 id is mapped to its canonical replacement first
 *  (so a colon-bearing legacy id like `ton:-239` still canonicalizes).
 *  An unknown slug returns unchanged (no `:`), which the client treats as
 *  "unresolved — don't hide it" rather than a confident mismatch. */
export function normalizeNetwork(network: string): string {
  const legacy = LEGACY_CAIP2_ALIAS[network]
  if (legacy) return legacy
  if (network.includes(':')) return network
  return SLUG_TO_CAIP2[network.toLowerCase()] ?? network
}

/* ----------------------------- read (search) ----------------------------- */

/**
 * Search the open indexes for payable resources, in parallel, and merge them into
 * one ranked list (deduped by resource URL — the first source in `sources` wins).
 * NEVER throws: any index that errors, times out, or changes shape contributes `[]`.
 *
 * Pipeline: fetch (402 Index server-side, with a per-token fan-out for multi-word
 * queries + server-side filters; Bazaar list, filtered client-side) → merge + dedupe
 * → client-side filters ({@link SearchOpenIndexesOptions.maxPrice}/`category`/`asset`/
 * `minReliability`, all keeping items the index didn't annotate) → rank/sort.
 */
export async function searchOpenIndexes(
  opts: SearchOpenIndexesOptions = {}
): Promise<DiscoveredResource[]> {
  const sources = opts.sources ?? ['bazaar', '402index']
  const limit = opts.limit ?? 20
  const filters: Index402Filters = {
    ...optionalRaw('category', opts.category),
    ...optionalRaw('asset', opts.asset),
    ...optionalRaw('maxPrice', opts.maxPrice),
    ...optionalRaw('verified', opts.verified),
    ...optionalRaw('paymentValid', opts.paymentValid),
    ...optionalRaw('sort', opts.sort),
    ...optionalRaw('order', opts.order),
  }
  const results = await Promise.all(
    sources.map((source) => {
      if (source === 'bazaar') return safeSearch(() => searchBazaar(opts.query, limit, opts.signal))
      if (source === '402index') return safeSearch(() => search402Index(opts.query, limit, filters, opts.signal))
      return Promise.resolve<DiscoveredResource[]>([]) // x402scan reads are paid — off by default here
    })
  )
  const merged = applyClientFilters(dedupeByResource(results.flat()), opts)
  // Order: relevance when a query is present (unless overridden), else first-seen — or a
  // requested field sort. Relevance ranking adds a `score`; field sorts are stable.
  const wantRelevance = opts.query !== undefined && (opts.sort ?? 'relevance') === 'relevance'
  if (wantRelevance) return rankResources(merged, opts.query)
  if (opts.sort && opts.sort !== 'relevance') return sortResources(merged, opts.sort, opts.order ?? 'desc')
  return merged
}

/** A `{ [field]: value }` spread only when `value` is defined (any type — keeps the
 *  filter object tidy without coercing falsy-but-valid values like `0`). */
function optionalRaw<T>(field: string, value: T | undefined): Record<string, T> {
  return value !== undefined ? { [field]: value } : {}
}

/**
 * Client-side filters applied to the MERGED set:
 *  - **`category` is STRICT:** asking for a category means you want exactly that, so a
 *    resource the index didn't categorize is DROPPED (otherwise un-categorized Bazaar
 *    listings, which carry no category, drown the real matches).
 *  - **`asset` / `maxPrice` / `minReliability` KEEP the un-annotated** (the "never hide an
 *    unresolved field" rule used for networks): a missing price/asset/score is "unknown",
 *    not "fails", so it passes and the agent confirms with `quote()`/`planPayment()`.
 *  - **`verified` is NOT filtered here** — it's pushed to 402 Index server-side only,
 *    because that index's `verified` flag and its per-record `domain_verified` field don't
 *    align (a server-"verified" listing can still report `domain_verified:0`), so a
 *    client-side strict check would wrongly drop everything. {@link DiscoveredResource.verified}
 *    remains the honest per-record ownership signal to inspect.
 */
function applyClientFilters(items: DiscoveredResource[], opts: SearchOpenIndexesOptions): DiscoveredResource[] {
  let out = items
  if (opts.category) {
    const want = opts.category.toLowerCase()
    out = out.filter((r) => r.category !== undefined && r.category.toLowerCase().startsWith(want)) // strict
  }
  if (opts.maxPrice !== undefined) {
    const max = opts.maxPrice
    out = out.filter((r) => r.priceUsd === undefined || r.priceUsd <= max)
  }
  if (opts.asset) {
    const want = opts.asset.toLowerCase()
    out = out.filter((r) => {
      const known = r.rails.map((x) => x.symbol ?? x.asset).filter((a): a is string => !!a)
      return known.length === 0 || known.some((a) => a.toLowerCase() === want)
    })
  }
  if (opts.minReliability !== undefined) {
    const min = opts.minReliability
    out = out.filter((r) => r.reliabilityScore === undefined || r.reliabilityScore >= min)
  }
  return out
}

/* ----------------------------- relevance ranking ----------------------------- */

/** Split text into lowercase alphanumeric tokens (the unit both the ranker and the
 *  402 Index fan-out work in). Empty/whitespace → `[]`. */
function tokenize(s: string | undefined): string[] {
  return (s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Per-field weights — a query term in the NAME is worth far more than one buried in a
 *  long description. Host+path catch domain-y queries (`"weather"` → `weather.example.com`). */
const FIELD_WEIGHTS = { name: 6, category: 4, tags: 4, path: 3, description: 2 } as const

/** The searchable token sets of one resource, paired with their weights. */
function fieldTokens(r: DiscoveredResource): Array<[string[], number]> {
  let pathText = r.resource
  try {
    const u = new URL(r.resource)
    pathText = `${u.hostname} ${u.pathname}`
  } catch {
    /* keep the raw string if it isn't a full URL */
  }
  return [
    [tokenize(r.name), FIELD_WEIGHTS.name],
    [tokenize(r.category), FIELD_WEIGHTS.category],
    [tokenize((r.tags ?? []).join(' ')), FIELD_WEIGHTS.tags],
    [tokenize(pathText), FIELD_WEIGHTS.path],
    [tokenize(r.description), FIELD_WEIGHTS.description],
  ]
}

/** Relevance score of one resource for a tokenized query. Exact token hits score full
 *  weight; a substring/prefix hit scores a fraction (only for tokens ≥4 chars, so short
 *  words like "ai"/"for" don't fuzz-match noise). A resource matching EVERY query token
 *  gets a big "complete match" bonus (this is what makes multi-word queries pinpoint).
 *  Returns 0 when nothing matched (the caller drops those). */
export function scoreResource(r: DiscoveredResource, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const fields = fieldTokens(r)
  let score = 0
  let matched = 0
  for (const qt of queryTokens) {
    let hit = false
    for (const [toks, w] of fields) {
      if (toks.includes(qt)) {
        score += w
        hit = true
      } else if (qt.length >= 4 && toks.some((t) => t.startsWith(qt) || (t.length >= 4 && qt.startsWith(t)))) {
        score += w * 0.4
        hit = true
      }
    }
    if (hit) matched++
  }
  if (matched === 0) return 0
  if (matched === queryTokens.length) score += 8 // complete-match bonus → pinpoint multi-word results
  // Tiny tie-breaker nudge from health, so equally-relevant results favour reliable endpoints.
  if (r.reliabilityScore !== undefined) score += r.reliabilityScore / 1000
  return score
}

/**
 * Rank resources by relevance to `query`, dropping non-matches and stamping each kept
 * resource with its `score` (descending). Pure + stable: equal scores keep input order
 * (so the dedupe's source priority survives a tie). No query → returned unchanged.
 */
export function rankResources(items: DiscoveredResource[], query: string | undefined): DiscoveredResource[] {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return items
  return items
    .map((r, i) => ({ r, i, s: scoreResource(r, qTokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => ({ ...x.r, score: x.s }))
}

/** Stable sort by a single reported field (unknowns last). Used when an explicit
 *  non-relevance {@link DiscoverySort} is requested. */
function sortResources(items: DiscoveredResource[], sort: DiscoverySort, order: 'asc' | 'desc'): DiscoveredResource[] {
  const dir = order === 'asc' ? 1 : -1
  const key = (r: DiscoveredResource): number | string | undefined =>
    sort === 'reliability' || sort === 'uptime'
      ? r.reliabilityScore
      : sort === 'price'
        ? r.priceUsd
        : sort === 'name'
          ? (r.name ?? r.resource).toLowerCase()
          : undefined // exhaustive over DiscoverySort's non-relevance members; defensive fallback
  return items
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ka = key(a.r)
      const kb = key(b.r)
      if (ka === undefined && kb === undefined) return a.i - b.i
      if (ka === undefined) return 1 // unknowns last regardless of direction
      if (kb === undefined) return -1
      if (ka < kb) return -1 * dir
      if (ka > kb) return 1 * dir
      return a.i - b.i
    })
    .map((x) => x.r)
}

async function safeSearch(
  run: () => Promise<DiscoveredResource[]>
): Promise<DiscoveredResource[]> {
  try {
    return await run()
  } catch {
    return []
  }
}

/** Dedupe by resource URL, preserving first-seen order (source priority). */
function dedupeByResource(items: DiscoveredResource[]): DiscoveredResource[] {
  const seen = new Set<string>()
  const out: DiscoveredResource[] = []
  for (const it of items) {
    const key = it.resource
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

async function searchBazaar(
  query: string | undefined,
  limit: number,
  signal?: AbortSignal
): Promise<DiscoveredResource[]> {
  const res = await fetch(`${BAZAAR_URL}?limit=${encodeURIComponent(String(limit))}`, {
    headers: clientHeaders({ accept: 'application/json' }),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) return []
  const body = (await res.json()) as { items?: unknown }
  const items = Array.isArray(body.items) ? body.items : []
  const mapped = items.map(mapBazaarItem).filter((r): r is DiscoveredResource => r !== null)
  // Bazaar's server-side search is unusable without a CDP key (its /search endpoint
  // answers 200 but returns nothing), so we filter its LIST locally: a loose any-token
  // pre-filter for recall, then the merged-set ranker handles precision + ordering.
  return query ? mapped.filter((r) => matchesQuery(r, query)) : mapped
}

function mapBazaarItem(raw: unknown): DiscoveredResource | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const resource = pickString(o, 'resource', 'url', 'endpoint')
  if (!resource) return null
  const meta = (o.metadata && typeof o.metadata === 'object' ? o.metadata : {}) as Record<string, unknown>
  return {
    resource,
    source: 'bazaar',
    rails: mapRails(o.accepts),
    ...optionalString('name', pickString(meta, 'name', 'title')),
    ...optionalString('description', pickString(meta, 'description') ?? pickString(o, 'description')),
    ...optionalString('category', pickString(meta, 'category')),
  }
}

/**
 * Search 402 Index — server-side, with a per-token FAN-OUT and server-side filters.
 *
 * 402 Index's `?q=` is AND-tokenized: a multi-word query only matches resources that
 * contain EVERY word together, so `"piprail demo"` returns nothing even though both words
 * are in our listing's name. To fix that without a backend we issue the full phrase PLUS
 * one request per token (capped, in parallel), union the results, and let the merged-set
 * ranker order by how many tokens each resource matched. Filters (`category`/`asset`/
 * `max_price_usd`/`verified`/`payment_valid`/`sort`) ride on every request.
 */
async function search402Index(
  query: string | undefined,
  limit: number,
  filters: Index402Filters,
  signal?: AbortSignal
): Promise<DiscoveredResource[]> {
  // Query strings to fan out over: the full phrase first (most precise AND-match), then
  // each distinct token. Capped at 5 requests so a long query can't storm the index.
  const tokens = tokenize(query)
  const queries: Array<string | undefined> =
    query && tokens.length > 1 ? [...new Set([query, ...tokens])].slice(0, 5) : [query]
  const pages = await Promise.all(queries.map((q) => safeSearch(() => fetch402Page(q, limit, filters, signal))))
  return dedupeByResource(pages.flat())
}

/** Fetch + map ONE 402 Index page for a single query string (or none) + filters. */
async function fetch402Page(
  query: string | undefined,
  limit: number,
  filters: Index402Filters,
  signal?: AbortSignal
): Promise<DiscoveredResource[]> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (query) qs.set('q', query)
  if (filters.category) qs.set('category', filters.category)
  if (filters.asset) qs.set('payment_asset', filters.asset)
  if (filters.maxPrice !== undefined) qs.set('max_price_usd', String(filters.maxPrice))
  if (filters.verified) qs.set('verified', 'true')
  if (filters.paymentValid) qs.set('payment_valid', 'true')
  if (filters.sort && filters.sort !== 'relevance') {
    qs.set('sort', filters.sort)
    qs.set('order', filters.order ?? 'desc')
  }
  const res = await fetch(`${INDEX402_SEARCH}?${qs.toString()}`, {
    headers: clientHeaders({ accept: 'application/json' }),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) return []
  const body = (await res.json()) as Record<string, unknown>
  const list = firstArray(body, 'services', 'results', 'items', 'data')
  return list
    .map(map402IndexItem)
    .filter((r): r is DiscoveredResource => r !== null)
    // 402 Index is protocol-mixed (L402 / MPP / x402) — keep only x402.
    .filter((r) => r.rails.length > 0)
}

function map402IndexItem(raw: unknown): DiscoveredResource | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const resource = pickString(o, 'url', 'resource', 'endpoint')
  if (!resource) return null
  const protocol = (pickString(o, 'protocol') ?? 'x402').toLowerCase()
  if (protocol !== 'x402') return null // drop L402 / MPP — not payable by PipRail
  const rails = Array.isArray(o.accepts)
    ? mapRails(o.accepts)
    : railFrom402IndexFields(o)
  const priceUsd = pickNumber(o, 'price_usd', 'priceUsd', 'price')
  const reliabilityScore = pickNumber(o, 'reliability_score', 'reliabilityScore')
  const tags = pickStringArray(o, 'tags', 'keywords')
  return {
    resource,
    source: '402index',
    rails,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(reliabilityScore !== undefined ? { reliabilityScore } : {}),
    ...(tags ? { tags } : {}),
    ...optionalString('name', pickString(o, 'name', 'title')),
    ...optionalString('description', pickString(o, 'description')),
    ...optionalString('category', pickString(o, 'category', 'tag')),
    ...optionalString('health', pickString(o, 'health_status', 'health')),
    // 402 Index reports domain_verified as 0/1; surface a boolean only when the field is present.
    ...(o.domain_verified !== undefined || o.verified !== undefined
      ? { verified: isTruthyFlag(o.domain_verified) || isTruthyFlag(o.verified) }
      : {}),
  }
}

/** Coerce a 402 Index 0/1/`'true'`/boolean flag to a clean boolean. */
function isTruthyFlag(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true'
}

/** 402 Index often flattens payment into top-level fields rather than accepts[]. */
function railFrom402IndexFields(o: Record<string, unknown>): DiscoveredRail[] {
  const network = pickString(o, 'payment_network', 'network')
  const asset = pickString(o, 'payment_asset', 'asset', 'token')
  if (!network && !asset) return []
  return [
    {
      scheme: 'exact',
      network: network ?? 'unknown',
      ...(asset ? { asset } : {}),
      ...optionalString('symbol', asset),
    },
  ]
}

/* ----------------------------- write (register) ----------------------------- */

/**
 * Register a resource on **402 Index** — the primary, friction-free path: a
 * single POST, no auth, no signature, no payment. A self-registered listing is
 * **pending review** (not searchable until approved — verify your domain on
 * 402index.io for instant approval). Returns a structured outcome; never throws
 * for an HTTP/transport problem. NOTE: the outcome is BARE — `visibility`/`note`
 * are added by {@link PipRailClient.register} (or call {@link decorateOutcome}).
 */
export async function register402Index(input: RegisterInput): Promise<RegisterOutcome> {
  try {
    // Attribution is ON by default (opt out with `attribution: false`) — a `via` provenance
    // field PLUS a tasteful description suffix (the one field 402 Index displays), so a
    // PipRail-registered listing is visibly "built with PipRail" as it spreads. See STANDARDS §
    // attribution — it's metadata only and never alters how the resource is paid or ranked.
    const attributionOn = input.attribution !== false
    // Fold keyword tags into the description FIRST (so they're searchable on a literal
    // index), then the attribution suffix — both tasteful, capped, never double-stamping.
    const withTags = appendKeywords(input.description, input.tags)
    const description = attributionOn ? appendAttribution(withTags) : withTags
    const payload: Record<string, unknown> = {
      url: input.url,
      name: input.name ?? hostOf(input.url),
      protocol: 'x402',
      ...(description ? { description } : {}),
      ...(typeof input.priceUsd === 'number' ? { price_usd: input.priceUsd } : {}),
      ...(input.asset ? { payment_asset: input.asset } : {}),
      ...(input.network ? { payment_network: input.network } : {}),
      ...(input.method ? { http_method: input.method.toUpperCase() } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.contactEmail ? { contact_email: input.contactEmail } : {}),
      ...(input.probeBody !== undefined ? { probe_body: input.probeBody } : {}),
      ...(attributionOn ? { via: '@piprail/sdk' } : {}),
    }
    const res = await fetch(INDEX402_REGISTER, {
      method: 'POST',
      headers: clientHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      // Read the body once: surface 402 Index's own message AND its structured status —
      // a register from a VERIFIED domain comes back `service.status:'active'` (live, not
      // pending-review), so report `visibility:'live'` for it (decorateOutcome honours it).
      const body = (await res.json().catch(() => ({}))) as { message?: unknown; service?: { status?: unknown } }
      const msg = typeof body.message === 'string' && body.message.length > 0 ? body.message : undefined
      const live = body.service?.status === 'active'
      return {
        source: '402index',
        ok: true,
        status: res.status,
        ...(live ? { visibility: 'live' as const } : {}),
        detail:
          msg ??
          (live
            ? 'Registered + live on 402 Index (domain verified).'
            : 'Registered on 402 Index — probed on submit, then searchable once it passes automated ' +
              'health + payment checks (verify your domain on 402index.io for instant approval + a verified badge).'),
      }
    }
    // Surface the index's own reason so a merchant can act — 402 Index PROBES the URL
    // and rejects (422) any endpoint that doesn't actually return a 402 (verified live).
    const why = await readIndexError(res)
    return {
      source: '402index',
      ok: false,
      status: res.status,
      detail: why ? `402 Index rejected it (HTTP ${res.status}): ${why}` : `402 Index returned HTTP ${res.status}.`,
    }
  } catch (err) {
    return { source: '402index', ok: false, detail: errMsg(err) }
  }
}

/** Pull a human reason out of an index's JSON error body (`error`/`detail`/`message`),
 *  so a failed register/registration explains itself instead of just "HTTP 4xx". */
async function readIndexError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as Record<string, unknown>
    const parts = [body.error, body.detail, body.message].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    )
    return parts.length ? [...new Set(parts)].join(' — ') : undefined
  } catch {
    return undefined
  }
}

/**
 * Register on **x402scan** via SIWX (Sign-In-With-X): POST the URL, sign the
 * EIP-4361 challenge with the merchant's own key, resend with the
 * `SIGN-IN-WITH-X` header. Facilitator-free, but **Base/Solana-only** and EVM
 * signing today. EXPERIMENTAL — the open SIWX handshake is a moving convention;
 * validate against x402scan before relying on it. Never throws. NOTE: returns a
 * BARE outcome — `visibility`/`note` are added by {@link PipRailClient.register}
 * (or call {@link decorateOutcome}).
 */
export async function registerX402Scan(
  input: { url: string },
  signer: DiscoverySigner
): Promise<RegisterOutcome> {
  try {
    const challengeRes = await fetch(X402SCAN_REGISTER, {
      method: 'POST',
      headers: clientHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ url: input.url }),
    })
    if (challengeRes.status !== 402) {
      // Some deployments accept an unauthenticated register directly.
      return {
        source: 'x402scan',
        ok: challengeRes.ok,
        status: challengeRes.status,
        detail: challengeRes.ok
          ? 'Listed on x402scan.'
          : `x402scan returned HTTP ${challengeRes.status} (expected a SIWX 402 challenge).`,
      }
    }
    const info = await readSiwxInfo(challengeRes)
    if (!info) {
      return { source: 'x402scan', ok: false, status: 402, detail: 'x402scan SIWX challenge was unparseable.' }
    }
    // `Issued At` is REQUIRED by EIP-4361 — default it if the challenge omitted it,
    // and sign + echo the SAME value so a field-reconstructing verifier rebuilds
    // identical bytes. We also carry the literal signed `message` in the header so a
    // message-based verifier can check the exact bytes (belt and suspenders).
    const resolvedInfo: SiwxInfo = { ...info, issuedAt: info.issuedAt ?? new Date().toISOString() }
    const message = formatSiweMessage(resolvedInfo, signer.address)
    const signature = await signer.signMessage(message)
    const header = encodeBase64(
      JSON.stringify({ ...resolvedInfo, address: signer.address, type: 'eip191', message, signature })
    )
    const res = await fetch(X402SCAN_REGISTER, {
      method: 'POST',
      headers: clientHeaders({
        'content-type': 'application/json',
        accept: 'application/json',
        'sign-in-with-x': header,
      }),
      body: JSON.stringify({ url: input.url }),
    })
    if (res.ok) {
      return { source: 'x402scan', ok: true, status: res.status, detail: 'Listed on x402scan (SIWX).' }
    }
    const why = await readIndexError(res)
    return {
      source: 'x402scan',
      ok: false,
      status: res.status,
      detail: why ? `x402scan rejected it (HTTP ${res.status}): ${why}` : `x402scan returned HTTP ${res.status} after signing.`,
    }
  } catch (err) {
    return { source: 'x402scan', ok: false, detail: errMsg(err) }
  }
}

/* ----------------- 402 Index domain verification (pending-review → live) ----------------- */

/** What {@link claim402IndexDomain} returns — the proof to SERVE so 402 Index will
 *  approve your domain (and flip your `pending-review` listings to searchable). */
export interface DomainClaim {
  ok: boolean
  domain: string
  /** The exact text to serve as the ENTIRE body of `verificationUrl` — this is what
   *  402 Index fetches and checks (the SHA-256 of the token). Always populated on
   *  success: read from the response, or computed as `sha256(verificationToken)` if
   *  the API returns only the token. Serve THIS. */
  verificationHash?: string
  /** The raw 64-hex token 402 Index issued (the preimage of `verificationHash`). */
  verificationToken?: string
  /** Where to serve `verificationHash` — your `https://<domain>/.well-known/402index-verify.txt`. */
  verificationUrl?: string
  /** 402 Index's own human instructions. */
  instructions?: string
  httpStatus?: number
  /** Failure reason when `ok:false`. */
  detail?: string
}

/** What {@link verify402IndexDomain} returns once the proof is in place. */
export interface DomainVerification {
  ok: boolean
  domain: string
  /** 402 Index's status string, e.g. `'verified'`. */
  status?: string
  /** How many of your pending listings were approved by the verification. */
  servicesCount?: number
  httpStatus?: number
  detail?: string
}

/**
 * Step 1 of 402 Index domain verification: claim the host of `domainOrUrl`. 402 Index
 * lists a self-registered resource as PENDING REVIEW; verifying the domain approves it
 * (and every other pending listing on that domain) so it becomes searchable. Returns the
 * `verificationHash` to serve as the entire body of `verificationUrl`
 * (`https://<domain>/.well-known/402index-verify.txt`). Then call {@link verify402IndexDomain}.
 * No funds move. Never throws.
 */
export async function claim402IndexDomain(
  domainOrUrl: string,
  opts: { contactEmail?: string } = {}
): Promise<DomainClaim> {
  const domain = hostOf(domainOrUrl)
  try {
    const res = await fetch(INDEX402_CLAIM, {
      method: 'POST',
      headers: clientHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ domain, ...(opts.contactEmail ? { contact_email: opts.contactEmail } : {}) }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return { ok: false, domain, httpStatus: res.status, detail: pickString(body, 'error', 'detail', 'message') ?? `402 Index claim returned HTTP ${res.status}.` }
    }
    // The live public endpoint returns BOTH `verification_token` and `verification_hash`
    // (the file body is the HASH). Surface the token AND always give the merchant the
    // exact bytes to serve — falling back to sha256(token) if a future response omits
    // the hash (verified: hash === sha256(utf8(token))).
    const verificationToken = pickString(body, 'verification_token')
    const verificationHash =
      pickString(body, 'verification_hash') ?? (verificationToken ? await sha256Hex(verificationToken) : undefined)
    return {
      ok: true,
      domain,
      httpStatus: res.status,
      ...optionalString('verificationHash', verificationHash),
      ...optionalString('verificationToken', verificationToken),
      ...optionalString('verificationUrl', pickString(body, 'verification_url')),
      ...optionalString('instructions', pickString(body, 'instructions')),
    }
  } catch (err) {
    return { ok: false, domain, detail: errMsg(err) }
  }
}

/** SHA-256 of a UTF-8 string, lowercase hex — via Web Crypto (Node 18+ + browsers).
 *  Used to derive 402 Index's verification hash from the token if the API returns
 *  only the token. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Step 2 of 402 Index domain verification: after {@link claim402IndexDomain} and serving
 * the `verificationHash` at `verificationUrl`, tell 402 Index to re-fetch + approve. On
 * success, the domain's pending listings become searchable (`status:'verified'`,
 * `servicesCount` approved). No funds move. Never throws.
 */
export async function verify402IndexDomain(domainOrUrl: string): Promise<DomainVerification> {
  const domain = hostOf(domainOrUrl)
  try {
    const res = await fetch(INDEX402_VERIFY, {
      method: 'POST',
      headers: clientHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ domain }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return { ok: false, domain, httpStatus: res.status, detail: pickString(body, 'error', 'detail', 'message') ?? `402 Index verify returned HTTP ${res.status}.` }
    }
    return {
      ok: true,
      domain,
      httpStatus: res.status,
      ...optionalString('status', pickString(body, 'status')),
      ...(typeof body.services_count === 'number' ? { servicesCount: body.services_count } : {}),
    }
  } catch (err) {
    return { ok: false, domain, detail: errMsg(err) }
  }
}

/** SIWX challenge info, as x402scan returns it in the 402 body. */
interface SiwxInfo {
  domain: string
  uri: string
  nonce: string
  issuedAt?: string
  expirationTime?: string
  chainId?: string
  statement?: string
  [k: string]: unknown
}

async function readSiwxInfo(res: Response): Promise<SiwxInfo | null> {
  try {
    const body = (await res.json()) as Record<string, unknown>
    const ext = body.extensions as Record<string, unknown> | undefined
    const siwx = ext?.['sign-in-with-x'] as Record<string, unknown> | undefined
    const info = (siwx?.info ?? siwx) as SiwxInfo | undefined
    // x402scan's challenge carries chainId in `info`, but its canonical parser also
    // reads `supportedChains[].chainId` — fall back to the EVM entry there so we sign
    // the correct `Chain ID` (e.g. Base 8453) even if a deployment omits it from `info`.
    if (info && info.chainId == null && Array.isArray(siwx?.supportedChains)) {
      const evm = (siwx!.supportedChains as Array<{ chainId?: unknown }>).find(
        (c) => typeof c?.chainId === 'string' && (c.chainId as string).startsWith('eip155:')
      )
      if (evm && typeof evm.chainId === 'string') info.chainId = evm.chainId
    }
    // domain + nonce + uri are needed to build a valid EIP-4361 message; a blank
    // uri would otherwise sign `URI: undefined` (unrecoverable).
    if (
      info &&
      typeof info.domain === 'string' && info.domain.length > 0 &&
      typeof info.nonce === 'string' && info.nonce.length > 0 &&
      typeof info.uri === 'string' && info.uri.length > 0
    ) {
      return info
    }
    return null
  } catch {
    return null
  }
}

/** Build the EIP-4361 (SIWE) message x402scan's eip191 SIWX verifies. `Issued At`
 *  is required (the caller defaults it); the statement block is omitted entirely
 *  when the challenge carries none (an empty statement is NOT a blank line). */
function formatSiweMessage(info: SiwxInfo, address: string): string {
  const chainId = info.chainId ? caip2ToChainId(info.chainId) : 1
  const statement = info.statement && info.statement.trim() ? info.statement : undefined
  const lines = [
    `${info.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    ...(statement ? [statement, ''] : ['']),
    `URI: ${info.uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${info.nonce}`,
    `Issued At: ${info.issuedAt}`,
    ...(info.expirationTime ? [`Expiration Time: ${info.expirationTime}`] : []),
  ]
  return lines.join('\n')
}

function caip2ToChainId(caip2: string): number {
  const m = /^eip155:(\d+)$/.exec(caip2)
  const n = m ? Number(m[1]) : Number(caip2)
  return Number.isSafeInteger(n) && n > 0 ? n : 1
}

/* ----------------------------- shared helpers ----------------------------- */

function mapRails(accepts: unknown): DiscoveredRail[] {
  if (!Array.isArray(accepts)) return []
  const out: DiscoveredRail[] = []
  for (const raw of accepts) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    const network = pickString(a, 'network')
    if (!network) continue
    const extra = (a.extra && typeof a.extra === 'object' ? a.extra : {}) as Record<string, unknown>
    out.push({
      scheme: pickString(a, 'scheme') ?? 'exact',
      network,
      ...optionalString('asset', pickString(a, 'asset')),
      ...optionalString('amount', pickString(a, 'amount', 'maxAmountRequired')),
      ...optionalString('payTo', pickString(a, 'payTo')),
      ...optionalString('symbol', pickString(extra, 'symbol')),
    })
  }
  return out
}

/** A loose recall pre-filter for client-side sources (Bazaar): keep a resource if ANY
 *  query token appears in its searchable text. The ranker handles precision afterwards;
 *  this only avoids dragging an index's entire catalog into the merge. A whole-phrase
 *  substring also counts (so "weather forecast" still matches a literal "weather forecast"). */
function matchesQuery(r: DiscoveredResource, query: string): boolean {
  const haystack = [r.name, r.description, r.category, (r.tags ?? []).join(' '), r.resource]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (haystack.includes(query.toLowerCase())) return true
  const qTokens = tokenize(query)
  const hayTokens = new Set(tokenize(haystack))
  return qTokens.some((t) => hayTokens.has(t))
}

/** First string-array value among `keys` (filters to non-empty strings). 402 Index may
 *  report tags as an array; tolerate a comma/space string too. */
function pickStringArray(o: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
      if (arr.length) return arr
    } else if (typeof v === 'string' && v.trim()) {
      const arr = v.split(/[,\s]+/).filter((x) => x.length > 0)
      if (arr.length) return arr
    }
  }
  return undefined
}

/** First string value present among `keys` on `o`. */
function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/** First finite numeric value present among `keys`. Accepts a number, or a
 *  PLAIN decimal string only — never coerces hex/exponent forms (Number('0x10')
 *  is 16, Number('1e3') is 1000), which would fabricate a bogus price from
 *  untrusted index JSON. */
function pickNumber(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
      const n = Number(v.trim())
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

/** A `{ [field]: value }` spread only when `value` is defined (keeps types tidy). */
function optionalString(field: string, value: string | undefined): Record<string, string> {
  return value !== undefined ? { [field]: value } : {}
}

/** First array-valued field among `keys` (402 Index varies its envelope). */
function firstArray(o: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[]
  }
  return Array.isArray(o) ? (o as unknown[]) : []
}

/** Extract the hostname from a URL OR a bare domain (optionally with a port).
 *  `new URL('host:port')` parses the host as a SCHEME and yields an empty hostname,
 *  so prefix a scheme when there isn't one. `'piprail.com'`, `'piprail.com:8080'`,
 *  and `'https://piprail.com/x'` all → `'piprail.com'`. */
function hostOf(url: string): string {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`
    return new URL(withScheme).hostname || url
  } catch {
    return url
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The compact "Made with X" marker {@link appendAttribution} adds to a listing's
 *  description by default (the elegant, universally-accepted Swagger/Hugo pattern).
 *  Middot-separated so it reads as metadata, never as part of the merchant's prose. */
export const REGISTER_ATTRIBUTION = '· Built with @piprail/sdk'

/** Append {@link REGISTER_ATTRIBUTION} to a listing description — *tastefully*. Pure.
 *  Returns the description unchanged when it's absent (we never fabricate one), already
 *  mentions PipRail (never double-stamp), or the result would exceed a sane listing cap
 *  (≤ 500 chars). This is the only attribution an index actually DISPLAYS, so it's how a
 *  registered listing stays visibly "built with PipRail" — opt out with `attribution:false`. */
export function appendAttribution(description: string | undefined): string | undefined {
  if (!description) return description
  if (/piprail/i.test(description)) return description
  const next = `${description.trimEnd()} ${REGISTER_ATTRIBUTION}`
  return next.length <= 500 ? next : description
}

/**
 * Fold keyword tags into a description as a compact, searchable tail — `desc · Keywords:
 * a, b, c` — because 402 Index search is literal (a term must appear in the name or
 * description to match). Pure + tasteful: drops tags already present in the text
 * (case-insensitive, no duplication), no-ops when there are no tags, and returns the
 * description unchanged rather than overflow a sane listing cap (≤ 500 chars). When the
 * description is empty it still seeds one from the tags (so they're not lost). */
export function appendKeywords(description: string | undefined, tags: string[] | undefined): string | undefined {
  const clean = (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)
  if (clean.length === 0) return description
  const have = (description ?? '').toLowerCase()
  const fresh = [...new Set(clean.filter((t) => !have.includes(t.toLowerCase())))]
  if (fresh.length === 0) return description
  const tail = `Keywords: ${fresh.join(', ')}`
  if (!description) return tail
  const next = `${description.trimEnd()} · ${tail}`
  return next.length <= 500 ? next : description
}

function encodeBase64(str: string): string {
  // UTF-8 SAFE — `btoa` is Latin1-only and throws on any non-ASCII byte (a SIWX
  // statement/domain could carry one). Prefer Buffer; bridge btoa via TextEncoder.
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function' && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
  }
  throw new Error('No base64 encoder available in this runtime.')
}
