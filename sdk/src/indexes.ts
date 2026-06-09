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
  /** Advertised price in USD, when the index reports one (402 Index). */
  priceUsd?: number
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

export interface SearchOpenIndexesOptions {
  /** Free-text query (filtered client-side against name/description/resource). */
  query?: string
  /** Which indexes to read. Default `['bazaar', '402index']` (both free). */
  sources?: DiscoverySource[]
  /** Max results per source before dedupe. Default 20. */
  limit?: number
  signal?: AbortSignal
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
   * Opt-in (default off): add a `via: '@piprail/sdk'` tag to the listing payload. It's the
   * MERCHANT's listing on a third-party index, so we never tag it by default; and it's
   * **best-effort** — an index may ignore an unrecognised field. The reliable, always-on
   * attribution is the `User-Agent` on the request + the `x-generator` stamp in your
   * emitted `/openapi.json`. Off by default keeps your listing clean and can't be seen as spam.
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
export const DIRECTORY_INFO: Readonly<Record<DiscoverySource, DirectoryInfo>> = {
  '402index': {
    source: '402index',
    review: 'probe-sync',
    auth: 'none',
    chains: null,
    onSuccess: 'pending-review',
    readByDiscover: true,
    caveat:
      '402 Index probes your URL on submit, then lists it as PENDING REVIEW — a self-registered ' +
      'resource is NOT in search until approved. Verify your domain on 402index.io for instant ' +
      'approval; otherwise it appears after manual review, so retry discover() later.',
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
}

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
  ton: 'ton:-239',
  tron: 'tron:mainnet',
  near: 'near:mainnet',
  sui: 'sui:mainnet',
  aptos: 'aptos:1',
  algorand: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  stellar: 'stellar:pubnet',
  xrpl: 'xrpl:0',
}

/** Normalize an index's network field to CAIP-2 when we recognise the slug;
 *  pass a value that's already CAIP-2 (`namespace:reference`) through unchanged.
 *  An unknown slug returns unchanged (no `:`), which the client treats as
 *  "unresolved — don't hide it" rather than a confident mismatch. */
export function normalizeNetwork(network: string): string {
  if (network.includes(':')) return network
  return SLUG_TO_CAIP2[network.toLowerCase()] ?? network
}

/* ----------------------------- read (search) ----------------------------- */

/**
 * Search the open indexes for payable resources, in parallel, and merge them
 * (deduped by resource URL — the first source in `sources` wins). NEVER throws:
 * any index that errors, times out, or changes shape contributes `[]`.
 */
export async function searchOpenIndexes(
  opts: SearchOpenIndexesOptions = {}
): Promise<DiscoveredResource[]> {
  const sources = opts.sources ?? ['bazaar', '402index']
  const limit = opts.limit ?? 20
  const results = await Promise.all(
    sources.map((source) => {
      if (source === 'bazaar') return safeSearch(() => searchBazaar(opts.query, limit, opts.signal))
      if (source === '402index') return safeSearch(() => search402Index(opts.query, limit, opts.signal))
      return Promise.resolve<DiscoveredResource[]>([]) // x402scan reads are paid — off by default here
    })
  )
  return dedupeByResource(results.flat())
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

async function search402Index(
  query: string | undefined,
  limit: number,
  signal?: AbortSignal
): Promise<DiscoveredResource[]> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (query) qs.set('q', query)
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
  return {
    resource,
    source: '402index',
    rails,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...optionalString('name', pickString(o, 'name', 'title')),
    ...optionalString('description', pickString(o, 'description')),
    ...optionalString('category', pickString(o, 'category', 'tag')),
  }
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
    const payload: Record<string, unknown> = {
      url: input.url,
      name: input.name ?? hostOf(input.url),
      protocol: 'x402',
      ...(input.description ? { description: input.description } : {}),
      ...(typeof input.priceUsd === 'number' ? { price_usd: input.priceUsd } : {}),
      ...(input.asset ? { payment_asset: input.asset } : {}),
      ...(input.network ? { payment_network: input.network } : {}),
      ...(input.method ? { http_method: input.method.toUpperCase() } : {}),
      ...(input.attribution ? { via: '@piprail/sdk' } : {}),
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
            : 'Registered on 402 Index — pending review (verify your domain on 402index.io for instant approval).'),
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

function matchesQuery(r: DiscoveredResource, query: string): boolean {
  const q = query.toLowerCase()
  return (
    r.resource.toLowerCase().includes(q) ||
    (r.name?.toLowerCase().includes(q) ?? false) ||
    (r.description?.toLowerCase().includes(q) ?? false)
  )
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
