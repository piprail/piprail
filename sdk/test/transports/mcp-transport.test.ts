/**
 * The MCP SELLER transport (`createMcpPaymentTool`) — x402 carried over MCP tool calls. A
 * controllable fake EVM driver (via registerDriver, the server-exact harness) proves the transport
 * mapping, the rejection re-challenge, the shared-replay invariant (incl. CROSS-transport: a proof
 * settled over MCP is rejected over HTTP on the same gate), the buyer READ/FRAME helpers, and the
 * wire conformance (byte-equal structuredContent/text, the spec key strings, v2, the 4-field
 * settlement subset) — independent of any chain.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createPaymentGate } from '../../src/server.js'
import {
  createMcpPaymentTool,
  toMcpPaymentRequired,
  fromMcpPaymentRequired,
  fromMcpPaymentResponse,
  isMcpPaymentRequired,
  buildMcpPaymentMeta,
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
} from '../../src/transports/mcp.js'
import type { McpToolCallParams, McpToolResult } from '../../src/transports/mcp-types.js'
import { buildSignatureHeader } from '../../src/x402.js'
import { registerDriver } from '../../src/drivers/index.js'
import type { PaymentDriver } from '../../src/drivers/types.js'
import { resolveExactRailEvm } from '../../src/drivers/evm/exact.js'
import { SettlementError } from '../../src/errors.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC = '0xusdc'
const RELAYER = { key: '0x' + 'ab'.repeat(32) }
const RELAYER_ADDR = '0x2222222222222222222222222222222222222222'

let settleMode: 'ok' | 'throw' = 'ok'

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) =>
        ref.startsWith('0xbad')
          ? { ok: false, error: 'amount_too_low', detail: `bad ref ${ref}` }
          : { ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } },
      exactPermit2Supported: () => true,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({ asset, method, readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null), permit2Supported: () => true }),
      settleExactSelf: async ({ payload, accept }) => {
        if (settleMode === 'throw') throw new SettlementError('relayer out of gas')
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: 'authorization' in payload ? payload.authorization.from : 'x', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeEvm)
afterEach(() => { settleMode = 'ok' })

const AUTH = (over: Record<string, string> = {}) => ({
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAY_TO, value: '50000', validAfter: '0', validBefore: '9999999999',
  nonce: '0x' + Math.floor(Math.random() * 1e12).toString(16).padStart(64, '0'), ...over,
})
const baseGate = (over = {}) => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...over })
const exactGateCfg = { exact: { settle: 'self' as const, relayer: RELAYER } }
const fulfill = async () => [{ type: 'text', text: 'the-tool-output-42' }]

const call = (tool: ReturnType<typeof createMcpPaymentTool>, meta?: Record<string, unknown>): Promise<McpToolResult> => {
  const params: McpToolCallParams = { name: 'do_thing', arguments: {} }
  if (meta) params._meta = meta
  return tool.handleToolCall(params)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function proofMeta(challenge: any, ref = '0xgoodproof') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accept = challenge.accepts.find((a: any) => a.scheme === 'onchain-proof')!
  return buildMcpPaymentMeta({ accepted: { scheme: 'onchain-proof', network: accept.network, asset: accept.asset }, payload: { nonce: accept.extra.nonce, txHash: ref } })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exactMeta(challenge: any, over: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accept = challenge.accepts.find((a: any) => a.scheme === 'exact')!
  return buildMcpPaymentMeta({ accepted: accept, payload: { signature: '0x' + 'cd'.repeat(65), authorization: AUTH(over) } })
}

describe('MCP seller — no _meta payment → an isError PaymentRequired challenge', () => {
  it('returns isError + the X402Challenge in structuredContent (== the HTTP gate challenge)', async () => {
    const gate = baseGate()
    const tool = createMcpPaymentTool({ gate, fulfill })
    const r = await call(tool)
    expect(r.isError).toBe(true)
    expect(r.structuredContent!.x402Version).toBe(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.structuredContent as any).accepts[0].scheme).toBe('onchain-proof')
    expect(fromMcpPaymentRequired(r)).toEqual(r.structuredContent)
  })
})

describe('MCP seller — round-trip (every scheme rides MCP unchanged)', () => {
  it('onchain-proof: pay → settled, fulfill output in content + _meta payment-response', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    const r = await call(tool, proofMeta(challenge))
    expect(r.isError).toBeFalsy()
    expect(r.content[0]).toMatchObject({ type: 'text', text: 'the-tool-output-42' })
    const settle = fromMcpPaymentResponse(r)!
    expect(settle).toEqual({ success: true, transaction: '0xgoodproof', network: 'eip155:8453', payer: '0xpayer' })
  })

  it('exact: a signed authorization rides MCP → self-settled', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(exactGateCfg), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    const r = await call(tool, exactMeta(challenge))
    expect(r.isError).toBeFalsy()
    expect(fromMcpPaymentResponse(r)!.success).toBe(true)
  })
})

describe('MCP buyer — read/frame helpers', () => {
  it('isMcpPaymentRequired / fromMcpPaymentRequired read structuredContent AND fall back to content text', async () => {
    const challenge = fromMcpPaymentRequired(await call(createMcpPaymentTool({ gate: baseGate(), fulfill })))!
    const viaSc = toMcpPaymentRequired(challenge)
    expect(isMcpPaymentRequired(viaSc)).toBe(true)
    // strip structuredContent → must still parse from content[0].text
    const textOnly: McpToolResult = { isError: true, content: viaSc.content }
    expect(fromMcpPaymentRequired(textOnly)).toEqual(challenge)
  })

  it('buildMcpPaymentMeta frames an already-produced payment under the x402/payment key', () => {
    const meta = buildMcpPaymentMeta({ accepted: { scheme: 'exact' }, payload: { signature: '0x1' } })
    expect(Object.keys(meta)).toEqual([MCP_PAYMENT_META_KEY])
    expect(meta[MCP_PAYMENT_META_KEY]).toMatchObject({ x402Version: 2, accepted: { scheme: 'exact' }, payload: { signature: '0x1' } })
  })
})

describe('MCP seller — BREAK IT (adversarial)', () => {
  it('malformed _meta payment ({} / string / missing payload) → an isError re-challenge, never a crash', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(), fulfill })
    for (const bad of [{}, 'nope', { x402Version: 2 }, { accepted: {}, payload: null }]) {
      const r = await call(tool, { [MCP_PAYMENT_META_KEY]: bad })
      expect(r.isError).toBe(true)
      expect(r.structuredContent!.x402Version).toBe(2) // a fresh challenge to retry
    }
  })

  it('a non-402 isError result is NOT mistaken for a payment request', () => {
    const plainFailure: McpToolResult = { isError: true, content: [{ type: 'text', text: 'rate limited' }] }
    expect(isMcpPaymentRequired(plainFailure)).toBe(false)
    expect(fromMcpPaymentRequired(plainFailure)).toBeNull()
  })

  it('a successful (non-402) result is a passthrough — not a payment request', () => {
    const ok: McpToolResult = { content: [{ type: 'text', text: 'hello' }] }
    expect(isMcpPaymentRequired(ok)).toBe(false)
    expect(fromMcpPaymentResponse(ok)).toBeNull()
  })

  it('REPLAY: the SAME _meta payment twice → the second is rejected (tx_already_used) via the shared set', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    const meta = proofMeta(challenge, '0xreplayme')
    expect((await call(tool, meta)).isError).toBeFalsy() // first settles
    const second = await call(tool, meta)
    expect(second.isError).toBe(true) // replay → isError re-challenge
  })

  it('CROSS-TRANSPORT replay: a proof settled over MCP is rejected over HTTP on the SAME gate (one replay set)', async () => {
    const gate = baseGate()
    const tool = createMcpPaymentTool({ gate, fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accept = (challenge as any).accepts.find((a: any) => a.scheme === 'onchain-proof')
    const ref = '0xcrosstx'
    expect((await call(tool, proofMeta(challenge, ref))).isError).toBeFalsy() // settled over MCP
    // now replay the same proof over the HTTP verify path on the SAME gate:
    const httpResult = await gate.verify(buildSignatureHeader({ x402Version: 2, accepted: { scheme: 'onchain-proof', network: accept.network, asset: accept.asset } as never, payload: { nonce: accept.extra.nonce, txHash: ref } }))
    expect(httpResult).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })

  it('forged `accepted` (an unoffered asset) → the gate re-derives → rejected re-challenge (no redirect)', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accept = (challenge as any).accepts.find((a: any) => a.scheme === 'onchain-proof')
    const forged = buildMcpPaymentMeta({ accepted: { scheme: 'onchain-proof', network: accept.network, asset: '0xWRONGASSET' }, payload: { nonce: accept.extra.nonce, txHash: '0xgood' } })
    expect((await call(tool, forged)).isError).toBe(true)
  })

  it('settlement failure (relayer throws) → an isError "settlement failed" result', async () => {
    settleMode = 'throw'
    const tool = createMcpPaymentTool({ gate: baseGate(exactGateCfg), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    const r = await call(tool, exactMeta(challenge))
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/settlement failed/i)
  })
})

describe('MCP wire conformance (the silent-interop guards)', () => {
  it('structuredContent is BYTE-EQUAL to content[0].text', async () => {
    const challenge = fromMcpPaymentRequired(await call(createMcpPaymentTool({ gate: baseGate(), fulfill })))!
    const r = toMcpPaymentRequired(challenge)
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent))
    expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent)
  })

  it('the _meta key strings are spec-exact (slash, not dot)', () => {
    expect(MCP_PAYMENT_META_KEY).toBe('x402/payment')
    expect(MCP_PAYMENT_RESPONSE_META_KEY).toBe('x402/payment-response')
  })

  it('the emitted PaymentRequired is strict x402 V2 (amount string, CAIP-2 network, no maxAmountRequired)', async () => {
    const r = await call(createMcpPaymentTool({ gate: baseGate(), fulfill }))
    const sc = r.structuredContent!
    expect(sc.x402Version).toBe(2)
    expect(typeof sc.resource).toBe('object')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (sc as any).accepts[0]
    expect(typeof a.amount).toBe('string')
    expect('maxAmountRequired' in a).toBe(false)
    expect(a.network).toMatch(/^[a-z0-9]+:/i) // CAIP-2
  })

  it('the settlement object is EXACTLY the spec 4-field subset (no X402Receipt leak)', async () => {
    const tool = createMcpPaymentTool({ gate: baseGate(), fulfill })
    const challenge = fromMcpPaymentRequired(await call(tool))!
    const r = await call(tool, proofMeta(challenge, '0xsubsetcheck'))
    const settle = r._meta![MCP_PAYMENT_RESPONSE_META_KEY]!
    expect(Object.keys(settle).sort()).toEqual(['network', 'payer', 'success', 'transaction'])
  })
})
