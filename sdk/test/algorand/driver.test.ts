import { describe, it, expect } from 'vitest'
import algosdk from 'algosdk'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { algorandDriver } from '../../src/drivers/algorand/index.js'

const PAY_TO = algosdk.generateAccount().addr.toString() // a valid Algorand address

describe('auto-mount — naming "algorand" is enough (no setup call)', () => {
  it('mounts the Algorand driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'algorand', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')
    expect(accept.asset).toBe('31566704')
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a native ALGO (6-decimal) challenge', async () => {
    const gate = createPaymentGate({ chain: 'algorand', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('1000000') // 1 × 10^6
    expect(accept.extra.symbol).toBe('ALGO')
    expect(accept.extra.decimals).toBe(6)
  })
})

describe('Algorand tokens — USDC built in, custom ASA by { assetId, decimals }', () => {
  it('rejects an unknown symbol with a typed UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'algorand', token: 'DAI', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.message).toMatch(/isn't built in for Algorand/)
  })

  it('does NOT ship USDT (Tether deprecated it on Algorand)', async () => {
    const gate = createPaymentGate({ chain: 'algorand', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    await expect(gate.challenge()).rejects.toBeInstanceOf(UnknownTokenError)
  })

  it('accepts any ASA by { assetId, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'algorand',
      token: { assetId: 312769, decimals: 6, symbol: 'USDt' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('312769')
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('USDt')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM { address } token on an Algorand chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'algorand',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/Algorand/)
  })

  it('rejects a Solana { mint } token on an Algorand chain', async () => {
    const gate = createPaymentGate({
      chain: 'algorand',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Algorand/)
  })

  it('rejects an EVM 0x payTo on an Algorand chain', async () => {
    const gate = createPaymentGate({
      chain: 'algorand',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/Algorand/)
  })

  it('rejects a Solana base58 payTo that is not a valid Algorand address', async () => {
    const gate = createPaymentGate({
      chain: 'algorand',
      token: 'USDC',
      amount: '0.05',
      payTo: '6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW',
    })
    await expect(gate.challenge()).rejects.toThrow(/Algorand/)
  })
})

describe('Algorand wallet binding (driver bindWallet → assertAlgorandWallet)', () => {
  it('accepts { key } (mnemonic) and { account }, rejects legacy/other families', () => {
    const net = algorandDriver.resolve({ chain: 'algorand' })!
    const acct = algosdk.generateAccount()
    const mnemonic = algosdk.secretKeyToMnemonic(acct.sk)
    expect(() => net.bindWallet({ key: mnemonic })).not.toThrow()
    expect(() => net.bindWallet({ account: acct })).not.toThrow()
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).toThrow(/Algorand/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/Algorand/)
    expect(() => net.bindWallet({ accountId: 'a.near', secret: 'x' })).toThrow(/Algorand/)
  })
})

describe('algorandDriver.resolve — only claims the "algorand" selector', () => {
  it('returns null for non-Algorand inputs so the registry can route elsewhere', () => {
    expect(algorandDriver.resolve({ chain: 'base' })).toBeNull()
    expect(algorandDriver.resolve({ chain: 'aptos' })).toBeNull()
    expect(algorandDriver.resolve({ chain: 'near' })).toBeNull()
    expect(algorandDriver.resolve({ chain: 'algorand' })).not.toBeNull()
  })
})
