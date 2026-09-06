import { describe, it, expect } from 'vitest'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { suiDriver } from '../../src/drivers/sui/index.js'

const PAY_TO = new Ed25519Keypair().getPublicKey().toSuiAddress() // a valid Sui 0x… address
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

describe('auto-mount — naming "sui" is enough (no setup call)', () => {
  it('mounts the Sui driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'sui', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('sui:mainnet')
    expect(accept.asset).toBe(USDC)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra!.symbol).toBe('USDC')
    expect(accept.extra!.decimals).toBe(6)
  })

  it('builds a native SUI (9-decimal) challenge', async () => {
    const gate = createPaymentGate({ chain: 'sui', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('1000000000') // 1 × 10^9
    expect(accept.extra!.symbol).toBe('SUI')
    expect(accept.extra!.decimals).toBe(9)
  })
})

describe('Sui tokens — USDC built in (no native USDT), custom by { coinType, decimals }', () => {
  it('rejects USDT with a typed UnknownTokenError (no native USDT on Sui)', async () => {
    const gate = createPaymentGate({ chain: 'sui', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.message).toMatch(/isn't built in for Sui/)
  })

  it('accepts any coin by { coinType, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'sui',
      token: { coinType: '0xabc::foo::FOO', decimals: 8, symbol: 'FOO' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('0xabc::foo::FOO')
    expect(accept.extra!.decimals).toBe(8)
    expect(accept.extra!.symbol).toBe('FOO')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM { address } token on a Sui chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'sui',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.message).toMatch(/Sui/)
  })

  it('rejects a Solana { mint } token on a Sui chain', async () => {
    const gate = createPaymentGate({
      chain: 'sui',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/Sui/)
  })

  it('rejects an EVM 0x… payTo that is not a valid Sui address', async () => {
    const gate = createPaymentGate({
      chain: 'sui',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111', // 20-byte EVM, not 32-byte Sui
    })
    await expect(gate.challenge()).rejects.toThrow(/Sui/)
  })
})

describe('Sui wallet binding (driver bindWallet → assertSuiWallet)', () => {
  it('accepts { key } and { keypair }, rejects legacy/other families', () => {
    const net = suiDriver.resolve({ chain: 'sui' })!
    const kp = new Ed25519Keypair()
    expect(() => net.bindWallet({ key: kp.getSecretKey() })).not.toThrow()
    expect(() => net.bindWallet({ keypair: kp })).not.toThrow()
    expect(() => net.bindWallet({ walletClient: {} })).toThrow(/Sui/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/Sui/)
    expect(() => net.bindWallet({ accountId: 'a.near', privateKey: 'ed25519:x' })).toThrow(/Sui/)
  })
})

describe('suiDriver.resolve — only claims the "sui" selector', () => {
  it('returns null for non-Sui inputs so the registry can route elsewhere', () => {
    expect(suiDriver.resolve({ chain: 'base' })).toBeNull()
    expect(suiDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(suiDriver.resolve({ chain: 'near' })).toBeNull()
    expect(suiDriver.resolve({ chain: 'sui' })).not.toBeNull()
  })
})
