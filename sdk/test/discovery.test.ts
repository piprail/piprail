/**
 * Discovery emitters — pure truth tables. Fixed input → exact JSON out, and a
 * proof that emitting touches NO network. Plus `gate.describe()`, which feeds the
 * emitters from a gate's resolved config (nonce-free, since discovery metadata is
 * long-lived). Reference: `.claude/research/x402-discovery.md`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  buildOpenApi,
  buildWellKnownX402,
  buildX402DnsTxt,
  buildBazaarExtension,
  createPaymentGate,
  GENERATOR,
  type ResourceDescription,
} from '../src/index.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'

const RESOURCE: ResourceDescription = {
  url: 'https://api.example.com/report',
  description: 'Premium market data',
  accepts: [
    {
      scheme: 'onchain-proof',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: PAY_TO,
      amount: '50000',
      amountFormatted: '0.05',
      decimals: 6,
      symbol: 'USDC',
      maxTimeoutSeconds: 600,
    },
  ],
}

describe('discovery emitters (pure)', () => {
  it('buildOpenApi: one path per resource, x-payment-info per op, no nonce', () => {
    const doc = buildOpenApi({ origin: 'https://api.example.com', resources: [RESOURCE] })
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers).toEqual([{ url: 'https://api.example.com' }])
    const op = doc.paths['/report']!.get!
    expect(op.summary).toBe('Premium market data')
    expect(op['x-payment-info'].x402Version).toBe(2)
    expect(op['x-payment-info'].accepts[0]!.amount).toBe('50000')
    // No invented marker — x-payment-info is exactly { x402Version, accepts }.
    expect(Object.keys(op['x-payment-info'])).toEqual(['x402Version', 'accepts'])
    expect('bazaar' in op['x-payment-info']).toBe(false)
    // discovery metadata is long-lived → never carries a single-use nonce
    expect(JSON.stringify(doc)).not.toContain('nonce')
  })

  it('buildBazaarExtension: defaults to a no-input GET; honours a descriptor', () => {
    const def = buildBazaarExtension()
    expect(def.info.input).toEqual({ type: 'http', method: 'GET', queryParams: {} })
    expect(def.info.output).toEqual({ type: 'json' })
    expect((def.schema as { required: string[] }).required).toEqual(['input'])

    const described = buildBazaarExtension({ method: 'post', queryParams: { q: { type: 'string' } }, output: { type: 'json', example: { ok: true } } })
    expect(described.info.input.method).toBe('POST') // upper-cased
    expect(described.info.input.queryParams).toEqual({ q: { type: 'string' } })
    expect(described.info.output).toEqual({ type: 'json', example: { ok: true } })
  })

  it('buildOpenApi: groups methods under one path; attaches ownership proofs', () => {
    const doc = buildOpenApi({
      origin: 'https://api.example.com',
      resources: [
        RESOURCE,
        { ...RESOURCE, method: 'POST', description: 'Submit' },
      ],
      ownershipProofs: ['0xdeadbeef'],
    })
    expect(Object.keys(doc.paths['/report']!).sort()).toEqual(['get', 'post'])
    expect(doc['x-agentcash-provenance']).toEqual({ ownershipProofs: ['0xdeadbeef'] })
  })

  it('buildOpenApi: omits provenance when there are no proofs (or an empty array)', () => {
    expect('x-agentcash-provenance' in buildOpenApi({ origin: 'https://api.example.com', resources: [RESOURCE] })).toBe(false)
    expect(
      'x-agentcash-provenance' in
        buildOpenApi({ origin: 'https://api.example.com', resources: [RESOURCE], ownershipProofs: [] })
    ).toBe(false)
  })

  it('buildOpenApi: distinct resources become distinct paths; method defaults to GET', () => {
    const doc = buildOpenApi({
      origin: 'https://api.example.com',
      resources: [
        RESOURCE,
        { url: 'https://api.example.com/feed', accepts: RESOURCE.accepts },
      ],
    })
    expect(Object.keys(doc.paths).sort()).toEqual(['/feed', '/report'])
    expect(doc.paths['/feed']!.get).toBeDefined() // defaulted to GET
  })

  it('buildOpenApi: derives the path from the URL and strips any query string', () => {
    const doc = buildOpenApi({
      origin: 'https://api.example.com',
      resources: [{ url: 'https://api.example.com/v1/report?key=1', accepts: RESOURCE.accepts }],
    })
    expect(Object.keys(doc.paths)).toEqual(['/v1/report']) // no query in the path key
  })

  it('buildOpenApi: tolerates a bare path string (not a full URL) and a root path', () => {
    const doc = buildOpenApi({
      origin: 'https://api.example.com',
      resources: [
        { url: '/bare/path', accepts: RESOURCE.accepts },
        { url: 'https://api.example.com', accepts: RESOURCE.accepts }, // root → '/'
      ],
    })
    expect(doc.paths['/bare/path']).toBeDefined()
    expect(doc.paths['/']).toBeDefined()
  })

  it('buildOpenApi: default vs custom title/version', () => {
    expect(buildOpenApi({ origin: 'https://o', resources: [RESOURCE] }).info).toEqual({
      title: 'PipRail x402 resources',
      version: '1.0.0',
    })
    expect(buildOpenApi({ origin: 'https://o', resources: [RESOURCE], title: 'Acme', version: '2.3' }).info).toEqual({
      title: 'Acme',
      version: '2.3',
    })
  })

  it('buildOpenApi: a multi-rail resource carries every rail in x-payment-info', () => {
    const multi: ResourceDescription = {
      url: 'https://api.example.com/multi',
      accepts: [
        RESOURCE.accepts[0]!,
        { ...RESOURCE.accepts[0]!, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPj…', symbol: 'USDC' },
      ],
    }
    const accepts = buildOpenApi({ origin: 'https://o', resources: [multi] }).paths['/multi']!.get!['x-payment-info'].accepts
    expect(accepts.map((a) => a.network)).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'])
  })

  it('buildOpenApi: empty resources → valid doc with no paths', () => {
    const doc = buildOpenApi({ origin: 'https://o', resources: [] })
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths).toEqual({})
  })

  it('buildOpenApi: stamps "@piprail/sdk" attribution at the root by default, opt-out with attribution:false', () => {
    const on = buildOpenApi({ origin: 'https://o', resources: [RESOURCE] })
    expect(on['x-generator']).toBe(GENERATOR)
    expect(GENERATOR).toContain('@piprail/sdk')
    // it rides at the document ROOT, so info stays exactly { title, version }
    expect(on.info).toEqual({ title: 'PipRail x402 resources', version: '1.0.0' })

    const off = buildOpenApi({ origin: 'https://o', resources: [RESOURCE], attribution: false })
    expect('x-generator' in off).toBe(false)
  })

  it('buildWellKnownX402: lists every resource URL in order', () => {
    const wk = buildWellKnownX402({
      origin: 'https://o',
      resources: [RESOURCE, { url: 'https://o/two', accepts: RESOURCE.accepts }],
    })
    expect(wk.resources).toEqual(['https://api.example.com/report', 'https://o/two'])
  })

  it('buildWellKnownX402: { version:1, resources:[urls] } + optional proofs', () => {
    expect(buildWellKnownX402({ origin: 'https://api.example.com', resources: [RESOURCE] })).toEqual({
      version: 1,
      resources: ['https://api.example.com/report'],
    })
    expect(
      buildWellKnownX402({
        origin: 'https://api.example.com',
        resources: [RESOURCE],
        ownershipProofs: ['0xabc'],
      })
    ).toEqual({
      version: 1,
      resources: ['https://api.example.com/report'],
      ownershipProofs: ['0xabc'],
    })
  })

  it('buildX402DnsTxt: exact _x402 TXT string (with + without descriptor)', () => {
    expect(
      buildX402DnsTxt({ host: 'api.example.com', discoveryUrl: 'https://api.example.com/openapi.json' })
    ).toEqual({
      name: '_x402.api.example.com',
      type: 'TXT',
      value: 'v=x4021;url=https://api.example.com/openapi.json',
    })
    expect(
      buildX402DnsTxt({
        host: 'api.example.com',
        discoveryUrl: 'https://api.example.com/openapi.json',
        descriptor: 'api',
      }).value
    ).toBe('v=x4021;descriptor=api;url=https://api.example.com/openapi.json')
  })

  it('emitting touches no network', () => {
    const realFetch = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      return new Response('{}')
    }) as typeof fetch
    try {
      buildOpenApi({ origin: 'https://api.example.com', resources: [RESOURCE] })
      buildWellKnownX402({ origin: 'https://api.example.com', resources: [RESOURCE] })
      buildX402DnsTxt({ host: 'h', discoveryUrl: 'https://h/openapi.json' })
      expect(called).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('gate.describe() — feeds the emitters from the gate config', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('returns nonce-free rails with true base-unit amounts (single-chain)', async () => {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
      description: 'Premium market data',
    })
    const desc = await gate.describe('https://api.example.com/report')
    expect(desc.url).toBe('https://api.example.com/report')
    expect(desc.description).toBe('Premium market data')
    expect(desc.accepts).toHaveLength(1)
    const rail = desc.accepts[0]!
    expect(rail.scheme).toBe('onchain-proof')
    expect(rail.network).toBe('eip155:8453')
    expect(rail.amount).toBe('50000')
    expect(rail.amountFormatted).toBe('0.05')
    expect(rail.decimals).toBe(6)
    expect(rail.symbol).toBe('USDC')
    expect(rail.payTo).toBe(PAY_TO)
    expect(rail.maxTimeoutSeconds).toBe(600) // the default flows onto the rail
    // no nonce / minConfirmations leaked into static metadata
    expect(JSON.stringify(desc)).not.toContain('nonce')

    // …and it feeds the emitter straight through.
    const doc = buildOpenApi({ origin: 'https://api.example.com', resources: [desc] })
    expect(doc.paths['/report']!.get!['x-payment-info'].accepts[0]!.amount).toBe('50000')
  })

  it('describes every offered rail (multi-chain)', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'https://base.example/rpc' }, token: 'native', amount: '0.001', payTo: PAY_TO },
        { chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' }, token: 'native', amount: '0.002', payTo: PAY_TO },
      ],
    })
    const desc = await gate.describe('https://api.example.com/multi')
    expect(desc.accepts.map((r) => r.network).sort()).toEqual(['eip155:56', 'eip155:8453'])
  })

  it('describes a native-coin rail with its true symbol/decimals and no description', async () => {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: 'native',
      amount: '0.01',
      payTo: PAY_TO,
    })
    const desc = await gate.describe() // no resource url, no description
    expect(desc.url).toBe('')
    expect('description' in desc).toBe(false)
    const rail = desc.accepts[0]!
    expect(rail.asset).toBe('native')
    expect(rail.symbol).toBe('ETH')
    expect(rail.decimals).toBe(18)
    expect(rail.amount).toBe('10000000000000000') // 0.01 ETH in wei
  })

  it('honors a configured maxTimeoutSeconds on the rail', async () => {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: 'native',
      amount: '0.01',
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
    })
    expect((await gate.describe()).accepts[0]!.maxTimeoutSeconds).toBe(120)
  })

  it('omits symbol when a custom token has none', async () => {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x1234567890123456789012345678901234567890', decimals: 6 }, // no symbol
      amount: '1',
      payTo: PAY_TO,
    })
    const rail = (await gate.describe()).accepts[0]!
    expect('symbol' in rail).toBe(false)
    expect(rail.decimals).toBe(6)
  })
})
