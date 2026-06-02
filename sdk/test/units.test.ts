import { describe, it, expect } from 'vitest'
import { parseUnits, formatUnits, floorUnits } from '../src/util/units.js'

describe('parseUnits', () => {
  it('parses decimals into base units', () => {
    expect(parseUnits('0.05', 6)).toBe(50_000n)
    expect(parseUnits('1', 18)).toBe(1_000_000_000_000_000_000n)
    expect(parseUnits('0', 6)).toBe(0n)
    expect(parseUnits('123', 0)).toBe(123n)
  })
  it('throws on malformed input or excess precision', () => {
    expect(() => parseUnits('0.001', 2)).toThrow(/decimal places/)
    expect(() => parseUnits('-1', 6)).toThrow(/decimal/)
    expect(() => parseUnits('abc', 6)).toThrow(/decimal/)
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
  })
})
