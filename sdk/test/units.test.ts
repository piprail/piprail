import { describe, it, expect } from 'vitest'
import { parseUnits, formatUnits, floorUnits, MAX_DECIMALS } from '../src/util/units.js'

describe('parseUnits', () => {
  it('parses decimals into base units', () => {
    expect(parseUnits('0.05', 6)).toBe(50_000n)
    expect(parseUnits('1', 18)).toBe(1_000_000_000_000_000_000n)
    expect(parseUnits('0', 6)).toBe(0n)
    expect(parseUnits('123', 0)).toBe(123n)
  })
  it('throws on malformed input, excess precision, or invalid decimals', () => {
    expect(() => parseUnits('0.001', 2)).toThrow(/decimal places/)
    expect(() => parseUnits('-1', 6)).toThrow(/decimal/)
    expect(() => parseUnits('abc', 6)).toThrow(/decimal/)
    expect(() => parseUnits('1', -1)).toThrow(/decimals/) // negative decimals
    expect(() => parseUnits('1', 1.5)).toThrow(/decimals/) // non-integer decimals
  })
})

describe('formatUnits', () => {
  it('is the inverse of parseUnits, trimming trailing zeros', () => {
    expect(formatUnits(50_000n, 6)).toBe('0.05')
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(formatUnits(0n, 6)).toBe('0')
    expect(formatUnits(5n, 0)).toBe('5')
    expect(formatUnits(1n, 6)).toBe('0.000001') // smallest unit
    expect(formatUnits(100n, 6)).toBe('0.0001')
    expect(() => formatUnits(1n, -1)).toThrow(/decimals/) // invalid decimals
  })
  it('round-trips for a spread of values', () => {
    for (const [v, d] of [['0.05', 6], ['1', 18], ['1234.5678', 6], ['0.000001', 6], ['9999999', 6]] as const) {
      expect(formatUnits(parseUnits(v, d), d)).toBe(v)
    }
  })
})

describe('floorUnits — tolerant cap parsing for spend policy', () => {
  it('matches parseUnits when precision fits', () => {
    expect(floorUnits('0.05', 6)).toBe(50_000n)
    expect(floorUnits('5', 2)).toBe(500n)
  })
  it('truncates (floors) finer precision instead of throwing', () => {
    expect(floorUnits('0.001', 2)).toBe(0n) // below the smallest unit → 0
    expect(floorUnits('0.105', 2)).toBe(10n) // 0.105 → 0.10
    expect(floorUnits('0.059', 2)).toBe(5n) // floors down (the safe direction for a ceiling)
  })
  it('still rejects a malformed / negative amount', () => {
    expect(() => floorUnits('-1', 2)).toThrow()
    expect(() => floorUnits('1.2.3', 2)).toThrow()
    expect(() => floorUnits('1', -1)).toThrow(/decimals/) // invalid decimals
  })
})

describe('scientific notation — XRPL rippled serializes IOU balances as e/E (must not throw → false null)', () => {
  it('floorUnits expands e-notation losslessly, then truncates to the token scale', () => {
    expect(floorUnits('5e-7', 6)).toBe(0n) // 0.0000005 < 1e-6 → 0 base units (same as the plain form)
    expect(floorUnits('1E-7', 6)).toBe(0n)
    expect(floorUnits('2.569903e-12', 6)).toBe(0n) // realistic rippled dust string
    expect(floorUnits('1.23e11', 6)).toBe(123_000_000_000_000_000n) // 123000000000 × 10^6
    expect(floorUnits('1e3', 6)).toBe(1_000_000_000n) // 1000 × 10^6
  })
  it('parseUnits REJECTS e-notation (a MERCHANT amount like "1e3" must NOT be read as 1000 tokens — F-B1)', () => {
    // floorUnits expands e-notation (it reads hostile RPC dust); parseUnits is the MERCHANT-amount
    // path and must reject scientific notation as a plain-decimal violation — the silent-1000×-charge footgun.
    expect(() => parseUnits('1e3', 6)).toThrow(/scientific notation/)
    expect(() => parseUnits('1.23e11', 6)).toThrow(/scientific notation/)
    expect(() => parseUnits('5e-7', 18)).toThrow(/scientific notation/)
    expect(() => parseUnits('1e2000', 6)).toThrow(/scientific notation/) // no expansion → no DoS, just a clean reject
  })
  it('parseUnits rejects a non-STRING amount with a clear typed error (not "value.split is not a function" — F-C2a)', () => {
    // @ts-expect-error — deliberately passing a number to assert the runtime guard
    expect(() => parseUnits(0.05, 6)).toThrow(/amount must be a decimal STRING/)
  })
  it('a negative-mantissa e-notation (issuer liability) is still rejected by floorUnits — the safe "unavailable" read', () => {
    expect(() => floorUnits('-8000000000000000e-27', 6)).toThrow(/decimal amount/)
  })
  it('DoS guard: floorUnits throws on an absurd exponent (no multi-GB string); parseUnits never expands it', () => {
    expect(() => floorUnits('9e999999999', 6)).toThrow(/exponent out of range/)
  })
})

describe('decimals upper bound — OOM/DoS guard (2.9.0)', () => {
  it('accepts decimals up to MAX_DECIMALS (covers every real token)', () => {
    expect(MAX_DECIMALS).toBeGreaterThanOrEqual(24) // NEAR yoctoNEAR is the deepest real token
    expect(() => floorUnits('1', MAX_DECIMALS)).not.toThrow()
    expect(formatUnits(1n, 24)).toBe('0.000000000000000000000001')
  })
  it('REJECTS an absurd decimals (a hostile 402 stating 1e9 would allocate a multi-GB string)', () => {
    // The guard must fire BEFORE padStart/padEnd is reached — so this is fast, not an OOM.
    expect(() => floorUnits('1', 1_000_000_000)).toThrow(new RegExp(`≤ ${MAX_DECIMALS}`))
    expect(() => formatUnits(1n, 1_000_000_000)).toThrow(/decimals/)
    expect(() => parseUnits('1', MAX_DECIMALS + 1)).toThrow(/decimals/)
  })
})
