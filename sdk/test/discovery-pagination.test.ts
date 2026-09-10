/**
 * Pagination contract for the open-index readers.
 *
 * The bug this pins: `discover()` issued ONE request per source and took whatever the
 * index chose to return, so it read 50 rows of a 106,398-row catalog and reported them
 * as if they were the market. Every assertion here is about the SHAPE OF THE WIRE — how
 * many requests, at what offsets, with what page size — because that is the part that
 * silently regressed and that no result-count assertion can catch.
 *
 * Measured ceilings the SDK pages against (live, 2026-09-10): Bazaar serves at most 1000
 * rows per request, 402 Index at most 200. Both cap silently rather than erroring, which
 * is precisely why this needs a test and not a comment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { searchOpenIndexes } from '../src/indexes.js'

const REAL_FETCH = globalThis.fetch

/** One Bazaar row that survives `mapBazaarItem` (needs a `resource`). */
const bazaarRow = (i: number) => ({
  resource: `https://example.test/bazaar/${i}`,
  accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1000' }],
  metadata: { name: `bazaar ${i}`, description: 'a resource', category: 'data' },
})

/** One 402 Index row that survives `map402IndexItem` (needs url + protocol + a rail). */
const indexRow = (i: number) => ({
  url: `https://example.test/402index/${i}`,
  name: `index ${i}`,
  description: 'a resource',
  protocol: 'x402',
  price_usd: 0.01,
  payment_asset: 'USDC',
  payment_network: 'Base',
  reliability_score: 90,
  health_status: 'healthy',
})

interface Call {
  url: URL
  limit: number
  offset: number
}

/**
 * Install a fake index server. `total` is the catalog size it claims and serves; page
 * size is clamped to `ceiling` exactly as the real indexes do (silently, not by erroring).
 */
function mockIndexes(opts: {
  bazaarTotal?: number
  bazaarCeiling?: number
  indexTotal?: number
  indexCeiling?: number
  failOffsets?: number[]
}) {
  const calls: Call[] = []
  const {
    bazaarTotal = 0,
    bazaarCeiling = 1000,
    indexTotal = 0,
    indexCeiling = 200,
    failOffsets = [],
  } = opts

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const wanted = Number(url.searchParams.get('limit') ?? '0')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    calls.push({ url, limit: wanted, offset })

    if (failOffsets.includes(offset)) return new Response('boom', { status: 500 })

    const isBazaar = url.hostname.includes('cdp.coinbase.com')
    const ceiling = isBazaar ? bazaarCeiling : indexCeiling
    const total = isBazaar ? bazaarTotal : indexTotal
    const size = Math.min(wanted, ceiling) // the silent cap, as observed live
    const n = Math.max(0, Math.min(size, total - offset))
    const rows = Array.from({ length: n }, (_, k) =>
      isBazaar ? bazaarRow(offset + k) : indexRow(offset + k)
    )

    return new Response(
      JSON.stringify(
        isBazaar
          ? { items: rows, pagination: { limit: size, offset, total } }
          : { services: rows, total, limit: size, offset }
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch

  return calls
}

const bazaarCalls = (c: Call[]) => c.filter((x) => x.url.hostname.includes('cdp.coinbase.com'))
const indexCalls = (c: Call[]) => c.filter((x) => x.url.hostname.includes('402index.io'))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  globalThis.fetch = REAL_FETCH
})

describe('pagination — the shallow default is unchanged', () => {
  it('a default search still costs exactly ONE request per source', async () => {
    const calls = mockIndexes({ bazaarTotal: 5000, indexTotal: 5000 })
    await searchOpenIndexes({ sources: ['bazaar', '402index'] })
    expect(bazaarCalls(calls)).toHaveLength(1)
    expect(indexCalls(calls)).toHaveLength(1)
  })

  it('a limit at or below the ceiling sends that exact limit and NO offset param', async () => {
    const calls = mockIndexes({ bazaarTotal: 5000 })
    await searchOpenIndexes({ sources: ['bazaar'], limit: 7 })
    expect(bazaarCalls(calls)).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get('limit')).toBe('7')
    // Byte-identical to the pre-pagination SDK: no offset key at all on the first page.
    expect(calls[0]!.url.searchParams.has('offset')).toBe(false)
  })

  it('returns no more than the requested limit', async () => {
    mockIndexes({ bazaarTotal: 5000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 12 })
    expect(out).toHaveLength(12)
  })
})

describe('pagination — deep reads actually page', () => {
  it('a limit ABOVE the ceiling walks offsets at the ceiling page size', async () => {
    const calls = mockIndexes({ bazaarTotal: 5000, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 3000 })

    expect(out).toHaveLength(3000)
    const b = bazaarCalls(calls)
    expect(b).toHaveLength(3)
    expect(b.map((c) => c.offset)).toEqual([0, 1000, 2000])
    expect(b.every((c) => c.limit === 1000)).toBe(true)
  })

  it('reads past the old 50-row horizon — the actual regression', async () => {
    // The shape of the real failure: an index holding thousands, read 50 deep.
    mockIndexes({ bazaarTotal: 14_629, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 5000 })
    expect(out.length).toBe(5000)
    expect(out.length).toBeGreaterThan(50)
  })

  it('402 Index pages at ITS smaller ceiling (200), not Bazaar’s', async () => {
    const calls = mockIndexes({ indexTotal: 1000, indexCeiling: 200 })
    await searchOpenIndexes({ sources: ['402index'], limit: 600 })
    const i = indexCalls(calls)
    expect(i.every((c) => c.limit === 200)).toBe(true)
    expect(i.map((c) => c.offset)).toEqual([0, 200, 400])
  })

  it('dedupes across page boundaries rather than double-counting', async () => {
    mockIndexes({ bazaarTotal: 2500, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 2500 })
    expect(new Set(out.map((r) => r.resource)).size).toBe(out.length)
  })
})

describe('pagination — protocol-mixed pages (the second bug)', () => {
  /**
   * 402 Index is protocol-mixed: a 200-row page can hold L402 and MPP rows the SDK drops.
   * The first pagination implementation measured the FILTERED array to decide whether the
   * catalog had ended, so a full page yielding 193 x402 rows read as "short page, we're
   * done" and capped a 106,398-row index at 193 results. Termination must read the RAW
   * row count the index served, never what survived filtering.
   */
  it('a FULL page that filters down does NOT end the walk', async () => {
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const size = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      calls.push({ url, limit: size, offset })
      // A FULL page of `size` rows, but only ~10% are x402 — the rest are L402 noise.
      const rows = Array.from({ length: size }, (_, k) =>
        k % 10 === 0
          ? indexRow(offset + k)
          : { url: `https://example.test/l402/${offset + k}`, protocol: 'l402', name: 'ln' }
      )
      return new Response(JSON.stringify({ services: rows, total: 100_000, limit: size, offset }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const out = await searchOpenIndexes({ sources: ['402index'], limit: 400, maxRequests: 12 })
    expect(indexCalls(calls).length).toBeGreaterThan(1)
    // Would have been 20 (one page's survivors) under the filtered-length bug.
    expect(out.length).toBeGreaterThan(100)
  })

  it('a genuinely SHORT raw page still ends the walk', async () => {
    const calls = mockIndexes({ indexTotal: 150, indexCeiling: 200 })
    const out = await searchOpenIndexes({ sources: ['402index'], limit: 5000 })
    expect(indexCalls(calls)).toHaveLength(1)
    expect(out).toHaveLength(150)
  })
})

describe('pagination — the stopping rules', () => {
  it('stops at the catalog end instead of walking empty offsets forever', async () => {
    const calls = mockIndexes({ bazaarTotal: 1500, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 10_000 })
    expect(out).toHaveLength(1500)
    // total=1500 at 1000/page ⇒ 2 requests. Never the 10 a naive limit/size would issue.
    expect(bazaarCalls(calls)).toHaveLength(2)
  })

  it('a SHORT first page ends the walk immediately', async () => {
    const calls = mockIndexes({ bazaarTotal: 40, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 5000 })
    expect(out).toHaveLength(40)
    expect(bazaarCalls(calls)).toHaveLength(1)
  })

  it('respects the maxRequests budget even when far more is available', async () => {
    const calls = mockIndexes({ bazaarTotal: 100_000, bazaarCeiling: 1000 })
    await searchOpenIndexes({ sources: ['bazaar'], limit: 50_000, maxRequests: 4 })
    expect(bazaarCalls(calls)).toHaveLength(4)
  })

  it('maxRequests is a floor of 1, never 0 — a search always tries once', async () => {
    const calls = mockIndexes({ bazaarTotal: 5000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 5000, maxRequests: 0 })
    expect(bazaarCalls(calls)).toHaveLength(1)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('exhaustive mode', () => {
  it('reads the whole catalog without being told a limit', async () => {
    mockIndexes({ bazaarTotal: 3200, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], exhaustive: true })
    expect(out).toHaveLength(3200)
  })

  it('is still bounded by maxRequests — it is deep, not unbounded', async () => {
    const calls = mockIndexes({ bazaarTotal: 100_000, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], exhaustive: true, maxRequests: 3 })
    expect(bazaarCalls(calls)).toHaveLength(3)
    expect(out).toHaveLength(3000)
  })

  it('overrides an explicit limit rather than being capped by it', async () => {
    mockIndexes({ bazaarTotal: 2500, bazaarCeiling: 1000 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], exhaustive: true, limit: 5 })
    expect(out).toHaveLength(2500)
  })
})

describe('pagination — never throws, degrades to partial', () => {
  it('a failing LATER page yields the pages that landed, not an exception', async () => {
    mockIndexes({ bazaarTotal: 5000, bazaarCeiling: 1000, failOffsets: [2000] })
    const out = await searchOpenIndexes({ sources: ['bazaar'], limit: 4000 })
    // Pages 0,1,3 landed; page 2 died. Partial beats a throw for a read-only method.
    expect(out).toHaveLength(3000)
  })

  it('a failing FIRST page yields [] for that source without killing the other', async () => {
    mockIndexes({ bazaarTotal: 5000, indexTotal: 500, failOffsets: [0] })
    const out = await searchOpenIndexes({ sources: ['bazaar', '402index'], limit: 100 })
    expect(out).toEqual([])
  })

  it('a source that throws outright contributes [] and the other still returns', async () => {
    const calls = mockIndexes({ indexTotal: 300 })
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('cdp.coinbase.com')) throw new Error('network down')
      return inner(input as never, init as never)
    }) as typeof fetch

    const out = await searchOpenIndexes({ sources: ['bazaar', '402index'], limit: 250 })
    expect(out.length).toBe(250)
    expect(indexCalls(calls).length).toBeGreaterThan(1) // it still paged
  })
})

describe('pagination — the 402 Index multi-word fan-out', () => {
  it('shares the request budget across query variants instead of multiplying it', async () => {
    const calls = mockIndexes({ indexTotal: 100_000, indexCeiling: 200 })
    await searchOpenIndexes({
      sources: ['402index'],
      query: 'crypto price feed',
      limit: 50_000,
      maxRequests: 6,
    })
    // 4 variants (phrase + 3 tokens) sharing 6 requests ⇒ 1 each, not 6 each.
    const variants = new Set(indexCalls(calls).map((c) => c.url.searchParams.get('q')))
    expect(variants.size).toBe(4)
    expect(indexCalls(calls).length).toBeLessThanOrEqual(8)
  })

  it('still carries the query on every paged request', async () => {
    const calls = mockIndexes({ indexTotal: 1000, indexCeiling: 200 })
    await searchOpenIndexes({ sources: ['402index'], query: 'weather', limit: 600 })
    expect(indexCalls(calls).every((c) => c.url.searchParams.get('q') === 'weather')).toBe(true)
  })

  it('keeps server-side filters on every page, not just the first', async () => {
    const calls = mockIndexes({ indexTotal: 1000, indexCeiling: 200 })
    await searchOpenIndexes({
      sources: ['402index'],
      limit: 600,
      category: 'ai',
      verified: true,
      maxPrice: 0.05,
    })
    const i = indexCalls(calls)
    expect(i.length).toBeGreaterThan(1)
    expect(i.every((c) => c.url.searchParams.get('category') === 'ai')).toBe(true)
    expect(i.every((c) => c.url.searchParams.get('verified') === 'true')).toBe(true)
    expect(i.every((c) => c.url.searchParams.get('max_price_usd') === '0.05')).toBe(true)
  })
})

describe('pagination — politeness toward a free, unauthenticated index', () => {
  /**
   * A deep read of 402 Index is 500+ pages at its 200-row ceiling. Issuing those as one
   * `Promise.all` is how a well-meaning agent becomes a denial-of-service against a
   * directory that is doing us a favour by existing, and how PipRail's User-Agent gets
   * blocked for every user at once. Pages go out in bounded waves.
   */
  it('never exceeds the concurrency bound, however deep the read', async () => {
    let inFlight = 0
    let peak = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      const url = new URL(String(input))
      const size = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      inFlight -= 1
      const rows = Array.from({ length: size }, (_, k) => bazaarRow(offset + k))
      return new Response(
        JSON.stringify({ items: rows, pagination: { limit: size, offset, total: 100_000 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch

    await searchOpenIndexes({ sources: ['bazaar'], limit: 40_000, maxRequests: 40 })
    expect(peak).toBeGreaterThan(1) // it does parallelise
    expect(peak).toBeLessThanOrEqual(6) // but never unboundedly
  })

  it('stops issuing waves as soon as the limit is satisfied', async () => {
    const calls = mockIndexes({ bazaarTotal: 100_000, bazaarCeiling: 1000 })
    await searchOpenIndexes({ sources: ['bazaar'], limit: 2500, maxRequests: 40 })
    // 3 pages of 1000 satisfy 2500. Later waves would be wasted work on someone else's server.
    expect(bazaarCalls(calls).length).toBeLessThanOrEqual(6)
  })
})

describe('the Circle catalog as a source', () => {
  /** Circle's item shape: human fields nested under `metadata.provider`, unlike Bazaar. */
  const circleRow = (i: number) => ({
    resource: `https://example.test/circle/${i}`,
    type: 'http',
    accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '10000' }],
    metadata: { provider: { name: `circle ${i}`, description: 'a circle resource' } },
  })

  /**
   * Circle REJECTS an over-limit page with HTTP 400 instead of capping it silently, and
   * reads never throw — so asking for too many rows makes the source contribute NOTHING,
   * with no error anywhere. This is the one ceiling whose exact value is load-bearing.
   */
  function mockCircle(total: number, ceiling = 200) {
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const size = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      calls.push({ url, limit: size, offset })
      if (size > ceiling) return new Response('limit too large', { status: 400 })
      const n = Math.max(0, Math.min(size, total - offset))
      const rows = Array.from({ length: n }, (_, k) => circleRow(offset + k))
      return new Response(
        JSON.stringify({ x402Version: 2, items: rows, pagination: { limit: size, offset, total } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    return calls
  }

  it('is read by default, alongside Bazaar and 402 Index', async () => {
    const calls = mockIndexes({ bazaarTotal: 100, indexTotal: 100 })
    const hosts = new Set<string>()
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hosts.add(new URL(String(input)).hostname)
      return inner(input as never, init as never)
    }) as typeof fetch
    await searchOpenIndexes({})
    expect(hosts).toContain('api.circle.com')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('NEVER requests a page above Circle’s 200 ceiling — a 400 would zero it silently', async () => {
    const calls = mockCircle(1246)
    const out = await searchOpenIndexes({ sources: ['circle'], limit: 5000, maxRequests: 20 })
    expect(calls.every((c) => c.limit <= 200)).toBe(true)
    expect(out).toHaveLength(1246) // proof no page 400'd
  })

  it('pages the whole Circle catalog', async () => {
    const calls = mockCircle(1246)
    const out = await searchOpenIndexes({ sources: ['circle'], exhaustive: true, maxRequests: 20 })
    expect(out).toHaveLength(1246)
    expect(calls.map((c) => c.offset).slice(0, 3)).toEqual([0, 200, 400])
  })

  it('reads the human fields from metadata.provider, where Circle nests them', async () => {
    mockCircle(3)
    const out = await searchOpenIndexes({ sources: ['circle'], limit: 3 })
    expect(out[0]).toMatchObject({
      source: 'circle',
      name: 'circle 0',
      description: 'a circle resource',
    })
    expect(out[0]!.rails.length).toBeGreaterThan(0)
  })

  it('a 400 on every page degrades to [] rather than throwing', async () => {
    mockCircle(1246, 0) // ceiling 0 ⇒ every request 400s
    const out = await searchOpenIndexes({ sources: ['circle'], limit: 500 })
    expect(out).toEqual([])
  })

  it('a resource listed in BOTH catalogs is returned once', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const shared = {
        resource: 'https://dup.example.test/x',
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1' }],
        metadata: { name: 'dup' },
      }
      const body = url.hostname.includes('circle')
        ? { items: [shared], pagination: { total: 1 } }
        : { items: [shared], pagination: { total: 1 } }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const out = await searchOpenIndexes({ sources: ['bazaar', 'circle'], limit: 50 })
    expect(out).toHaveLength(1)
    expect(out[0]!.source).toBe('bazaar') // first source named wins
  })
})

describe('Bazaar semantic search — precision on top of recall', () => {
  const isSearch = (c: Call) => c.url.pathname.endsWith('/discovery/search')
  const isList = (c: Call) => c.url.pathname.endsWith('/discovery/resources')

  /** Bazaar's list + search, distinguishable, with the search endpoint's real quirks. */
  function mockBazaarBoth(opts: { searchHits?: number; searchStatus?: number; listTotal?: number } = {}) {
    const calls: Call[] = []
    const { searchHits = 3, searchStatus = 200, listTotal = 500 } = opts
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const size = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      calls.push({ url, limit: size, offset })

      if (url.pathname.endsWith('/discovery/search')) {
        if (searchStatus !== 200) return new Response('nope', { status: searchStatus })
        // The real endpoint 400s above ~20.
        if (size > 20) return new Response('limit too large', { status: 400 })
        const rows = Array.from({ length: searchHits }, (_, k) => ({
          resource: `https://example.test/semantic/${k}`,
          serviceName: `semantic ${k}`,
          description: 'meaning-matched',
          accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1' }],
        }))
        return new Response(JSON.stringify({ resources: rows, searchMethod: 'hybrid' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const n = Math.max(0, Math.min(size, listTotal - offset))
      const rows = Array.from({ length: n }, (_, k) => bazaarRow(offset + k))
      return new Response(
        JSON.stringify({ items: rows, pagination: { limit: size, offset, total: listTotal } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    return calls
  }

  /**
   * `?q=` is ACCEPTED and silently ignored by this endpoint: it returns the same rows for
   * every value, including nonsense. Only `?query=` filters. An integration built on `q=`
   * looks like it works, ranks plausibly, and is answering a question nobody asked.
   */
  it('sends `query=`, never `q=` — the parameter that is silently ignored', async () => {
    const calls = mockBazaarBoth()
    await searchOpenIndexes({ sources: ['bazaar'], query: 'weather', limit: 10 })
    const search = calls.find(isSearch)
    expect(search).toBeDefined()
    expect(search!.url.searchParams.get('query')).toBe('weather')
    expect(search!.url.searchParams.has('q')).toBe(false)
  })

  it('never asks the search endpoint for more than it will serve', async () => {
    const calls = mockBazaarBoth()
    // Query matches the LIST rows too, so this measures depth rather than the ranker.
    const out = await searchOpenIndexes({ sources: ['bazaar'], query: 'bazaar', limit: 5000 })
    expect(calls.filter(isSearch).every((c) => c.limit <= 20)).toBe(true)
    expect(out.length).toBeGreaterThan(20) // proof it did not become search-only
  })

  it('UNIONS semantic hits with the paged list rather than replacing it', async () => {
    mockBazaarBoth({ searchHits: 3, listTotal: 500 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], query: 'bazaar', limit: 200 })
    const semantic = out.filter((r) => r.resource.includes('/semantic/'))
    const listed = out.filter((r) => r.resource.includes('/bazaar/'))
    expect(semantic).toHaveLength(3)
    expect(listed.length).toBeGreaterThan(0)
  })

  it('does not touch the search endpoint when there is no query', async () => {
    const calls = mockBazaarBoth()
    await searchOpenIndexes({ sources: ['bazaar'], limit: 50 })
    expect(calls.some(isSearch)).toBe(false)
    expect(calls.some(isList)).toBe(true)
  })

  it('a failing semantic pass still returns the list — precision is optional, recall is not', async () => {
    mockBazaarBoth({ searchStatus: 500, listTotal: 300 })
    const out = await searchOpenIndexes({ sources: ['bazaar'], query: 'bazaar', limit: 100 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((r) => !r.resource.includes('/semantic/'))).toBe(true)
  })

  it('keeps the RICHER semantic record when a resource is in both', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const shared = 'https://example.test/both/1'
      if (url.pathname.endsWith('/discovery/search')) {
        return new Response(
          JSON.stringify({
            resources: [
              {
                resource: shared,
                serviceName: 'rich name',
                description: 'rich description',
                accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          items: [{ resource: shared, accepts: [{ scheme: 'exact', network: 'eip155:8453' }] }],
          pagination: { total: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    const out = await searchOpenIndexes({ sources: ['bazaar'], query: 'rich', limit: 20 })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('rich name')
  })
})

describe('Circle filters and searches at the index, not locally', () => {
  function mockCircleParams(total = 40) {
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const size = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      calls.push({ url, limit: size, offset })
      const n = Math.max(0, Math.min(size, total - offset))
      const rows = Array.from({ length: n }, (_, k) => ({
        // Deliberately NOT matching the query text: proves we trust the index's filtering
        // instead of re-filtering rows it already selected.
        resource: `https://example.test/circle/${offset + k}`,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1' }],
        metadata: { provider: { name: `unrelated ${offset + k}` } },
      }))
      return new Response(
        JSON.stringify({ items: rows, pagination: { limit: size, offset, total } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    return calls
  }

  it('pushes the query to Circle as `query=`', async () => {
    const calls = mockCircleParams()
    await searchOpenIndexes({ sources: ['circle'], query: 'weather', limit: 10 })
    expect(calls[0]!.url.searchParams.get('query')).toBe('weather')
  })

  it('does NOT re-filter what Circle already selected', async () => {
    mockCircleParams(40)
    // The rows say "unrelated"; a client-side token filter would drop every one of them.
    const out = await searchOpenIndexes({ sources: ['circle'], query: 'weather', limit: 40 })
    expect(out.length).toBeGreaterThan(0)
  })

  it('pushes category, asset and maxPrice using CIRCLE’s parameter names', async () => {
    const calls = mockCircleParams()
    await searchOpenIndexes({
      sources: ['circle'],
      limit: 10,
      category: 'FINANCIAL_ANALYSIS',
      asset: 'USDC',
      maxPrice: 0.01,
    })
    const p = calls[0]!.url.searchParams
    expect(p.get('category')).toBe('FINANCIAL_ANALYSIS')
    expect(p.get('asset')).toBe('USDC')
    // Circle spells it maxUsdPrice, not max_price_usd (402 Index) and not maxPrice.
    expect(p.get('maxUsdPrice')).toBe('0.01')
  })

  it('carries the query on every paged request, not just the first', async () => {
    const calls = mockCircleParams(1000)
    await searchOpenIndexes({ sources: ['circle'], query: 'image', limit: 600 })
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((c) => c.url.searchParams.get('query') === 'image')).toBe(true)
  })
})
