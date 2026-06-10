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
    // No-boot regression: the boolean knobs default WITHOUT a ZodError on a zero-config boot.
    expect(cfg.confirm).toBe(false)
    expect(cfg.guide).toBe(true)
    expect(cfg.ttlSeconds).toBeUndefined()
    expect(cfg.windowTotal).toBeUndefined()
    expect(cfg.confirmTimeoutMs).toBeUndefined()
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
    confirm: false,
    guide: true,
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

  test('omits `schemes` when PIPRAIL_SCHEMES is unset (zero-config posture byte-identical)', () => {
    const opts = configToClientOptions(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }))
    expect('schemes' in opts).toBe(false)
  })

  test('surfaces `schemes` when PIPRAIL_SCHEMES is set', () => {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_SCHEMES: 'onchain-proof,exact' })
    expect(cfg.schemes).toEqual(['onchain-proof', 'exact'])
    expect(configToClientOptions(cfg).schemes).toEqual(['onchain-proof', 'exact'])
  })
})

describe('parseConfig — PIPRAIL_SCHEMES', () => {
  test('parses + lowercases + dedupes a comma-separated list', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_SCHEMES: ' EXACT , exact ,onchain-proof' }).schemes).toEqual([
      'exact',
      'onchain-proof',
    ])
  })

  test('rejects an unknown scheme with a clear error', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_SCHEMES: 'exact,bogus' })).toThrow(
      /Invalid PIPRAIL_SCHEMES/
    )
  })

  test('rejects an empty value', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_SCHEMES: ' , ' })).toThrow(
      /Invalid PIPRAIL_SCHEMES/
    )
  })

  test('is absent by default (so the SDK default — onchain-proof only — holds)', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }).schemes).toBeUndefined()
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

describe('parseConfig — time envelope (PIPRAIL_TTL + rolling window)', () => {
  test('PIPRAIL_TTL parses to an integer ttlSeconds', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_TTL: '3600' }).ttlSeconds).toBe(3600)
  })
  test('a non-integer / zero / negative TTL is rejected', () => {
    for (const v of ['0', '-5', '1.5', 'lots']) {
      expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_TTL: v })).toThrow(ConfigError)
    }
  })
  test('a TTL beyond 10 years is rejected', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_TTL: '999999999' })).toThrow(/seconds/)
  })
  test('window needs BOTH bounds — one alone is a ConfigError', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_WINDOW_TOTAL: '1.00' })).toThrow(/together/)
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_WINDOW_SECONDS: '60' })).toThrow(/together/)
  })
  test('both bounds set → windowTotal + windowSeconds', () => {
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: KEY,
      PIPRAIL_WINDOW_TOTAL: '1.00',
      PIPRAIL_WINDOW_SECONDS: '60',
    })
    expect(cfg.windowTotal).toBe('1.00')
    expect(cfg.windowSeconds).toBe(60)
  })
  test('neither set → both omitted (byte-identical posture)', () => {
    const cfg = parseConfig({ PIPRAIL_PRIVATE_KEY: KEY })
    expect(cfg.windowTotal).toBeUndefined()
    expect(cfg.windowSeconds).toBeUndefined()
  })
})

describe('parseConfig — PIPRAIL_CONFIRM (Mode B) + PIPRAIL_CONFIRM_TIMEOUT_MS', () => {
  test('default off; truthy/falsy parse', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }).confirm).toBe(false)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM: '1' }).confirm).toBe(true)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM: 'yes' }).confirm).toBe(true)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM: 'no' }).confirm).toBe(false)
  })
  test('a typo PIPRAIL_CONFIRMM is rejected by the typo guard', () => {
    expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRMM: '1' })).toThrow(/Unknown PipRail config var/)
  })
  test('PIPRAIL_CONFIRM_TIMEOUT_MS: positive int parses; junk rejected; absent omitted', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM_TIMEOUT_MS: '30000' }).confirmTimeoutMs).toBe(30000)
    for (const v of ['0', '-1', '1.5', 'soon']) {
      expect(() => parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM_TIMEOUT_MS: v })).toThrow(ConfigError)
    }
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }).confirmTimeoutMs).toBeUndefined()
  })
})

describe('parseConfig — PIPRAIL_GUIDE (default on)', () => {
  test('default on; can be turned off', () => {
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }).guide).toBe(true)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_GUIDE: '0' }).guide).toBe(false)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_GUIDE: 'false' }).guide).toBe(false)
    expect(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_GUIDE: 'no' }).guide).toBe(false)
  })
})

describe('configToClientOptions — the time policy + the onBeforePay seam', () => {
  test('NEVER sets onBeforePay (the confirm hook is wired in createMcpServer, not here)', () => {
    const opts = configToClientOptions(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CONFIRM: '1' }))
    expect('onBeforePay' in opts).toBe(false)
  })
  test('zero-config policy is byte-identical (no time fields leak in)', () => {
    const opts = configToClientOptions(parseConfig({ PIPRAIL_PRIVATE_KEY: KEY }))
    expect(opts.policy).toEqual({
      maxAmount: '0.10',
      maxTotal: '10.00',
      tokens: ['USDC'],
      allowUnknownTokens: false,
    })
  })
  test('spreads ttl + window into the policy when set', () => {
    const opts = configToClientOptions(
      parseConfig({
        PIPRAIL_PRIVATE_KEY: KEY,
        PIPRAIL_TTL: '3600',
        PIPRAIL_WINDOW_TOTAL: '1.00',
        PIPRAIL_WINDOW_SECONDS: '60',
      })
    )
    expect(opts.policy).toMatchObject({ ttlSeconds: 3600, windowTotal: '1.00', windowSeconds: 60 })
  })
})
