import { describe, it, expect } from 'vitest'
import { TronWeb } from 'tronweb'
import { Wallet } from 'xrpl'
import { createPaymentGate } from '../src/server.js'

// One challenge spanning an EVM chain + the two new families. Proves Tron and
// XRPL resolve correctly under a multi-chain accept[] gate (the gate itself is
// chain-agnostic — each option is resolved by its own driver).
const EVM_PAY_TO = '0x1111111111111111111111111111111111111111'
const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const TRON_PAY_TO = tw.address.fromPrivateKey('22'.repeat(32)) as string
const XRPL_PAY_TO = Wallet.generate().classicAddress
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDC_XRPL = '5553444300000000000000000000000000000000:rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE'

describe('multi-chain accepts — EVM + Tron + XRPL in one challenge', () => {
  it('offers all three options with the right networks/assets/amounts + a shared nonce', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO },
        { chain: 'tron', token: 'USDT', amount: '1', payTo: TRON_PAY_TO },
        { chain: 'xrpl', token: 'USDC', amount: '0.05', payTo: XRPL_PAY_TO },
      ],
      description: 'pay on Base, Tron, or the XRP Ledger',
    })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts).toHaveLength(3)
    const [base, tron, xrpl] = challenge.accepts

    expect(base!.network).toBe('eip155:8453')

    expect(tron!.network).toBe('tron:mainnet')
    expect(tron!.asset).toBe(USDT_TRON)
    expect(tron!.payTo).toBe(TRON_PAY_TO)
    expect(tron!.amount).toBe('1000000') // 1 × 10^6
    expect(tron!.extra.symbol).toBe('USDT')

    expect(xrpl!.network).toBe('xrpl:0')
    expect(xrpl!.asset).toBe(USDC_XRPL)
    expect(xrpl!.payTo).toBe(XRPL_PAY_TO)
    expect(xrpl!.amount).toBe('50000') // 0.05 × 10^6
    expect(xrpl!.extra.symbol).toBe('USDC')

    // One nonce shared across every offered accept.
    expect(base!.extra.nonce).toBe(tron!.extra.nonce)
    expect(tron!.extra.nonce).toBe(xrpl!.extra.nonce)
  })
})
