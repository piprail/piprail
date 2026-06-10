import { describe, it, expect, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { buildConfirmRequest, buildConfirmHook, CONFIRM_TIMEOUT_MS } from '../src/confirm.js'
import type { PipRailQuote } from '@piprail/sdk'

const quote = (over: Partial<PipRailQuote> = {}): PipRailQuote => ({
  url: 'https://api.example.com/r?secret=abc123',
  chain: 'base',
  network: 'eip155:8453',
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '50000',
  amountFormatted: '0.05',
  decimals: 6,
  symbol: 'USDC',
  payTo: '0xmerchant',
  maxTimeoutSeconds: 600,
  recognized: true,
  symbolMismatch: false,
  withinPolicy: true,
  ...over,
})

const FORM_CAPS = { elicitation: { form: {} } }

/** A minimal fake Server exposing only what the hook touches. */
function fakeServer(opts: {
  caps?: unknown
  elicit?: (params: unknown, options?: unknown) => Promise<unknown>
}) {
  const elicit = vi.fn(opts.elicit ?? (async () => ({ action: 'accept', content: { approve: true } })))
  const server = { getClientCapabilities: () => opts.caps, elicitInput: elicit } as unknown as Server
  return { server, elicit }
}

describe('buildConfirmRequest — secret-free form', () => {
  it('shows amount, token, host, network — and no key/RPC/full-URL query', () => {
    const req = buildConfirmRequest(quote())
    expect(req.mode).toBe('form')
    expect(req.message).toContain('0.05 USDC')
    expect(req.message).toContain('api.example.com')
    expect(req.message).toContain('eip155:8453')
    const json = JSON.stringify(req)
    expect(json).not.toContain('secret=abc123') // host only, never the query string
    expect(json).not.toContain('0xmerchant') // payTo isn't shown
    expect(req.requestedSchema.required).toEqual(['approve'])
    expect(req.requestedSchema.properties.approve).toMatchObject({ type: 'boolean' })
  })

  it('FLAGS an unverified / symbol-mismatched token and shows the on-chain id', () => {
    const u = buildConfirmRequest(quote({ recognized: false }))
    expect(u.message).toContain('⚠ UNVERIFIED token')
    expect(u.message).toContain(quote().asset)
    expect(buildConfirmRequest(quote()).message).not.toContain('UNVERIFIED')

    const m = buildConfirmRequest(quote({ symbolMismatch: true }))
    expect(m.message).toContain('⚠ UNVERIFIED token')
  })
})

describe('buildConfirmHook — capability detection (silent Mode-A degrade)', () => {
  it.each([undefined, {}, { elicitation: {} }, { elicitation: { url: {} } }])(
    'returns true WITHOUT calling elicitInput when caps = %o',
    async (caps) => {
      const { server, elicit } = fakeServer({ caps })
      const approved = await buildConfirmHook(() => server)(quote())
      expect(approved).toBe(true)
      expect(elicit).not.toHaveBeenCalled()
    }
  )
})

describe('buildConfirmHook — only an explicit approval pays', () => {
  it('accept + approve:true → true', async () => {
    const { server } = fakeServer({ caps: FORM_CAPS, elicit: async () => ({ action: 'accept', content: { approve: true } }) })
    expect(await buildConfirmHook(() => server)(quote())).toBe(true)
  })
  it.each([
    { action: 'accept', content: { approve: false } },
    { action: 'accept', content: {} },
    { action: 'accept' },
    { action: 'decline' },
    { action: 'cancel' },
  ])('non-approval result %o → false', async (res) => {
    const { server } = fakeServer({ caps: FORM_CAPS, elicit: async () => res })
    expect(await buildConfirmHook(() => server)(quote())).toBe(false)
  })
})

describe('buildConfirmHook — fail-safe to NOT pay on any throw', () => {
  it('a rejected elicitInput (timeout / transport / validation) → false', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const err of [new Error('McpError: Request timed out'), new Error('transport closed')]) {
      const { server } = fakeServer({ caps: FORM_CAPS, elicit: async () => { throw err } })
      expect(await buildConfirmHook(() => server)(quote())).toBe(false)
    }
    spy.mockRestore()
  })
})

describe('buildConfirmHook — timeout wiring', () => {
  it('passes CONFIRM_TIMEOUT_MS (and an override) to elicitInput', async () => {
    const { server, elicit } = fakeServer({ caps: FORM_CAPS })
    await buildConfirmHook(() => server)(quote())
    expect(elicit.mock.calls[0]![1]).toMatchObject({ timeout: CONFIRM_TIMEOUT_MS })

    const { server: s2, elicit: e2 } = fakeServer({ caps: FORM_CAPS })
    await buildConfirmHook(() => s2, 12_345)(quote())
    expect(e2.mock.calls[0]![1]).toMatchObject({ timeout: 12_345 })
  })

  it('the default sits BELOW the MCP CallTool request timeout (60s)', () => {
    expect(CONFIRM_TIMEOUT_MS).toBeLessThan(60_000)
  })
})
