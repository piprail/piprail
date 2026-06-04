import { describe, it, expect } from 'vitest'
import { evmDriver } from '../src/drivers/evm/index.js'
import { solanaDriver } from '../src/drivers/solana/index.js'
import { tonDriver } from '../src/drivers/ton/index.js'
import { tronDriver } from '../src/drivers/tron/index.js'
import { suiDriver } from '../src/drivers/sui/index.js'
import { aptosDriver } from '../src/drivers/aptos/index.js'

/**
 * recipientReady must report 'n/a' (no receive prerequisite) TRUTHFULLY on the
 * families that have none — EVM/Solana/TON/Tron/Sui/Aptos and every native coin —
 * so an agent never over-trusts a `ready: true` that means "no concept here". These
 * are pure (no RPC): the 'n/a' branch returns without a network read. The real
 * probes (NEAR/Stellar/XRPL/Algorand) are exercised by the planPayment flow test +
 * the live Algorand smoke.
 */
describe("recipientReady — truthful 'n/a' on no-prerequisite families", () => {
  it('EVM: any address can receive native + ERC-20', async () => {
    const net = evmDriver.resolve({ chain: 'base' })!
    expect(await net.recipientReady('0x1111111111111111111111111111111111111111', 'native')).toEqual({ ready: 'n/a' })
    expect(
      await net.recipientReady('0x1111111111111111111111111111111111111111', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    ).toEqual({ ready: 'n/a' })
  })

  it('Solana: payer auto-creates the ATA → no recipient action', async () => {
    const net = solanaDriver.resolve({ chain: 'solana' })!
    expect(await net.recipientReady('6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW', 'native')).toEqual({ ready: 'n/a' })
  })

  it('TON: jetton wallet auto-deploys on receipt', async () => {
    const net = tonDriver.resolve({ chain: 'ton' })!
    expect(await net.recipientReady('UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'native')).toEqual({ ready: 'n/a' })
  })

  it('Tron: no prerequisite', async () => {
    const net = tronDriver.resolve({ chain: 'tron' })!
    expect(await net.recipientReady('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'native')).toEqual({ ready: 'n/a' })
  })

  it('Sui: no prerequisite', async () => {
    const net = suiDriver.resolve({ chain: 'sui' })!
    expect(await net.recipientReady('0x2', 'native')).toEqual({ ready: 'n/a' })
  })

  it('Aptos: primary FA store auto-creates', async () => {
    const net = aptosDriver.resolve({ chain: 'aptos' })!
    expect(await net.recipientReady('0xa', 'native')).toEqual({ ready: 'n/a' })
  })
})
