import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  paymentTools,
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

const NETWORK = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'

function challengeBody() {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount: '500000',
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
  return { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [accept] }
}

const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => 'ref',
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 100000000n, native: 100000000n }),
  recipientReady: async () => ({ ready: 'n/a' as const }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function receiptHeader() {
  return buildReceiptHeader({
    scheme: 'onchain-proof',
    success: true,
    network: NETWORK,
    transaction: 'ref',
    asset: 'native',
    amount: '500000',
    payer: 'GPAYER',
    payTo: 'GMERCHANT',
    verifiedAt: '2026-06-02T00:00:00.000Z',
  })
}

function stubFetch(onProof: () => Response) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (!hasProof) {
      const b = challengeBody()
      return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
    }
    return onProof()
  }) as typeof fetch
}

const client = (over = {}) => new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, ...over })

describe('paymentTools — framework-agnostic descriptors', () => {
  it('exposes quote, plan, and pay tools, each well-formed', () => {
    const tools = paymentTools(client())
    expect(tools.map((t) => t.name)).toEqual([
      'piprail_quote_payment',
      'piprail_plan_payment',
      'piprail_pay_request',
    ])
    for (const t of tools) {
      expect(typeof t.description).toBe('string')
      expect(t.parameters).toMatchObject({ type: 'object' })
      expect(typeof t.invoke).toBe('function')
    }
  })

  it('plan tool reports payable + the best rail (reads balance + recipient-readiness)', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const planTool = paymentTools(client()).find((t) => t.name === 'piprail_plan_payment')!
    const out = (await planTool.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out.gated).toBe(true)
    expect(out.payable).toBe(true)
    expect(out.best).toMatchObject({ symbol: 'XLM', amount: '0.05' })
  })

  it('plan tool reports { gated: false } for an open URL', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    const planTool = paymentTools(client()).find((t) => t.name === 'piprail_plan_payment')!
    expect(await planTool.invoke({ url: RESOURCE })).toEqual({ gated: false, url: RESOURCE })
  })

  it('quote tool prices a gated URL without paying', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const [quoteTool] = paymentTools(client())
    const out = (await quoteTool!.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out).toMatchObject({ gated: true, amountFormatted: '0.05', symbol: 'XLM' })
  })

  it('quote tool reports { gated: false } for an open URL', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    const [quoteTool] = paymentTools(client())
    expect(await quoteTool!.invoke({ url: RESOURCE })).toEqual({ gated: false, url: RESOURCE })
  })

  it('pay tool returns status + body + receipt on success', async () => {
    stubFetch(() => new Response(JSON.stringify({ secret: 42 }), { status: 200, headers: { 'payment-response': receiptHeader() } }))
    const payTool = paymentTools(client()).find((t) => t.name === 'piprail_pay_request')!
    const out = (await payTool!.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ secret: 42 })
    expect(out.receipt).toMatchObject({ transaction: 'ref', amount: '500000' })
  })

  it('pay tool returns { declined } instead of throwing when policy refuses', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const payTool = paymentTools(client({ policy: { maxAmount: '0.01' } })).find((t) => t.name === 'piprail_pay_request')!
    const out = (await payTool!.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out.declined).toBe(true)
    expect(String(out.reason)).toMatch(/maxAmount/)
  })

  it('pay tool serialises an object body for a non-GET method', async () => {
    let seenBody: string | null = null
    let seenMethod: string | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      if (!h.get('payment-signature')) {
        const b = challengeBody()
        return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
      }
      seenMethod = init?.method
      seenBody = (init?.body as string) ?? null
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const payTool = paymentTools(client()).find((t) => t.name === 'piprail_pay_request')!
    const out = (await payTool!.invoke({ url: RESOURCE, method: 'PUT', body: { q: 1 } })) as Record<string, unknown>
    expect(out.status).toBe(200)
    expect(seenMethod).toBe('PUT')
    expect(seenBody).toBe('{"q":1}')
  })

  it('pay tool rethrows a non-declined error (e.g. a malformed 402)', async () => {
    globalThis.fetch = (async () => new Response('garbage', { status: 402 })) as typeof fetch
    const payTool = paymentTools(client()).find((t) => t.name === 'piprail_pay_request')!
    await expect(payTool!.invoke({ url: RESOURCE })).rejects.toThrow(/x402 challenge/)
  })
})
