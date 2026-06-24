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

describe('render — the generated project', () => {
  it('emits a runnable node project depending only on @piprail/sdk (+ express)', () => {
    const f = render(base)
    expect([...f.keys()]).toEqual(
      expect.arrayContaining([
        'package.json',
        'src/gate.mjs',
        'src/server.mjs',
        'src/verify.mjs',
        'README.md',
        '.env.example',
        '.gitignore',
      ])
    )
    const pkg = JSON.parse(f.get('package.json')!)
    expect(pkg.dependencies['@piprail/sdk']).toBeTruthy()
    expect(pkg.dependencies.express).toBeTruthy()
    expect(Object.keys(pkg.dependencies)).toHaveLength(2) // ONLY the SDK + express
    expect(pkg.scripts.verify).toContain('verify.mjs')
    expect(pkg.scripts.start).toContain('server.mjs')
  })

  it('bakes the chain + PUBLIC payTo into the gate (createPaywall) — and no private key', () => {
    const gate = render(base).get('src/gate.mjs')!
    expect(gate).toContain('createPaywall')
    expect(gate).toContain('"base"')
    expect(gate).toContain(`"${PAY_TO}"`)
    expect(gate).toContain('amount: "0.05"')
    // never any secret KEY material: the address is public (0x + 40 hex); a private key is 0x + 64 hex.
    expect(gate).not.toContain('key:')
    expect(gate).not.toMatch(/0x[0-9a-fA-F]{64}/)
  })

  it('a tip jar uses createTipJar with min', () => {
    const gate = render({ ...base, sell: 'tip', amount: '2.00' }).get('src/gate.mjs')!
    expect(gate).toContain('createTipJar')
    expect(gate).toContain('min: "2.00"')
    expect(gate).not.toContain('createPaywall')
  })

  it('the cloudflare host emits a worker + wrangler.toml and uses toFetchHandler', () => {
    const f = render({ ...base, host: 'cloudflare' })
    expect(f.has('src/worker.mjs')).toBe(true)
    expect(f.has('wrangler.toml')).toBe(true)
    expect(f.has('src/server.mjs')).toBe(false)
    expect(f.get('src/worker.mjs')!).toContain('toFetchHandler')
    expect(f.get('wrangler.toml')!).toContain('main = "src/worker.mjs"')
    const pkg = JSON.parse(f.get('package.json')!)
    expect(pkg.devDependencies.wrangler).toBeTruthy()
    expect(pkg.scripts.deploy).toContain('wrangler deploy')
    expect(pkg.dependencies.express).toBeUndefined() // no express on the worker
  })

  it('MAINNET-DEFAULT GUARD — never emits a testnet network in any file', () => {
    for (const host of ['node', 'cloudflare'] as const) {
      for (const sell of ['api', 'tip'] as const) {
        for (const [path, content] of render({ ...base, host, sell })) {
          expect(content.toLowerCase(), `${host}/${sell}:${path}`).not.toMatch(
            /sepolia|goerli|holesky|testnet|devnet|mumbai|fuji/
          )
        }
      }
    }
  })

  it('serves /.well-known/x402 for agent discovery on both hosts', () => {
    expect(render(base).get('src/server.mjs')!).toContain('/.well-known/x402')
    expect(render({ ...base, host: 'cloudflare' }).get('src/worker.mjs')!).toContain('/.well-known/x402')
  })

  it('verify.mjs runs gate.selfTest() and fails loudly on a bad config', () => {
    const v = render(base).get('src/verify.mjs')!
    expect(v).toContain('gate.selfTest()')
    expect(v).toContain('process.exit(1)')
  })

  it('the package name is carried into package.json + wrangler', () => {
    const f = render({ ...base, name: 'acme-api', host: 'cloudflare' })
    expect(JSON.parse(f.get('package.json')!).name).toBe('acme-api')
    expect(f.get('wrangler.toml')!).toContain('name = "acme-api"')
  })
})
