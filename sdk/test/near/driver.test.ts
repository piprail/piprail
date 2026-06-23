import { describe, it, expect } from 'vitest'
import { KeyPair } from 'near-api-js'
import { createPaymentGate, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { nearDriver } from '../../src/drivers/near/index.js'

const PAY_TO = 'merchant.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const USDT = 'usdt.tether-token.near'
const KEY = KeyPair.fromRandom('ed25519').toString() // a valid ed25519:… secret

describe('auto-mount — naming "near" is enough (no setup call)', () => {
  it('mounts the NEAR driver on first use and builds a USDC challenge', async () => {
    const gate = createPaymentGate({ chain: 'near', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('near:mainnet')
    expect(accept.asset).toBe(USDC)
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDC')
    expect(accept.extra.decimals).toBe(6)
  })

  it('builds a USDT challenge (native Tether on NEAR)', async () => {
    const gate = createPaymentGate({ chain: 'near', token: 'USDT', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe(USDT)
    expect(accept.extra.symbol).toBe('USDT')
  })
})

describe('NEAR tokens — USDC + USDT + native NEAR', () => {
  it('accepts native NEAR (digest-bound) — builds a NEAR challenge', async () => {
    const gate = createPaymentGate({ chain: 'near', token: 'native', amount: '0.01', payTo: PAY_TO })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('native')
    expect(accept.extra.decimals).toBe(24)
    expect(accept.extra.symbol).toBe('NEAR')
    expect(accept.amount).toBe('10000000000000000000000') // 0.01 × 10^24 yoctoNEAR
  })

  it('rejects an unknown token symbol with a clear UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'near', token: 'USDX', amount: '1', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
  })

  it('accepts any NEP-141 by { contractId, decimals }', async () => {
    const gate = createPaymentGate({
      chain: 'near',
      token: { contractId: 'mytoken.near', decimals: 8, symbol: 'MINE' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('mytoken.near')
    expect(accept.extra.decimals).toBe(8)
    expect(accept.extra.symbol).toBe('MINE')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM { address } token on a NEAR chain', async () => {
    const gate = createPaymentGate({
      chain: 'near',
      token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/NEAR/)
  })

  it('rejects a Solana { mint } token on a NEAR chain', async () => {
    const gate = createPaymentGate({
      chain: 'near',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    await expect(gate.challenge()).rejects.toThrow(/NEAR/)
  })

  it('rejects an EVM 0x… payTo on a NEAR chain', async () => {
    const gate = createPaymentGate({
      chain: 'near',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    await expect(gate.challenge()).rejects.toThrow(/NEAR/)
  })
})

describe('NEAR wallet binding (driver bindWallet → assertNearWallet)', () => {
  it('accepts { accountId, key }, rejects a bare key + legacy fields', () => {
    const net = nearDriver.resolve({ chain: 'near' })!
    expect(() => net.bindWallet({ accountId: 'alice.near', key: KEY })).not.toThrow()
    // a bare { key } (no accountId) is not enough for NEAR
    expect(() => net.bindWallet({ key: KEY })).toThrow(/NEAR/)
    expect(() => net.bindWallet({ walletClient: {} })).toThrow(/NEAR/)
    // pre-v2 field names now give a clear migration error (mentions key)
    expect(() => net.bindWallet({ accountId: 'alice.near', privateKey: KEY })).toThrow(/key/)
    expect(() => net.bindWallet({ secretKey: new Uint8Array(64) })).toThrow(/key/)
    expect(() => net.bindWallet({ seed: 'sABC' })).toThrow(/key/)
  })
})

describe('nearDriver.resolve — only claims the "near" selector', () => {
  it('returns null for non-NEAR inputs so the registry can route elsewhere', () => {
    expect(nearDriver.resolve({ chain: 'base' })).toBeNull()
    expect(nearDriver.resolve({ chain: 'solana' })).toBeNull()
    expect(nearDriver.resolve({ chain: 'sui' })).toBeNull()
    expect(nearDriver.resolve({ chain: 'near' })).not.toBeNull()
  })
})

describe('nearDriver.estimateCost — the exact rail is buyer-gasless (so autoRoute prefers it)', () => {
  const net = nearDriver.resolve({ chain: 'near' })!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accept = (scheme: 'onchain-proof' | 'exact'): any => ({
    scheme,
    network: net.network,
    asset: USDC,
    amount: '1000000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { decimals: 6 },
  })

  it('reports 0 buyer gas for an `exact` rail (the relayer prepays), basis estimated', async () => {
    // BREAK-IT: against the pre-fix no-arg impl this returned 1_500_000_000_000_000_000_000 / 'heuristic'.
    const cost = await net.estimateCost(accept('exact'))
    expect(cost.fee).toBe('0')
    expect(cost.feeSymbol).toBe('NEAR')
    expect(cost.basis).toBe('estimated')
  })

  it('an `onchain-proof` rail keeps the real (non-zero) NEAR heuristic — the buyer broadcasts', async () => {
    const cost = await net.estimateCost(accept('onchain-proof'))
    expect(BigInt(cost.fee) > 0n).toBe(true)
    expect(cost.basis).toBe('heuristic')
  })
})
