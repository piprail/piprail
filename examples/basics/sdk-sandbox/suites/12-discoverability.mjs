// Suite 12 — DISCOVERABILITY 2.1.0, the full upgrade surface, against the
// workspace @piprail/sdk. Offline checks (stubbed fetch + pure helpers) are HARD
// assertions; the LIVE checks (real CDP Bazaar + 402 Index) assert "no-throw +
// right shape" hard and print real samples, so a transient index hiccup can't
// flake the suite. Covers: relevance ranking, the 402-Index per-word fan-out,
// server-side + client-side filters, the new DiscoveredResource fields, the
// richer register() payload (category/tags/provider/…), and the self-describing
// endpoint block (extensions.piprail.endpoint + v2 resource.mimeType).

import {
  PipRailClient,
  createPaymentGate,
  searchOpenIndexes,
  register402Index,
  rankResources,
  scoreResource,
  appendKeywords,
  buildEndpointInfo,
  buildSelfDescription,
} from '@piprail/sdk'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const realFetch = globalThis.fetch
/** Route a stubbed fetch by host. Returns recorded request URLs for assertions. */
function stub(handlers) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (u.includes('api.cdp.coinbase.com')) return handlers.bazaar?.(u) ?? new Response(JSON.stringify({ items: [] }), { status: 200 })
    if (u.includes('402index.io')) return handlers.index402?.(u) ?? new Response(JSON.stringify({ services: [] }), { status: 200 })
    throw new Error(`unexpected fetch ${u}`)
  }
  return seen
}
const res = (over) => ({ resource: 'https://x.example.com/y', source: '402index', rails: [{ scheme: 'exact', network: 'eip155:8453' }], ...over })

export async function run() {
  group('12 · the package exports the 2.1.0 discoverability surface')
  for (const [n, v] of Object.entries({ rankResources, scoreResource, appendKeywords, buildEndpointInfo, buildSelfDescription })) {
    check(`exports ${n}`, typeof v === 'function')
  }

  group('12 · rankResources / scoreResource — relevance')
  {
    const items = [
      res({ resource: 'https://a/x', name: 'Random Weather Toy' }),
      res({ resource: 'https://b/x', name: 'PipRail x402 demo', description: 'a tiny demo endpoint' }),
    ]
    const ranked = rankResources(items, 'piprail demo')
    check('complete multi-word match ranks first', ranked[0]?.resource === 'https://b/x')
    check('a relevance score is stamped (desc)', (ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0))
    check('zero-match resources are dropped', rankResources([res({ name: 'Weather' }), res({ resource: 'https://z/q', name: 'Stocks' })], 'weather').length === 1)
    check('no query → list unchanged, no score', (() => { const o = rankResources(items, undefined); return o.length === 2 && o[0].score === undefined })())
    check('NAME hit outscores a description-only hit',
      scoreResource(res({ name: 'crypto prices' }), ['crypto']) > scoreResource(res({ name: 'svc', description: 'crypto prices' }), ['crypto']))
    check('matches a query token in tags and in the URL path',
      scoreResource(res({ tags: ['weather'] }), ['weather']) > 0 && scoreResource(res({ resource: 'https://api/weather' }), ['weather']) > 0)
  }

  group('12 · appendKeywords — searchable tag tail (pure)')
  {
    check('appends fresh tags', appendKeywords('Weather API', ['rain', 'forecast']) === 'Weather API · Keywords: rain, forecast')
    check('no tags → unchanged', appendKeywords('Weather API', []) === 'Weather API' && appendKeywords('Weather API', undefined) === 'Weather API')
    check('seeds from tags when no description', appendKeywords(undefined, ['rain']) === 'Keywords: rain')
    check('skips tags already present (case-insensitive)', appendKeywords('Rain and SNOW', ['rain', 'snow', 'hail']) === 'Rain and SNOW · Keywords: hail')
  }

  group('12 · buildEndpointInfo / buildSelfDescription — agent-readability')
  {
    check('undefined when nothing described', buildEndpointInfo({}) === undefined && buildEndpointInfo({ descriptor: {} }) === undefined)
    check('description → summary', JSON.stringify(buildEndpointInfo({ description: 'Weather by lat/lon' })) === JSON.stringify({ summary: 'Weather by lat/lon' }))
    const ep = buildEndpointInfo({ description: 'fallback', mimeType: 'application/json', descriptor: { summary: 'precise', method: 'post', queryParams: { q: { type: 'string' } }, output: { type: 'json', example: { ok: true } } } })
    check('descriptor.summary wins; method upper-cased; input+output carried',
      ep.summary === 'precise' && ep.method === 'POST' && ep.mimeType === 'application/json' && !!ep.input && ep.output.example.ok === true)
    check('empty queryParams → input omitted', !('input' in buildEndpointInfo({ descriptor: { method: 'GET', queryParams: {} } })))
    const sd = buildSelfDescription({ accepts: [{ scheme: 'onchain-proof', network: 'eip155:8453', asset: USDC_BASE, payTo: PAY_TO, amount: '10000', extra: {} }], endpoint: { summary: 'x' } })
    check('buildSelfDescription includes endpoint when given', sd.endpoint?.summary === 'x')
    check('buildSelfDescription omits endpoint when absent', !('endpoint' in buildSelfDescription({ accepts: [{ scheme: 'onchain-proof', network: 'eip155:8453', asset: USDC_BASE, payTo: PAY_TO, amount: '10000', extra: {} }] })))
  }

  group('12 · gate self-describe injection — one descriptor lights up both blocks')
  {
    const gate = createPaymentGate({
      chain: { id: 8453, rpcUrl: 'http://127.0.0.1:1' }, token: { address: USDC_BASE, decimals: 6, symbol: 'USDC' },
      amount: '0.01', payTo: PAY_TO, description: 'Current USD price for any crypto ticker', mimeType: 'application/json',
      discovery: { method: 'GET', queryParams: { symbol: { type: 'string' } }, output: { type: 'json', example: { symbol: 'ETH', usd: 3247.18 } } },
    })
    const { challenge } = await gate.challenge('https://api/price')
    check('v2 root resource carries description + mimeType', challenge.resource.description === 'Current USD price for any crypto ticker' && challenge.resource.mimeType === 'application/json')
    const epx = challenge.extensions?.piprail?.endpoint
    check('extensions.piprail.endpoint has summary/method/input/output', epx?.summary && epx?.method === 'GET' && !!epx?.input && epx?.output?.example?.usd === 3247.18)
    check('the SAME descriptor populated extensions.bazaar', JSON.stringify(challenge.extensions?.bazaar?.info?.input?.queryParams) === JSON.stringify({ symbol: { type: 'string' } }))

    const bare = createPaymentGate({ chain: { id: 8453, rpcUrl: 'http://127.0.0.1:1' }, token: { address: USDC_BASE, decimals: 6, symbol: 'USDC' }, amount: '0.01', payTo: PAY_TO })
    const bareCh = (await bare.challenge('https://api/x')).challenge
    check('zero-config gate → no endpoint block + no resource.mimeType (byte-identical default)',
      bareCh.resource.mimeType === undefined && !('endpoint' in (bareCh.extensions?.piprail ?? {})))
  }

  group('12 · searchOpenIndexes — fan-out, server-side filters, field mapping (stubbed)')
  {
    const seen = stub({
      index402: () => new Response(JSON.stringify({ services: [
        { url: 'https://ai/x', name: 'AI svc', protocol: 'x402', payment_network: 'base', payment_asset: 'USDC', category: 'ai', price_usd: 0.01, reliability_score: 91, health_status: 'healthy', domain_verified: 1, tags: ['ml', 'inference'] },
        { url: 'https://uncat/x', name: 'Plain', protocol: 'x402', payment_network: 'base', payment_asset: 'USDC', price_usd: 0.2 },
        { url: 'https://fin/x', name: 'Finance', protocol: 'x402', payment_network: 'base', payment_asset: 'DAI', category: 'finance', price_usd: 2, reliability_score: 40 },
      ] }), { status: 200 }),
    })
    try {
      const all = await searchOpenIndexes({ sources: ['402index'] })
      const ai = all.find((r) => r.resource === 'https://ai/x')
      check('maps reliability_score/health_status/domain_verified/tags onto the result',
        ai?.reliabilityScore === 91 && ai?.health === 'healthy' && ai?.verified === true && JSON.stringify(ai?.tags) === JSON.stringify(['ml', 'inference']))

      seen.length = 0
      await searchOpenIndexes({ sources: ['402index'], query: 'weather feed' })
      const qs = seen.filter((s) => s.url.includes('402index.io')).map((s) => new URL(s.url).searchParams.get('q'))
      check('multi-word query FANS OUT (full phrase + per token)', qs.includes('weather feed') && qs.includes('weather') && qs.includes('feed'))

      seen.length = 0
      await searchOpenIndexes({ sources: ['402index'], category: 'ai', asset: 'USDC', maxPrice: 0.05, verified: true, paymentValid: true, sort: 'reliability', order: 'desc' })
      const p = new URL(seen.find((s) => s.url.includes('402index.io')).url).searchParams
      check('pushes server-side filters onto the request',
        p.get('category') === 'ai' && p.get('payment_asset') === 'USDC' && p.get('max_price_usd') === '0.05' && p.get('verified') === 'true' && p.get('payment_valid') === 'true' && p.get('sort') === 'reliability')

      const cat = await searchOpenIndexes({ sources: ['402index'], category: 'ai' })
      check('category is STRICT (drops mismatch AND un-categorized)', cat.map((r) => r.resource).join() === 'https://ai/x')
      const cheap = await searchOpenIndexes({ sources: ['402index'], maxPrice: 0.05 })
      check('maxPrice drops over-priced, keeps unknown-price', cheap.some((r) => r.resource === 'https://ai/x') && !cheap.some((r) => r.resource === 'https://fin/x'))
      const rel = await searchOpenIndexes({ sources: ['402index'], minReliability: 80 })
      check('minReliability drops low-scored, keeps unscored', rel.some((r) => r.resource === 'https://ai/x') && rel.some((r) => r.resource === 'https://uncat/x') && !rel.some((r) => r.resource === 'https://fin/x'))
      const sorted = await searchOpenIndexes({ sources: ['402index'], sort: 'reliability' })
      check('sort:reliability orders by score, unknowns last', sorted[0].resource === 'https://ai/x' && sorted[sorted.length - 1].resource === 'https://uncat/x')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  group('12 · register402Index — richer metadata payload (stubbed)')
  {
    let body
    globalThis.fetch = async (_u, init) => { body = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }) }
    try {
      const out = await register402Index({ url: 'https://api.example.com/r', description: 'Live market data.', category: 'finance', tags: ['crypto', 'price', 'ticker'], provider: 'Acme', contactEmail: 'dev@acme.com', probeBody: { symbol: 'ETH' } })
      check('returns a structured outcome', out.source === '402index' && out.ok === true)
      check('forwards category/tags/provider/contact_email/probe_body',
        body.category === 'finance' && JSON.stringify(body.tags) === JSON.stringify(['crypto', 'price', 'ticker']) && body.provider === 'Acme' && body.contact_email === 'dev@acme.com' && JSON.stringify(body.probe_body) === JSON.stringify({ symbol: 'ETH' }))
      check('folds tags into the description before the attribution suffix',
        body.description === 'Live market data. · Keywords: crypto, price, ticker · Built with @piprail/sdk')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  group('12 · LIVE — pinpoint discover() against the real indexes')
  {
    const client = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: 'http://127.0.0.1:1' })
    const cp = await client.discover({ query: 'crypto price', network: 'any', limit: 10 })
    check('multi-word discover() returns a ranked array (no throw)', Array.isArray(cp))
    check('live results carry a relevance score when present', cp.length === 0 || typeof cp[0].score === 'number')
    note(`discover("crypto price") live: ${cp.length} hit(s)${cp[0] ? ` — top: ${(cp[0].name ?? cp[0].resource).slice(0, 48)} (score ${cp[0].score?.toFixed(1)})` : ''}`)

    const filtered = await client.discover({ network: 'any', sort: 'reliability', minReliability: 50, limit: 5 })
    check('filtered discover() (sort+minReliability) returns an array', Array.isArray(filtered))
    note(`discover(sort:reliability,minReliability:50) live: ${filtered.length} hit(s)${filtered[0]?.reliabilityScore !== undefined ? ` — top reliability ${filtered[0].reliabilityScore}` : ''}`)

    const mine = await client.discover({ query: 'piprail', network: 'any', limit: 20 })
    const demo = mine.find((r) => r.resource.includes('piprail.com/x402/demo'))
    check('our own demo is discoverable via a keyword query', !!demo, demo ? `category=${demo.category} reliability=${demo.reliabilityScore} health=${demo.health}` : 'not found (transient?)')
    if (demo) note(`found our demo: ${demo.name} · ${demo.category} · ${demo.priceUsd} USDC · score ${demo.score?.toFixed(1)}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
