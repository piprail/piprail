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
  it('exposes the 7 tools (first 5 byte-identical in order; budget + guide appended last)', () => {
    const tools = paymentTools(client())
    expect(tools.map((t) => t.name)).toEqual([
      'piprail_discover',
      'piprail_quote_payment',
      'piprail_plan_payment',
      'piprail_pay_request',
      'piprail_register',
      'piprail_budget',
      'piprail_guide',
    ])
    for (const t of tools) {
      expect(typeof t.description).toBe('string')
      expect(t.parameters).toMatchObject({ type: 'object' })
      expect(typeof t.invoke).toBe('function')
    }
  })

  it('the two appended tools are read-only + idempotent (move no funds)', () => {
    const ann = Object.fromEntries(paymentTools(client()).map((t) => [t.name, t.annotations]))
    expect(ann['piprail_budget']).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(ann['piprail_guide']).toMatchObject({ readOnlyHint: true, idempotentHint: true })
  })

  it('declares an outputSchema ONLY on the stable read tools (quote/plan/budget)', () => {
    const byName = Object.fromEntries(paymentTools(client()).map((t) => [t.name, t]))
    for (const n of ['piprail_quote_payment', 'piprail_plan_payment', 'piprail_budget']) {
      expect(byName[n]!.outputSchema).toMatchObject({ type: 'object' })
    }
    // value-moving / variant-shape tools declare NONE (a single schema can't describe both shapes)
    expect(byName['piprail_pay_request']!.outputSchema).toBeUndefined()
    expect(byName['piprail_register']!.outputSchema).toBeUndefined()
  })

  it('each tool carries correct, advisory MCP annotations (read-only vs value-moving)', () => {
    const ann = Object.fromEntries(paymentTools(client()).map((t) => [t.name, t.annotations]))
    // the three reads never move funds: read-only + open-world, with a human title.
    for (const n of ['piprail_discover', 'piprail_quote_payment', 'piprail_plan_payment']) {
      expect(ann[n]).toMatchObject({ readOnlyHint: true, openWorldHint: true })
      expect(typeof ann[n]?.title).toBe('string')
    }
    // pay is the ONLY value-moving tool: not read-only, destructive, not idempotent.
    expect(ann['piprail_pay_request']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    // register writes a listing to an external index but is not destructive and moves no funds.
    expect(ann['piprail_register']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })
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
    const quoteTool = paymentTools(client()).find((t) => t.name === 'piprail_quote_payment')!
    const out = (await quoteTool.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out).toMatchObject({ gated: true, amountFormatted: '0.05', symbol: 'XLM' })
  })

  it('quote tool reports { gated: false } for an open URL', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    const quoteTool = paymentTools(client()).find((t) => t.name === 'piprail_quote_payment')!
    expect(await quoteTool.invoke({ url: RESOURCE })).toEqual({ gated: false, url: RESOURCE })
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
    // The funnel superset: a structured code + a one-line explain ride along.
    expect(out.ok).toBe(false)
    expect(out.code).toBe('PAYMENT_DECLINED')
    expect(typeof out.explain).toBe('string')
  })

  it('pay tool FUNNELS a PipRailError (malformed 402) into a structured result, not a throw', async () => {
    // A garbage 402 → InvalidEnvelopeError (a PipRailError) — now caught + returned.
    globalThis.fetch = (async () => new Response('garbage', { status: 402 })) as typeof fetch
    const payTool = paymentTools(client()).find((t) => t.name === 'piprail_pay_request')!
    const out = (await payTool!.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.code).toBe('INVALID_ENVELOPE')
    expect(out.declined).toBeUndefined() // not a decline — declined stays only for PaymentDeclinedError
    expect(typeof out.explain).toBe('string')
  })

  it('pay tool RETHROWS a genuine non-PipRailError bug (e.g. a raw network error)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket hang up')
    }) as typeof fetch
    const payTool = paymentTools(client()).find((t) => t.name === 'piprail_pay_request')!
    await expect(payTool!.invoke({ url: RESOURCE })).rejects.toThrow(/socket hang up/)
  })

  it('plan tool carries a one-line summary string', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))
    const planTool = paymentTools(client()).find((t) => t.name === 'piprail_plan_payment')!
    const out = (await planTool.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(typeof out.summary).toBe('string')
    expect(String(out.summary)).toMatch(/Payable|NOT payable/)
  })

  it('piprail_budget returns spent + remaining + session + a report (read-only)', async () => {
    const budgetTool = paymentTools(client({ policy: { maxTotal: '1.00' } })).find((t) => t.name === 'piprail_budget')!
    const out = (await budgetTool.invoke({})) as Record<string, unknown>
    expect(out).toMatchObject({ remaining: [], report: 'No payments yet.' })
    expect(out.spent).toMatchObject({ count: 0 })
    expect(out.session).toBeDefined()
  })

  it('piprail_guide returns the agent contract string', async () => {
    const guideTool = paymentTools(client()).find((t) => t.name === 'piprail_guide')!
    const out = (await guideTool.invoke({})) as Record<string, unknown>
    expect(String(out.guide)).toContain('piprail_pay_request')
    expect(String(out.guide)).toContain('never re-pay')
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

  it('discover tool returns a compact, model-friendly resource list', async () => {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('402index.io')) {
        return new Response(
          JSON.stringify({
            services: [
              { url: 'https://news.example.com/h', name: 'Headlines', protocol: 'x402', price_usd: 0.02, payment_network: 'stellar' },
            ],
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 }) // bazaar
    }) as typeof fetch
    const discoverTool = paymentTools(client()).find((t) => t.name === 'piprail_discover')!
    const out = (await discoverTool.invoke({ query: 'headlines', network: 'any' })) as Record<string, unknown>
    expect(out.count).toBe(1)
    expect((out.resources as Record<string, unknown>[])[0]).toMatchObject({
      resource: 'https://news.example.com/h',
      name: 'Headlines',
      source: '402index',
      priceUsd: 0.02,
    })
  })

  it('discover tool dedupes a multi-rail resource into an ordered networks list', async () => {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('api.cdp.coinbase.com')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                resource: 'https://multi.example.com/x',
                metadata: { name: 'Multi', description: 'multi-rail feed' },
                accepts: [
                  { scheme: 'exact', network: 'stellar:pubnet', asset: 'USDC' },
                  { scheme: 'exact', network: 'stellar:pubnet', asset: 'native' }, // dup network
                  { scheme: 'exact', network: 'eip155:8453', asset: 'USDC' },
                ],
              },
            ],
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ services: [] }), { status: 200 }) // 402index
    }) as typeof fetch
    const discoverTool = paymentTools(client()).find((t) => t.name === 'piprail_discover')!
    const out = (await discoverTool.invoke({ network: 'any' })) as Record<string, unknown>
    const r = (out.resources as Record<string, unknown>[])[0]!
    expect(r.networks).toEqual(['stellar:pubnet', 'eip155:8453']) // deduped, insertion-ordered
    expect(r.description).toBe('multi-rail feed') // passthrough
  })

  it('register tool lists on 402 Index without moving funds', async () => {
    let payloadUrl: string | undefined
    let calls = 0
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      calls += 1
      payloadUrl = JSON.parse(String(init?.body)).url
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const registerTool = paymentTools(client()).find((t) => t.name === 'piprail_register')!
    const out = (await registerTool.invoke({ url: 'https://api.example.com/report', name: 'Report' })) as Record<string, unknown>
    const outcomes = out.outcomes as Record<string, unknown>[]
    expect(outcomes[0]).toMatchObject({ source: '402index', ok: true })
    expect(payloadUrl).toBe('https://api.example.com/report')
    expect(calls).toBe(1) // one register POST, no payment flow
  })
})
