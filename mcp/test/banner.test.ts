import { describe, expect, test } from 'vitest'
import { chainWarnings, formatBanner } from '../src/banner.js'
import type { Config } from '../src/config.js'

const cfg = (over: Partial<Config> = {}): Config => ({
  chain: 'base',
  walletSecret: 'SECRET',
  readOnly: false,
  maxAmount: '0.10',
  maxTotal: '10.00',
  tokens: ['USDC'],
  allowUnknownTokens: false,
  confirm: false,
  guide: true,
  keySource: 'PIPRAIL_PRIVATE_KEY',
  ...over,
})

describe('chainWarnings', () => {
  test('TON without a keyed RPC is warned', () => {
    expect(chainWarnings(cfg({ chain: 'ton' })).join(' ')).toMatch(/TON.*rate-limited/)
  })
  test('TON with an RPC set is silent', () => {
    expect(
      chainWarnings(cfg({ chain: 'ton', rpcUrl: 'https://toncenter.com/api/v2/jsonRPC?api_key=x' }))
    ).toEqual([])
  })
  test('Tron without a custom RPC is warned', () => {
    expect(chainWarnings(cfg({ chain: 'tron' })).join(' ')).toMatch(/Tron.*rate-limited/)
  })
  test('EVM chains have no caveat warnings', () => {
    expect(chainWarnings(cfg({ chain: 'base' }))).toEqual([])
  })
})

describe('formatBanner', () => {
  test('renders a notes block for caveat chains', () => {
    expect(formatBanner(cfg({ chain: 'tron', tokens: ['USDT'] }))).toContain('⚠ notes:')
  })
  test('no notes block for plain EVM', () => {
    expect(formatBanner(cfg())).not.toContain('⚠ notes:')
  })
  test('lists the two new read-only tools (budget + guide)', () => {
    const b = formatBanner(cfg())
    expect(b).toContain('piprail_budget')
    expect(b).toContain('piprail_guide')
  })
  test('shows the confirm row ONLY when confirm is on; never leaks a secret', () => {
    expect(formatBanner(cfg())).not.toMatch(/^\s*confirm/m)
    const on = formatBanner(cfg({ confirm: true }))
    expect(on).toMatch(/confirm/)
    expect(on).not.toContain('SECRET')
  })
  test('shows the time-envelope rows only when configured', () => {
    expect(formatBanner(cfg())).not.toMatch(/session ttl/)
    expect(formatBanner(cfg({ ttlSeconds: 3600 }))).toMatch(/session ttl\s+3600s/)
    expect(formatBanner(cfg({ windowTotal: '1.00', windowSeconds: 60 }))).toMatch(/rate window\s+1\.00 \/ 60s/)
  })
})
