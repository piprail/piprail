import { describe, it, expect } from 'vitest'
import { render, type ScaffoldConfig } from '../src/render.js'

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

describe('render — common to every host', () => {
  it('bakes chain + PUBLIC payTo into the gate (createPaywall) — and no key material', () => {
    const gate = render(base).get('src/gate.mjs')!
    expect(gate).toContain('createPaywall')
    expect(gate).toContain('"base"')
    expect(gate).toContain(`"${PAY_TO}"`)
    expect(gate).toContain('amount: "0.05"')
    expect(gate).not.toContain('key:')
    expect(gate).not.toMatch(/0x[0-9a-fA-F]{64}/) // a private key is 0x+64hex; the address is 0x+40hex
  })

  it('a tip jar uses createTipJar with min', () => {
    const g = render({ ...base, sell: 'tip', amount: '2.00' }).get('src/gate.mjs')!
    expect(g).toContain('createTipJar')
    expect(g).toContain('min: "2.00"')
    expect(g).not.toContain('createPaywall')
  })

  it('verify.mjs runs gate.selfTest() and exits 1 on a bad config', () => {
    const v = render(base).get('src/verify.mjs')!
    expect(v).toContain('gate.selfTest()')
    expect(v).toContain('process.exit(1)')
  })

  it('serves /.well-known/x402 for agent discovery on every host', () => {
    expect(render(base).get('src/server.mjs')!).toContain('/.well-known/x402')
    expect(render({ ...base, host: 'cloudflare' }).get('src/worker.mjs')!).toContain('/.well-known/x402')
    expect(render({ ...base, host: 'vercel' }).get('api/x402.js')!).toContain('/.well-known/x402')
  })

  it('MAINNET-DEFAULT GUARD — never emits a testnet network in any file, host, or sell', () => {
    for (const host of ['node', 'cloudflare', 'vercel'] as const) {
      for (const sell of ['api', 'tip'] as const) {
        for (const [path, content] of render({ ...base, host, sell })) {
          expect(content.toLowerCase(), `${host}/${sell}:${path}`).not.toMatch(
            /sepolia|goerli|holesky|testnet|devnet|mumbai|fuji/
          )
        }
      }
    }
  })
})

describe('render — node host', () => {
  it('emits an express server, deps {sdk, express}, scripts {verify, start}, and no deploy button', () => {
    const f = render(base)
    expect(f.has('src/server.mjs')).toBe(true)
    const pkg = JSON.parse(f.get('package.json')!)
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@piprail/sdk', 'express'])
    expect(pkg.scripts.start).toContain('server.mjs')
    expect(pkg.devDependencies).toBeUndefined()
    expect(f.get('README.md')!).not.toContain('Deploy in one click')
  })
})

describe('render — cloudflare host (Phase 3 deploy template)', () => {
  const f = render({ ...base, host: 'cloudflare' })

  it('emits a worker (toFetchHandler) + wrangler.toml; no express; npx deploy (no pinned CLI)', () => {
    expect(f.get('src/worker.mjs')!).toContain('toFetchHandler')
    expect(f.get('wrangler.toml')!).toContain('main = "src/worker.mjs"')
    const pkg = JSON.parse(f.get('package.json')!)
    expect(pkg.dependencies.express).toBeUndefined()
    expect(pkg.scripts.deploy).toBe('npx wrangler deploy')
    expect(pkg.devDependencies).toBeUndefined()
  })

  it('README carries the one-click "Deploy to Cloudflare" button + the correct URL', () => {
    const readme = f.get('README.md')!
    expect(readme).toContain('Deploy in one click')
    expect(readme).toContain('https://deploy.workers.cloudflare.com/button')
    expect(readme).toContain(
      'https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/my-shop'
    )
  })
})

describe('render — vercel host (Phase 3 deploy template)', () => {
  const f = render({ ...base, host: 'vercel' })

  it('emits an Edge Function + vercel.json rewrite; no express; npx deploy', () => {
    const fn = f.get('api/x402.js')!
    expect(fn).toContain("runtime: 'edge'")
    expect(fn).toContain('toFetchHandler')
    expect(fn).toContain("from '../src/gate.mjs'")
    const vj = JSON.parse(f.get('vercel.json')!)
    expect(vj.rewrites[0].destination).toBe('/api/x402')
    const pkg = JSON.parse(f.get('package.json')!)
    expect(pkg.dependencies.express).toBeUndefined()
    expect(pkg.scripts.deploy).toBe('npx vercel deploy')
  })

  it('README carries the one-click "Deploy with Vercel" button + the correct URL', () => {
    const readme = f.get('README.md')!
    expect(readme).toContain('https://vercel.com/button')
    expect(readme).toContain(
      'https://vercel.com/new/clone?repository-url=https://github.com/YOUR_GITHUB_USERNAME/my-shop'
    )
  })
})

describe('render — the name flows into config files', () => {
  it('package.json + wrangler.toml carry the package name', () => {
    const f = render({ ...base, name: 'acme-api', host: 'cloudflare' })
    expect(JSON.parse(f.get('package.json')!).name).toBe('acme-api')
    expect(f.get('wrangler.toml')!).toContain('name = "acme-api"')
  })
})
