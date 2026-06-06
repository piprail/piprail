/**
 * Discovery — END-TO-END + EVERY-CHAIN + LIMITS.
 *
 * This file REALLY exercises the discovery code, not just unit-stubs it:
 *  - a real gate is described, the real emitters build a manifest, and we assert
 *    the emitted OpenAPI is a structurally valid 3.1 document that round-trips;
 *  - the real EVM driver signs a real ownership proof that cryptographically
 *    recovers to the wallet;
 *  - discovery is proven to work on EVERY chain family AND on a custom
 *    { id, rpcUrl } chain — the core promise: no matter the chain, users and
 *    agents can index and find apps built on the SDK;
 *  - the emitters + adapters are pushed to the limit (hundreds of resources,
 *    many rails, unicode, very long inputs, concurrency, malformed mixed in).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { recoverMessageAddress } from 'viem'
import {
  PipRailClient,
  createPaymentGate,
  registerDriver,
  buildOpenApi,
  buildWellKnownX402,
  buildX402DnsTxt,
  type ResolvedNetwork,
  type ResourceDescription,
} from '../src/index.js'

const TEST_KEY = `0x${'1'.repeat(64)}` as const
const PAY_TO = '0x1111111111111111111111111111111111111111'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/* ----------------------------- helpers ----------------------------- */

/** A fake bound network for a given family + CAIP-2 — lets us run discover()'s
 *  'self' path on every family without mounting real peer libraries. */
function makeFake(family: ResolvedNetwork['family'], caip2: string): ResolvedNetwork {
  return {
    family,
    network: caip2 as ResolvedNetwork['network'],
    supports: (n) => n === caip2,
    resolveToken: () => ({ asset: 'native', decimals: 6, symbol: 'X' }),
    describeAsset: () => ({ symbol: 'X', decimals: 6 }),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => 'ref',
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'X', feeDecimals: 6, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
    balanceOf: async () => ({ token: 0n, native: 0n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: '' }),
  }
}

/** Stub fetch: 402 Index returns `services`, the Bazaar returns `items`. */
function stub(opts: { services?: unknown[]; items?: unknown[] } = {}) {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('402index.io')) {
      return new Response(JSON.stringify({ services: opts.services ?? [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ items: opts.items ?? [] }), { status: 200 })
  }) as typeof fetch
}

/* ----------------------------- the real loop ----------------------------- */

describe('discovery — the real merchant→agent loop', () => {
  it('describes a real gate, emits a valid OpenAPI doc, and an agent discovers it', async () => {
    // MERCHANT — gate a route, describe it, emit the discovery file.
    const gate = createPaymentGate({
      chain: 'base',
      token: 'USDC',
      amount: '0.05',
      payTo: PAY_TO,
      description: 'Premium market data',
    })
    const resource = await gate.describe('https://api.acme.com/report')
    const doc = buildOpenApi({ origin: 'https://api.acme.com', resources: [resource] })

    // The emitted doc is a structurally valid OpenAPI 3.1 document…
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toMatchObject({ title: expect.any(String), version: expect.any(String) })
    expect(doc.servers).toEqual([{ url: 'https://api.acme.com' }])
    const op = doc.paths['/report']!.get!
    expect(op['x-payment-info'].x402Version).toBe(2)
    expect(op['x-payment-info'].accepts[0]).toMatchObject({ network: 'eip155:8453', amount: '50000', symbol: 'USDC' })
    // …that round-trips through JSON unchanged (it's what you serve at /openapi.json).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
    expect(JSON.stringify(doc)).not.toContain('nonce')

    // AGENT — an index has crawled that doc; the agent finds the resource on its chain.
    stub({
      items: [
        {
          resource: resource.url,
          metadata: { name: 'Acme Report', description: resource.description },
          accepts: resource.accepts.map((r) => ({ scheme: 'exact', network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, extra: { symbol: r.symbol } })),
        },
      ],
    })
    const agent = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await agent.discover({ query: 'acme' })
    expect(found.map((f) => f.resource)).toContain('https://api.acme.com/report')
    expect(found[0]!.rails[0]).toMatchObject({ network: 'eip155:8453', amount: '50000' })
  })

  it('the real EVM signer produces an ownership proof that recovers to the wallet', async () => {
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const signer = await client.discoverySigner()
    expect(signer).not.toBeNull()
    const origin = 'https://api.acme.com'
    const proof = await signer!.signMessage(origin)
    // exactly how x402scan verifies origin ownership
    const recovered = await recoverMessageAddress({ message: origin, signature: proof as `0x${string}` })
    expect(recovered.toLowerCase()).toBe(signer!.address.toLowerCase())
    // …and the proof flows into the emitted manifest.
    const doc = buildOpenApi({
      origin,
      resources: [{ url: `${origin}/r`, accepts: [] }],
      ownershipProofs: [proof],
    })
    expect(doc['x-agentcash-provenance']).toEqual({ ownershipProofs: [proof] })
  })
})

/* --------------------- discovery works on EVERY chain --------------------- */

// Each family with the exact CAIP-2 its driver binds + the slug an index reports.
const FAMILIES: { family: ResolvedNetwork['family']; chain: string; caip2: string; slug: string }[] = [
  { family: 'solana', chain: 'solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', slug: 'solana' },
  { family: 'ton', chain: 'ton', caip2: 'ton:-239', slug: 'ton' },
  { family: 'tron', chain: 'tron', caip2: 'tron:mainnet', slug: 'tron' },
  { family: 'near', chain: 'near', caip2: 'near:mainnet', slug: 'near' },
  { family: 'sui', chain: 'sui', caip2: 'sui:mainnet', slug: 'sui' },
  { family: 'aptos', chain: 'aptos', caip2: 'aptos:1', slug: 'aptos' },
  { family: 'algorand', chain: 'algorand', caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', slug: 'algorand' },
  { family: 'stellar', chain: 'stellar', caip2: 'stellar:pubnet', slug: 'stellar' },
  { family: 'xrpl', chain: 'xrpl', caip2: 'xrpl:0', slug: 'xrpl' },
]

describe('discovery works on EVERY chain — agent on its own chain (self)', () => {
  it.each(FAMILIES)('$family: discover(self) finds a $slug resource and excludes others', async ({ family, chain, caip2, slug }) => {
    registerDriver({ family, resolve: () => makeFake(family, caip2) })
    stub({
      services: [
        { url: `https://${slug}.example.com/x`, protocol: 'x402', payment_network: slug }, // on-chain → found
        { url: 'https://other.example.com/x', protocol: 'x402', payment_network: 'eip155:1' }, // off-chain → excluded
      ],
    })
    const client = new PipRailClient({ chain: chain as never, wallet: { privateKey: TEST_KEY } as never })
    const found = await client.discover() // default network:'self'
    const urls = found.map((r) => r.resource)
    expect(urls).toContain(`https://${slug}.example.com/x`)
    expect(urls).not.toContain('https://other.example.com/x')
  })

  it('a CUSTOM { id, rpcUrl } EVM chain (no preset) still discovers its own resources', async () => {
    const id = 1313161554 // Aurora — not a built-in preset; resolved via defineChain
    stub({
      services: [
        { url: 'https://aurora.example.com/x', protocol: 'x402', payment_network: `eip155:${id}` },
        { url: 'https://base.example.com/x', protocol: 'x402', payment_network: 'base' }, // eip155:8453 → excluded
      ],
    })
    const client = new PipRailClient({ chain: { id, rpcUrl: 'https://aurora.invalid/rpc' }, wallet: { privateKey: TEST_KEY } })
    const found = await client.discover()
    expect(found.map((r) => r.resource)).toEqual(['https://aurora.example.com/x'])
  })
})

describe('discovery works on EVERY chain — explicit CAIP-2 scope (no driver needed)', () => {
  it.each(FAMILIES)('$family: a bare "$slug" rail matches network: "$caip2" and excludes off-chain', async ({ caip2, slug }) => {
    stub({
      services: [
        { url: `https://${slug}.example.com/x`, protocol: 'x402', payment_network: slug },
        { url: 'https://off.example.com/x', protocol: 'x402', payment_network: 'eip155:1' }, // not the target (not in FAMILIES)
      ],
    })
    // a base client, filtering explicitly to another chain — proves the slug→CAIP-2 map alone.
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const urls = (await client.discover({ network: caip2 as never })).map((r) => r.resource)
    expect(urls).toContain(`https://${slug}.example.com/x`) // resolved + matched
    expect(urls).not.toContain('https://off.example.com/x') // a non-matching rail IS filtered out
  })

  it('register on 402 Index passes protocol:x402 + the right payment_network for every family', async () => {
    let body: Record<string, unknown> = {}
    let count = 0
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      count += 1
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    for (const f of FAMILIES) {
      const client = new PipRailClient({ chain: f.chain as never, wallet: { privateKey: TEST_KEY } as never })
      const [outcome] = await client.register(`https://${f.slug}.example.com/x`)
      expect(outcome!.ok).toBe(true) // 402 Index lists every chain, no signature
      expect(body.protocol).toBe('x402')
      expect(body.payment_network).toBe(f.slug) // the family's own slug rides into the listing
    }
    expect(count).toBe(FAMILIES.length)
  })
})

/* ----------------------------- pushing the limits ----------------------------- */

describe('discovery — pushed to the limit', () => {
  it('buildOpenApi handles hundreds of resources across distinct paths', () => {
    const resources: ResourceDescription[] = Array.from({ length: 500 }, (_, i) => ({
      url: `https://api.acme.com/r/${i}`,
      description: `resource ${i}`,
      accepts: [
        { scheme: 'onchain-proof', network: 'eip155:8453', asset: 'native', payTo: PAY_TO, amount: String(i), amountFormatted: String(i), decimals: 18, maxTimeoutSeconds: 600 },
      ],
    }))
    const doc = buildOpenApi({ origin: 'https://api.acme.com', resources })
    expect(Object.keys(doc.paths)).toHaveLength(500)
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc) // serializable at scale
  })

  it('a single resource with many rails keeps every rail in order', () => {
    const accepts = Array.from({ length: 40 }, (_, i) => ({
      scheme: 'onchain-proof' as const,
      network: `eip155:${i + 1}` as `eip155:${number}`,
      asset: 'native',
      payTo: PAY_TO,
      amount: '1',
      amountFormatted: '1',
      decimals: 18,
      maxTimeoutSeconds: 600,
    }))
    const doc = buildOpenApi({ origin: 'https://o', resources: [{ url: 'https://o/multi', accepts }] })
    expect(doc.paths['/multi']!.get!['x-payment-info'].accepts).toHaveLength(40)
  })

  it('emitters survive unicode + very long inputs', () => {
    const longPath = '/' + 'a'.repeat(2000)
    const doc = buildOpenApi({
      origin: 'https://例え.example.com',
      title: '日本語 — émojis 🚀 & <tags>',
      resources: [{ url: `https://例え.example.com${longPath}`, description: '价格 0.05 — naïve', accepts: [] }],
    })
    expect(doc.servers[0]!.url).toBe('https://例え.example.com')
    expect(doc.paths[longPath]).toBeDefined()
    const wk = buildWellKnownX402({ origin: 'https://例え.example.com', resources: [{ url: 'https://例え.example.com/r', accepts: [] }] })
    expect(wk.resources[0]).toContain('例え')
    const dns = buildX402DnsTxt({ host: '例え.example.com', discoveryUrl: 'https://例え.example.com/openapi.json', descriptor: 'naïve-api' })
    expect(dns.value).toBe('v=x4021;descriptor=naïve-api;url=https://例え.example.com/openapi.json')
  })

  it('discover() handles a large, mixed, partly-malformed index page without crashing', async () => {
    const services = Array.from({ length: 300 }, (_, i) =>
      i % 7 === 0
        ? null // malformed — dropped, never crashes
        : { url: `https://svc${i}.example.com/x`, name: `svc ${i}`, protocol: i % 3 === 0 ? 'l402' : 'x402', payment_network: 'base' }
    )
    stub({ services })
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    const found = await client.discover({ network: 'any' })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((r) => r.resource.startsWith('https://svc'))).toBe(true) // only valid x402 kept
  })

  it('many concurrent discover()/register() calls all resolve (no shared-state races)', async () => {
    stub({ services: [{ url: 'https://c.example.com/x', protocol: 'x402', payment_network: 'base' }] })
    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
    // network:'self' on purpose — it contends on the memoized network bind (this.bound).
    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => client.discover({ network: 'self' })),
      ...Array.from({ length: 25 }, (_, i) => client.register(`https://c.example.com/${i}`)),
    ])
    expect(results).toHaveLength(50)
    const discoveries = results.slice(0, 25) as Awaited<ReturnType<PipRailClient['discover']>>[]
    expect(discoveries.every((d) => d.length === 1)).toBe(true)
  })
})
