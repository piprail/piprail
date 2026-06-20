import { afterEach, describe, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  MultiChainPayer,
  type ResolvedNetwork,
  type X402AcceptEntry,
  type Caip2,
} from '@piprail/sdk'
import {
  parseConfig,
  configToClientOptions,
  configToClientOptionsList,
  walletInputFor,
  ConfigError,
} from '../src/config.js'
import { formatBanner } from '../src/banner.js'
import { createMcpServer } from '../src/server.js'

const EVM_KEY = '0x' + '1'.repeat(64)
const SOL_KEY = 'sol-secret-key'

// ----------------------------------------------------------------------------
// Config — the new PIPRAIL_CHAINS env shape
// ----------------------------------------------------------------------------
describe('parseConfig — multi-chain mode (PIPRAIL_CHAINS)', () => {
  test('builds one account per chain; primary = first; per-chain keys', () => {
    const cfg = parseConfig({
      PIPRAIL_CHAINS: 'base,solana',
      PIPRAIL_BASE_KEY: EVM_KEY,
      PIPRAIL_SOLANA_KEY: SOL_KEY,
    })
    expect(cfg.chains).toHaveLength(2)
    expect(cfg.chain).toBe('base') // primary = first
    expect(cfg.readOnly).toBe(false)
    expect(cfg.chains![0]).toMatchObject({ chain: 'base', walletSecret: EVM_KEY, readOnly: false, keySource: 'PIPRAIL_BASE_KEY' })
    expect(cfg.chains![1]).toMatchObject({ chain: 'solana', walletSecret: SOL_KEY, readOnly: false, keySource: 'PIPRAIL_SOLANA_KEY' })
  })

  test('single-chain mode is unchanged — no `chains` field', () => {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: EVM_KEY })
    expect(cfg.chains).toBeUndefined()
    expect(cfg.chain).toBe('base')
  })

  test('default tokens = UNION across chains (base→USDC, tron→USDT)', () => {
    const cfg = parseConfig({
      PIPRAIL_CHAINS: 'base,tron',
      PIPRAIL_BASE_KEY: EVM_KEY,
      PIPRAIL_TRON_KEY: EVM_KEY,
    })
    expect(cfg.tokens.sort()).toEqual(['USDC', 'USDT'])
  })

  test('a chain with no key is read-only; the server is read-only only if ALL are', () => {
    const partial = parseConfig({ PIPRAIL_CHAINS: 'base,solana', PIPRAIL_BASE_KEY: EVM_KEY })
    expect(partial.readOnly).toBe(false) // base is funded
    expect(partial.chains![1]).toMatchObject({ chain: 'solana', readOnly: true })
    expect(partial.chains![1]!.walletSecret).toBeUndefined()

    const none = parseConfig({ PIPRAIL_CHAINS: 'base,solana' })
    expect(none.readOnly).toBe(true)
  })

  test('per-chain RPC override', () => {
    const cfg = parseConfig({
      PIPRAIL_CHAINS: 'base,solana',
      PIPRAIL_BASE_KEY: EVM_KEY,
      PIPRAIL_BASE_RPC_URL: 'https://base.example/rpc',
      PIPRAIL_SOLANA_KEY: SOL_KEY,
    })
    expect(cfg.chains![0]!.rpcUrl).toBe('https://base.example/rpc')
    expect(configToClientOptionsList(cfg)[0]!.rpcUrl).toBe('https://base.example/rpc')
  })

  test('NEAR carries the shared account id into its account + WalletInput', () => {
    const cfg = parseConfig({
      PIPRAIL_CHAINS: 'near',
      PIPRAIL_NEAR_KEY: 'ed25519:secret',
      PIPRAIL_NEAR_ACCOUNT_ID: 'agent.near',
    })
    expect(cfg.chains![0]).toMatchObject({ chain: 'near', nearAccountId: 'agent.near' })
    expect(walletInputFor(cfg.chains![0]!)).toEqual({ accountId: 'agent.near', key: 'ed25519:secret' })
  })

  test('dedupes a repeated chain', () => {
    const cfg = parseConfig({ PIPRAIL_CHAINS: 'base,base,solana', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_SOLANA_KEY: SOL_KEY })
    expect(cfg.chains!.map((a) => a.chain)).toEqual(['base', 'solana'])
  })
})

describe('parseConfig — multi-chain guards (fail loudly)', () => {
  const bad = (env: Record<string, string>) => () => parseConfig(env)

  test('PIPRAIL_CHAINS + PIPRAIL_CHAIN is ambiguous', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base,solana', PIPRAIL_CHAIN: 'base' })).toThrow(ConfigError)
  })
  test('PIPRAIL_CHAINS + a global key is rejected (keys are per-chain)', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base,solana', PIPRAIL_PRIVATE_KEY: EVM_KEY })).toThrow(/per-chain/i)
  })
  test('PIPRAIL_CHAINS + a global RPC is rejected (RPC is per-chain)', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_RPC_URL: 'https://x' })).toThrow(/per-chain/i)
  })
  test('an unknown chain in the list', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base,dogecoin' })).toThrow(/Unknown chain "dogecoin"/)
  })
  test('a per-chain var for an UNLISTED chain is a typo (caught)', () => {
    // base is listed; PIPRAIL_SOLANA_KEY is not (solana not in PIPRAIL_CHAINS).
    expect(bad({ PIPRAIL_CHAINS: 'base', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_SOLANA_KEY: SOL_KEY })).toThrow(/Unknown PipRail config var/)
  })
  test('a misspelled per-chain var is caught', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base', PIPRAIL_BASE_KEYY: EVM_KEY })).toThrow(/Unknown PipRail config var/)
  })
  test('NEAR keyed without its account id', () => {
    expect(bad({ PIPRAIL_CHAINS: 'near', PIPRAIL_NEAR_KEY: 'ed25519:x' })).toThrow(/PIPRAIL_NEAR_ACCOUNT_ID/)
  })
  test('a malformed per-chain RPC URL', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_BASE_RPC_URL: 'not a url' })).toThrow(/URL/)
  })
  test('a non-network RPC scheme (mailto:/ftp:) is rejected', () => {
    expect(bad({ PIPRAIL_CHAINS: 'base', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_BASE_RPC_URL: 'mailto:a@b.com' })).toThrow(/http\(s\)/)
  })
  test('empty PIPRAIL_CHAINS', () => {
    expect(bad({ PIPRAIL_CHAINS: ' , ,' })).toThrow(/at least one chain/)
  })
})

describe('configToClientOptionsList', () => {
  test('one option per chain, each with its own wallet + the shared policy', () => {
    const cfg = parseConfig({
      PIPRAIL_CHAINS: 'base,solana',
      PIPRAIL_BASE_KEY: EVM_KEY,
      PIPRAIL_SOLANA_KEY: SOL_KEY,
      PIPRAIL_MAX_AMOUNT: '1.00',
    })
    const list = configToClientOptionsList(cfg)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ chain: 'base', wallet: { key: EVM_KEY } })
    expect(list[1]).toMatchObject({ chain: 'solana', wallet: { key: SOL_KEY } })
    expect(list[0]!.policy!.maxAmount).toBe('1.00')
    expect(list[1]!.policy!.maxAmount).toBe('1.00') // same policy on every chain
  })

  test('single-chain config still yields a one-element list', () => {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: EVM_KEY })
    expect(configToClientOptionsList(cfg)).toHaveLength(1)
    expect(configToClientOptions(cfg).chain).toBe('base')
  })

  test('configToClientOptions THROWS on a multi-chain config (would drop the other accounts)', () => {
    const cfg = parseConfig({ PIPRAIL_CHAINS: 'base,solana', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_SOLANA_KEY: SOL_KEY })
    expect(() => configToClientOptions(cfg)).toThrow(ConfigError)
    expect(() => configToClientOptions(cfg)).toThrow(/configToClientOptionsList/)
  })
})

describe('parseConfig — chain-aware defaults & normalization', () => {
  test('Kaia defaults tokens to USDT (it ships NO native USDC) — single + multi union', () => {
    // A USDC-only default would silently block every payment on Kaia.
    expect(parseConfig({ PIPRAIL_CHAIN: 'kaia', PIPRAIL_PRIVATE_KEY: EVM_KEY }).tokens).toEqual(['USDT'])
    expect(parseConfig({ PIPRAIL_CHAINS: 'base,kaia', PIPRAIL_BASE_KEY: EVM_KEY, PIPRAIL_KAIA_KEY: EVM_KEY }).tokens.sort()).toEqual(['USDC', 'USDT'])
  })

  test('single-mode chain casing is normalized like multi-mode (PIPRAIL_CHAIN=Base → base)', () => {
    expect(parseConfig({ PIPRAIL_CHAIN: 'Base', PIPRAIL_PRIVATE_KEY: EVM_KEY }).chain).toBe('base')
    expect(parseConfig({ PIPRAIL_CHAIN: 'BASE', PIPRAIL_PRIVATE_KEY: EVM_KEY }).chain).toBe('base')
  })

  test('a non-network scalar RPC scheme is rejected', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: EVM_KEY, PIPRAIL_RPC_URL: 'ftp://x' })).toThrow(/http\(s\)/)
    // ws(s) IS allowed (WebSocket RPC)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: EVM_KEY, PIPRAIL_RPC_URL: 'wss://rpc.example/ws' }).rpcUrl).toBe('wss://rpc.example/ws')
  })
})

describe('formatBanner — multi-chain', () => {
  test('lists each chain + its key status (never the secret)', () => {
    const cfg = parseConfig({ PIPRAIL_CHAINS: 'base,solana', PIPRAIL_BASE_KEY: EVM_KEY })
    const banner = formatBanner(cfg)
    expect(banner).toContain('chains')
    expect(banner).toContain('base')
    expect(banner).toContain('solana')
    expect(banner).toContain('read-only (no key)') // solana has no key
    expect(banner).not.toContain(EVM_KEY) // secret-free by contract
  })
})

// ----------------------------------------------------------------------------
// Server — a multi-chain MCP routes a 402 to whichever chain can settle
// ----------------------------------------------------------------------------
const BASE: Caip2 = 'eip155:8453'
const SOL: Caip2 = 'solana:mainnet'
const RESOURCE = 'https://api.example.com/report'

function mkNet(family: ResolvedNetwork['family'], network: Caip2, symbol: string, fee: string): ResolvedNetwork {
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: () => ({ asset: 'native', decimals: 6, symbol }),
    describeAsset: () => ({ symbol, decimals: 6 }),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${network}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: symbol, feeDecimals: 6, fee, feeFormatted: '0.0001', basis: 'estimated' }),
    balanceOf: async () => ({ token: 1_000_000_000n, native: 1_000_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
  }
}
registerDriver({ family: 'evm', resolve: () => mkNet('evm', BASE, 'ETH', '100') })
registerDriver({ family: 'solana', resolve: () => mkNet('solana', SOL, 'SOL', '50') })

function multiRailStub() {
  const accept = (network: Caip2, symbol: string): X402AcceptEntry => ({
    scheme: 'onchain-proof',
    network,
    amount: '50000', // 0.05 @ 6dp — under the MCP's default per-payment cap (0.10)
    asset: 'native',
    payTo: 'M',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol },
  })
  const body = {
    x402Version: 2 as const,
    error: null,
    resource: { url: RESOURCE },
    accepts: [accept(BASE, 'ETH'), accept(SOL, 'SOL')],
  }
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature')) {
      return new Response('{}', {
        status: 200,
        headers: {
          'payment-response': buildReceiptHeader({
            scheme: 'onchain-proof',
            success: true,
            network: SOL,
            transaction: `ref-${SOL}`,
            asset: 'native',
            amount: '50000',
            payer: 'P',
            payTo: 'M',
            verifiedAt: '2026-06-02T00:00:00.000Z',
          }),
        },
      })
    }
    return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
  }) as typeof fetch
}

async function connectMulti() {
  const cfg = parseConfig({
    PIPRAIL_CHAINS: 'base,solana',
    PIPRAIL_BASE_KEY: EVM_KEY,
    PIPRAIL_SOLANA_KEY: SOL_KEY,
    PIPRAIL_TOKENS: 'ETH,SOL',
  })
  const { server, client } = createMcpServer(configToClientOptionsList(cfg))
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(st), mcp.connect(ct)])
  return { mcp, client }
}

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe('createMcpServer — multi-chain server', () => {
  test('builds a MultiChainPayer over both chains, exposing the same 8 tools', async () => {
    const { mcp, client } = await connectMulti()
    expect(client).toBeInstanceOf(MultiChainPayer)
    const { tools } = await mcp.listTools()
    expect(tools).toHaveLength(8)
  })

  test('the plan tool merges both chains; the pay tool routes to the first-listed chain', async () => {
    multiRailStub()
    const { mcp, client } = await connectMulti()

    const plan = (await mcp.callTool({ name: 'piprail_plan_payment', arguments: { url: RESOURCE } })).structuredContent as {
      gated: boolean
      options: unknown[]
    }
    expect(plan.gated).toBe(true)
    expect(plan.options).toHaveLength(2) // base + solana merged

    const pay = (await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })).structuredContent as {
      status: number
    }
    expect(pay.status).toBe(200)
    // PIPRAIL_CHAINS='base,solana' lists base first → it settles (no cross-coin fee oracle).
    const spent = (client as MultiChainPayer).spent()
    expect(spent.count).toBe(1)
    expect(spent.records[0]!.network).toBe(BASE)
  })

  test('the budget tool aggregates across chains', async () => {
    multiRailStub()
    const { mcp } = await connectMulti()
    await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })
    const budget = (await mcp.callTool({ name: 'piprail_budget', arguments: {} })).structuredContent as {
      spent: { count: number }
      remaining: { network: string }[]
    }
    expect(budget.spent.count).toBe(1)
    expect(budget.remaining.some((r) => r.network === BASE)).toBe(true)
  })

  test('ALL SEVEN tools reach the MultiChainPayer without a missing-method error', async () => {
    const { mcp } = await connectMulti()

    // guide + budget — static / ledger, no network.
    expect((await mcp.callTool({ name: 'piprail_guide', arguments: {} })).isError).toBeFalsy()
    expect((await mcp.callTool({ name: 'piprail_budget', arguments: {} })).isError).toBeFalsy()

    // quote + plan + pay — need the multi-rail 402.
    multiRailStub()
    const quote = await mcp.callTool({ name: 'piprail_quote_payment', arguments: { url: RESOURCE } })
    expect(quote.isError).toBeFalsy()
    expect((quote.structuredContent as { gated: boolean }).gated).toBe(true)
    expect((await mcp.callTool({ name: 'piprail_plan_payment', arguments: { url: RESOURCE } })).isError).toBeFalsy()
    expect((await mcp.callTool({ name: 'piprail_pay_request', arguments: { url: RESOURCE } })).isError).toBeFalsy()

    // discover + register — reach the open indexes; a benign stub proves the payer's
    // methods are wired (the merge/register paths run, no crash, no missing method).
    globalThis.fetch = (async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const discover = await mcp.callTool({ name: 'piprail_discover', arguments: { query: 'x' } })
    expect(discover.isError).toBeFalsy()
    expect(discover.structuredContent).toHaveProperty('count')
    const register = await mcp.callTool({ name: 'piprail_register', arguments: { url: RESOURCE } })
    expect(register.isError).toBeFalsy()
    expect(register.structuredContent).toHaveProperty('outcomes')
  })
})
