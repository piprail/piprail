import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  PipRailClient,
  MultiChainPayer,
  SpendLedger,
  memorySpendStore,
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  type PipRailEvent,
  type ResolvedNetwork,
  type SpendRecord,
  type SessionBudget,
  type X402AcceptEntry,
  type Caip2,
} from '../src/index.js'

// Two heterogeneous fake chains, each recognising USDC + USDT stablecoins (→ USD denom)
// so we can prove the cross-token, cross-CHAIN grand total + the count caps + persistence.
const A: Caip2 = 'eip155:8453' // "chain A"
const B: Caip2 = 'eip155:56' // "chain B"
const URL = 'https://api.example.com/r'
const KEY = { key: '0xkey' }

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xusdc': { symbol: 'USDC', decimals: 6 },
  '0xusdt': { symbol: 'USDT', decimals: 6 },
  native: { symbol: 'ETH', decimals: 18 },
}

function mkNet(family: ResolvedNetwork['family'], network: Caip2): ResolvedNetwork {
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: () => ({ asset: '0xusdc', decimals: 6, symbol: 'USDC' }),
    describeAsset: (a) => TOKENS[a] ?? null,
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${network}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '1', feeFormatted: '0', basis: 'heuristic' }),
    balanceOf: async () => ({ token: 10_000_000n, native: 10_000_000_000_000_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
  }
}
registerDriver({ family: 'evm', resolve: (opts) => mkNet('evm', opts.chain === 'bnb' ? B : A) })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// Stub a payable endpoint on `network` for `asset` (0.05 @ 6dp = 50000 base).
function stubPay(network: Caip2, asset = '0xusdc', symbol = 'USDC', amount = '50000') {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature')) {
      return new Response('{}', {
        status: 200,
        headers: {
          'payment-response': buildReceiptHeader({
            scheme: 'onchain-proof', success: true, network, transaction: 'ref',
            asset, amount, payer: 'P', payTo: 'M', verifiedAt: '2026-06-02T00:00:00.000Z',
          }),
        },
      })
    }
    const accept: X402AcceptEntry = {
      scheme: 'onchain-proof', network, amount, asset, payTo: 'M', maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol },
    }
    const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts: [accept] }
    return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
  }) as typeof fetch
}

const mk = (over: Record<string, unknown> = {}) => new PipRailClient({ chain: 'base', wallet: KEY, ...over })

describe('maxTotalPerDenom — the cross-token grand total (one chain)', () => {
  it('refuses the payment that pushes total USD past the cap, ACROSS tokens', async () => {
    const c = mk({ policy: { maxTotalPerDenom: { USD: '0.08' } } })
    stubPay(A, '0xusdc', 'USDC')
    await c.get(URL) // 0.05 USDC → USD total 0.05
    stubPay(A, '0xusdt', 'USDT')
    await expect(c.get(URL)).rejects.toMatchObject({ code: 'PAYMENT_DECLINED', reasonCode: 'BUDGET' })
    // The grand total reads 0.05 (only the first settled); the second never moved funds.
    expect(c.budget().byDenom[0]).toMatchObject({ denom: 'USD', spentFormatted: '0.05', capFormatted: '0.08' })
  })

  it('byDenom is previewable BEFORE any spend (cap is a declared number)', () => {
    const b = mk({ policy: { maxTotalPerDenom: { USD: '20.00' } } }).budget()
    expect(b.byDenom).toEqual([
      { denom: 'USD', spentFormatted: '0', capFormatted: '20', remainingFormatted: '20', fraction: 0 },
    ])
  })

  it('a native-coin payment is untouched by the USD grand total', async () => {
    const c = mk({ policy: { maxTotalPerDenom: { USD: '0.01' } } })
    stubPay(A, 'native', 'ETH')
    const res = await c.get(URL)
    expect(res.status).toBe(200) // native has no denomination → cap doesn't apply
  })
})

describe('payment-count caps', () => {
  it('maxPayments refuses the (cap+1)-th payment with reasonCode BUDGET', async () => {
    const c = mk({ policy: { maxPayments: 1 } })
    stubPay(A)
    await c.get(URL)
    await expect(c.get(URL)).rejects.toMatchObject({ code: 'PAYMENT_DECLINED', reasonCode: 'BUDGET' })
    expect(c.budget().counts).toMatchObject({ settled: 1, lifetimeCap: 1, lifetimeRemaining: 0 })
  })

  it('maxPaymentsPerWindow refuses once the window is full (OUTSIDE_WINDOW)', async () => {
    const c = mk({ policy: { maxPaymentsPerWindow: 1, windowSeconds: 3600 } })
    stubPay(A)
    await c.get(URL)
    await expect(c.get(URL)).rejects.toMatchObject({ reasonCode: 'OUTSIDE_WINDOW' })
  })
})

describe('observability — policy(), onSpend, events', () => {
  it('policy() reads the configured leash back', () => {
    const p = { maxTotalPerDenom: { USD: '5' }, maxPayments: 10 }
    expect(mk({ policy: p }).policy()).toEqual(p)
    expect(mk().policy()).toBeUndefined()
  })

  it('onSpend fires after each settle with the record + post-payment budget', async () => {
    const seen: { record: SpendRecord; usd?: string }[] = []
    const c = mk({
      policy: { maxTotalPerDenom: { USD: '1' } },
      onSpend: (record: SpendRecord, budget: SessionBudget) =>
        seen.push({ record, usd: budget.byDenom[0]?.spentFormatted }),
    })
    stubPay(A)
    await c.get(URL)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.record).toMatchObject({ symbol: 'USDC', denom: 'USD', decimals: 6, amountFormatted: '0.05' })
    expect(seen[0]!.usd).toBe('0.05')
  })

  it('a decline emits BOTH payment-failed (legacy) and the rich payment-declined', async () => {
    const events: PipRailEvent[] = []
    const c = mk({ policy: { maxPayments: 1 }, onEvent: (e: PipRailEvent) => events.push(e) })
    stubPay(A)
    await c.get(URL) // settles
    await c.get(URL).catch(() => undefined) // declined (count cap)
    const declined = events.find((e) => e.kind === 'payment-declined')
    const failed = events.find((e) => e.kind === 'payment-failed')
    expect(failed).toBeTruthy() // back-compat preserved
    expect(declined).toBeTruthy()
    if (declined?.kind === 'payment-declined') {
      expect(declined.reasonCode).toBe('BUDGET')
      expect(declined.code).toBe('MAX_PAYMENTS')
      expect(declined.budget.counts.settled).toBe(1) // snapshot at refusal
      expect(declined.quote?.symbol).toBe('USDC')
    }
  })

  it('budget-threshold fires when spend crosses warnAtFraction (early warning)', async () => {
    const events: PipRailEvent[] = []
    // cap 0.08 USD, warn at 50%. One 0.05 payment = 62.5% → crosses.
    const c = mk({ policy: { maxTotalPerDenom: { USD: '0.08' }, warnAtFraction: 0.5 }, onEvent: (e: PipRailEvent) => events.push(e) })
    stubPay(A)
    await c.get(URL)
    const warn = events.find((e) => e.kind === 'budget-threshold')
    expect(warn).toBeTruthy()
    if (warn?.kind === 'budget-threshold') {
      expect(warn.scope).toBe('denom')
      expect(warn.label).toBe('USD')
      expect(warn.fraction).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe('durable spend store — budget survives a "restart"', () => {
  it('a fresh client over the same store resumes the grand total', async () => {
    const store = memorySpendStore()
    const c1 = mk({ policy: { maxTotalPerDenom: { USD: '0.08' } }, spendStore: store })
    stubPay(A)
    await c1.get(URL) // 0.05 USD persisted

    // Simulate a restart: a brand-new client over the SAME store.
    const c2 = mk({ policy: { maxTotalPerDenom: { USD: '0.08' } }, spendStore: store })
    expect(c2.budget().byDenom[0]).toMatchObject({ spentFormatted: '0.05', remainingFormatted: '0.03' })
    // And the cap is enforced against the RESUMED total.
    stubPay(A, '0xusdt', 'USDT')
    await expect(c2.get(URL)).rejects.toMatchObject({ reasonCode: 'BUDGET' })
  })

  it('passing BOTH a shared ledger and a spendStore throws', () => {
    expect(() => mk({ ledger: new SpendLedger(), spendStore: memorySpendStore() })).toThrow(TypeError)
  })
})

describe('shared ledger — ONE budget across chains', () => {
  it('a USD grand total spans both chains (MultiChainPayer.fromWallets)', async () => {
    const payer = MultiChainPayer.fromWallets({
      wallets: { base: KEY, bnb: KEY },
      policy: { maxTotalPerDenom: { USD: '0.08' } },
    })
    // Pay 0.05 USDC on chain A (base).
    stubPay(A, '0xusdc', 'USDC')
    await payer.clients[0]!.get(URL)
    // The SHARED budget already reflects it across the whole payer.
    expect(payer.budget().byDenom[0]).toMatchObject({ denom: 'USD', spentFormatted: '0.05' })
    // A 0.05 USDT payment on chain B would breach the SHARED $0.08 cap → refused.
    stubPay(B, '0xusdt', 'USDT')
    const q = await payer.clients[1]!.quote(URL)
    expect(q?.withinPolicy).toBe(false)
    expect(q?.policyCode).toBe('MAX_TOTAL_DENOM')
  })
})

describe('construction validation — new caps fail loudly', () => {
  it('rejects a malformed denom cap', () => {
    expect(() => mk({ policy: { maxTotalPerDenom: { USD: '5abc' } } })).toThrow(TypeError)
    expect(() => mk({ policy: { maxTotalPerDenom: 'nope' as unknown as Record<string, string> } })).toThrow(TypeError)
  })
  it('rejects non-positive counts and a window count without windowSeconds', () => {
    expect(() => mk({ policy: { maxPayments: 0 } })).toThrow(TypeError)
    expect(() => mk({ policy: { maxPayments: 1.5 } })).toThrow(TypeError)
    expect(() => mk({ policy: { maxPaymentsPerWindow: 5 } })).toThrow(/windowSeconds/)
  })
  it('rejects warnAtFraction outside (0, 1]', () => {
    expect(() => mk({ policy: { warnAtFraction: 0 } })).toThrow(TypeError)
    expect(() => mk({ policy: { warnAtFraction: 1.5 } })).toThrow(TypeError)
    expect(() => mk({ policy: { warnAtFraction: 0.8 } })).not.toThrow()
  })
  it('a count-only rolling window (no windowTotal) is allowed', () => {
    expect(() => mk({ policy: { maxPaymentsPerWindow: 5, windowSeconds: 60 } })).not.toThrow()
  })
})
