import { describe, it, expect } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { stellarDriver } from '../../src/drivers/stellar/index.js'

const PAY_TO = Keypair.random().publicKey() // a valid Stellar G… address
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'

describe('auto-mount — naming "stellar" is enough (no setup call)', () => {
  it('mounts the Stellar driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'stellar', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('stellar:pubnet')
    expect(accept.asset).toBe(`USDC:${USDC_ISSUER}`)
    expect(accept.amount).toBe('500000') // 0.05 × 10^7 (Stellar is 7dp)
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.decimals).toBe(7)
    expect(accept.extra.amountFormatted).toBe('0.05')
  })

  it('builds an EURC challenge', async () => {
    const gate = createPaymentGate({ chain: 'stellar', token: 'EURC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`EURC:${EURC_ISSUER}`)
    expect(accept.extra.symbol).toBe('EURC')
    expect(accept.extra.decimals).toBe(7)
  })

  it('builds a native XLM (7-decimal) challenge', async () => {
    const gate = createPaymentGate({ chain: 'stellar', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('10000000') // 1 × 10^7
    expect(accept.extra.symbol).toBe('XLM')
    expect(accept.extra.decimals).toBe(7)
  })
})

describe('Stellar tokens — USDC/EURC built in, custom by { issuer, code, decimals }', () => {
  it('accepts any classic asset by { issuer, code, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'stellar',
      token: { issuer: USDC_ISSUER, code: 'XYZ', decimals: 7, symbol: 'XYZ' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`XYZ:${USDC_ISSUER}`)
    expect(accept.extra.decimals).toBe(7)
    expect(accept.extra.symbol).toBe('XYZ')
  })

  it('rejects an unknown built-in symbol with a typed UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'stellar', token: 'DOGE', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.code).toBe('UNKNOWN_TOKEN')
    expect(err.message).toMatch(/isn't built in for Stellar/)
  })

  it('resolves a built-in symbol case-insensitively', async () => {
    const gate = createPaymentGate({ chain: 'stellar', token: 'usdc', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(`USDC:${USDC_ISSUER}`)
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM 0x payTo on a Stellar chain', async () => {
    const gate = createPaymentGate({
      chain: 'stellar',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/Stellar/)
  })

  it('rejects an EVM { address } token on a Stellar chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'stellar',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.code).toBe('WRONG_FAMILY')
    expect(err.message).toMatch(/Stellar/)
  })

  it('rejects a Solana { mint } token on a Stellar chain', async () => {
    const gate = createPaymentGate({
      chain: 'stellar',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Stellar/)
  })

  it('rejects a TON { master } token on a Stellar chain', async () => {
    const gate = createPaymentGate({
      chain: 'stellar',
      token: { master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Stellar/)
  })
})

describe('Stellar wallet binding (driver bindWallet → assertStellarWallet)', () => {
  it('accepts { secret } and { keypair }, rejects EVM / Solana / TON wallets', () => {
    const net = stellarDriver.resolve({ chain: 'stellar' })!
    expect(() => net.bindWallet({ secret: Keypair.random().secret() })).not.toThrow()
    expect(() => net.bindWallet({ keypair: Keypair.random() })).not.toThrow()
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).toThrow(/Stellar/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/Stellar/)
    expect(() => net.bindWallet({ mnemonic: Array(24).fill('abandon') })).toThrow(/Stellar/)
  })
})

describe('stellarDriver.resolve — only claims the "stellar" selector', () => {
  it('returns null for non-Stellar inputs so the registry can route elsewhere', () => {
    expect(stellarDriver.resolve({ chain: 'base' })).toBeNull()
    expect(stellarDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(stellarDriver.resolve({ chain: 'ton' })).toBeNull()
    expect(stellarDriver.resolve({ chain: 'stellar' })).not.toBeNull()
  })
})
