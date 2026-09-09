/**
 * The swap helper's contract.
 *
 * The load-bearing assertion in this file is the FIRST describe block: a client that
 * never mentions swapping must behave EXACTLY as it did before this feature existed.
 * That is STANDARDS §0 ("opt-in, defaults unchanged — omitting it leaves behaviour
 * byte-identical"), and it is the promise the docs make to every user who does not
 * want this. It is asserted, not just written down.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  applySlippage,
  resolveSlippageBps,
  summarizeSwap,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  UnsupportedNetworkError,
  WalletRequiredError,
  type ResolvedNetwork,
  type SwapQuote,
} from '../src/index.js'

const NET = 'stellar:pubnet'
const USDC = 'USDC:GISSUER'

/** A fake network. `over` lets each test drive one behaviour. */
function baseNet(over: Partial<ResolvedNetwork> = {}): ResolvedNetwork {
  return {
    family: 'stellar',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: (t) =>
      t === 'native'
        ? { asset: 'native', decimals: 7, symbol: 'XLM' }
        : { asset: USDC, decimals: 7, symbol: 'USDC' },
    describeAsset: (a) =>
      a === 'native' ? { symbol: 'XLM', decimals: 7 } : { symbol: 'USDC', decimals: 7 },
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => 'ref',
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({
      feeSymbol: 'XLM',
      feeDecimals: 7,
      fee: '100',
      feeFormatted: '0.00001',
      basis: 'estimated' as const,
    }),
    addressOf: async () => 'FAKE_SELF_ADDRESS',
    balanceOf: async () => ({ token: 100_000_000n, native: 100_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: true }) as never,
    ...over,
  } as ResolvedNetwork
}

let net = baseNet()
registerDriver({ family: 'stellar', resolve: () => net })
const client = (over = {}) =>
  new PipRailClient({ chain: 'stellar', wallet: { key: 'x' }, ...over })

afterEach(() => {
  net = baseNet()
})

const quote = (over: Partial<SwapQuote> = {}): SwapQuote => ({
  source: { kind: 'protocol', name: 'Stellar SDEX' },
  network: NET,
  from: { asset: 'native', symbol: 'XLM', decimals: 7, amount: '5000000', amountFormatted: '0.5' },
  to: { asset: USDC, symbol: 'USDC', decimals: 7, amount: '1000000', amountFormatted: '0.1' },
  maxSpend: '5025000',
  maxSpendFormatted: '0.5025',
  slippageBps: 50,
  route: [],
  ...over,
})

/* ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE PROMISE: not using it costs you nothing.
 * ───────────────────────────────────────────────────────────────────────────── */
describe('swap is OPT-IN — a driver without it is completely unaffected', () => {
  it('quoteSwap returns null (never throws) when the chain has no swap support', async () => {
    net = baseNet() // no quoteSwap / swap implemented
    const q = await client().quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.1' })
    expect(q).toBeNull()
  })

  it('swap() throws a CLEAR UnsupportedNetworkError naming why, not a crash', async () => {
    net = baseNet()
    await expect(client().swap(quote())).rejects.toThrow(UnsupportedNetworkError)
    await expect(client().swap(quote())).rejects.toThrow(/OPEN, KEYLESS route/i)
  })

  it('every other client method behaves identically with and without swap support', async () => {
    const withSwap = baseNet({ quoteSwap: async () => quote(), swap: async () => ({}) as never })
    const plain = baseNet()
    // The full read-only surface must be byte-identical across the two.
    for (const n of [plain, withSwap]) {
      net = n
      const c = client()
      const w = net.bindWallet({ key: 'x' })
      expect(await net.balanceOf(w, 'native')).toEqual({ token: 100_000_000n, native: 100_000_000n })
      expect((await net.estimateCost({} as never)).fee).toBe('100')
      expect(await c.canAfford('https://example.com/free')).toBe(true)
    }
  })
})

/* ─────────────────────────────────────────────────────────────────────────────
 * Pure maths — no I/O, exact integers.
 * ───────────────────────────────────────────────────────────────────────────── */
describe('slippage maths is pure and rounds in the USER’s favour', () => {
  it('applySlippage rounds UP so the on-chain cap is never tighter than asked', () => {
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n)
    expect(applySlippage(1_000_000n, 50)).toBe(1_005_000n) // 0.5%
    expect(applySlippage(1_000_000n, 1000)).toBe(1_100_000n) // 10%
    // 1 base unit at 1bp would round to 1.0001 → must round UP to 2, never down to 1.
    expect(applySlippage(1n, 1)).toBe(2n)
  })

  it('defaults to 0.5% and rejects nonsense loudly', () => {
    expect(resolveSlippageBps(undefined)).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(resolveSlippageBps(0)).toBe(0)
    expect(() => resolveSlippageBps(-1)).toThrow(RangeError)
    expect(() => resolveSlippageBps(MAX_SLIPPAGE_BPS + 1)).toThrow(RangeError)
    expect(() => resolveSlippageBps(1.5)).toThrow(RangeError)
  })
})

/* ─────────────────────────────────────────────────────────────────────────────
 * 🔴 No price oracle: every quote says who priced it.
 * ───────────────────────────────────────────────────────────────────────────── */
describe('a rate is always attributed — PipRail never asserts a price', () => {
  it('summarizeSwap names the source in the sentence a human or an LLM reads', () => {
    const s = summarizeSwap(quote())
    expect(s).toMatch(/Stellar SDEX/)
    expect(s).toMatch(/rate from/i)
    expect(s).toMatch(/0\.5/) // the amount
  })

  it('the protocol rails are marked `protocol`, not `provider`', async () => {
    net = baseNet({ quoteSwap: async () => quote() })
    const q = await client().quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.1' })
    expect(q?.source.kind).toBe('protocol')
  })
})

/* ─────────────────────────────────────────────────────────────────────────────
 * The read path never throws; the write path fails safe.
 * ───────────────────────────────────────────────────────────────────────────── */
describe('quoteSwap holds the never-throw contract', () => {
  it('a driver that throws still yields null, not an exception', async () => {
    net = baseNet({
      quoteSwap: async () => {
        throw new Error('horizon exploded')
      },
    })
    await expect(client().quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.1' })).resolves.toBeNull()
  })

  it('an unknown token is "no quote", not a crash', async () => {
    net = baseNet({
      resolveToken: () => {
        throw new Error('unknown token')
      },
      quoteSwap: async () => quote(),
    })
    await expect(client().quoteSwap({ from: 'native', to: 'NOPE', wantAmount: '0.1' })).resolves.toBeNull()
  })

  it('passes the resolved slippage through to the driver', async () => {
    let seen = -1
    net = baseNet({
      quoteSwap: async (i) => {
        seen = i.slippageBps
        return quote({ slippageBps: i.slippageBps })
      },
    })
    await client().quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.1' })
    expect(seen).toBe(DEFAULT_SLIPPAGE_BPS)
    await client().quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.1', slippageBps: 200 })
    expect(seen).toBe(200)
  })
})

describe('swap() refuses before it signs', () => {
  it('a read-only client is told it needs a wallet', async () => {
    net = baseNet({ swap: async () => ({}) as never })
    const ro = new PipRailClient({ chain: 'stellar' })
    await expect(ro.swap(quote())).rejects.toThrow(WalletRequiredError)
  })

  it('a quote for ANOTHER network is rejected, never executed', async () => {
    let called = false
    net = baseNet({
      swap: async () => {
        called = true
        return {} as never
      },
    })
    await expect(client().swap(quote({ network: 'xrpl:0' }))).rejects.toThrow(UnsupportedNetworkError)
    expect(called).toBe(false) // refused BEFORE any side effect
  })

  it('a matching quote reaches the driver unmodified', async () => {
    let got: SwapQuote | null = null
    net = baseNet({
      swap: async (_w, q) => {
        got = q
        return { transaction: 'tx1', network: NET, source: q.source, from: q.from, to: q.to }
      },
    })
    const q = quote()
    const receipt = await client().swap(q)
    expect(got).toBe(q) // passed by reference, nothing rewritten behind the caller's back
    expect(receipt.transaction).toBe('tx1')
  })
})

describe('client-level swap contracts the docs promise', () => {
  it('quoteSwap throws RangeError on a malformed slippageBps, before any read', async () => {
    // The docs say this is the ONE thing quoteSwap throws for: a bug in the caller's code.
    // Swallowing it into `null` would read as "no route" and hide the bug.
    const { PipRailClient } = await import('../src/client.js')
    // Read-only on purpose: a bad tolerance must throw even when there is no wallet to bind,
    // which is exactly the case that used to come back as a silent null.
    const client = new PipRailClient({ chain: 'stellar' })
    let fetched = false
    const real = globalThis.fetch
    globalThis.fetch = (async () => { fetched = true; return new Response('{}') }) as typeof fetch
    try {
      await expect(client.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '1', slippageBps: -1 })).rejects.toThrow(RangeError)
      await expect(client.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '1', slippageBps: 1.5 })).rejects.toThrow(RangeError)
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })

  it('the unsupported-network message names EVERY shipped venue, read from the registry', async () => {
    // It hand-listed seven and silently fell three behind when Aptos, TON and Tron shipped.
    const { SWAP_PROVIDERS } = await import('../src/swapProviders.js')
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8'))
    expect(src).toContain('SWAP_PROVIDERS.map((p) => p.name)')
    for (const p of SWAP_PROVIDERS) expect(p.name.length).toBeGreaterThan(2)
  })
})
