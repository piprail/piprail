import { describe, expect, test } from 'vitest'
import { parseConfig, configToClientOptions } from '../src/config.js'
import { createMcpServer } from '../src/server.js'
import { formatBanner } from '../src/banner.js'

const SECRET = '0x' + 'a'.repeat(64)

describe('full local flow: env → config → server + banner', () => {
  test('boots a server and produces an informative, secret-free banner', () => {
    const env = {
      PIPRAIL_PRIVATE_KEY: SECRET,
      PIPRAIL_CHAIN: 'base',
      PIPRAIL_MAX_AMOUNT: '0.25',
      PIPRAIL_MAX_TOTAL: '12.50',
      PIPRAIL_TOKENS: 'USDC,USDT',
    }
    const cfg = parseConfig(env)
    const { server, client } = createMcpServer(configToClientOptions(cfg))
    expect(server).toBeTruthy()
    expect(client).toBeTruthy()

    const banner = formatBanner(cfg)
    expect(banner).toContain('base')
    expect(banner).toContain('0.25')
    expect(banner).toContain('12.50')
    expect(banner).toContain('USDC, USDT')
    expect(banner).toContain('piprail_pay_request')
    expect(banner).toContain('set via PIPRAIL_PRIVATE_KEY')

    // The banner must NEVER leak the wallet secret.
    expect(banner).not.toContain(SECRET)
    expect(banner).not.toContain('a'.repeat(64))
  })

  test('a custom RPC URL is never printed verbatim (it can embed an API key)', () => {
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: SECRET,
      PIPRAIL_RPC_URL: 'https://rpc.example.com/v2/SUPER_SECRET_KEY',
    })
    const banner = formatBanner(cfg)
    expect(banner).toContain('(custom)')
    expect(banner).not.toContain('SUPER_SECRET_KEY')
  })

  test('Mode B + a time envelope: the banner reflects both and the server builds', () => {
    const cfg = parseConfig({
      PIPRAIL_PRIVATE_KEY: SECRET,
      PIPRAIL_CONFIRM: '1',
      PIPRAIL_TTL: '1800',
    })
    expect(cfg.confirm).toBe(true)
    const { server } = createMcpServer(configToClientOptions(cfg), {
      confirm: cfg.confirm,
      guide: cfg.guide,
    })
    expect(server).toBeTruthy()
    const banner = formatBanner(cfg)
    expect(banner).toMatch(/confirm/)
    expect(banner).toMatch(/session ttl\s+1800s/)
  })
})
