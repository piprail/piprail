import { describe, expect, test } from 'vitest'
import { chainWarnings, formatBanner } from '../src/banner.js'
import type { Config } from '../src/config.js'

const cfg = (over: Partial<Config> = {}): Config => ({
  chain: 'base',
  walletSecret: 'SECRET',
  maxAmount: '0.10',
  maxTotal: '10.00',
  tokens: ['USDC'],
  allowUnknownTokens: false,
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
})
