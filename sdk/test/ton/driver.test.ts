import { describe, it, expect } from 'vitest'
import { Address } from '@ton/core'
import { createPaymentGate, WrongFamilyError } from '../../src/index.js'
import { tonDriver } from '../../src/drivers/ton/index.js'
import { resolveTonWallet } from '../../src/drivers/ton/wallet.js'
import { normalizeNetwork } from '../../src/indexes.js'

const PAY_TO = new Address(0, Buffer.alloc(32, 3)).toString() // a valid TON address
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

describe('auto-mount — naming "ton" is enough (no setup call)', () => {
  it('mounts the TON driver on first use and builds a USD₮ challenge', async () => {
    const gate = createPaymentGate({ chain: 'ton', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('tvm:-239')
    expect(accept.asset).toBe(USDT_MASTER)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDT')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a native Gram (9-decimal) challenge — ticker GRAM, network still tvm:-239', async () => {
    const gate = createPaymentGate({ chain: 'ton', token: 'native', amount: '1', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.amount).toBe('1000000000') // 1 × 10^9
    expect(accept.network).toBe('tvm:-239') // network unchanged by the token rebrand
    expect(accept.extra.symbol).toBe('GRAM') // Toncoin → Gram (ticker TON → GRAM), live 2026-06-15
  })
})

describe('TON tokens — USDT yes, USDC no, custom jetton by master', () => {
  it('rejects USDC with a message explaining it does not exist on TON', async () => {
    const gate = createPaymentGate({ chain: 'ton', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    await expect(gate.challenge()).rejects.toThrow(/USDC doesn't exist on TON/)
  })

  it('accepts any jetton by { master, decimals } (no preset needed)', async () => {
    const gate = createPaymentGate({
      chain: 'ton',
      token: { master: USDT_MASTER, decimals: 6, symbol: 'USDe' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(USDT_MASTER)
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('USDe')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM 0x payTo on a TON chain', async () => {
    const gate = createPaymentGate({
      chain: 'ton',
      token: 'USDT',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/TON/)
  })

  it('rejects a Solana { mint } token on a TON chain', async () => {
    const gate = createPaymentGate({
      chain: 'ton',
      // A Solana { mint } token is a valid TokenInput shape (it's a SolanaToken),
      // so this is a RUNTIME wrong-family rejection, not a type error.
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/TON/)
  })
})

describe('TON wallet binding (driver bindWallet → assertTonWallet)', () => {
  it('accepts { key } (mnemonic) and { keyPair }, rejects a legacy/EVM wallet', () => {
    const net = tonDriver.resolve({ chain: 'ton' })!
    expect(() => net.bindWallet({ key: Array(24).fill('abandon') })).not.toThrow()
    expect(() => net.bindWallet({ keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) } })).not.toThrow()
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).toThrow(/TON/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/TON/)
  })
})

describe('resolveTonWallet — validates the mnemonic (no silent wrong-wallet derivation)', () => {
  // @ton/crypto derives a key from ARBITRARY words; without validation a typo'd
  // mnemonic would bind the WRONG wallet and only fail later at the network.
  it('rejects a garbage / wrong-length mnemonic with a clear WrongFamilyError', async () => {
    await expect(resolveTonWallet({ key: 'not a real ton mnemonic zzz totally bogus' })).rejects.toBeInstanceOf(
      WrongFamilyError
    )
    await expect(resolveTonWallet({ key: Array(24).fill('abandon') })).rejects.toThrow(/mnemonic/i)
  })

  it('rejects a non-string / non-array key (number/boolean) with WrongFamilyError, not a raw TypeError', async () => {
    await expect(resolveTonWallet({ key: true as never })).rejects.toBeInstanceOf(WrongFamilyError)
    await expect(resolveTonWallet({ key: 12345 as never })).rejects.toBeInstanceOf(WrongFamilyError)
  })

  it('accepts a ready { keyPair } without mnemonic validation', async () => {
    const keyPair = { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) }
    await expect(resolveTonWallet({ keyPair })).resolves.toBeTruthy()
  })
})

describe('tonDriver.resolve — only claims the "ton" selector', () => {
  it('returns null for non-TON inputs so the registry can route elsewhere', () => {
    expect(tonDriver.resolve({ chain: 'base' })).toBeNull()
    expect(tonDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(tonDriver.resolve({ chain: 'ton' })).not.toBeNull()
  })

  it('routes both the canonical and the legacy CAIP-2 id (the supportsNetwork seam)', () => {
    const net = tonDriver.resolve({ chain: 'ton' })!
    // EXACTLY the composition supportsNetwork uses: net.supports(normalizeNetwork(network)).
    expect(net.supports(normalizeNetwork('tvm:-239'))).toBe(true)
    expect(net.supports(normalizeNetwork('ton:-239'))).toBe(true)
    // belt-and-suspenders: the raw legacy id bypassing normalizeNetwork still matches.
    expect(net.supports('ton:-239')).toBe(true)
  })
})
