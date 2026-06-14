import { describe, it, expect } from 'vitest'
import {
  renderLandingPage,
  discoveryHeaders,
  POWERED_BY,
  buildSelfDescription,
  createPaymentGate,
  type X402AcceptEntry,
} from '../src/index.js'

const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

const onchainProof: X402AcceptEntry = {
  scheme: 'onchain-proof',
  network: 'eip155:8453',
  amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: PAY_TO,
  maxTimeoutSeconds: 600,
  extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.01', symbol: 'USDC' },
}

describe('renderLandingPage', () => {
  it('renders a self-describing HTML page with identity, the rail, the install + snippet', () => {
    const html = renderLandingPage(buildSelfDescription({ accepts: [onchainProof] }))
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('402 — Payment Required')
    expect(html).toContain('PipRail')
    expect(html).toContain('0.01 USDC')
    expect(html).toContain('eip155:8453')
    expect(html).toContain(PAY_TO)
    expect(html).toContain('npm i @piprail/sdk')
    expect(html).toContain('client.fetch') // the snippet
    expect(html).toContain('npx -y @piprail/mcp')
  })

  it('HTML-escapes every interpolated field (XSS gate)', () => {
    const hostile: X402AcceptEntry = {
      ...onchainProof,
      payTo: '<script>alert(1)</script>',
      extra: { ...onchainProof.extra, symbol: '"><img src=x onerror=alert(1)>' },
    }
    const sd = buildSelfDescription({
      accepts: [hostile],
      instruction: '<b>hi</b> & "quotes" \'apos\'',
    })
    const html = renderLandingPage(sd)
    // no raw injection survives
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    // escaped forms ARE present
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
    expect(html).toContain('&#39;')
  })
})

describe('discoveryHeaders / POWERED_BY', () => {
  it('emits a Link header with both discovery rels + x-powered-by by default', () => {
    const h = discoveryHeaders()
    expect(h.link).toContain('rel="service-desc"')
    expect(h.link).toContain('rel="x402-discovery"')
    expect(h.link).toContain('/openapi.json')
    expect(h.link).toContain('/.well-known/x402')
    expect(h['x-powered-by']).toBe(POWERED_BY)
    expect(POWERED_BY).toContain('PipRail')
  })

  it('attribution:false omits x-powered-by but keeps the Link pointers', () => {
    const h = discoveryHeaders({ attribution: false })
    expect('x-powered-by' in h).toBe(false)
    expect(h.link).toContain('service-desc')
  })
})

describe('gate.landingPage (integration)', () => {
  it('renders an HTML page from a real gate challenge', async () => {
    const gate = createPaymentGate({
      chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
      token: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const { challenge } = await gate.challenge('https://api.example.com/x')
    const html = gate.landingPage(challenge)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('USDC')
    expect(html).toContain(PAY_TO)
    expect(html).toContain('npm i @piprail/sdk')
    expect(html).toContain('eip155:56')
  })
})
