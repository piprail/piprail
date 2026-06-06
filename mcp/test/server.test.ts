import { afterEach, describe, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/server.js'

const KEY = '0x' + '1'.repeat(64)

/** Spin up the server + a linked in-memory client. No network, no chain calls. */
async function connect() {
  const { server, client } = createMcpServer({
    chain: 'base',
    wallet: { privateKey: KEY },
    policy: { tokens: ['USDC'], maxAmount: '0.10' },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)])
  return { mcp, server, client }
}

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe('createMcpServer — tool listing', () => {
  test('exposes exactly the 5 SDK tools, each with an object JSON-Schema', async () => {
    const { mcp } = await connect()
    const { tools } = await mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'piprail_discover',
      'piprail_pay_request',
      'piprail_plan_payment',
      'piprail_quote_payment',
      'piprail_register',
    ])
    for (const t of tools) {
      expect(t.description).toBeTruthy()
      expect(t.inputSchema.type).toBe('object') // JSON Schema passthrough, not Zod
    }
  })

  test('advertises the SDK tool annotations so a client can reason about each tool', async () => {
    const { mcp } = await connect()
    const { tools } = await mcp.listTools()
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
    // every tool carries annotations + a human title
    for (const t of tools) expect(typeof t.annotations?.title).toBe('string')
    // the reads are flagged read-only; the pay tool is flagged value-moving (consent UI hook)
    expect(ann['piprail_discover']).toMatchObject({ readOnlyHint: true })
    expect(ann['piprail_quote_payment']).toMatchObject({ readOnlyHint: true })
    expect(ann['piprail_plan_payment']).toMatchObject({ readOnlyHint: true })
    expect(ann['piprail_pay_request']).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(ann['piprail_register']).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })
})

describe('createMcpServer — call dispatch', () => {
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
    const res = await mcp.callTool({
      name: 'piprail_quote_payment',
      arguments: { url: 'https://example.test/resource' },
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('network boom')
  })

  test('a successful tool call returns a (non-error) text content result', async () => {
    // A 200 (non-402) means "not gated" — quote() returns null, the tool returns { gated: false }.
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch
    const { mcp } = await connect()
    const res = await mcp.callTool({
      name: 'piprail_quote_payment',
      arguments: { url: 'https://example.test/free' },
    })
    expect(res.isError).toBeFalsy()
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('"gated": false')
  })
})
