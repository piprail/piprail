import { describe, it, expect } from 'vitest'
import {
  KNOWN_FACILITATORS,
  knownFacilitatorsFor,
  firstKeylessFacilitator,
  parseFacilitatorSupported,
} from '../src/index.js'

describe('KNOWN_FACILITATORS (seed data)', () => {
  it('every entry is well-formed: CAIP-2 key, non-empty url, boolean keyless, non-empty schemes', () => {
    const entries = Object.entries(KNOWN_FACILITATORS)
    expect(entries.length).toBeGreaterThan(0)
    for (const [network, facs] of entries) {
      expect(network).toMatch(/^[a-z0-9]+:.+/i) // CAIP-2 namespace:reference
      expect(facs.length).toBeGreaterThan(0)
      for (const f of facs) {
        expect(typeof f.url).toBe('string')
        expect(f.url.length).toBeGreaterThan(0)
        expect(f.url).not.toMatch(/\/$/) // no trailing slash
        expect(typeof f.keyless).toBe('boolean')
        expect(f.schemes.length).toBeGreaterThan(0)
        expect(f.settles.length).toBeGreaterThan(0)
      }
    }
  })

  it('does NOT seed x402.org as a mainnet facilitator (it is Base Sepolia)', () => {
    const allUrls = Object.values(KNOWN_FACILITATORS).flat().map((f) => f.url)
    expect(allUrls.some((u) => u.includes('x402.org'))).toBe(false)
  })

  it('seeds PayAI keyless for Base (eip3009) and Solana (svm)', () => {
    const base = knownFacilitatorsFor('eip155:8453')
    expect(base.some((f) => f.url.includes('payai') && f.settles.includes('eip3009') && f.keyless)).toBe(true)
    const sol = knownFacilitatorsFor('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(sol.some((f) => f.url.includes('payai') && f.settles.includes('svm') && f.keyless)).toBe(true)
  })
})

describe('knownFacilitatorsFor / firstKeylessFacilitator', () => {
  it('returns [] / undefined for an unknown network', () => {
    expect(knownFacilitatorsFor('eip155:999999' as `${string}:${string}`)).toEqual([])
    expect(firstKeylessFacilitator('eip155:999999' as `${string}:${string}`)).toBeUndefined()
  })

  it('returns the seeded keyless facilitator for a known network', () => {
    const f = firstKeylessFacilitator('eip155:8453')
    expect(f?.url).toContain('payai')
    expect(f?.keyless).toBe(true)
  })

  it('honours the method filter', () => {
    expect(firstKeylessFacilitator('eip155:8453', 'eip3009')?.url).toContain('payai')
    // Base PayAI seed settles eip3009, not svm → no match for svm on Base
    expect(firstKeylessFacilitator('eip155:8453', 'svm')).toBeUndefined()
    expect(firstKeylessFacilitator('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'svm')?.url).toContain('payai')
  })
})

describe('parseFacilitatorSupported', () => {
  it('parses a PayAI-shaped /supported body into kinds', () => {
    const body = {
      kinds: [
        { scheme: 'exact', network: 'eip155:8453' },
        { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer: 'Fee111' } },
      ],
    }
    const kinds = parseFacilitatorSupported(body)
    expect(kinds).toHaveLength(2)
    expect(kinds[0]).toEqual({ scheme: 'exact', network: 'eip155:8453' })
    expect(kinds[1]).toMatchObject({ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', feePayer: 'Fee111' })
  })

  it('returns [] (never throws) on malformed / empty bodies', () => {
    expect(parseFacilitatorSupported(null)).toEqual([])
    expect(parseFacilitatorSupported({})).toEqual([])
    expect(parseFacilitatorSupported({ kinds: 'nope' })).toEqual([])
    expect(parseFacilitatorSupported({ kinds: [null, 42, { scheme: 'exact' }, { network: 'x' }] })).toEqual([])
    expect(parseFacilitatorSupported('garbage')).toEqual([])
  })
})
