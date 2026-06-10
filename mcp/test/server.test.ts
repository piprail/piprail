import { afterEach, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  type PipRailClientOptions,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '@piprail/sdk'
import { createMcpServer, type McpServerOptions } from '../src/server.js'

const KEY = '0x' + '1'.repeat(64)
const STELLAR = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'

// A fake driver so the Mode-B E2E can pay end-to-end without a real chain.
const sendSpy = vi.fn(async () => 'ref')
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: STELLAR,
  supports: (n) => n === STELLAR,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: sendSpy,
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 1_000_000_000n, native: 1_000_000_000n }),
  recipientReady: async () => ({ ready: 'n/a' as const }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  sendSpy.mockClear()
})

function stellarPayStub() {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof', network: STELLAR, amount: '500000', asset: 'native', payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600, extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
  const body = { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [accept] }
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature')) {
      return new Response('{}', {
        status: 200,
        headers: { 'payment-response': buildReceiptHeader({ scheme: 'onchain-proof', success: true, network: STELLAR, transaction: 'ref', asset: 'native', amount: '500000', payer: 'GP', payTo: 'GMERCHANT', verifiedAt: '2026-06-02T00:00:00.000Z' }) },
      })
    }
    return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
  }) as typeof fetch
}

/** Spin up the server + a linked in-memory client. No network unless a fetch stub is set. */
async function connect(opts?: {
  clientOptions?: Partial<PipRailClientOptions>
  serverOpts?: McpServerOptions
  clientCapabilities?: Record<string, unknown>
  onElicit?: (req: { params: { message: string } }) => Promise<unknown>
}) {
  const { server, client } = createMcpServer(
    { chain: 'base', wallet: { privateKey: KEY }, policy: { tokens: ['USDC'], maxAmount: '0.10' }, ...opts?.clientOptions },
    opts?.serverOpts
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' }, { capabilities: opts?.clientCapabilities ?? {} })
  if (opts?.onElicit) {
    mcp.setRequestHandler(ElicitRequestSchema, opts.onElicit as never)
  }
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)])
  return { mcp, server, client }
}

describe('createMcpServer — tool listing', () => {
  test('exposes exactly the 7 SDK tools, each with an object JSON-Schema', async () => {
    const { mcp } = await connect()
    const { tools } = await mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'piprail_budget',
      'piprail_discover',
      'piprail_guide',
      'piprail_pay_request',
      'piprail_plan_payment',
      'piprail_quote_payment',
      'piprail_register',
    ])
    for (const t of tools) {
      expect(t.description).toBeTruthy()
      expect(t.inputSchema.type).toBe('object')
    }
  })

  test('forwards an outputSchema ONLY on the stable read tools', async () => {
    const { mcp } = await connect()
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t]))
    for (const n of ['piprail_quote_payment', 'piprail_plan_payment', 'piprail_budget']) {
      expect(byName[n]!.outputSchema).toMatchObject({ type: 'object' })
    }
    expect(byName['piprail_pay_request']!.outputSchema).toBeUndefined()
    expect(byName['piprail_register']!.outputSchema).toBeUndefined()
  })
})

describe('createMcpServer — call dispatch + structured output', () => {
  test('an unknown tool returns an isError result (never throws)', async () => {
    const { mcp } = await connect()
    const res = await mcp.callTool({ name: 'does_not_exist', arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('Unknown tool')
  })

  test('a tool whose invoke throws surfaces as an isError result', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network boom')
    }) as typeof fetch
    const { mcp } = await connect()
    const res = await mcp.callTool({ name: 'piprail_quote_payment', arguments: { url: 'https://example.test/r' } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('network boom')
  })

  test('a successful call returns BOTH a text block AND structuredContent', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
    const { mcp } = await connect()
    const res = await mcp.callTool({ name: 'piprail_quote_payment', arguments: { url: 'https://example.test/free' } })
    expect(res.isError).toBeFalsy()
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('"gated": false')
    expect(res.structuredContent).toMatchObject({ gated: false, url: 'https://example.test/free' })
  })

  test('piprail_budget returns structured spend/remaining/report', async () => {
    const { mcp } = await connect()
    const res = await mcp.callTool({ name: 'piprail_budget', arguments: {} })
    expect(res.structuredContent).toMatchObject({ remaining: [], report: 'No payments yet.' })
  })
})

describe('createMcpServer — the agent guide (prompts + resources)', () => {
  test('lists + serves the piprail_agent_guide prompt', async () => {
    const { mcp } = await connect()
    const list = await mcp.listPrompts()
    expect(list.prompts.map((p) => p.name)).toContain('piprail_agent_guide')
    const got = await mcp.getPrompt({ name: 'piprail_agent_guide' })
    const text = (got.messages[0]?.content as { text: string }).text
    expect(text).toContain('piprail_pay_request')
  })

  test('lists the guide + budget resources, and reads a SpendSummary-shaped budget', async () => {
    const { mcp } = await connect()
    const res = await mcp.listResources()
    expect(res.resources.map((r) => r.uri).sort()).toEqual(['piprail://budget', 'piprail://guide'])
    const budget = await mcp.readResource({ uri: 'piprail://budget' })
    const parsed = JSON.parse((budget.contents[0] as { text: string }).text)
    expect(parsed).toMatchObject({ spent: { count: 0 }, remaining: [] })
  })

  test('with guide off, the TOOLS path is byte-identical and prompts/resources are absent', async () => {
    const { mcp } = await connect({ serverOpts: { guide: false } })
    const { tools } = await mcp.listTools()
    expect(tools).toHaveLength(7) // tools unchanged
    await expect(mcp.listPrompts()).rejects.toBeTruthy() // capability not advertised
  })
})

describe('Mode B — ask-before-pay over a real InMemoryTransport (E2E)', () => {
  const payOpts = {
    clientOptions: { chain: 'stellar' as const, wallet: { secret: 'x' }, policy: { maxAmount: '1.00' } },
    serverOpts: { confirm: true },
    clientCapabilities: { elicitation: { form: {} } },
  }

  test('accept → the human is asked (amount + host) and the payment proceeds', async () => {
    stellarPayStub()
    let seen = ''
    const { mcp } = await connect({
      ...payOpts,
      onElicit: async (req) => {
        seen = req.params.message
        return { action: 'accept', content: { approve: true } }
      },
    })
    const res = await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })
    expect(seen).toContain('0.05')
    expect(seen).toContain('api.example.com')
    expect(res.structuredContent).toMatchObject({ status: 200, ok: true })
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  test('decline → the pay tool returns { declined } and NO funds move', async () => {
    stellarPayStub()
    const { mcp } = await connect({
      ...payOpts,
      onElicit: async () => ({ action: 'decline' }),
    })
    const res = await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })
    expect(res.structuredContent).toMatchObject({ declined: true, reasonCode: 'APPROVAL', code: 'PAYMENT_DECLINED' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  test('a non-eliciting client (confirm on) still pays — silent Mode-A fallback', async () => {
    stellarPayStub()
    const { mcp } = await connect({
      clientOptions: { chain: 'stellar', wallet: { secret: 'x' }, policy: { maxAmount: '1.00' } },
      serverOpts: { confirm: true },
      clientCapabilities: {}, // no elicitation capability
    })
    const res = await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })
    expect(res.structuredContent).toMatchObject({ status: 200, ok: true })
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })
})
