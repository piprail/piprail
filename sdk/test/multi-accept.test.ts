import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { parseUnits } from 'viem'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'

const EVM_PAY_TO = '0x1111111111111111111111111111111111111111'
const SOL_PAY_TO = Keypair.generate().publicKey.toBase58()
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

// A gate that takes USDC on Base OR on Solana — the agent pays with what it holds.
const multiGate = () =>
  createPaymentGate({
    accept: [
      { chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO },
      { chain: 'solana', token: 'USDC', amount: '0.05', payTo: SOL_PAY_TO },
    ],
    description: 'multi-chain report',
  })

describe('multi-chain accepts — challenge issuance', () => {
  it('offers every option in accepts[], one shared nonce', async () => {
    const { challenge } = await multiGate().challenge('https://api.example.com/r')
    expect(challenge.accepts).toHaveLength(2)

    const [base, sol] = challenge.accepts
    expect(base!.network).toBe('eip155:8453')
    expect(base!.asset).toBe(BASE_USDC)
    expect(base!.payTo).toBe(EVM_PAY_TO)
    expect(base!.amount).toBe(parseUnits('0.05', 6).toString())

    expect(sol!.network).toBe(SOL_NETWORK)
    expect(sol!.asset).toBe(SOL_USDC)
    expect(sol!.payTo).toBe(SOL_PAY_TO)
    expect(sol!.amount).toBe(parseUnits('0.05', 6).toString())

    // One nonce shared across every offered accept.
    expect(base!.extra.nonce).toBe(sol!.extra.nonce)
    expect(challenge.resource.description).toBe('multi-chain report')
  })

  it('offers three chains, mixing per-option and top-level payTo', async () => {
    // EVM accepts fall back to the top-level (0x) payTo; Solana brings its own base58 one.
    const gate = createPaymentGate({
      payTo: EVM_PAY_TO, // fallback for the EVM options
      accept: [
        { chain: 'base', token: 'USDC', amount: '0.05' },
        { chain: 'arbitrum', token: 'USDC', amount: '0.06' },
        { chain: 'solana', token: 'USDC', amount: '0.05', payTo: SOL_PAY_TO },
      ],
    })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts).toHaveLength(3)
    expect(challenge.accepts.map((a) => a.network)).toEqual(['eip155:8453', 'eip155:42161', SOL_NETWORK])
    expect(challenge.accepts[0]!.payTo).toBe(EVM_PAY_TO) // fallback
    expect(challenge.accepts[1]!.payTo).toBe(EVM_PAY_TO) // fallback
    expect(challenge.accepts[2]!.payTo).toBe(SOL_PAY_TO) // per-option
    expect(challenge.accepts[1]!.amount).toBe(parseUnits('0.06', 6).toString())
    // still one shared nonce across all three
    expect(new Set(challenge.accepts.map((a) => a.extra.nonce)).size).toBe(1)
  })

  it('per-option amounts and tokens can differ', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO },
        { chain: 'base', token: 'native', amount: '0.001', payTo: EVM_PAY_TO },
      ],
    })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts.map((a) => a.asset)).toEqual([BASE_USDC, 'native'])
    expect(challenge.accepts[1]!.amount).toBe(parseUnits('0.001', 18).toString())
  })
})

describe('multi-chain accepts — config validation', () => {
  it('rejects mixing the single and multi forms', async () => {
    const gate = createPaymentGate({
      chain: 'base',
      token: 'USDC',
      amount: '0.05',
      payTo: EVM_PAY_TO,
      accept: [{ chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO }],
    })
    await expect(gate.challenge()).rejects.toThrow(/EITHER .*OR|not both/)
  })

  it('errors when neither form is provided', async () => {
    const gate = createPaymentGate({ payTo: EVM_PAY_TO })
    await expect(gate.challenge()).rejects.toThrow(/provide either/)
  })

  it('errors when an option has no payTo and there is no top-level fallback', async () => {
    const gate = createPaymentGate({ accept: [{ chain: 'base', token: 'USDC', amount: '0.05' }] })
    await expect(gate.challenge()).rejects.toThrow(/no payTo/)
  })

  it('falls back to the top-level payTo when an option omits it', async () => {
    const gate = createPaymentGate({
      accept: [{ chain: 'base', token: 'USDC', amount: '0.05' }],
      payTo: EVM_PAY_TO,
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    expect(accept.payTo).toBe(EVM_PAY_TO)
  })
})

describe('multi-chain accepts — verify routing (no RPC needed)', () => {
  it('rejects a proof claiming a network the gate does not offer', async () => {
    const gate = multiGate()
    const accept = (await gate.challenge()).challenge.accepts[0]!
    // Forge a proof claiming an un-offered network.
    const sig = buildSignatureHeader({
      x402Version: 2,
      accepted: { ...accept, network: 'eip155:1' },
      payload: { nonce: accept.extra.nonce, txHash: `0x${'a'.repeat(64)}` },
    })
    const res = await gate.verify(sig)
    expect(res).toMatchObject({ kind: 'invalid', error: 'transfer_not_found' })
    if (res.kind === 'invalid') {
      expect(res.detail).toMatch(/eip155:8453/) // lists what IS offered
      expect(res.detail).toMatch(/solana:/)
    }
  })

  it('rejects an already-redeemed proof on an offered network before any RPC', async () => {
    const gate = createPaymentGate({
      accept: [{ chain: 'base', token: 'USDC', amount: '0.05', payTo: EVM_PAY_TO }],
      isUsed: () => true,
      markUsed: () => {},
    })
    const accept = (await gate.challenge()).challenge.accepts[0]!
    const sig = buildSignatureHeader({
      x402Version: 2,
      accepted: accept,
      payload: { nonce: accept.extra.nonce, txHash: `0x${'b'.repeat(64)}` },
    })
    expect(await gate.verify(sig)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
})
