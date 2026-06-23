// Contract tests for the 2.14.1 break-it fixes (found by the live-artifact adversarial pass —
// examples/basics/x402-parity-sandbox/FINDINGS.md). Each asserts the FIXED behaviour.
import { describe, it, expect } from 'vitest'
import {
  classifyChallenge,
  describeChallenge,
  buildWellKnownX402Manifest,
  createPaymentGate,
  DIRECTORY_INFO,
  InvalidConfigError,
  PipRailError,
} from '../src/index.js'
import type { X402Challenge } from '../src/index.js'

const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const opts = { network: 'eip155:8453' as const, schemes: ['onchain-proof'] as const }

describe('F-A1 — classifyChallenge never throws (documented contract)', () => {
  it('a nullish / shapeless challenge degrades to NO_RAIL, never a TypeError', () => {
    for (const bad of [null, undefined, {}, { accepts: null }, { accepts: undefined }, 'nope', 42]) {
      let v
      expect(() => { v = classifyChallenge(bad as unknown as X402Challenge, opts) }).not.toThrow()
      expect(v).toMatchObject({ verdict: 'NO_RAIL', onClientChain: false, payableScheme: false })
    }
  })
  it('a nullish opts also degrades, never throws', () => {
    expect(() => classifyChallenge({ accepts: [] } as unknown as X402Challenge, undefined as never)).not.toThrow()
  })
})

describe('F-A2 — describeChallenge never throws (degrades to a generic pointer)', () => {
  it('null / {} / {accepts:null|undefined} all return the generic pointer string', () => {
    for (const bad of [null, undefined, {}, { accepts: null }, { accepts: undefined }, { accepts: [] }]) {
      let s = ''
      expect(() => { s = describeChallenge(bad as unknown as X402Challenge) }).not.toThrow()
      expect(typeof s).toBe('string')
      expect(s).toMatch(/x402 payment endpoint/)
    }
  })
})

describe('F-B1 — createPaymentGate rejects a scientific-notation amount (no silent 1000× charge)', () => {
  it("amount '1e3' is rejected with a typed InvalidConfigError, never read as 1000 tokens", async () => {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '1e3', payTo: PAY_TO })
    await expect(gate.challenge('http://127.0.0.1:1/r')).rejects.toBeInstanceOf(InvalidConfigError)
  })
  it("a plain decimal still works (0.05 USDC → 50000 base units)", async () => {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const accept = (await gate.challenge('http://127.0.0.1:1/r')).challenge.accepts[0]!
    expect(accept.amount).toBe('50000')
  })
})

describe('F-C2 — invalid gate config throws a typed InvalidConfigError (ERRORS.md §5), not a raw error', () => {
  it('a non-string (numeric) amount → InvalidConfigError, not "value.split is not a function"', async () => {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: 0.05 as unknown as string, payTo: PAY_TO })
    await expect(gate.challenge('http://127.0.0.1:1/r')).rejects.toBeInstanceOf(InvalidConfigError)
  })
  it('a missing payTo → InvalidConfigError', async () => {
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05' } as never)
    await expect(gate.challenge('http://127.0.0.1:1/r')).rejects.toBeInstanceOf(InvalidConfigError)
  })
})

describe('F-C1 / F-D4 — buildWellKnownX402Manifest validates its input', () => {
  it('a missing / non-array resources → InvalidConfigError, not "reading map"', () => {
    expect(() => buildWellKnownX402Manifest({ origin: 'https://x.com' } as never)).toThrow(InvalidConfigError)
    expect(() => buildWellKnownX402Manifest({ origin: 'https://x.com', resources: null as never })).toThrow(InvalidConfigError)
  })
  it('a non-finite lastUpdated does NOT pass through (no JSON null) — falls back to now', () => {
    const m = buildWellKnownX402Manifest({ origin: 'https://x.com', resources: [], lastUpdated: NaN })
    expect(Number.isFinite(m.lastUpdated)).toBe(true)
    expect(JSON.parse(JSON.stringify(m)).lastUpdated).not.toBeNull()
  })
  it('an explicit finite lastUpdated is deterministic', () => {
    const a = buildWellKnownX402Manifest({ origin: 'https://x.com', resources: [], lastUpdated: 1_700_000_000 })
    const b = buildWellKnownX402Manifest({ origin: 'https://x.com', resources: [], lastUpdated: 1_700_000_000 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.lastUpdated).toBe(1_700_000_000)
  })
})

describe('F-D2 — DIRECTORY_INFO is frozen (its Readonly<> type is enforced at runtime)', () => {
  it('is Object.frozen', () => {
    expect(Object.isFrozen(DIRECTORY_INFO)).toBe(true)
  })
})

describe('InvalidConfigError — typed, stable code', () => {
  it('is a PipRailError with code INVALID_CONFIG', () => {
    const e = new InvalidConfigError('x')
    expect(e).toBeInstanceOf(PipRailError)
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('INVALID_CONFIG')
  })
})
