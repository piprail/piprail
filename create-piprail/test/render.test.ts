import { describe, it, expect } from 'vitest'
import { render, type ScaffoldConfig, type Host, type Sell } from '../src/render.js'

const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const base: ScaffoldConfig = {
  name: 'my-shop',
  sell: 'api',
  chain: 'base',
  token: 'USDC',
  payTo: PAY_TO,
  amount: '0.05',
  host: 'node',
}

/** Every VALID (sell, host) combo — proxy is edge-only (cloudflare/vercel). */
function combos(): ScaffoldConfig[] {
  const out: ScaffoldConfig[] = []
  for (const host of ['node', 'cloudflare', 'vercel'] as Host[]) {
    for (const sell of ['api', 'tip'] as Sell[]) out.push({ ...base, host, sell })
    if (host !== 'node') out.push({ ...base, host, sell: 'proxy', origin: 'https://api.example.com' })
  }
  return out
}

/** The entry file each host writes its handler into. */
function entryOf(cfg: ScaffoldConfig): string {
  const f = render(cfg)
  return (
    f.get('src/server.mjs') ?? f.get('src/worker.mjs') ?? f.get('api/x402.js') ?? ''
  )
}

describe('render — common to every host', () => {
  it('bakes chain + PUBLIC payTo into the gate (createPaywall) — and no key material', () => {
    const gate = render(base).get('src/gate.mjs')!
    expect(gate).toContain('createPaywall')
    expect(gate).toContain('"base"')
    expect(gate).toContain(`"${PAY_TO}"`)
    expect(gate).toContain('amount: "0.05"')
    expect(gate).not.toContain('key:')
    expect(gate).not.toMatch(/0x[0-9a-fA-F]{64}/)
  })

  it('a tip jar uses createTipJar with min', () => {
    const g = render({ ...base, sell: 'tip', amount: '2.00' }).get('src/gate.mjs')!
    expect(g).toContain('createTipJar')
    expect(g).toContain('min: "2.00"')
    expect(g).not.toContain('createPaywall')
  })

  it('api/tip gates emit discovery (the bazaar block agents read); a proxy does not', () => {
    expect(render(base).get('src/gate.mjs')!).toContain('discovery: true')
    expect(render({ ...base, sell: 'tip' }).get('src/gate.mjs')!).toContain('discovery: true')
    const proxy = render({ ...base, sell: 'proxy', host: 'cloudflare', origin: 'https://api.example.com' })
    expect(proxy.get('src/gate.mjs')!).not.toContain('discovery: true')
  })

  it('verify.mjs runs gate.selfTest() and exits 1 on a bad config', () => {
    const v = render(base).get('src/verify.mjs')!
    expect(v).toContain('gate.selfTest()')
    expect(v).toContain('process.exit(1)')
  })

  it('serves /.well-known/x402 + a human landing page on every host', () => {
    for (const cfg of combos()) {
      const entry = entryOf(cfg)
      expect(entry, `${cfg.host}/${cfg.sell}`).toContain('/.well-known/x402')
      expect(entry, `${cfg.host}/${cfg.sell}`).toContain('gate.landingPage') // friendly page for browsers
      expect(entry, `${cfg.host}/${cfg.sell}`).toContain('text/html')
    }
  })

  it('MAINNET-DEFAULT GUARD — never emits a testnet network in any file, any valid combo', () => {
    for (const cfg of combos()) {
      for (const [path, content] of render(cfg)) {
        expect(content.toLowerCase(), `${cfg.host}/${cfg.sell}:${path}`).not.toMatch(
          /sepolia|goerli|holesky|testnet|devnet|mumbai|fuji/
        )
      }
    }
  })
})

describe('render — node host', () => {
  it('express server, deps {sdk, express}, scripts {verify, start}, no deploy button', () => {
    const f = render(base)
    expect(f.has('src/server.mjs')).toBe(true)
    const pkg = JSON.parse(f.get('package.json')!)
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@piprail/sdk', 'express'])
    expect(pkg.scripts.start).toContain('server.mjs')
    expect(f.get('README.md')!).not.toContain('Deploy in one click')
  })
})

describe('render — cloudflare host (deploy template)', () => {
  const f = render({ ...base, host: 'cloudflare' })
  it('worker (toFetchHandler) + wrangler.toml; no express; npx deploy', () => {
    expect(f.get('src/worker.mjs')!).toContain('toFetchHandler')
    expect(f.get('wrangler.toml')!).toContain('main = "src/worker.mjs"')
    const pkg = JSON.parse(f.get('package.json')!)
    expect(pkg.dependencies.express).toBeUndefined()
    expect(pkg.scripts.deploy).toBe('npx wrangler deploy')
  })
  it('README has the one-click Deploy to Cloudflare button + URL', () => {
    const readme = f.get('README.md')!
    expect(readme).toContain('https://deploy.workers.cloudflare.com/button')
    expect(readme).toContain(
      'https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/my-shop'
    )
  })
})

describe('render — vercel host (deploy template)', () => {
  const f = render({ ...base, host: 'vercel' })
  it('edge function + vercel.json rewrite; no express; npx deploy', () => {
    const fn = f.get('api/x402.js')!
    expect(fn).toContain("runtime: 'edge'")
    expect(fn).toContain('toFetchHandler')
    expect(fn).toContain("from '../src/gate.mjs'")
    expect(JSON.parse(f.get('vercel.json')!).rewrites[0].destination).toBe('/api/x402')
    expect(JSON.parse(f.get('package.json')!).scripts.deploy).toBe('npx vercel deploy')
  })
  it('README has the one-click Deploy with Vercel button + URL', () => {
    const readme = f.get('README.md')!
    expect(readme).toContain('https://vercel.com/button')
    expect(readme).toContain(
      'https://vercel.com/new/clone?repository-url=https://github.com/YOUR_GITHUB_USERNAME/my-shop'
    )
  })
})

describe('render — proxy (gate an existing API, any language)', () => {
  const cfg: ScaffoldConfig = { ...base, sell: 'proxy', host: 'cloudflare', origin: 'https://api.example.com' }
  const f = render(cfg)

  it('forwards to the baked ORIGIN via proxyTo, gates every path', () => {
    const worker = f.get('src/worker.mjs')!
    expect(worker).toContain('proxyTo')
    expect(worker).toContain('toFetchHandler, proxyTo')
    expect(worker).toContain('const ORIGIN = "https://api.example.com"')
    expect(worker).toContain('proxyTo(ORIGIN)')
    expect(worker).toContain('const RESOURCE = "/"') // gates the whole API
  })

  it('still uses a paywall gate + serves discovery, and has NO express', () => {
    expect(f.get('src/gate.mjs')!).toContain('createPaywall')
    expect(f.get('src/worker.mjs')!).toContain('/.well-known/x402')
    expect(JSON.parse(f.get('package.json')!).dependencies.express).toBeUndefined()
  })

  it('the README explains it gates the origin (not a canned payload) and omits the embed', () => {
    const readme = f.get('README.md')!
    expect(readme).toContain('https://api.example.com')
    expect(readme).toContain('forwards **paid** requests')
    expect(readme).not.toContain('<button id="pay">') // an API has no human "Pay" button
  })

  it('works on vercel too (edge function with proxyTo)', () => {
    const fn = render({ ...cfg, host: 'vercel' }).get('api/x402.js')!
    expect(fn).toContain('proxyTo(ORIGIN)')
    expect(fn).toContain('const ORIGIN = "https://api.example.com"')
  })
})

describe('render — the shareable embed (Phase 5)', () => {
  it('api + tip READMEs carry a copy-paste browser "Pay" button', () => {
    for (const sell of ['api', 'tip'] as Sell[]) {
      const readme = render({ ...base, sell }).get('README.md')!
      expect(readme, sell).toContain('Share it')
      expect(readme, sell).toContain('<button id="pay">')
      expect(readme, sell).toContain("import { PipRailClient } from 'https://esm.sh/@piprail/sdk'")
    }
  })
})

describe('render — the name flows into config files', () => {
  it('package.json + wrangler.toml carry the package name', () => {
    const f = render({ ...base, name: 'acme-api', host: 'cloudflare' })
    expect(JSON.parse(f.get('package.json')!).name).toBe('acme-api')
    expect(f.get('wrangler.toml')!).toContain('name = "acme-api"')
  })
})
