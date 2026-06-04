import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { createPaymentGate, WrongFamilyError } from '../src/index.js'
import { familyForChain } from '../src/drivers/registry.js'
import { solanaDriver } from '../src/drivers/solana/index.js'

describe('familyForChain — one parameter picks the family', () => {
  it('routes EVM names + custom configs to evm', () => {
    expect(familyForChain('base')).toBe('evm')
    expect(familyForChain('bnb')).toBe('evm')
    expect(familyForChain({ id: 5000, rpcUrl: 'https://rpc.mantle.xyz' })).toBe('evm')
  })
  it('routes every non-EVM family name to its family', () => {
    expect(familyForChain('solana')).toBe('solana')
    expect(familyForChain('ton')).toBe('ton')
    expect(familyForChain('stellar')).toBe('stellar')
    expect(familyForChain('xrpl')).toBe('xrpl')
    expect(familyForChain('tron')).toBe('tron')
    expect(familyForChain('sui')).toBe('sui')
    expect(familyForChain('near')).toBe('near')
    expect(familyForChain('aptos')).toBe('aptos')
  })
})

describe('auto-mount — naming the chain is enough (no enableSolana)', () => {
  it('mounts the Solana driver on first use and builds a USDC challenge', async () => {
    // No setup call: createPaymentGate({ chain: 'solana' }) auto-mounts the
    // Solana driver the first time challenge() resolves.
    const payTo = Keypair.generate().publicKey.toBase58()
    const gate = createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.05', payTo })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(accept.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(accept.amount).toBe('50000') // 0.05 × 10^6
    expect(accept.extra.symbol).toBe('USDC')
  })
})

describe('Solana custom token — total control via { mint }', () => {
  it('accepts any SPL token by mint + decimals (no preset needed)', async () => {
    const payTo = Keypair.generate().publicKey.toBase58()
    const gate = createPaymentGate({
      chain: 'solana',
      token: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
      amount: '0.05',
      payTo,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(accept.extra.decimals).toBe(6)
    expect(accept.extra.symbol).toBe('USDC')
  })
})

describe('cross-family guards (loud, on first use)', () => {
  it('rejects an EVM 0x payTo on a Solana chain (typed WrongFamilyError)', async () => {
    const gate = createPaymentGate({
      chain: 'solana',
      token: 'USDC',
      amount: '0.05',
      payTo: '0x1111111111111111111111111111111111111111',
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.code).toBe('WRONG_FAMILY')
    expect(err.message).toMatch(/Solana/)
  })

  it('rejects a Solana base58 payTo on an EVM chain', async () => {
    const gate = createPaymentGate({
      chain: 'base',
      token: 'native',
      amount: '0.05',
      payTo: '6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW',
    })
    await expect(gate.challenge()).rejects.toThrow(/EVM/)
  })
})

describe('Solana wallet binding (driver bindWallet → toKeypair)', () => {
  it('accepts { signer } and a raw { secretKey }, rejects an EVM wallet', () => {
    const net = solanaDriver.resolve({ chain: 'solana' })!
    const kp = Keypair.generate()
    // a ready Keypair signer
    expect(() => net.bindWallet({ signer: kp })).not.toThrow()
    // a raw 64-byte secret key
    expect(() => net.bindWallet({ secretKey: kp.secretKey })).not.toThrow()
    // an EVM wallet on a Solana chain → WrongFamilyError (message mentions Solana)
    expect(() => net.bindWallet({ privateKey: `0x${'1'.repeat(64)}` })).toThrow(/Solana/)
  })
})
