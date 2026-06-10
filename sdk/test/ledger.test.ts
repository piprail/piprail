import { describe, it, expect } from 'vitest'
import { SpendLedger } from '../src/ledger.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const base = (over: Record<string, unknown> = {}) => ({
  url: 'https://api.example.com/r',
  host: 'api.example.com',
  network: 'eip155:8453' as const,
  asset: USDC,
  amountBase: '50000',
  amountFormatted: '0.05',
  symbol: 'USDC',
  ref: '0xabc',
  at: '2026-06-02T00:00:00.000Z',
  ...over,
})

describe('SpendLedger', () => {
  it('aggregates repeated payments of the same asset', () => {
    const l = new SpendLedger()
    l.record(base(), 6)
    l.record(base({ amountBase: '30000', amountFormatted: '0.03', ref: '0xdef' }), 6)

    expect(l.totalFor('eip155:8453', USDC)).toBe(80_000n)
    const s = l.summary()
    expect(s.count).toBe(2)
    expect(s.byAsset).toHaveLength(1)
    expect(s.byAsset[0]).toMatchObject({
      asset: USDC,
      symbol: 'USDC',
      decimals: 6,
      totalBase: '80000',
      totalFormatted: '0.08',
      count: 2,
    })
    expect(s.records).toHaveLength(2)
  })

  it('keeps distinct assets in separate buckets', () => {
    const l = new SpendLedger()
    l.record(base(), 6)
    l.record(base({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'mint', symbol: 'SOL', amountBase: '1000000000', amountFormatted: '1' }), 9)
    expect(l.summary().byAsset).toHaveLength(2)
    expect(l.totalFor('eip155:8453', USDC)).toBe(50_000n)
    expect(l.totalFor('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'mint')).toBe(1_000_000_000n)
  })

  it('returns 0 for an asset never paid', () => {
    expect(new SpendLedger().totalFor('eip155:1', 'native')).toBe(0n)
  })
})

describe('SpendLedger — totalSince (rolling-window source)', () => {
  it('includes records at/after sinceMs, excludes earlier, scoped to (network,asset)', () => {
    const l = new SpendLedger()
    l.record(base({ at: '2026-06-02T00:00:00.000Z', amountBase: '10000' }), 6) // early
    l.record(base({ at: '2026-06-02T00:10:00.000Z', amountBase: '20000', ref: '0x2' }), 6) // late
    const since = Date.parse('2026-06-02T00:05:00.000Z')
    expect(l.totalSince('eip155:8453', USDC, since)).toBe(20_000n) // only the later
    expect(l.totalSince('eip155:8453', USDC, 0)).toBe(30_000n) // both
    expect(l.totalSince('eip155:8453', '0xother', since)).toBe(0n) // different asset
  })

  it('a record exactly AT sinceMs is included (>=)', () => {
    const l = new SpendLedger()
    l.record(base({ at: '2026-06-02T00:00:00.000Z' }), 6)
    expect(l.totalSince('eip155:8453', USDC, Date.parse('2026-06-02T00:00:00.000Z'))).toBe(50_000n)
  })
})

describe('SpendLedger — sessionStart + buckets_', () => {
  it('sessionStart is a stable number set once at construction', () => {
    const l = new SpendLedger()
    const s = l.sessionStart
    expect(typeof s).toBe('number')
    l.record(base(), 6)
    expect(l.sessionStart).toBe(s)
  })

  it('assetBuckets exposes (network, asset, decimals, totalBase) tuples', () => {
    const l = new SpendLedger()
    l.record(base(), 6)
    expect(l.assetBuckets()).toEqual([
      { network: 'eip155:8453', asset: USDC, symbol: 'USDC', decimals: 6, totalBase: 50_000n },
    ])
    expect(new SpendLedger().assetBuckets()).toEqual([]) // a fresh ledger has no buckets
  })
})
