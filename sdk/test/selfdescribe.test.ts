import { describe, it, expect } from 'vitest'
import {
  buildSelfDescription,
  buildEndpointInfo,
  BRAND,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type X402UptoAcceptEntry,
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

const uptoRail: X402UptoAcceptEntry = {
  scheme: 'upto',
  network: 'eip155:8453',
  amount: '50000', // the authorized MAX (0.05 USDC)
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: PAYTO, amountFormatted: '0.05', symbol: 'USDC', decimals: 6 },
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

  it('upto rail: described with scheme `upto`, the MAX amount, and a rail-specific `how`', () => {
    const sd = buildSelfDescription({ accepts: [uptoRail, onchainProof] })
    expect(sd.pay.map((r) => r.scheme)).toEqual(['upto', 'onchain-proof'])
    expect(sd.pay[0]).toMatchObject({ scheme: 'upto', amount: '50000', asset: USDC, symbol: 'USDC' })
    expect(sd.pay[0]!.how).toBeTruthy() // a non-empty how-text (the metered rail is explained)
    // verifiableReceipts gating is independent of the rail set (additive, off by default).
    expect('verifiableReceipts' in buildSelfDescription({ accepts: [uptoRail] })).toBe(false)
    expect(buildSelfDescription({ accepts: [uptoRail], verifiableReceipts: true }).verifiableReceipts).toBe(true)
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

  it('does not throw on an accept missing `extra` (foreign/odd input — bug-hunt hardening)', () => {
    const bad = {
      scheme: 'onchain-proof',
      network: 'eip155:1',
      amount: '5',
      asset: 'native',
      payTo: '0xX',
      maxTimeoutSeconds: 600,
    } as unknown as X402AcceptEntry // deliberately no `extra`
    const sd = buildSelfDescription({ accepts: [bad] })
    expect(sd.pay).toHaveLength(1)
    expect(sd.pay[0]).toMatchObject({ scheme: 'onchain-proof', amount: '5', asset: 'native' })
    expect(sd.pay[0]!.amountFormatted).toBeUndefined()
    expect(sd.pay[0]!.symbol).toBeUndefined()
  })

  it('omits `endpoint` by default (zero-config 402 stays byte-identical)', () => {
    const sd = buildSelfDescription({ accepts: [onchainProof] })
    expect('endpoint' in sd).toBe(false)
  })

  it('omits `verifiableReceipts` by default (byte-identical), present + true only when receipts on', () => {
    expect('verifiableReceipts' in buildSelfDescription({ accepts: [onchainProof] })).toBe(false)
    expect(
      'verifiableReceipts' in buildSelfDescription({ accepts: [onchainProof], verifiableReceipts: false })
    ).toBe(false)
    expect(buildSelfDescription({ accepts: [onchainProof], verifiableReceipts: true }).verifiableReceipts).toBe(true)
  })

  it('includes an `endpoint` block when one is provided (agent-readability)', () => {
    const sd = buildSelfDescription({
      accepts: [onchainProof],
      endpoint: {
        summary: 'Current USD price for any crypto ticker',
        method: 'GET',
        mimeType: 'application/json',
        input: { symbol: { type: 'string' } },
        output: { type: 'json', example: { symbol: 'ETH', usd: 3247.18 } },
      },
    })
    expect(sd.endpoint).toMatchObject({
      summary: 'Current USD price for any crypto ticker',
      method: 'GET',
      mimeType: 'application/json',
      input: { symbol: { type: 'string' } },
      output: { type: 'json', example: { symbol: 'ETH', usd: 3247.18 } },
    })
  })
})

describe('buildEndpointInfo — assemble what-the-endpoint-does', () => {
  it('returns undefined when nothing was described (byte-identical default)', () => {
    expect(buildEndpointInfo({})).toBeUndefined()
    expect(buildEndpointInfo({ descriptor: {} })).toBeUndefined()
  })

  it('uses the gate description as the summary', () => {
    expect(buildEndpointInfo({ description: 'Weather by lat/lon' })).toEqual({ summary: 'Weather by lat/lon' })
  })

  it('a descriptor summary overrides the gate description; method is upper-cased', () => {
    const ep = buildEndpointInfo({
      description: 'fallback',
      mimeType: 'application/json',
      descriptor: { summary: 'precise', method: 'post', queryParams: { q: { type: 'string' } }, output: { type: 'json', example: { ok: true } } },
    })
    expect(ep).toEqual({
      summary: 'precise',
      method: 'POST',
      mimeType: 'application/json',
      input: { q: { type: 'string' } },
      output: { type: 'json', example: { ok: true } },
    })
  })

  it('omits empty input (a no-param GET descriptor)', () => {
    const ep = buildEndpointInfo({ descriptor: { method: 'GET', queryParams: {} } })
    expect(ep).toEqual({ method: 'GET' })
    expect(ep && 'input' in ep).toBe(false)
  })
})

describe('dynamicInfoFields safety (#2655) — the self-describe block emits NO per-response dynamic field', () => {
  it('two builds with identical input are DEEP-EQUAL (no nonce/timestamp/per-call value)', () => {
    const a = buildSelfDescription({ accepts: [exactRail, onchainProof], instruction: 'pay 0.01 USDC on Base' })
    const b = buildSelfDescription({ accepts: [exactRail, onchainProof], instruction: 'pay 0.01 USDC on Base' })
    expect(a).toEqual(b)
    // identical input → byte-identical serialization. The day someone adds a per-call value
    // (a nonce/timestamp) here, THIS fails — forcing the dynamicInfoFields decision.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does NOT leak the accept-level nonce into the block (railOf strips it)', () => {
    // onchainProof carries extra.nonce 'n1' — a per-challenge value that must NOT land in
    // long-lived self-describe metadata, or an official echo-validator would false-reject it.
    const sd = buildSelfDescription({ accepts: [onchainProof] })
    // The dynamic VALUE must not leak. (The static `how` instruction legitimately contains the
    // WORD "nonce" — "...carrying the proof ref + nonce" — which is fine; it's not a per-call value.)
    expect(JSON.stringify(sd)).not.toContain('"n1"')
    expect(JSON.stringify(sd)).not.toContain('n1')
  })

  it('a verbatim echo is a subset of itself; DELETING an advertised key breaks the subset (extension_echo_mismatch)', () => {
    // Mirror the official `objectContainsSubset` rule: the client echo must CONTAIN every
    // advertised field (append OK, delete/change NOT). A static block echoed verbatim passes.
    const sd = buildSelfDescription({ accepts: [exactRail] }) as unknown as Record<string, unknown>
    const subset = (exp: unknown, act: unknown): boolean => {
      if (exp === null || typeof exp !== 'object') return exp === act
      if (act === null || typeof act !== 'object') return false
      return Object.entries(exp as Record<string, unknown>).every(([k, v]) =>
        k in (act as Record<string, unknown>) ? subset(v, (act as Record<string, unknown>)[k]) : v === undefined,
      )
    }
    expect(subset(sd, { ...sd })).toBe(true) // verbatim echo passes
    const deleted = { ...sd }
    delete deleted.what // a client dropping an advertised field
    expect(subset(sd, deleted)).toBe(false) // → would be extension_echo_mismatch
  })
})
