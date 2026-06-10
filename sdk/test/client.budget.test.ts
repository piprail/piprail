import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  PipRailClient,
  paymentTools,
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  PaymentDeclinedError,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

const NETWORK = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'
const KEY = { secret: 'x' }

// A fake driver whose `send` is spied so we can assert NO funds move on a refusal.
const sendSpy = vi.fn(async () => 'ref')
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: sendSpy,
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 1_000_000_000n, native: 1_000_000_000n }),
  recipientReady: async () => ({ ready: 'n/a' as const }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'y' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  sendSpy.mockClear()
})

function challengeBody(amount = '500000') {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount,
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
  return { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [accept] }
}

function stubPay(amount = '500000') {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature')) {
      return new Response('{}', {
        status: 200,
        headers: {
          'payment-response': buildReceiptHeader({
            scheme: 'onchain-proof', success: true, network: NETWORK, transaction: 'ref',
            asset: 'native', amount, payer: 'GPAYER', payTo: 'GMERCHANT', verifiedAt: '2026-06-02T00:00:00.000Z',
          }),
        },
      })
    }
    const b = challengeBody(amount)
    return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
  }) as typeof fetch
}

const mk = (over: Record<string, unknown> = {}) =>
  new PipRailClient({ chain: 'stellar', wallet: KEY, ...over })

describe('PipRailClient construction guards (time policy)', () => {
  it('rejects a half-armed rolling window (one bound without the other)', () => {
    expect(() => mk({ policy: { windowTotal: '1' } })).toThrow(TypeError)
    expect(() => mk({ policy: { windowSeconds: 60 } })).toThrow(/together/)
  })
  it('rejects a non-positive or overflowing ttlSeconds', () => {
    expect(() => mk({ policy: { ttlSeconds: 0 } })).toThrow(TypeError)
    expect(() => mk({ policy: { ttlSeconds: -5 } })).toThrow(TypeError)
    expect(() => mk({ policy: { ttlSeconds: Number.MAX_SAFE_INTEGER } })).toThrow(/safe integer/)
  })
  it('accepts a well-formed time policy', () => {
    expect(() => mk({ policy: { ttlSeconds: 100, windowTotal: '1', windowSeconds: 60 } })).not.toThrow()
  })
})

describe('client.remaining() — ledger-bucket-scoped, per (network,asset)', () => {
  it('a fresh client returns [] even WITH maxTotal set (decimals unknown until first spend)', () => {
    expect(mk({ policy: { maxTotal: '1.00' } }).remaining()).toEqual([])
  })

  it('reports the remaining cap after a recorded spend, and decreases', async () => {
    stubPay()
    const c = mk({ policy: { maxTotal: '1.00' } })
    await c.get(RESOURCE)
    const rows = c.remaining()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      network: NETWORK, asset: 'native', spentBase: '500000',
      capBase: '10000000', remainingBase: '9500000', remainingFormatted: '0.95',
    })
  })

  it('leaves cap/remaining undefined when no maxTotal is set (unbounded)', async () => {
    stubPay()
    const c = mk()
    await c.get(RESOURCE)
    const row = c.remaining()[0]!
    expect(row.spentBase).toBe('500000')
    expect(row.capBase).toBeUndefined()
    expect(row.remainingBase).toBeUndefined()
  })
})

describe('client.budget() — the Mode-A leash surface', () => {
  it('reports the session time envelope (ISO + clamped secondsRemaining)', () => {
    const c = mk({ policy: { expiresAt: Date.now() + 3_600_000 } })
    const b = c.budget()
    expect(typeof b.session.start).toBe('string')
    expect(typeof b.session.expiresAt).toBe('string')
    expect(b.session.secondsRemaining!).toBeGreaterThan(0)
    expect(b.byAsset).toEqual([]) // no spend yet
  })
  it('clamps secondsRemaining at 0 for an already-past deadline (no negative leak)', () => {
    const c = mk({ policy: { expiresAt: Date.now() - 10_000 } })
    expect(c.budget().session.secondsRemaining).toBe(0)
  })
  it('has null session fields when no time policy is set', () => {
    const b = mk().budget()
    expect(b.session.expiresAt).toBeNull()
    expect(b.session.secondsRemaining).toBeNull()
  })
})

describe('session TTL / expiry — end to end (no funds move past the deadline)', () => {
  it('pays before the deadline', async () => {
    stubPay()
    const c = mk({ policy: { expiresAt: Date.now() + 60_000 } })
    const res = await c.get(RESOURCE)
    expect(res.status).toBe(200)
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses after the deadline with reasonCode SESSION_EXPIRED, and never sends', async () => {
    stubPay()
    const c = mk({ policy: { expiresAt: Date.now() - 1_000 } })
    await expect(c.get(RESOURCE)).rejects.toMatchObject({
      code: 'PAYMENT_DECLINED',
      reasonCode: 'SESSION_EXPIRED',
    })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('a quote flips withinPolicy false once expired', async () => {
    stubPay()
    const c = mk({ policy: { expiresAt: Date.now() - 1_000 } })
    const q = await c.quote(RESOURCE)
    expect(q?.withinPolicy).toBe(false)
    expect(q?.policyCode).toBe('SESSION_EXPIRED')
  })
})

describe('rolling window — across pays', () => {
  it('refuses the pay that would breach the window (reasonCode OUTSIDE_WINDOW)', async () => {
    stubPay() // each pay is 500000 base (0.05)
    const c = mk({ policy: { windowTotal: '0.08', windowSeconds: 3600 } }) // cap 800000 base
    await c.get(RESOURCE) // 1st: window now 500000
    await expect(c.get(RESOURCE)).rejects.toMatchObject({
      code: 'PAYMENT_DECLINED',
      reasonCode: 'OUTSIDE_WINDOW',
    })
    expect(sendSpy).toHaveBeenCalledTimes(1) // only the first actually sent
  })
})

describe('the pay tool surfaces a terminal expiry to the agent', () => {
  it('returns { declined:true, reasonCode:SESSION_EXPIRED, code:PAYMENT_DECLINED }', async () => {
    stubPay()
    const c = mk({ policy: { expiresAt: Date.now() - 1_000 } })
    const payTool = paymentTools(c).find((t) => t.name === 'piprail_pay_request')!
    const out = (await payTool.invoke({ url: RESOURCE })) as Record<string, unknown>
    expect(out).toMatchObject({ declined: true, reasonCode: 'SESSION_EXPIRED', code: 'PAYMENT_DECLINED' })
    expect(typeof out.explain).toBe('string')
  })
})

// Keep PaymentDeclinedError import meaningful (type-only usage above is via matchObject).
describe('PaymentDeclinedError carries reasonCode', () => {
  it('constructs with a reasonCode', () => {
    const e = new PaymentDeclinedError('x', { reasonCode: 'APPROVAL' })
    expect(e.reasonCode).toBe('APPROVAL')
    expect(e.code).toBe('PAYMENT_DECLINED')
  })
})
