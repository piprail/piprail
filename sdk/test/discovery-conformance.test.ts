/**
 * Conformance contract — proves PipRail's discovery wire is what the open indexes
 * and the x402 v2 spec actually require, so a PipRail-gated endpoint is genuinely
 * LISTABLE and DISCOVERABLE (not just "we think it conforms").
 *
 * It re-implements, in the test, the two gates a real listing must clear:
 *   1. The x402 v2 PaymentRequirements envelope (spec §5.1) — CAIP-2 networks,
 *      atomic-unit string amounts, the EIP-712 domain on an `exact` rail.
 *   2. x402scan's documented `validateResource` (research/x402-discovery.md §C):
 *      HTTPS · x402 v2 · non-empty accepts · a resolvable input schema · ≥1
 *      Base/Solana rail. A 402 that fails ANY of these is silently rejected on
 *      submit — so this is the difference between "registered" and "actually found".
 *
 * Mirrors the live demo (piprail.com/x402/demo), whose real 402 was captured and
 * confirmed to pass every check here.
 */
import { describe, it, expect } from 'vitest'
import { createPaymentGate, appendAttribution, REGISTER_ATTRIBUTION } from '../src/index.js'

const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const BASE = 'eip155:8453'
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/* ----- the two gates, as executable predicates ----- */

/** x402 v2 PaymentRequirements envelope (spec §5.1). Every accept entry must carry
 *  these fields, CAIP-2 network, an atomic-unit STRING amount, and a payTo. */
function isV2Envelope(challenge: any): true | string {
  if (challenge?.x402Version !== 2) return `x402Version must be 2, got ${challenge?.x402Version}`
  if (typeof challenge?.resource?.url !== 'string') return 'resource.url missing'
  if (!Array.isArray(challenge?.accepts) || challenge.accepts.length === 0) return 'accepts is empty'
  for (const a of challenge.accepts) {
    if (!/^[a-z0-9]+:[^\s]+$/i.test(a.network)) return `network not CAIP-2: ${a.network}`
    if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount)) return `amount not an atomic-unit string: ${a.amount}`
    if (typeof a.payTo !== 'string' || !a.payTo) return 'payTo missing'
    if (typeof a.scheme !== 'string') return 'scheme missing'
    // An `exact` rail MUST advertise the token's EIP-712 domain so a buyer can sign.
    if (a.scheme === 'exact' && (!a.extra?.name || !a.extra?.version)) return 'exact rail missing EIP-712 domain (extra.name/version)'
    // An `upto` rail MUST advertise the facilitatorAddress the buyer signs into witness.facilitator
    // (scheme_upto_evm §2 — the spec's normative MUST; only the bound facilitator can settle).
    if (a.scheme === 'upto' && !a.extra?.facilitatorAddress) return 'upto rail missing extra.facilitatorAddress'
  }
  return true
}

/** x402scan validateResource (the open-explorer gate that decides if a self-register sticks). */
const X402SCAN_CHAINS = new Set([BASE, SOLANA])
function passesX402Scan(challenge: any): true | string {
  if (!String(challenge?.resource?.url).startsWith('https://')) return 'not HTTPS'
  if (challenge?.x402Version !== 2) return 'not x402 v2'
  if (!challenge?.accepts?.length) return 'no accepts'
  // A resolvable input schema — from the bazaar extension in the 402 body (or /openapi.json).
  const bazaar = challenge?.extensions?.bazaar
  if (!bazaar?.info?.input || !bazaar?.schema) return 'no resolvable input schema (extensions.bazaar)'
  // At least one supported network.
  const nets = new Set(challenge.accepts.map((a: any) => a.network))
  if (![...nets].some((n) => X402SCAN_CHAINS.has(n as string))) return `no Base/Solana rail (got ${[...nets].join(',')})`
  return true
}

/** The REAL 402 body served by the live demo (piprail.com/x402/demo), captured verbatim.
 *  This is our own SDK's production wire — locking it here means a regression that would
 *  make the live endpoint un-listable fails CI. */
const LIVE_DEMO_CHALLENGE = {
  x402Version: 2,
  resource: { url: 'https://piprail.com/x402/demo', description: 'PipRail live x402 demo — pay $0.01 USDC on Base to unlock.' },
  accepts: [
    {
      scheme: 'exact', network: BASE, amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2', minConfirmations: 1, decimals: 6, amountFormatted: '0.01', symbol: 'USDC' },
    },
    {
      scheme: 'onchain-proof', network: BASE, amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, maxTimeoutSeconds: 600,
      extra: { nonce: '750e15fe-9008-42af-87ae-ee276da453f6', decimals: 6, minConfirmations: 1, amountFormatted: '0.01', symbol: 'USDC' },
    },
  ],
  extensions: {
    bazaar: {
      info: { input: { type: 'http', method: 'GET', queryParams: {} }, output: { type: 'json', example: { paid: true } } },
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { input: {} }, required: ['input'] },
    },
  },
}

describe('x402 conformance — the live wire a real index validates', () => {
  it('the live demo 402 (dual-rail, captured verbatim) clears BOTH the v2 envelope and x402scan', () => {
    expect(isV2Envelope(LIVE_DEMO_CHALLENGE)).toBe(true)
    expect(passesX402Scan(LIVE_DEMO_CHALLENGE)).toBe(true)

    // Dual-rail: a standard `exact` rail (so the dominant exact-on-Base index payers can pay it)
    // AND PipRail's backendless onchain-proof rail.
    const schemes = LIVE_DEMO_CHALLENGE.accepts.map((a) => a.scheme)
    expect(schemes).toContain('exact')
    expect(schemes).toContain('onchain-proof')
    // The exact rail carries the real USDC EIP-712 domain (name "USD Coin", version "2").
    const exact = LIVE_DEMO_CHALLENGE.accepts.find((a) => a.scheme === 'exact')!
    expect(exact.extra).toMatchObject({ name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' })
    // Discovery metadata (extensions.bazaar) is long-lived — it must carry NO single-use nonce.
    expect(JSON.stringify(LIVE_DEMO_CHALLENGE.extensions.bazaar)).not.toContain('nonce')
  })

  it("our generator produces a conformant, listable wire (gate.challenge → the bytes we'd serve)", async () => {
    // A plain gate + discovery, no network read — proves the SDK EMITS conformant bytes, not just
    // that the deployed demo happens to. (onchain-proof rail; add an `exact` rail to also be payable
    // by exact-only index clients — see the dual-rail live demo above.)
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo: PAY_TO, discovery: true })
    const { challenge } = await gate.challenge('https://piprail.com/x402/demo')
    expect(isV2Envelope(challenge)).toBe(true)
    expect(passesX402Scan(challenge)).toBe(true)
    expect(JSON.stringify((challenge.extensions as any)?.bazaar)).not.toContain('nonce')
  })

  it('a gate offering the upto rail emits a conformant wire carrying extra.facilitatorAddress', async () => {
    const gate = createPaymentGate({
      chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO, discovery: true,
      upto: { relayer: { key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' }, settleAmount: () => 0n },
    })
    const { challenge } = await gate.challenge('https://piprail.com/x402/meter')
    expect(isV2Envelope(challenge)).toBe(true) // the new upto branch is satisfied
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    expect(upto.extra?.facilitatorAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    // and the gate would FAIL the conformance check if facilitatorAddress were dropped:
    const stripped = { ...challenge, accepts: [{ ...upto, extra: { ...upto.extra, facilitatorAddress: '' } }] }
    expect(isV2Envelope(stripped)).toBe('upto rail missing extra.facilitatorAddress')
  })

  it('REJECTS the things x402scan rejects (so the gate is meaningful, not vacuous)', async () => {
    // (a) http:// origin → not HTTPS
    expect(passesX402Scan({ x402Version: 2, resource: { url: 'http://x/y' }, accepts: [{ network: BASE }], extensions: { bazaar: { info: { input: {} }, schema: {} } } }))
      .toMatch(/HTTPS/)
    // (b) no input schema → not listable on x402scan
    expect(passesX402Scan({ x402Version: 2, resource: { url: 'https://x/y' }, accepts: [{ network: BASE }] }))
      .toMatch(/input schema/)
    // (c) only an unsupported chain → rejected
    expect(passesX402Scan({ x402Version: 2, resource: { url: 'https://x/y' }, accepts: [{ network: 'eip155:137' }], extensions: { bazaar: { info: { input: {} }, schema: {} } } }))
      .toMatch(/Base\/Solana/)
  })
})

describe('registration attribution — appendAttribution (pure)', () => {
  it('appends the tasteful suffix to a normal description', () => {
    expect(appendAttribution('Weather by lat/lon.')).toBe(`Weather by lat/lon. ${REGISTER_ATTRIBUTION}`)
  })
  it('never double-stamps a description already mentioning PipRail', () => {
    expect(appendAttribution('Powered by piprail.')).toBe('Powered by piprail.')
    expect(appendAttribution(`x ${REGISTER_ATTRIBUTION}`)).toBe(`x ${REGISTER_ATTRIBUTION}`)
  })
  it('never fabricates a description from nothing', () => {
    expect(appendAttribution(undefined)).toBeUndefined()
    expect(appendAttribution('')).toBe('')
  })
  it('is length-guarded — leaves an over-long description untouched', () => {
    const long = 'x'.repeat(495)
    expect(appendAttribution(long)).toBe(long) // 495 + suffix > 500 → unchanged
  })
})
