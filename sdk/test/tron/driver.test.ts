import { describe, it, expect } from 'vitest'
import { TronWeb } from 'tronweb'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { tronDriver } from '../../src/drivers/tron/index.js'

const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const PAY_TO = tw.address.fromPrivateKey('11'.repeat(32)) as string // a valid Tron T… address (offline)
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

describe('auto-mount — naming "tron" is enough (no setup call)', () => {
  it('mounts the Tron driver on first use and builds a USD₮ challenge', async () => {
    const gate = createPaymentGate({ chain: 'tron', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('tron:mainnet')
    expect(accept.asset).toBe(USDT)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDT')
    expect(accept.extra.decimals).toBe(6)
  })
})

describe('Tron tokens — TRC-20 only (USDT yes, USDC no, native TRX no)', () => {
  it('rejects native TRX with a clear UnknownTokenError (TRC-20 only)', async () => {
    const gate = createPaymentGate({ chain: 'tron', token: 'native', amount: '1', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.message).toMatch(/TRC-20 only/)
  })

  it('rejects USDC with a message explaining it does not exist on Tron', async () => {
    const gate = createPaymentGate({ chain: 'tron', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    await expect(gate.challenge()).rejects.toThrow(/native USDC doesn't exist on Tron/)
  })

  it('accepts any TRC-20 by { address, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'tron',
      token: { address: USDT, decimals: 6, symbol: 'USDD' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(USDT)
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('USDD')
  })

  it('rejects a custom token given as a 0x address (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'tron',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/Tron/)
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM 0x payTo on a Tron chain', async () => {
    const gate = createPaymentGate({
      chain: 'tron',
      token: 'USDT',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/Tron/)
  })

  it('rejects a Solana { mint } token on a Tron chain', async () => {
    const gate = createPaymentGate({
      chain: 'tron',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Tron/)
  })

  it('rejects a Stellar { issuer, code } token on a Tron chain', async () => {
    const gate = createPaymentGate({
      chain: 'tron',
      token: { issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', code: 'USDC', decimals: 7 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Tron/)
  })
})

describe('Tron wallet binding (driver bindWallet → assertTronWallet)', () => {
  it('accepts { privateKey }, rejects viem/Solana/TON/Stellar/XRPL wallets', () => {
    const net = tronDriver.resolve({ chain: 'tron' })!
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).not.toThrow()
    expect(() => net.bindWallet({ privateKey: '1'.repeat(64) })).not.toThrow()
    expect(() => net.bindWallet({ walletClient: {} })).toThrow(/Tron/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/Tron/)
    expect(() => net.bindWallet({ mnemonic: Array(24).fill('abandon') })).toThrow(/Tron/)
    expect(() => net.bindWallet({ secret: 'SABC' })).toThrow(/Tron/)
    expect(() => net.bindWallet({ seed: 'sABC' })).toThrow(/Tron/)
  })
})

describe('tronDriver.resolve — only claims the "tron" selector', () => {
  it('returns null for non-Tron inputs so the registry can route elsewhere', () => {
    expect(tronDriver.resolve({ chain: 'base' })).toBeNull()
    expect(tronDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(tronDriver.resolve({ chain: 'xrpl' })).toBeNull()
    expect(tronDriver.resolve({ chain: 'tron' })).not.toBeNull()
  })
})
