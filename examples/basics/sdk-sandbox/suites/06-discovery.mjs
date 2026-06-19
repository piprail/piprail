// Suite 06 — DISCOVERY, against the PUBLISHED @piprail/sdk and the REAL open
// indexes. Proves the shipped 1.7.0 artifact: the pure emitters, gate.describe,
// the discovery signer + ownership proof, slug normalization, and — live over
// the network — searchOpenIndexes / client.discover against CDP Bazaar + 402
// Index, plus a real register402Index call (gracefully rejected, no junk listed).
//
// The pure + offline checks are hard assertions. The LIVE checks assert "no
// throw + right shape" hard, and print the real counts/samples as proof (so a
// transient index hiccup can't flake the suite into a false failure).

import {
  createPaymentGate,
  buildOpenApi,
  buildWellKnownX402,
  buildX402DnsTxt,
  searchOpenIndexes,
  register402Index,
  normalizeNetwork,
  GENERATOR,
  PipRailClient,
} from '@piprail/sdk'
import { recoverMessageAddress } from 'viem'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export async function run() {
  group('06 · the package exports the discovery surface (1.7.0)')
  {
    for (const [name, v] of Object.entries({
      buildOpenApi, buildWellKnownX402, buildX402DnsTxt, searchOpenIndexes, register402Index, normalizeNetwork, createPaymentGate, PipRailClient,
    })) {
      check(`exports ${name}`, typeof v === 'function')
    }
    check('exports GENERATOR constant', typeof GENERATOR === 'string' && GENERATOR.includes('@piprail/sdk'), GENERATOR)
  }

  group('06 · EMIT — gate.describe() → buildOpenApi/buildWellKnownX402/buildX402DnsTxt (pure)')
  {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'http://127.0.0.1:1' },
      token: { address: USDC_BASE, decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
      description: 'Quarterly report',
    })
    const desc = await gate.describe('https://api.acme.com/report')
    check('gate.describe() → nonce-free rail with true base-unit amount',
      desc.accepts[0].amount === '50000' && desc.accepts[0].symbol === 'USDC' && !JSON.stringify(desc).includes('nonce'),
      JSON.stringify(desc.accepts[0]))

    const doc = buildOpenApi({ origin: 'https://api.acme.com', resources: [desc] })
    check('buildOpenApi → valid OpenAPI 3.1 with x-payment-info per op',
      doc.openapi === '3.1.0' && doc.paths['/report'].get['x-payment-info'].accepts[0].amount === '50000')
    check('buildOpenApi stamps the x-generator attribution by default', doc['x-generator'] === GENERATOR, doc['x-generator'])
    check('attribution:false omits the stamp',
      !('x-generator' in buildOpenApi({ origin: 'https://o', resources: [], attribution: false })))

    const wk = buildWellKnownX402({ origin: 'https://api.acme.com', resources: [desc] })
    check('buildWellKnownX402 → { version:1, resources:[url] }', wk.version === 1 && wk.resources[0] === 'https://api.acme.com/report')

    const dns = buildX402DnsTxt({ host: 'api.acme.com', discoveryUrl: 'https://api.acme.com/openapi.json' })
    check('buildX402DnsTxt → exact _x402 TXT record',
      dns.name === '_x402.api.acme.com' && dns.value === 'v=x4021;url=https://api.acme.com/openapi.json', dns.value)
  }

  group('06 · discoverySigner — ownership proof recovers to the wallet (EVM)')
  {
    const client = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: 'http://127.0.0.1:1' })
    const signer = await client.discoverySigner()
    check('client.discoverySigner() returns { address, signMessage }', !!signer && typeof signer.signMessage === 'function')
    const origin = 'https://api.acme.com'
    const sig = await signer.signMessage(origin)
    const recovered = await recoverMessageAddress({ message: origin, signature: sig })
    check('signature recovers to the signer address (x402scan-style ownership check)',
      recovered.toLowerCase() === signer.address.toLowerCase())
  }

  group('06 · normalizeNetwork — every family slug resolves')
  {
    check("base → eip155:8453", normalizeNetwork('base') === 'eip155:8453')
    check("solana → truncated caip2", normalizeNetwork('solana') === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    check("stellar → stellar:pubnet", normalizeNetwork('stellar') === 'stellar:pubnet')
    check("CAIP-2 passes through", normalizeNetwork('eip155:8453') === 'eip155:8453')
    check("unknown slug passes through (never hidden)", normalizeNetwork('madeup') === 'madeup')
  }

  group('06 · LIVE READ — searchOpenIndexes against the real CDP Bazaar + 402 Index')
  {
    const baz = await searchOpenIndexes({ sources: ['bazaar'], limit: 5 })
    check('CDP Bazaar read returns an array (never throws)', Array.isArray(baz))
    note(`Bazaar live: ${baz.length} resource(s)${baz[0] ? ` — e.g. ${baz[0].resource} (${baz[0].rails[0]?.scheme} on ${baz[0].rails[0]?.network})` : ''}`)
    if (baz[0]) check('Bazaar item has resource + rails', typeof baz[0].resource === 'string' && Array.isArray(baz[0].rails))

    const idx = await searchOpenIndexes({ sources: ['402index'], query: 'data', limit: 10 })
    check('402 Index read returns an array (never throws)', Array.isArray(idx))
    note(`402 Index live (q=data): ${idx.length} x402 resource(s) after protocol filter`)
    check('every 402 Index result is a usable resource (filtered to x402 with a rail)',
      idx.every((r) => typeof r.resource === 'string' && r.rails.length > 0))
  }

  group('06 · LIVE — client.discover() federates the open indexes')
  {
    const client = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: 'http://127.0.0.1:1' })
    const any = await client.discover({ query: 'api', network: 'any', limit: 12 })
    check('discover({network:"any"}) returns an array (no throw)', Array.isArray(any))
    note(`discover(any) live: ${any.length} resource(s) from ${[...new Set(any.map((r) => r.source))].join(' + ') || 'none'}`)

    const self = await client.discover({ query: 'api', limit: 12 }) // default self=base
    check('discover() default self=base returns an array', Array.isArray(self))
    check('every self result resolves to base or is an unresolved slug (never wrongly hidden)',
      self.every((r) => r.rails.some((rail) => { const n = normalizeNetwork(rail.network); return !n.includes(':') || n === 'eip155:8453' })))
    note(`discover(self=base) live: ${self.length} resource(s)${self[0] ? ` — e.g. ${self[0].resource}` : ''}`)
  }

  group('06 · LIVE WRITE — register402Index handles the real validation gracefully')
  {
    // example.com is not an x402 endpoint (returns 200), so 402 Index PROBES it and
    // rejects with 422 — no junk listing is created. We assert the graceful handling.
    const out = await register402Index({ url: 'https://example.com', name: 'sandbox discovery live test', network: 'base' })
    check('register402Index never throws — returns a structured outcome', out && out.source === '402index' && typeof out.ok === 'boolean')
    check('a non-402 URL is rejected (ok:false) with the index reason surfaced',
      out.ok === false && /402|verification|instead of 402/i.test(out.detail || ''),
      `HTTP ${out.status}: ${out.detail}`)
    note('confirmed live: 402 Index probes the URL and only lists real 402 endpoints — our test created no listing.')
  }
}

// Allow running this suite standalone (node suites/06-discovery.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
