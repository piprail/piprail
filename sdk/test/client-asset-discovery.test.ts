/**
 * `assetDiscovery: 'onchain'` — paying a rail whose token the registry has never heard of.
 *
 * The gap this closes: `describeAsset` is a synchronous registry lookup, and an `exact` rail
 * quoting anything outside it was refused outright. Measured against the live CDP Bazaar
 * catalogue (2026-09-10) that was 1,008 rails on chains PipRail already presets — money the
 * SDK was fully able to move and declined for want of a table entry.
 *
 * The gap it must NOT open: the registry is an allowlist as well as a decimals table, and the
 * spend policy caps in the token's own units. So every test here is really about one of two
 * questions — does an unknown-but-real token become payable, and does a hostile or bogus one
 * stay refused. A driver that resolves garbage would turn a `maxPerPayment` into a suggestion.
 *
 * Drives a FAKE driver throughout: no chain, no RPC, deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  buildChallengeHeader,
  NoCompatibleAcceptError,
  type ResolvedNetwork,
  type X402ExactAcceptEntry,
  type ExactPaymentPayload,
  type PipRailEvent,
} from '../src/index.js'

const NET = 'eip155:196'
const URL = 'https://api.example.com/r'
/** In the registry. */
const KNOWN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Not in the registry, but a real EIP-3009 contract — the USD₮0 case, 884 live rails. */
const UNKNOWN_REAL = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736'
/** A near-miss of Arbitrum USDC that appears in the live corpus and is not a contract. */
const TYPO = '0xaf88d065e58a2e3789859b1b3622c0a25c81f19f'
const PAYTO = '0x1111111111111111111111111111111111111111'

let reads: string[] = []
let payExactCalls = 0
/** What the fake chain will say about each address when asked directly. */
let chainTruth: Record<string, { symbol?: string; decimals: number } | null> = {}

beforeEach(() => {
  reads = []
  payExactCalls = 0
  chainTruth = { [UNKNOWN_REAL]: { symbol: 'USD₮0', decimals: 6 }, [TYPO]: null }
})

function makeNet(opts: { withSpi?: boolean } = {}): ResolvedNetwork {
  const net: ResolvedNetwork = {
    family: 'evm',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: () => ({ asset: KNOWN, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a) => (a === KNOWN ? { symbol: 'USDC', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => '0xPROOF',
    confirm: async () => ({ height: '100' }),
    estimateCost: async () => ({
      feeSymbol: 'OKB', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'estimated' as const,
    }),
    addressOf: async () => 'SELF',
    balanceOf: async () => ({ token: 10_000_000n, native: 10n ** 18n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
    payExact: async (_w, accept) => {
      payExactCalls += 1
      const payload: ExactPaymentPayload = {
        signature: `0x${'cd'.repeat(65)}`,
        authorization: {
          from: '0xPAYER', to: accept.payTo, value: accept.amount,
          validAfter: '0', validBefore: '9999999999', nonce: `0x${'11'.repeat(32)}`,
        },
      }
      return { payload, accepted: accept, payerFrom: '0xPAYER', nonce: `0x${'11'.repeat(32)}` }
    },
  }
  if (opts.withSpi ?? true) {
    net.readAssetOnchain = async (asset: string) => {
      reads.push(asset)
      return chainTruth[asset] ?? null
    }
  }
  return net
}

let net = makeNet()
registerDriver({ family: 'evm', resolve: () => net })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  net = makeNet()
})

function exactAccept(over: Partial<X402ExactAcceptEntry> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact', network: NET, amount: '50000', asset: KNOWN, payTo: PAYTO,
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
    ...over,
  }
}

function stub(accepts: unknown[]) {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const sig = new Headers(init?.headers ?? {}).get('payment-signature')
    if (!sig) {
      const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { 'payment-required': buildChallengeHeader(body as never) },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'payment-response': Buffer.from(
          JSON.stringify({ success: true, transaction: '0xS', network: NET, payer: '0xPAYER' }),
          'utf8'
        ).toString('base64'),
      },
    })
  }) as typeof fetch
}

const client = (over: Record<string, unknown> = {}) =>
  new PipRailClient({
    chain: { id: 196, rpcUrl: 'https://rpc.test' },
    wallet: { key: '0xabc' },
    schemes: ['onchain-proof', 'exact'],
    ...over,
  })

describe('default is unchanged — registry only', () => {
  it('an unknown token is still refused when assetDiscovery is not set', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    await expect(client().fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(reads).toEqual([]) // the SPI was never even consulted
  })

  it("assetDiscovery: 'registry' is explicit about the same behaviour", async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    await expect(client({ assetDiscovery: 'registry' }).fetch(URL)).rejects.toBeInstanceOf(
      NoCompatibleAcceptError
    )
    expect(reads).toEqual([])
  })

  it('a KNOWN token never triggers a read — the registry still wins first', async () => {
    stub([exactAccept({ asset: KNOWN })])
    const res = await client({ assetDiscovery: 'onchain' }).fetch(URL)
    expect(res.status).toBe(200)
    expect(reads).toEqual([])
  })
})

describe("assetDiscovery: 'onchain' — reach", () => {
  it('pays a rail whose token exists on-chain but not in the registry', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    const res = await client({ assetDiscovery: 'onchain' }).fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1)
    expect(reads).toEqual([UNKNOWN_REAL])
  })

  it('prices the payment from the CONTRACT’s decimals, not the wire’s', async () => {
    // The server lies: it claims 18 decimals for a 6-decimal token, which would make a
    // 0.05 charge look like 0.00000000000005 and slip under any cap.
    chainTruth[UNKNOWN_REAL] = { symbol: 'USD₮0', decimals: 6 }
    stub([exactAccept({ asset: UNKNOWN_REAL, extra: { name: 'x', version: '2', decimals: 18 } })])
    const seen: PipRailEvent[] = []
    const c = client({ assetDiscovery: 'onchain', onEvent: (e: PipRailEvent) => seen.push(e) })
    const q = await c.quote(URL)
    expect(q?.decimals).toBe(6)
    const ev = seen.find((e) => e.kind === 'asset-resolved')
    expect(ev).toMatchObject({ kind: 'asset-resolved', asset: UNKNOWN_REAL, decimals: 6 })
  })

  it('the spend cap is enforced in the resolved decimals', async () => {
    // 50000 base units at 6dp = 0.05. A 0.01 cap must refuse it.
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    const c = client({ assetDiscovery: 'onchain', policy: { maxAmount: '0.01' } })
    await expect(c.fetch(URL)).rejects.toThrow()
    expect(payExactCalls).toBe(0)
  })

  it('caches per client — a second payment to the same host re-reads nothing', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    const c = client({ assetDiscovery: 'onchain' })
    await c.fetch(URL)
    await c.fetch(URL)
    expect(reads).toEqual([UNKNOWN_REAL]) // once, not twice
    expect(payExactCalls).toBe(2)
  })

  it('planPayment sees exactly what fetch would pay', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    const plan = await client({ assetDiscovery: 'onchain' }).planPayment(URL)
    expect(plan?.payable).toBe(true)
    const off = await client().planPayment(URL)
    expect(off?.payable).toBe(false)
  })
})

describe("assetDiscovery: 'onchain' — the refusals that keep the cap meaningful", () => {
  it('a non-contract / typo address stays unpayable', async () => {
    stub([exactAccept({ asset: TYPO })])
    await expect(client({ assetDiscovery: 'onchain' }).fetch(URL)).rejects.toBeInstanceOf(
      NoCompatibleAcceptError
    )
    expect(payExactCalls).toBe(0)
    expect(reads).toEqual([TYPO])
  })

  it('a refusal is REMEMBERED — a hostile host cannot force a read per request', async () => {
    stub([exactAccept({ asset: TYPO })])
    const c = client({ assetDiscovery: 'onchain' })
    await expect(c.fetch(URL)).rejects.toThrow()
    await expect(c.fetch(URL)).rejects.toThrow()
    expect(reads).toEqual([TYPO]) // read once, refused twice
  })

  it('emits unresolved:true so the refusal is visible to a log', async () => {
    stub([exactAccept({ asset: TYPO })])
    const seen: PipRailEvent[] = []
    await expect(
      client({ assetDiscovery: 'onchain', onEvent: (e: PipRailEvent) => seen.push(e) }).fetch(URL)
    ).rejects.toThrow()
    expect(seen.find((e) => e.kind === 'asset-resolved')).toMatchObject({ unresolved: true })
  })

  it('an SPI that THROWS leaves the rail unpayable instead of crashing the payment', async () => {
    net.readAssetOnchain = async () => {
      throw new Error('rpc exploded')
    }
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    await expect(client({ assetDiscovery: 'onchain' }).fetch(URL)).rejects.toBeInstanceOf(
      NoCompatibleAcceptError
    )
  })

  it('a driver with NO SPI degrades to registry behaviour, not an error', async () => {
    net = makeNet({ withSpi: false })
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    await expect(client({ assetDiscovery: 'onchain' }).fetch(URL)).rejects.toBeInstanceOf(
      NoCompatibleAcceptError
    )
  })

  it('the native coin is never resolved as a token', async () => {
    stub([exactAccept({ asset: 'native' })])
    await expect(client({ assetDiscovery: 'onchain' }).fetch(URL)).rejects.toThrow()
    expect(reads).toEqual([])
  })

  it('an asset on a DIFFERENT network is not read — we only price our own chain', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL, network: 'eip155:999999' })])
    await expect(client({ assetDiscovery: 'onchain' }).fetch(URL)).rejects.toThrow()
    expect(reads).toEqual([])
  })
})

describe('cache keying', () => {
  it('resolution is case-insensitive on the address, like every other EVM lookup', async () => {
    stub([exactAccept({ asset: UNKNOWN_REAL })])
    const c = client({ assetDiscovery: 'onchain' })
    await c.fetch(URL)
    // Same token, different casing — must hit the cache, not the chain.
    chainTruth[UNKNOWN_REAL.toLowerCase()] = { symbol: 'USD₮0', decimals: 6 }
    stub([exactAccept({ asset: UNKNOWN_REAL.toLowerCase() })])
    await c.fetch(URL)
    expect(reads).toEqual([UNKNOWN_REAL])
  })

  it('resolves each distinct unknown asset once, in one pass', async () => {
    const OTHER = '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8'
    chainTruth[OTHER] = { symbol: 'USDG', decimals: 6 }
    stub([exactAccept({ asset: UNKNOWN_REAL }), exactAccept({ asset: OTHER })])
    await client({ assetDiscovery: 'onchain' }).fetch(URL)
    expect(new Set(reads)).toEqual(new Set([UNKNOWN_REAL, OTHER]))
    expect(reads).toHaveLength(2)
  })
})
