import { describe, it, expect } from 'vitest'
import { Wallet } from 'xrpl'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { xrplDriver } from '../../src/drivers/xrpl/index.js'

const PAY_TO = Wallet.generate().classicAddress // a valid XRPL r… address
const USDC_ISSUER = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE'
const USDC_HEX = '5553444300000000000000000000000000000000'
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'
const RLUSD_HEX = '524C555344000000000000000000000000000000'

describe('auto-mount — naming "xrpl" is enough (no setup call)', () => {
  it('mounts the XRPL driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'xrpl', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('xrpl:0')
    expect(accept.asset).toBe(`${USDC_HEX}:${USDC_ISSUER}`)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.amountFormatted).toBe('0.05')
  })

  it('builds an RLUSD challenge', async () => {
    const gate = createPaymentGate({ chain: 'xrpl', token: 'RLUSD', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`${RLUSD_HEX}:${RLUSD_ISSUER}`)
    expect(accept.extra.symbol).toBe('RLUSD')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a native XRP (6-decimal drops) challenge', async () => {
    const gate = createPaymentGate({ chain: 'xrpl', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('1000000') // 1 XRP = 1e6 drops
    expect(accept.extra.symbol).toBe('XRP')
    expect(accept.extra.decimals).toBe(6)
  })
})

describe('XRPL tokens — USDC/RLUSD built in, custom by { issuer, currencyHex, decimals }', () => {
  it('accepts any issued currency by { issuer, currencyHex, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'xrpl',
      token: { issuer: USDC_ISSUER, currencyHex: '4142434400000000000000000000000000000000', decimals: 6, symbol: 'ABCD' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`4142434400000000000000000000000000000000:${USDC_ISSUER}`)
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('ABCD')
  })

  it('rejects an unknown built-in symbol with a typed UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'xrpl', token: 'DOGE', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.code).toBe('UNKNOWN_TOKEN')
    expect(err.message).toMatch(/isn't built in for XRPL/)
  })

  it('resolves a built-in symbol case-insensitively', async () => {
    const gate = createPaymentGate({ chain: 'xrpl', token: 'usdc', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`${USDC_HEX}:${USDC_ISSUER}`)
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM 0x payTo on an XRPL chain', async () => {
    const gate = createPaymentGate({
      chain: 'xrpl',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/XRPL/)
  })

  it('rejects an EVM { address } token on an XRPL chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'xrpl',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.code).toBe('WRONG_FAMILY')
    expect(err.message).toMatch(/XRPL/)
  })

  it('rejects a Solana { mint } token on an XRPL chain', async () => {
    const gate = createPaymentGate({
      chain: 'xrpl',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/XRPL/)
  })

  it('rejects a Stellar { issuer, code } token on an XRPL chain (issuer is NOT the discriminant)', async () => {
    const gate = createPaymentGate({
      chain: 'xrpl',
      token: { issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', code: 'USDC', decimals: 7 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/XRPL/)
  })
})

describe('XRPL wallet binding (driver bindWallet → assertXrplWallet)', () => {
  it('accepts { key } (seed) and { wallet }, rejects legacy/other wallets', () => {
    const net = xrplDriver.resolve({ chain: 'xrpl' })!
    const w = Wallet.generate()
    expect(() => net.bindWallet({ key: w.seed })).not.toThrow()
    expect(() => net.bindWallet({ wallet: w })).not.toThrow()
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).toThrow(/XRPL/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/XRPL/)
    expect(() => net.bindWallet({ mnemonic: Array(24).fill('abandon') })).toThrow(/XRPL/)
    // a pre-v2 { secret } field now gives a clear migration error
    expect(() => net.bindWallet({ secret: 'SABC' })).toThrow(/XRPL/)
  })
})

describe('xrplDriver.resolve — only claims the "xrpl" selector', () => {
  it('returns null for non-XRPL inputs so the registry can route elsewhere', () => {
    expect(xrplDriver.resolve({ chain: 'base' })).toBeNull()
    expect(xrplDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(xrplDriver.resolve({ chain: 'tron' })).toBeNull()
    expect(xrplDriver.resolve({ chain: 'xrpl' })).not.toBeNull()
  })
})
