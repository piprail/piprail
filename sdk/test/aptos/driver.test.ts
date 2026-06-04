import { describe, it, expect } from 'vitest'
import { Account } from '@aptos-labs/ts-sdk'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { aptosDriver } from '../../src/drivers/aptos/index.js'

const PAY_TO = Account.generate().accountAddress.toString() // a valid Aptos 0x… address
const USDC_META = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const USDT_META = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'

describe('auto-mount — naming "aptos" is enough (no setup call)', () => {
  it('mounts the Aptos driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'aptos', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('aptos:1')
    expect(accept.asset).toBe(USDC_META)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a native USDT (6-decimal) challenge', async () => {
    const gate = createPaymentGate({ chain: 'aptos', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(USDT_META)
    expect(accept.amount).toBe('50000')
    expect(accept.extra.symbol).toBe('USDT')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a native APT (8-decimal) challenge', async () => {
    const gate = createPaymentGate({ chain: 'aptos', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('100000000') // 1 × 10^8
    expect(accept.extra.symbol).toBe('APT')
    expect(accept.extra.decimals).toBe(8)
  })
})

describe('Aptos tokens — USDC + USDT built in, custom by { metadata, decimals }', () => {
  it('rejects an unknown symbol with a typed UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'aptos', token: 'DAI', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.message).toMatch(/isn't built in for Aptos/)
  })

  it('accepts any Fungible Asset by { metadata, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'aptos',
      token: { metadata: '0xabc', decimals: 8, symbol: 'FOO' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('0xabc')
    expect(accept.extra.decimals).toBe(8)
    expect(accept.extra.symbol).toBe('FOO')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM { address } token on an Aptos chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'aptos',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/Aptos/)
  })

  it('rejects a Solana { mint } token on an Aptos chain', async () => {
    const gate = createPaymentGate({
      chain: 'aptos',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Aptos/)
  })

  it('rejects a Solana base58 payTo that is not a valid Aptos address', async () => {
    const gate = createPaymentGate({
      chain: 'aptos',
      token: 'USDC',
      amount: '0.05',
      payTo: '6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW',
    })
    await expect(gate.challenge()).rejects.toThrow(/Aptos/)
  })

  it('rejects a 20-byte EVM payTo (a valid short Aptos addr would be a footgun)', async () => {
    const gate = createPaymentGate({
      chain: 'aptos',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111', // 20-byte EVM, not 32-byte Aptos
    })
    await expect(gate.challenge()).rejects.toThrow(/Aptos/)
  })
})

describe('Aptos wallet binding (driver bindWallet → assertAptosWallet)', () => {
  it('accepts { privateKey } and { account }, rejects other families', () => {
    const net = aptosDriver.resolve({ chain: 'aptos' })!
    const acct = Account.generate()
    expect(() => net.bindWallet({ privateKey: acct.privateKey.toString() })).not.toThrow()
    expect(() => net.bindWallet({ account: acct })).not.toThrow()
    expect(() => net.bindWallet({ walletClient: {} })).toThrow(/Aptos/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/Aptos/)
    expect(() => net.bindWallet({ accountId: 'a.near', privateKey: 'ed25519:x' })).toThrow(/Aptos/)
  })
})

describe('aptosDriver.resolve — only claims the "aptos" selector', () => {
  it('returns null for non-Aptos inputs so the registry can route elsewhere', () => {
    expect(aptosDriver.resolve({ chain: 'base' })).toBeNull()
    expect(aptosDriver.resolve({ chain: 'sui' })).toBeNull()
    expect(aptosDriver.resolve({ chain: 'near' })).toBeNull()
    expect(aptosDriver.resolve({ chain: 'aptos' })).not.toBeNull()
  })
})
