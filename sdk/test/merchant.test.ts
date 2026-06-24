import { describe, it, expect } from 'vitest'
import { createPaywall, createTipJar, createPaymentGate } from '../src/index.js'

const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

describe('createPaywall (preset === createPaymentGate)', () => {
  it('defaults the token to USDC and resolves to a gate identical to the hand-written one', async () => {
    // describe() is nonce-free + deterministic — the clean equality surface for "same wire".
    const preset = await createPaywall({ chain: 'base', amount: '0.05', payTo: PAY_TO }).describe(
      'https://api.example.com/x'
    )
    const manual = await createPaymentGate({
      chain: 'base',
      token: 'USDC',
      amount: '0.05',
      payTo: PAY_TO,
    }).describe('https://api.example.com/x')
    expect(preset).toEqual(manual)
  })

  it('honors a token override and forwards advanced gate options (description)', async () => {
    const d = await createPaywall({
      chain: 'base',
      token: 'USDC',
      amount: '0.10',
      payTo: PAY_TO,
      description: 'A premium report',
    }).describe('https://x')
    expect(d.description).toBe('A premium report')
    expect(d.accepts[0]).toMatchObject({ scheme: 'onchain-proof', amountFormatted: '0.10', symbol: 'USDC' })
  })

  it('an explicit token: undefined still falls back to USDC (destructuring default)', async () => {
    const st = await createPaywall({ chain: 'base', amount: '0.05', payTo: PAY_TO, token: undefined }).selfTest()
    expect(st.ok).toBe(true)
    expect(st.rails[0]).toMatchObject({ symbol: 'USDC' })
  })

  it('accepts the native coin and a fully-custom token', async () => {
    const native = await createPaywall({ chain: 'base', token: 'native', amount: '0.001', payTo: PAY_TO }).selfTest()
    expect(native.ok).toBe(true)
    const custom = await createPaywall({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x0000000000000000000000000000000000000001', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    }).selfTest()
    expect(custom.ok).toBe(true)
  })
})

describe('createTipJar (open "pay ≥ min")', () => {
  it('sets the challenge amount to the minimum (a floor — the gate accepts an over-payment)', async () => {
    const tip = await createTipJar({ chain: 'base', min: '1.00', payTo: PAY_TO }).describe('https://tip')
    const fixed = await createPaymentGate({
      chain: 'base',
      token: 'USDC',
      amount: '1.00',
      payTo: PAY_TO,
    }).describe('https://tip')
    // A tip jar IS a gate priced at the minimum; the driver's verify rejects only under-payment
    // (amount_too_low — drivers/evm/verify.ts), so paying more is accepted at the wire level.
    expect(tip).toEqual(fixed)
    expect(tip.accepts[0]).toMatchObject({ amountFormatted: '1.00' })
  })

  it('forwards advanced options (onPaid) — builds a sound gate', async () => {
    const st = await createTipJar({ chain: 'base', min: '0.50', payTo: PAY_TO, onPaid: () => {} }).selfTest()
    expect(st.ok).toBe(true)
  })
})

describe('gate.selfTest (read-only config check, never throws)', () => {
  it('returns ok + the resolved rail for a sound config — no signing, no sending', async () => {
    const st = await createPaywall({ chain: 'base', amount: '0.05', payTo: PAY_TO }).selfTest()
    expect(st.ok).toBe(true)
    expect(st.error).toBeUndefined()
    expect(st.rails).toHaveLength(1)
    expect(st.rails[0]).toMatchObject({
      network: 'eip155:8453',
      symbol: 'USDC',
      decimals: 6,
      amount: '0.05',
      payTo: PAY_TO,
      schemes: ['onchain-proof'],
    })
  })

  it('reports every rail of a multi-chain accept[] gate', async () => {
    const st = await createPaymentGate({
      payTo: PAY_TO,
      accept: [
        { chain: 'base', token: 'USDC', amount: '0.01' },
        { chain: 'polygon', token: 'USDC', amount: '0.02' },
      ],
    }).selfTest()
    expect(st.ok).toBe(true)
    expect(st.rails).toHaveLength(2)
    expect(st.rails.map((r) => r.network)).toEqual(['eip155:8453', 'eip155:137'])
  })

  it('returns ok:false with a human reason for a malformed payTo — never throws', async () => {
    const st = await createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: 'not-an-address' }).selfTest()
    expect(st.ok).toBe(false)
    expect(st.rails).toEqual([])
    expect(typeof st.error).toBe('string')
    expect(st.error!.length).toBeGreaterThan(0)
  })

  it('returns ok:false for an unparseable amount — never throws', async () => {
    const st = await createPaymentGate({ chain: 'base', token: 'USDC', amount: 'not-a-number', payTo: PAY_TO }).selfTest()
    expect(st.ok).toBe(false)
    expect(st.error).toBeTruthy()
  })

  it('warns (but stays ok) about a custom token with no built-in symbol', async () => {
    const st = await createPaymentGate({
      chain: { id: 8453, rpcUrl: 'https://base.example/rpc' },
      token: { address: '0x0000000000000000000000000000000000000001', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    }).selfTest()
    expect(st.ok).toBe(true)
    expect(st.warnings.join(' ')).toMatch(/custom token/i)
  })
})
