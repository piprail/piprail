import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  planAcross,
  registerDriver,
  buildChallengeHeader,
  PaymentDeclinedError,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

// A configurable fake 'stellar' network so we can drive every planPayment outcome
// (registerDriver replaces the family in the registry; the closure reads `net` live).
const NET = 'stellar:pubnet'
const URL = 'https://api.example.com/r'
const USDC = 'USDC:GISSUER'

type NetOver = Partial<Pick<ResolvedNetwork, 'balanceOf' | 'recipientReady' | 'estimateCost'>>
function baseNet(over: NetOver = {}): ResolvedNetwork {
  return {
    family: 'stellar',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
    describeAsset: (a) =>
      a === 'native'
        ? { symbol: 'XLM', decimals: 7 }
        : a === USDC
          ? { symbol: 'USDC', decimals: 7 }
          : null,
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => 'ref',
    confirm: async () => ({ height: '1' }),
    // native gas is cheaper (100) than the token rail (200) — exercises ranking.
    estimateCost: async (accept) => ({
      feeSymbol: 'XLM',
      feeDecimals: 7,
      fee: accept.asset === 'native' ? '100' : '200',
      feeFormatted: '0.00001',
      basis: 'estimated',
    }),
    balanceOf: async () => ({ token: 100_000_000n, native: 100_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({
      ok: true,
      receipt: {
        scheme: 'onchain-proof',
        success: true,
        network: NET,
        transaction: 'ref',
        asset: 'native',
        amount: '500000',
        payer: 'GP',
        payTo: 'GMERCHANT',
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    ...over,
  }
}
let net = baseNet()
registerDriver({ family: 'stellar', resolve: () => net })
const client = (over = {}) => new PipRailClient({ chain: 'stellar', wallet: { key: 'x' }, ...over })

function nativeAccept(o: Partial<X402AcceptEntry> = {}): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: NET,
    amount: '500000', // 0.05 @ 7dp
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
    ...o,
  }
}
function usdcAccept(o: Partial<X402AcceptEntry> = {}): X402AcceptEntry {
  return nativeAccept({
    asset: USDC,
    extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
    ...o,
  })
}

function stub402(accepts: X402AcceptEntry[], onProof?: () => Response) {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const proof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (proof && onProof) return onProof()
    const b = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
    return new Response(JSON.stringify(b), {
      status: 402,
      headers: { 'payment-required': buildChallengeHeader(b) },
    })
  }) as typeof fetch
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  net = baseNet()
})

describe('planPayment — affordability + recipient-readiness', () => {
  it('READY: payable, best rail, no funding hint', async () => {
    stub402([nativeAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.status).toBe('ready')
    expect(plan.payable).toBe(true)
    expect(plan.best?.state).toBe('payable')
    expect(plan.best?.accept.asset).toBe('native')
    expect(plan.best?.recipient.ready).toBe('n/a')
    expect(plan.fundingHint).toBeNull()
  })

  it('BLOCKED: insufficient native funds → shortfall + funding hint', async () => {
    net = baseNet({ balanceOf: async () => ({ token: 1000n, native: 1000n }) })
    stub402([nativeAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.status).toBe('blocked')
    expect(plan.best).toBeNull()
    expect(plan.options[0]!.blockers).toContain('INSUFFICIENT_TOKEN')
    expect(plan.options[0]!.shortfall?.token).toBeTruthy()
    expect(plan.fundingHint).toMatch(/top up/i)
  })

  it('BLOCKED: holds the token but no gas → INSUFFICIENT_GAS (distinct from funds)', async () => {
    net = baseNet({ balanceOf: async () => ({ token: 100_000_000n, native: 0n }) })
    stub402([usdcAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options[0]!.blockers).toContain('INSUFFICIENT_GAS')
    expect(plan.options[0]!.blockers).not.toContain('INSUFFICIENT_TOKEN')
    expect(plan.fundingHint).toMatch(/gas/i)
  })

  it('BLOCKED: recipient not ready → reason + fix + hint (the Algorand/Stellar class)', async () => {
    net = baseNet({ recipientReady: async () => ({ ready: false, reason: 'NO_TRUSTLINE' }) })
    stub402([usdcAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options[0]!.blockers).toContain('RECIPIENT_NOT_READY')
    expect(plan.options[0]!.recipient.reason).toBe('NO_TRUSTLINE')
    expect(plan.options[0]!.recipient.fix).toMatch(/trustline/i)
    expect(plan.fundingHint).toMatch(/receive/i)
  })

  it('BLOCKED: over the spend policy', async () => {
    stub402([nativeAccept()])
    const plan = (await client({ policy: { maxAmount: '0.01' } }).planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options[0]!.blockers).toContain('OUTSIDE_POLICY')
    expect(plan.fundingHint).toMatch(/policy/i)
  })

  it('UNKNOWN: balance read failed → not payable, warned, never a false "broke"', async () => {
    net = baseNet({ balanceOf: async () => ({ token: null, native: null }) })
    stub402([nativeAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.status).toBe('unknown')
    expect(plan.payable).toBe(false)
    expect(plan.options[0]!.state).toBe('unknown')
    expect(plan.options[0]!.warnings).toContain('BALANCE_UNREADABLE')
    expect(plan.options[0]!.blockers).toEqual([])
    expect(plan.fundingHint).toMatch(/retry/i)
  })

  it('BLOCKED: no rail on this chain → explains (does NOT throw NoCompatibleAccept)', async () => {
    stub402([nativeAccept({ network: 'solana:xyz' })])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options).toEqual([])
    expect(plan.fundingHint).toMatch(/offered on/i)
  })

  it('returns null when the URL is not gated; canAfford → true', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    expect(await client().planPayment(URL)).toBeNull()
    expect(await client().canAfford(URL)).toBe(true)
  })

  it('RANKING: cheapest-gas payable rail wins (within the same native coin)', async () => {
    // token rail listed first (fee 200), native second (fee 100); both payable.
    stub402([usdcAccept(), nativeAccept()])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(true)
    expect(plan.best?.accept.asset).toBe('native')
    expect(plan.options.map((o) => o.state)).toEqual(['payable', 'payable'])
  })

  it('symbol mismatch surfaces as a warning (not a block)', async () => {
    // server lies: stated symbol USDT for an asset the SDK knows as USDC.
    stub402([usdcAccept({ extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDT' } })])
    const plan = (await client().planPayment(URL))!
    expect(plan.payable).toBe(true)
    expect(plan.best?.warnings).toContain('SYMBOL_MISMATCH')
  })
})

describe('fetch autoRoute (opt-in)', () => {
  it('pays the affordable rail → 200', async () => {
    stub402([nativeAccept()], () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const res = await client({ autoRoute: true }).fetch(URL)
    expect(res.status).toBe(200)
  })

  it('throws PaymentDeclinedError with the funding hint when nothing is settleable', async () => {
    net = baseNet({ balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([nativeAccept()], () => new Response('{}', { status: 200 }))
    const err = await client({ autoRoute: true })
      .fetch(URL)
      .catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(String(err.message)).toMatch(/top up|gas|settle/i)
  })

  it('default fetch (autoRoute off) is unchanged — pays without reading balances', async () => {
    // balanceOf would say "broke", but default fetch never calls it → still pays.
    net = baseNet({ balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([nativeAccept()], () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const res = await client().fetch(URL)
    expect(res.status).toBe(200)
  })
})

describe('planAcross — cross-chain merge', () => {
  it('merges per-client plans, payable-first', async () => {
    stub402([nativeAccept()])
    const plan = (await planAcross([client(), client()], URL))!
    expect(plan.payable).toBe(true)
    expect(plan.best).not.toBeNull()
    expect(plan.options.length).toBe(2) // both clients' rails merged
  })

  it('returns null when not gated for any client', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    expect(await planAcross([client(), client()], URL)).toBeNull()
  })
})
