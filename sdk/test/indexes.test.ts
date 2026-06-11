/**
 * Open-index adapters (indexes.ts) — the low-level transport, tested in
 * isolation across EVERY variation: the CDP Bazaar + 402 Index read shapes,
 * envelope tolerance, the x402 protocol filter, dedupe, price parsing, the
 * never-throws contract, and the register payloads. No client, no chain.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  searchOpenIndexes,
  register402Index,
  registerX402Scan,
  normalizeNetwork,
  type DiscoverySigner,
} from '../src/index.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Route a stubbed fetch by host. Each handler returns a Response (or throws). */
function route(handlers: { bazaar?: (u: string) => Response; index402?: (u: string) => Response }) {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('api.cdp.coinbase.com')) {
      if (handlers.bazaar) return handlers.bazaar(u)
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }
    if (u.includes('402index.io')) {
      if (handlers.index402) return handlers.index402(u)
      return new Response(JSON.stringify({ services: [] }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${u}`)
  }) as typeof fetch
}

describe('searchOpenIndexes — CDP Bazaar read', () => {
  it('maps items to DiscoveredResource with normalized rails', async () => {
    route({
      bazaar: () =>
        new Response(
          JSON.stringify({
            items: [
              {
                resource: 'https://a.example.com/x',
                metadata: { name: 'A', description: 'desc A', category: 'data' },
                accepts: [
                  { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000', payTo: '0xm', extra: { symbol: 'USDC' } },
                ],
              },
            ],
          }),
          { status: 200 }
        ),
    })
    const [r] = await searchOpenIndexes({ sources: ['bazaar'] })
    expect(r).toMatchObject({
      resource: 'https://a.example.com/x',
      source: 'bazaar',
      name: 'A',
      description: 'desc A',
      category: 'data',
    })
    expect(r!.rails[0]).toMatchObject({ scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000', payTo: '0xm', symbol: 'USDC' })
  })

  it('reads `maxAmountRequired` as the amount and defaults a missing scheme to exact', async () => {
    route({
      bazaar: () =>
        new Response(
          JSON.stringify({ items: [{ resource: 'https://b/x', accepts: [{ network: 'eip155:1', maxAmountRequired: '5' }] }] }),
          { status: 200 }
        ),
    })
    const [r] = await searchOpenIndexes({ sources: ['bazaar'] })
    expect(r!.rails[0]).toMatchObject({ scheme: 'exact', network: 'eip155:1', amount: '5' })
  })

  it('tolerates missing items / malformed entries / a rail with no network', async () => {
    route({
      bazaar: () =>
        new Response(
          JSON.stringify({
            items: [
              null,
              'garbage',
              { description: 'no resource url' }, // dropped — no resource
              { resource: 'https://ok/x', accepts: [{ asset: '0x' /* no network */ }, { network: 'eip155:1' }] },
            ],
          }),
          { status: 200 }
        ),
    })
    const found = await searchOpenIndexes({ sources: ['bazaar'] })
    expect(found.map((r) => r.resource)).toEqual(['https://ok/x'])
    expect(found[0]!.rails).toHaveLength(1) // the network-less rail is skipped
  })

  it('filters the Bazaar by query client-side', async () => {
    route({
      bazaar: () =>
        new Response(
          JSON.stringify({
            items: [
              { resource: 'https://weather/x', metadata: { name: 'Weather' } },
              { resource: 'https://news/x', metadata: { name: 'News' } },
            ],
          }),
          { status: 200 }
        ),
    })
    const found = await searchOpenIndexes({ sources: ['bazaar'], query: 'weather' })
    expect(found.map((r) => r.resource)).toEqual(['https://weather/x'])
  })
})

describe('searchOpenIndexes — 402 Index read', () => {
  const body = () => ({
    services: [
      { url: 'https://x402a/x', name: 'A', protocol: 'x402', price_usd: 0.02, payment_network: 'base', payment_asset: 'USDC' },
      { url: 'https://l402/x', name: 'LN', protocol: 'l402', price_sats: 100 }, // dropped (not x402)
      { url: 'https://noproto/x', name: 'NP', payment_network: 'base' }, // protocol omitted → defaults x402
      { url: 'https://norails/x', name: 'NR', protocol: 'x402' }, // no rail → dropped
    ],
  })

  it('keeps only x402 (+ default-protocol) entries that carry a rail; flattens payment_* fields', async () => {
    route({ index402: () => new Response(JSON.stringify(body()), { status: 200 }) })
    const found = await searchOpenIndexes({ sources: ['402index'] })
    expect(found.map((r) => r.resource).sort()).toEqual(['https://noproto/x', 'https://x402a/x'])
    const a = found.find((r) => r.resource === 'https://x402a/x')!
    expect(a.priceUsd).toBe(0.02)
    expect(a.rails[0]).toMatchObject({ scheme: 'exact', network: 'base', asset: 'USDC' })
  })

  it.each([
    ['services', { services: [{ url: 'https://e/x', protocol: 'x402', payment_network: 'base' }] }],
    ['results', { results: [{ url: 'https://e/x', protocol: 'x402', payment_network: 'base' }] }],
    ['items', { items: [{ url: 'https://e/x', protocol: 'x402', payment_network: 'base' }] }],
    ['data', { data: [{ url: 'https://e/x', protocol: 'x402', payment_network: 'base' }] }],
    ['bare array', [{ url: 'https://e/x', protocol: 'x402', payment_network: 'base' }]],
  ])('tolerates the 402 Index envelope shape: %s', async (_label, payload) => {
    route({ index402: () => new Response(JSON.stringify(payload), { status: 200 }) })
    const found = await searchOpenIndexes({ sources: ['402index'] })
    expect(found.map((r) => r.resource)).toEqual(['https://e/x'])
  })

  it('parses a decimal-string price but NOT hex/exponent (no fabricated priceUsd)', async () => {
    route({
      index402: () =>
        new Response(
          JSON.stringify({
            services: [
              { url: 'https://p1/x', protocol: 'x402', payment_network: 'base', price: '0.50' }, // decimal string → 0.5
              { url: 'https://p2/x', protocol: 'x402', payment_network: 'base', price: '0x10' }, // hex → ignored
              { url: 'https://p3/x', protocol: 'x402', payment_network: 'base', price: '1e3' }, // exponent → ignored
            ],
          }),
          { status: 200 }
        ),
    })
    const found = await searchOpenIndexes({ sources: ['402index'] })
    expect(found.find((r) => r.resource === 'https://p1/x')!.priceUsd).toBe(0.5)
    expect(found.find((r) => r.resource === 'https://p2/x')!.priceUsd).toBeUndefined()
    expect(found.find((r) => r.resource === 'https://p3/x')!.priceUsd).toBeUndefined()
  })

  it('passes the query through as ?q=', async () => {
    let seen = ''
    route({ index402: (u) => { seen = u; return new Response(JSON.stringify({ services: [] }), { status: 200 }) } })
    await searchOpenIndexes({ sources: ['402index'], query: 'weather feed' })
    expect(seen).toContain('q=weather')
  })

  it('passes the limit through', async () => {
    let seen = ''
    route({ index402: (u) => { seen = u; return new Response(JSON.stringify({ services: [] }), { status: 200 }) } })
    await searchOpenIndexes({ sources: ['402index'], limit: 7 })
    expect(seen).toContain('limit=7')
  })

  it('tolerates a body with no recognized array field (yields [], never crashes)', async () => {
    route({ index402: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) })
    await expect(searchOpenIndexes({ sources: ['402index'] })).resolves.toEqual([])
  })
})

describe('searchOpenIndexes — merge + never-throws', () => {
  it('dedupes across sources by resource URL (first source wins)', async () => {
    route({
      bazaar: () => new Response(JSON.stringify({ items: [{ resource: 'https://dup/x', metadata: { name: 'from-bazaar' } }] }), { status: 200 }),
      index402: () => new Response(JSON.stringify({ services: [{ url: 'https://dup/x', name: 'from-402', protocol: 'x402', payment_network: 'base' }] }), { status: 200 }),
    })
    const found = await searchOpenIndexes({ sources: ['bazaar', '402index'] })
    expect(found.filter((r) => r.resource === 'https://dup/x')).toHaveLength(1)
    expect(found[0]!.source).toBe('bazaar')
  })

  it('x402scan is never read by default (its reads are paid)', async () => {
    route({})
    const found = await searchOpenIndexes({ sources: ['bazaar', '402index', 'x402scan'] })
    expect(found.every((r) => r.source !== 'x402scan')).toBe(true)
  })

  it.each([
    ['HTTP 500', () => new Response('nope', { status: 500 })],
    ['non-JSON body', () => new Response('<html>not json</html>', { status: 200 })],
  ])('a %s index contributes [] without throwing', async (_l, bazaar) => {
    route({ bazaar, index402: () => new Response(JSON.stringify({ services: [{ url: 'https://ok/x', protocol: 'x402', payment_network: 'base' }] }), { status: 200 }) })
    const found = await searchOpenIndexes({ sources: ['bazaar', '402index'] })
    expect(found.map((r) => r.resource)).toEqual(['https://ok/x'])
  })

  it('a thrown fetch never propagates', async () => {
    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    await expect(searchOpenIndexes({ sources: ['bazaar', '402index'] })).resolves.toEqual([])
  })
})

describe('register402Index — standalone', () => {
  it('builds the no-auth payload, defaulting name to the host', async () => {
    let body: Record<string, unknown> = {}
    let method = ''
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      method = String(init?.method)
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const out = await register402Index({ url: 'https://api.example.com/r', priceUsd: 0.1, asset: 'USDC', network: 'base', method: 'post', description: 'D' })
    expect(method).toBe('POST')
    expect(out).toMatchObject({ source: '402index', ok: true, status: 200 })
    expect(body).toEqual({
      url: 'https://api.example.com/r',
      name: 'api.example.com',
      protocol: 'x402',
      description: 'D · Built with @piprail/sdk', // attribution on by default (opt out with attribution:false)
      price_usd: 0.1,
      payment_asset: 'USDC',
      payment_network: 'base',
      http_method: 'POST',
      via: '@piprail/sdk',
    })
  })

  it('forwards a 0 price (free resource) as price_usd: 0, and omits it when absent', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://free.example.com/r', priceUsd: 0 })
    expect(body.price_usd).toBe(0) // a truthiness check would have dropped it
    await register402Index({ url: 'https://nofield.example.com/r' })
    expect('price_usd' in body).toBe(false) // omitted entirely when not provided
  })

  it('reports an HTTP error as ok:false (never throws)', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch
    const out = await register402Index({ url: 'https://x/y' })
    expect(out).toMatchObject({ source: '402index', ok: false, status: 429 })
  })

  it("surfaces the index's own rejection reason (real 422 body from a non-x402 URL)", async () => {
    // the exact shape 402 Index returns when it probes a URL that isn't a 402 (verified live)
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'x402 verification failed', detail: 'Your endpoint returned HTTP 200 instead of 402.' }),
        { status: 422 }
      )) as typeof fetch
    const out = await register402Index({ url: 'https://not-a-402.example.com' })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(422)
    expect(out.detail).toMatch(/x402 verification failed/)
    expect(out.detail).toMatch(/instead of 402/)
  })

  it('reports a thrown fetch as ok:false with the error message', async () => {
    globalThis.fetch = (async () => { throw new Error('boom') }) as typeof fetch
    const out = await register402Index({ url: 'https://x/y' })
    expect(out).toMatchObject({ source: '402index', ok: false })
    expect(out.detail).toMatch(/boom/)
  })
})

describe('registerX402Scan — standalone', () => {
  const signer: DiscoverySigner = {
    address: '0x1111111111111111111111111111111111111111',
    signMessage: async () => `0x${'a'.repeat(130)}`,
  }

  it('signs the SIWX challenge and returns ok on 200', async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info: { domain: 'd', uri: 'https://d', nonce: 'n' } } } }), { status: 402 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const out = await registerX402Scan({ url: 'https://x/y' }, signer)
    expect(out).toMatchObject({ source: 'x402scan', ok: true, status: 200 })
  })

  it('accepts a challenge whose fields sit directly under sign-in-with-x (no .info wrapper)', async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { domain: 'd', uri: 'https://d', nonce: 'n' } } }), { status: 402 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const out = await registerX402Scan({ url: 'https://x/y' }, signer)
    expect(out).toMatchObject({ source: 'x402scan', ok: true, status: 200 }) // exercises the `?? siwx` fallback
  })

  it('reports a signer that throws as ok:false (never throws)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info: { domain: 'd', uri: 'https://d', nonce: 'n' } } } }), { status: 402 })) as typeof fetch
    const throwingSigner: DiscoverySigner = { address: '0x1', signMessage: async () => { throw new Error('user rejected') } }
    const out = await registerX402Scan({ url: 'https://x/y' }, throwingSigner)
    expect(out).toMatchObject({ source: 'x402scan', ok: false })
    expect(out.detail).toMatch(/user rejected/)
  })

  it('refuses a challenge with a blank uri (would sign URI: undefined)', async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info: { domain: 'd', nonce: 'n' /* no uri */ } } } }), { status: 402 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const out = await registerX402Scan({ url: 'https://x/y' }, signer)
    expect(out).toMatchObject({ source: 'x402scan', ok: false, status: 402 })
    expect(out.detail).toMatch(/unparseable/i)
  })
})

describe('attribution — User-Agent (always) + PipRail tag (default ON, opt-out)', () => {
  const UA = '@piprail/sdk (+https://piprail.com)'

  it('sends the PipRail User-Agent on a READ request', async () => {
    let ua: string | undefined
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      ua = new Headers(init?.headers ?? {}).get('user-agent') ?? undefined
      return new Response(JSON.stringify({ services: [] }), { status: 200 })
    }) as typeof fetch
    await searchOpenIndexes({ sources: ['402index'] })
    expect(ua).toBe(UA)
  })

  it('sends the PipRail User-Agent on a REGISTER request', async () => {
    let ua: string | undefined
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      ua = new Headers(init?.headers ?? {}).get('user-agent') ?? undefined
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y' })
    expect(ua).toBe(UA)
  })

  it('adds the `via` provenance field by default', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y' })
    expect(body.via).toBe('@piprail/sdk')
  })

  it('appends "· Built with @piprail/sdk" to the description by default', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y', description: 'Weather by lat/lon.' })
    expect(body.description).toBe('Weather by lat/lon. · Built with @piprail/sdk')
  })

  it('opts out completely with attribution:false (no via, untouched description)', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y', description: 'Weather by lat/lon.', attribution: false })
    expect('via' in body).toBe(false)
    expect(body.description).toBe('Weather by lat/lon.')
  })

  it('never double-stamps a description that already mentions PipRail', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y', description: 'Built with @piprail/sdk already.' })
    expect(body.description).toBe('Built with @piprail/sdk already.') // unchanged
  })

  it('never fabricates a description when none was given (only sends via)', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://x/y' })
    expect('description' in body).toBe(false)
    expect(body.via).toBe('@piprail/sdk')
  })
})

describe('normalizeNetwork — every family slug resolves to its driver caip2', () => {
  it.each([
    ['ethereum', 'eip155:1'],
    ['base', 'eip155:8453'],
    ['bnb', 'eip155:56'],
    ['bsc', 'eip155:56'],
    ['solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    ['ton', 'ton:-239'],
    ['tron', 'tron:mainnet'],
    ['near', 'near:mainnet'],
    ['sui', 'sui:mainnet'],
    ['aptos', 'aptos:1'],
    ['algorand', 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'],
    ['stellar', 'stellar:pubnet'],
    ['xrpl', 'xrpl:0'],
    ['eip155:8453', 'eip155:8453'], // CAIP-2 passthrough
    ['unknownchain', 'unknownchain'], // unknown slug passthrough (no ':')
  ])('%s → %s', (input, expected) => {
    expect(normalizeNetwork(input)).toBe(expected)
  })
})
