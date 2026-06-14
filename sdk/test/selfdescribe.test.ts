import { describe, it, expect } from 'vitest'
import {
  buildSelfDescription,
  BRAND,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
} from '../src/index.js'

const PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const onchainProof: X402AcceptEntry = {
  scheme: 'onchain-proof',
  network: 'eip155:8453',
  amount: '10000',
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.01', symbol: 'USDC' },
}

const exactRail: X402ExactAcceptEntry = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '10000',
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: 'eip3009', amountFormatted: '0.01', symbol: 'USDC', decimals: 6 },
}

describe('buildSelfDescription', () => {
  it('onchain-proof-only: identity + one rail + sdk/mcp/docs/discovery present', () => {
    const sd = buildSelfDescription({ accepts: [onchainProof] })
    expect(sd.name).toBe('PipRail')
    expect(sd.protocol).toBe('x402')
    expect(sd.version).toBe('2')
    expect(sd.pay).toHaveLength(1)
    expect(sd.pay[0]).toMatchObject({
      scheme: 'onchain-proof',
      network: 'eip155:8453',
      asset: USDC,
      payTo: PAYTO,
      amount: '10000',
      amountFormatted: '0.01',
      symbol: 'USDC',
    })
    expect(sd.sdk.install).toBe('npm i @piprail/sdk')
    expect(sd.sdk.snippet).toContain('@piprail/sdk')
    expect(sd.mcp).toEqual({ run: 'npx -y @piprail/mcp', tool: 'piprail_pay_request' })
    expect(sd.docs.home).toBe(BRAND.home)
    expect(sd.discovery).toEqual({ openapi: '/openapi.json', wellKnown: '/.well-known/x402' })
  })

  it('dual-rail: exact first, then onchain-proof — both described, rail-specific `how`', () => {
    const sd = buildSelfDescription({ accepts: [exactRail, onchainProof] })
    expect(sd.pay.map((r) => r.scheme)).toEqual(['exact', 'onchain-proof'])
    expect(sd.pay[0]!.how).toMatch(/standard x402/i)
    expect(sd.pay[1]!.how).toMatch(/@piprail\/sdk/i)
  })

  it('multi-chain: a rail per accept, mirroring network/asset', () => {
    const sol: X402AcceptEntry = {
      scheme: 'onchain-proof',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '10000',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: 'So11111111111111111111111111111111111111112',
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n2', decimals: 6, minConfirmations: 1, amountFormatted: '0.01', symbol: 'USDC' },
    }
    const sd = buildSelfDescription({ accepts: [onchainProof, sol] })
    expect(sd.pay.map((r) => r.network)).toEqual([
      'eip155:8453',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    ])
  })

  // AUDIT MUST-ADD: the families with no standard `exact` rail (XRPL/TON/NEAR/…) rely
  // on this block as their ENTIRE interop story — it must render correctly for an
  // onchain-proof-only, native-coin 402, with a chain-agnostic `how`.
  it('non-EVM onchain-proof-only (native coin): block is the entire interop story', () => {
    const xrpl: X402AcceptEntry = {
      scheme: 'onchain-proof',
      network: 'xrpl:0',
      amount: '10000',
      asset: 'native',
      payTo: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n3', decimals: 6, minConfirmations: 1, amountFormatted: '0.01', symbol: 'XRP' },
    }
    const sd = buildSelfDescription({ accepts: [xrpl] })
    expect(sd.pay).toHaveLength(1)
    expect(sd.pay[0]).toMatchObject({ scheme: 'onchain-proof', asset: 'native', symbol: 'XRP', network: 'xrpl:0' })
    // the `how` must be chain-agnostic (no EVM/exact assumption) and point at the SDK
    expect(sd.pay[0]!.how).not.toMatch(/eip-?3009|permit2|\bevm\b/i)
    expect(sd.pay[0]!.how).toMatch(/@piprail\/sdk/i)
  })

  it('terse: the serialized block stays small (additive-metadata size budget)', () => {
    const sd = buildSelfDescription({ accepts: [exactRail, onchainProof], instruction: 'pay 0.01 USDC on Base' })
    expect(JSON.stringify(sd).length).toBeLessThan(2048)
    expect(sd.instruction).toBe('pay 0.01 USDC on Base')
  })

  it('omits amountFormatted/symbol when the accept has none', () => {
    const bare: X402AcceptEntry = {
      scheme: 'onchain-proof',
      network: 'eip155:1',
      amount: '5',
      asset: 'native',
      payTo: PAYTO,
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n4', decimals: 18, minConfirmations: 1, amountFormatted: '0.000000000000000005' },
    }
    const sd = buildSelfDescription({ accepts: [bare] })
    expect(sd.pay[0]!.symbol).toBeUndefined()
    expect('instruction' in sd).toBe(false) // none passed → omitted
  })
})
