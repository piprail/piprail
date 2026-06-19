import { describe, it, expect } from 'vitest'
import { SpendLedger, memorySpendStore, DENOM_PRECISION, type SpendRecord } from '../src/index.js'

const rec = (over: Partial<SpendRecord> = {}): SpendRecord => ({
  url: 'https://api.example.com/r',
  host: 'api.example.com',
  network: 'eip155:8453',
  asset: '0xusdc',
  amountBase: '50000',
  amountFormatted: '0.05',
  symbol: 'USDC',
  ref: '0xabc',
  at: '2026-06-02T00:00:00.000Z',
  ...over,
})

describe('SpendLedger — denomination grand total (cross-token)', () => {
  it('sums human-value across DIFFERENT-decimal tokens of the same denomination', () => {
    const l = new SpendLedger()
    // 0.05 USDC (6dp) on Base
    l.record(rec(), 6, 'USD')
    // 0.05 USDT (6dp) on BNB — different chain, different token, same unit
    l.record(rec({ network: 'eip155:56', asset: '0xusdt', symbol: 'USDT', ref: '0x2' }), 6, 'USD')
    // 0.05 of an 18dp USD stablecoin — different decimals entirely
    l.record(
      rec({ network: 'eip155:1', asset: '0xdai', symbol: 'DAI', amountBase: '50000000000000000', ref: '0x3' }),
      18,
      'USD'
    )
    // 0.15 USD total, exact, scaled to DENOM_PRECISION
    const expected = 150_000n * 10n ** BigInt(DENOM_PRECISION - 6)
    expect(l.totalForDenom('USD')).toBe(expected)
    expect(l.totalForDenom('usd')).toBe(expected) // case-insensitive
    expect(l.totalForDenom('EUR')).toBe(0n) // never spent
  })

  it('surfaces byDenom in the summary (formatted, with a count) and keeps per-asset rows', () => {
    const l = new SpendLedger()
    l.record(rec(), 6, 'USD')
    l.record(rec({ asset: '0xusdt', symbol: 'USDT', ref: '0x2' }), 6, 'USD')
    const s = l.summary()
    expect(s.count).toBe(2)
    expect(s.byAsset).toHaveLength(2) // still per (network,asset)
    expect(s.byDenom).toHaveLength(1)
    expect(s.byDenom[0]).toMatchObject({ denom: 'USD', totalFormatted: '0.1', count: 2 })
  })

  it('a record with NO denom contributes to count + byAsset but not any grand total', () => {
    const l = new SpendLedger()
    l.record(rec({ asset: 'native', symbol: 'ETH' }), 18) // no denom arg
    expect(l.summary().byDenom).toEqual([])
    expect(l.count()).toBe(1)
  })
})

describe('SpendLedger — payment counts', () => {
  it('count() is the total settled; countSince() slices by time (cross-token)', () => {
    const l = new SpendLedger()
    l.record(rec({ at: '2026-06-02T00:00:00.000Z' }), 6, 'USD') // early
    l.record(rec({ at: '2026-06-02T00:10:00.000Z', asset: '0xusdt', ref: '0x2' }), 6, 'USD') // late
    expect(l.count()).toBe(2)
    const since = Date.parse('2026-06-02T00:05:00.000Z')
    expect(l.countSince(since)).toBe(1) // only the later one
    expect(l.countSince(0)).toBe(2)
  })
})

describe('SpendLedger — durable store (hydrate + append)', () => {
  it('hydrates buckets, denom totals, and count from store.load()', () => {
    const seed: SpendRecord[] = [
      rec({ decimals: 6, denom: 'USD' }),
      rec({ asset: '0xusdt', symbol: 'USDT', ref: '0x2', decimals: 6, denom: 'USD' }),
    ]
    const l = new SpendLedger(memorySpendStore(seed))
    expect(l.count()).toBe(2)
    expect(l.totalFor('eip155:8453', '0xusdc')).toBe(50_000n)
    expect(l.totalForDenom('USD')).toBe(100_000n * 10n ** BigInt(DENOM_PRECISION - 6))
  })

  it('appends every settled payment to the store (round-trips to a fresh ledger)', () => {
    const store = memorySpendStore()
    const a = new SpendLedger(store)
    a.record(rec(), 6, 'USD')
    a.record(rec({ asset: '0xusdt', symbol: 'USDT', ref: '0x2' }), 6, 'USD')
    // A brand-new ledger over the SAME store resumes the totals (restart-survival).
    const b = new SpendLedger(store)
    expect(b.count()).toBe(2)
    expect(b.totalForDenom('USD')).toBe(100_000n * 10n ** BigInt(DENOM_PRECISION - 6))
    // The persisted record carries decimals + denom for an exact rebuild.
    expect(b.summary().records[0]).toMatchObject({ decimals: 6, denom: 'USD' })
  })

  it('never throws when the store misbehaves (load or append)', () => {
    const bad = {
      load: () => {
        throw new Error('disk gone')
      },
      append: () => {
        throw new Error('disk full')
      },
    }
    const l = new SpendLedger(bad)
    expect(l.count()).toBe(0) // load failed → empty, not a crash
    expect(() => l.record(rec(), 6, 'USD')).not.toThrow() // append failed → swallowed
    expect(l.totalForDenom('USD')).toBe(50_000n * 10n ** BigInt(DENOM_PRECISION - 6)) // in-memory tally still updated
  })
})

describe('SpendLedger — crash-safe against a POISONED store (adversarial regression)', () => {
  // A SpendStore is caller-owned (a tampered/corrupt/future-version JSONL file), so a
  // hydrated record can carry anything. None of it may crash construction or a read.
  const poison = (over: Record<string, unknown>): SpendRecord =>
    ({ ...rec(), ...over }) as unknown as SpendRecord

  it('skips records with a non-numeric / float / non-string amountBase (constructor never throws)', () => {
    for (const amountBase of ['not-a-number', '1e6', '0x5', '-1', 0.5, 5, null, undefined]) {
      const store = memorySpendStore([poison({ amountBase })])
      let l: SpendLedger | undefined
      expect(() => { l = new SpendLedger(store) }).not.toThrow()
      expect(l!.count()).toBe(0) // the corrupt record was skipped, not tallied
    }
  })

  it('skips records with out-of-range decimals (-1, 200) — reads NEVER throw', () => {
    for (const decimals of [-1, 200, 1.5, Number.NaN]) {
      const l = new SpendLedger(memorySpendStore([poison({ decimals })]))
      expect(l.count()).toBe(0)
      expect(() => l.summary()).not.toThrow()
      expect(() => l.summary().byDenom).not.toThrow()
    }
  })

  it('a NON-STRING denom never throws out of construction or reads (coerced to no-denomination)', () => {
    // A tampered/future-version line could have denom = number/object/array — denom.toUpperCase()
    // would otherwise crash the constructor. The record still tallies per-asset; the denom is dropped.
    for (const denom of [5, {}, ['USD'], true]) {
      let l: SpendLedger | undefined
      expect(() => { l = new SpendLedger(memorySpendStore([poison({ amountBase: '50000', decimals: 6, denom })])) }).not.toThrow()
      expect(l!.count()).toBe(1) // valid amountBase/decimals → still counted
      expect(l!.summary().byDenom).toEqual([]) // bad denom dropped, no grand total
      expect(l!.totalForDenom('USD')).toBe(0n)
    }
  })

  it('a mix of good + poisoned records keeps ONLY the good ones (totals stay exact)', () => {
    // Hydration reads decimals + denom OFF each record, so the good ones carry them.
    const l = new SpendLedger(memorySpendStore([
      rec({ ref: 'good1', decimals: 6, denom: 'USD' }),
      poison({ amountBase: 'JUNK', ref: 'bad1' }),
      rec({ asset: '0xusdt', symbol: 'USDT', ref: 'good2', decimals: 6, denom: 'USD' }),
      poison({ decimals: 999, ref: 'bad2' }),
    ]))
    expect(l.count()).toBe(2)
    expect(l.totalForDenom('USD')).toBe(100_000n * 10n ** BigInt(DENOM_PRECISION - 6)) // 0.05 + 0.05
  })

  it('countSince/totalSince fail CLOSED on an unparseable `at` (counts it, never silently drops)', () => {
    const l = new SpendLedger(memorySpendStore([
      rec({ at: 'not-a-date', decimals: 6, denom: 'USD' }),
      rec({ ref: 'r2', decimals: 6, denom: 'USD' }),
    ]))
    expect(l.count()).toBe(2)
    expect(l.countSince(0)).toBe(2) // the bad-`at` record is counted, not dropped (no NaN-compare hole)
    expect(l.totalForDenom('USD')).toBe(100_000n * 10n ** BigInt(DENOM_PRECISION - 6))
  })
})
