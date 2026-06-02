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
