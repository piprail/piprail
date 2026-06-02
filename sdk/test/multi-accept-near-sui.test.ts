import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'

// One challenge spanning an EVM chain + the two newest families (NEAR + Sui).
// Proves both resolve correctly under a multi-chain accept[] gate (the gate is
// chain-agnostic — each option is resolved by its own driver, with one shared
// nonce). Mirrors multi-accept-new-chains.test.ts (Tron + XRPL). Offline: only
// challenge() runs, which never touches RPC.
const EVM_PAY_TO = '0x1111111111111111111111111111111111111111'
const NEAR_PAY_TO = 'merchant.near'
const SUI_PAY_TO = `0x${'2'.repeat(64)}`

const USDC_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const USDT_NEAR = 'usdt.tether-token.near'
const USDC_SUI = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

describe('multi-chain accepts — EVM + NEAR + Sui in one challenge', () => {
  it('offers all three options with the right networks/assets/amounts + a shared nonce', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO },
        { chain: 'near', token: 'USDC', amount: '0.05', payTo: NEAR_PAY_TO },
        { chain: 'sui', token: 'USDC', amount: '0.05', payTo: SUI_PAY_TO },
      ],
      description: 'pay on Base, NEAR, or Sui',
    })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts).toHaveLength(3)
    const [base, near, sui] = challenge.accepts

    expect(base!.network).toBe('eip155:8453')

    expect(near!.network).toBe('near:mainnet')
    expect(near!.asset).toBe(USDC_NEAR)
    expect(near!.payTo).toBe(NEAR_PAY_TO)
    expect(near!.amount).toBe('50000') // 0.05 × 10^6
    expect(near!.extra.symbol).toBe('USDC')

    expect(sui!.network).toBe('sui:mainnet')
    expect(sui!.asset).toBe(USDC_SUI)
    expect(sui!.payTo).toBe(SUI_PAY_TO)
    expect(sui!.amount).toBe('50000') // 0.05 × 10^6
    expect(sui!.extra.symbol).toBe('USDC')

    // One nonce shared across every offered accept.
    expect(base!.extra.nonce).toBe(near!.extra.nonce)
    expect(near!.extra.nonce).toBe(sui!.extra.nonce)
  })

  it('NEAR offers BOTH native USDC and USDT in one challenge (both shipped)', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: 'near', token: 'USDC', amount: '0.05', payTo: NEAR_PAY_TO },
        { chain: 'near', token: 'USDT', amount: '0.05', payTo: NEAR_PAY_TO },
      ],
    })
    const { challenge } = await gate.challenge()
    const assets = challenge.accepts.map((a) => a.asset)
    expect(assets).toContain(USDC_NEAR)
    expect(assets).toContain(USDT_NEAR)
  })
})
