/**
 * client.discover() — read the OPEN indexes (stubbed), normalize + merge +
 * filter. No funds move; a dead index never sinks the others. The stub answers
 * by URL: the CDP Bazaar shape for the Bazaar host, the 402 Index shape for
 * 402index.io.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  searchOpenIndexes,
  normalizeNetwork,
  registerDriver,
  type ResolvedNetwork,
} from '../src/index.js'

const TEST_KEY = `0x${'1'.repeat(64)}` // valid secp256k1 key; address derived by viem

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function bazaarBody() {
  return {
    items: [
      {
        resource: 'https://weather.example.com/now',
        metadata: { name: 'Weather Now', description: 'Live weather feed' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: '10000',
            payTo: '0xabc',
            extra: { symbol: 'USDC' },
          },
        ],
      },
      {
        resource: 'https://sol.example.com/data',
        metadata: { name: 'Solana Data' },
        accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', asset: 'EPj…', payTo: 'So1…' }],
      },
    ],
  }
}

function index402Body() {
  return {
    services: [
      // x402 — kept
      {
        url: 'https://weather.example.com/now', // dup of a Bazaar entry → deduped
        name: 'Weather Now (mirror)',
        protocol: 'x402',
        price_usd: 0.01,
        payment_asset: 'USDC',
        payment_network: 'base',
      },
      {
        url: 'https://news.example.com/headlines',
        name: 'Headlines',
        protocol: 'x402',
        price_usd: 0.5,
        payment_asset: 'USDC',
        payment_network: 'base',
      },
      // L402 — dropped (not payable by PipRail)
      {
        url: 'https://ln.example.com/invoice',
        name: 'Lightning thing',
        protocol: 'l402',
        price_sats: 100,
      },
    ],
  }
}

/** Stub fetch routed by host. 402 Index honors its `?q=` like the real index
 *  (server-side text filter); the Bazaar returns its full page (filtered client-side). */
function stubIndexes(opts?: { dead402?: boolean }) {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('api.cdp.coinbase.com')) {
      return new Response(JSON.stringify(bazaarBody()), { status: 200 })
    }
    if (u.includes('402index.io')) {
      if (opts?.dead402) return new Response('nope', { status: 500 })
      const q = new URL(u).searchParams.get('q')?.toLowerCase()
      const body = index402Body()
      if (q) {
        body.services = body.services.filter((s) =>
          [s.url, (s as { name?: string }).name].some((f) => f?.toLowerCase().includes(q))
        )
      }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }) as typeof fetch
}

describe('client.discover() — federate the open indexes', () => {
  it('merges + dedupes by resource URL (first source wins)', async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'any' })
    const urls = found.map((r) => r.resource)
    // weather is in both → appears once, from the Bazaar (first source)
    expect(urls.filter((u) => u === 'https://weather.example.com/now')).toHaveLength(1)
    expect(found.find((r) => r.resource === 'https://weather.example.com/now')!.source).toBe('bazaar')
    expect(urls).toContain('https://news.example.com/headlines')
    expect(urls).toContain('https://sol.example.com/data')
  })

  it('drops non-x402 protocols (L402/MPP)', async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'any' })
    expect(found.some((r) => r.resource.includes('ln.example.com'))).toBe(false)
  })

  it("network:'self' keeps only resources payable on the client's chain", async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover() // default network:'self' → eip155:8453
    const urls = found.map((r) => r.resource)
    expect(urls).toContain('https://weather.example.com/now') // base
    expect(urls).toContain('https://news.example.com/headlines') // base ('base' → eip155:8453)
    expect(urls).not.toContain('https://sol.example.com/data') // solana → filtered out
  })

  it('query filters by name/description/resource', async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ query: 'headlines', network: 'any' })
    expect(found.map((r) => r.resource)).toEqual(['https://news.example.com/headlines'])
  })

  it('maxPrice drops results advertised above it (unknown price passes)', async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'any', maxPrice: 0.05 })
    expect(found.some((r) => r.resource.includes('news.example.com'))).toBe(false) // 0.5 > 0.05
    expect(found.some((r) => r.resource.includes('weather.example.com'))).toBe(true) // bazaar, no price
  })

  it("network: an explicit CAIP-2 id keeps only that chain", async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'eip155:8453' })
    const urls = found.map((r) => r.resource)
    expect(urls).toContain('https://weather.example.com/now') // base
    expect(urls).not.toContain('https://sol.example.com/data') // solana CAIP-2 ≠ target → dropped
  })

  it('network: a chain SLUG (not just CAIP-2) is normalized before matching', async () => {
    stubIndexes()
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    // 'base' is a slug, not a CAIP-2 — it must resolve to eip155:8453 and match.
    const found = await client.discover({ network: 'base' as never })
    const urls = found.map((r) => r.resource)
    expect(urls).toContain('https://weather.example.com/now') // base resource matched via the slug
    expect(urls).not.toContain('https://sol.example.com/data') // solana excluded
  })

  it('never silently hides a resource whose network it cannot resolve', async () => {
    // an index reports a rail on an unknown bare slug → kept (the agent re-checks at
    // quote time); the old strict-match map would have hidden it.
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('402index.io')) {
        return new Response(
          JSON.stringify({ services: [{ url: 'https://mystery/x', protocol: 'x402', payment_network: 'someNewL2' }] }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as typeof fetch
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover() // default self
    expect(found.map((r) => r.resource)).toContain('https://mystery/x')
  })

  it('a dead index never sinks the others (no throw)', async () => {
    stubIndexes({ dead402: true })
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'any' })
    // 402index 500s → only the Bazaar contributes; the call still resolves
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((r) => r.source === 'bazaar')).toBe(true)
  })

  it('searchOpenIndexes is usable standalone (no client/chain needed)', async () => {
    stubIndexes()
    const found = await searchOpenIndexes({ sources: ['402index'] })
    expect(found.every((r) => r.source === '402index')).toBe(true)
    expect(found.some((r) => r.resource.includes('news.example.com'))).toBe(true)
  })

  // The slug map is the linchpin of self-filtering — and its non-EVM entries must
  // mirror each driver's bound caip2 exactly (Solana's reference is truncated to
  // 32 chars). An unknown slug passes through unchanged (no ':') so the client
  // never silently hides it.
  it('normalizeNetwork: slug → CAIP-2, CAIP-2 passthrough, unknown passthrough', () => {
    expect(normalizeNetwork('base')).toBe('eip155:8453')
    expect(normalizeNetwork('BNB')).toBe('eip155:56')
    expect(normalizeNetwork('solana')).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(normalizeNetwork('stellar')).toBe('stellar:pubnet')
    expect(normalizeNetwork('xrpl')).toBe('xrpl:0')
    expect(normalizeNetwork('eip155:8453')).toBe('eip155:8453') // CAIP-2 passthrough
    expect(normalizeNetwork('cosmos:fake')).toBe('cosmos:fake') // unknown CAIP-2 passthrough
    expect(normalizeNetwork('madeup')).toBe('madeup') // unknown slug passthrough (no ':')
  })

  it("network:'self' works on a NON-EVM chain (the slug map covers every family)", async () => {
    const NET = 'stellar:pubnet'
    const fakeStellar: ResolvedNetwork = {
      family: 'stellar',
      network: NET,
      supports: (n) => n === NET,
      resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
      describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'ref',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: '' }),
    }
    registerDriver({ family: 'stellar', resolve: () => fakeStellar })

    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('402index.io')) {
        return new Response(
          JSON.stringify({
            services: [
              { url: 'https://xlm.example.com/data', name: 'XLM data', protocol: 'x402', payment_network: 'stellar' },
            ],
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 }) // bazaar
    }) as typeof fetch

    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' } })
    const found = await client.discover() // default network:'self' → stellar:pubnet
    // before the fix this returned [] (the slug 'stellar' never matched)
    expect(found.map((r) => r.resource)).toContain('https://xlm.example.com/data')
  })
})
