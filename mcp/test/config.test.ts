import { describe, expect, test } from 'vitest'
import {
  parseConfig,
  configToClientOptions,
  walletInputFor,
  ConfigError,
  type Config,
} from '../src/config.js'

const KEY = '0x' + '1'.repeat(64)

describe('parseConfig — requirements & defaults', () => {
  test('requires a wallet key', () => {
    expect(() => parseConfig({})).toThrow(ConfigError)
    expect(() => parseConfig({})).toThrow(/PIPRAIL_PRIVATE_KEY/)
  })

  test('AGENT_KEY alias alone satisfies the key requirement', () => {
    const cfg = parseConfig({ AGENT_KEY: KEY })
    expect(cfg.walletSecret).toBe(KEY)
    expect(cfg.keySource).toBe('AGENT_KEY')
  })

  test('PIPRAIL_WALLET_KEY is also accepted', () => {
    expect(parseConfig({ PIPRAIL_WALLET_KEY: KEY }).keySource).toBe('PIPRAIL_WALLET_KEY')
  })

  test('applies safe defaults when only the key is set', () => {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY })
    expect(cfg.chain).toBe('base')
    expect(cfg.maxAmount).toBe('0.10')
    expect(cfg.maxTotal).toBe('10.00')
    expect(cfg.tokens).toEqual(['USDC'])
    expect(cfg.allowUnknownTokens).toBe(false)
    expect(cfg.hosts).toBeUndefined()
    expect(cfg.rpcUrl).toBeUndefined()
  })
})

describe('parseConfig — coercion', () => {
  test('coerces CSV tokens + hosts (trimming blanks)', () => {
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: KEY,
      PIPRAIL_TOKENS: 'USDC, USDT ,EURC',
      PIPRAIL_HOSTS: 'api.x.com,*.y.com',
    })
    expect(cfg.tokens).toEqual(['USDC', 'USDT', 'EURC'])
    expect(cfg.hosts).toEqual(['api.x.com', '*.y.com'])
  })

  test('parses allowUnknownTokens truthily', () => {
    const on = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_ALLOW_UNKNOWN_TOKENS: 'true' })
    const off = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_ALLOW_UNKNOWN_TOKENS: 'no' })
    expect(on.allowUnknownTokens).toBe(true)
    expect(off.allowUnknownTokens).toBe(false)
  })
})

describe('parseConfig — fail-fast validation', () => {
  test('rejects an unknown PIPRAIL_* var (typo guard)', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMONT: '1' })).toThrow(
      /Unknown PipRail config var/
    )
  })

  test('rejects a non-decimal budget', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_MAX_AMOUNT: 'lots' })).toThrow(
      /decimal/
    )
  })

  test('rejects a malformed RPC URL', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_RPC_URL: 'not-a-url' })).toThrow(
      /URL/
    )
  })

  test('rejects an unknown chain', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'dogecoin' })).toThrow(
      /Unknown chain/
    )
  })

  test('near requires an account id', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'near' })).toThrow(
      /PIPRAIL_NEAR_ACCOUNT_ID/
    )
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: KEY,
      PIPRAIL_CHAIN: 'near',
      PIPRAIL_NEAR_ACCOUNT_ID: 'you.near',
    })
    expect(cfg.nearAccountId).toBe('you.near')
  })
})

describe('walletInputFor — per-family mapping', () => {
  const mk = (chain: string, extra: Partial<Config> = {}): Config => ({
    chain,
    walletSecret: 'SECRET',
    maxAmount: '0.10',
    maxTotal: '10.00',
    tokens: ['USDC'],
    allowUnknownTokens: false,
    keySource: 'PIPRAIL_PRIVATE_KEY',
    ...extra,
  })

  test('EVM / Tron / Sui / Aptos → { privateKey }', () => {
    for (const c of ['base', 'ethereum', 'tron', 'sui', 'aptos']) {
      expect(walletInputFor(mk(c))).toEqual({ privateKey: 'SECRET' })
    }
  })
  test('Solana → { secretKey }', () => {
    expect(walletInputFor(mk('solana'))).toEqual({ secretKey: 'SECRET' })
  })
  test('TON / Algorand → { mnemonic }', () => {
    expect(walletInputFor(mk('ton'))).toEqual({ mnemonic: 'SECRET' })
    expect(walletInputFor(mk('algorand'))).toEqual({ mnemonic: 'SECRET' })
  })
  test('Stellar → { secret }, XRPL → { seed }', () => {
    expect(walletInputFor(mk('stellar'))).toEqual({ secret: 'SECRET' })
    expect(walletInputFor(mk('xrpl'))).toEqual({ seed: 'SECRET' })
  })
  test('NEAR → { accountId, privateKey }', () => {
    expect(walletInputFor(mk('near', { nearAccountId: 'you.near' }))).toEqual({
      accountId: 'you.near',
      privateKey: 'SECRET',
    })
  })
})

describe('configToClientOptions', () => {
  test('maps the budget → policy and chain/wallet onto the client options', () => {
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: KEY,
      PIPRAIL_CHAIN: 'base',
      PIPRAIL_MAX_AMOUNT: '0.5',
      PIPRAIL_MAX_TOTAL: '20',
      PIPRAIL_TOKENS: 'USDC,USDT',
      PIPRAIL_HOSTS: 'api.x.com',
    })
    const opts = configToClientOptions(cfg)
    expect(opts.chain).toBe('base')
    expect(opts.wallet).toEqual({ privateKey: KEY })
    expect(opts.policy).toEqual({
      maxAmount: '0.5',
      maxTotal: '20',
      tokens: ['USDC', 'USDT'],
      allowUnknownTokens: false,
      hosts: ['api.x.com'],
    })
    expect(opts.rpcUrl).toBeUndefined()
  })
})

describe('parseConfig — chain-aware default token', () => {
  test('Tron defaults to USDT (no native USDC on Tron)', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'tron' }).tokens).toEqual(['USDT'])
  })
  test('TON defaults to USDT (no native USDC on TON)', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'ton' }).tokens).toEqual(['USDT'])
  })
  test('every other chain defaults to USDC', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base' }).tokens).toEqual(['USDC'])
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'solana' }).tokens).toEqual(['USDC'])
  })
  test('an explicit PIPRAIL_TOKENS overrides the chain default', () => {
    expect(
      parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'tron', PIPRAIL_TOKENS: 'USDT,TRX' }).tokens
    ).toEqual(['USDT', 'TRX'])
  })
})
