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

  it('every entry is internally consistent: keyless, exact-only, and a settle method that matches its chain family', () => {
    // The `family → expected settle method(s)` contract. This makes the method-BLIND
    // `firstKeylessFacilitator(network)` pick in server.ts safe BY CONSTRUCTION: since every
    // facilitator seeded under a CAIP-2 key settles that family's method, picking [0] (any of them)
    // always yields a facilitator that can settle the rail the driver will resolve for that chain.
    const familyMethods: Record<string, ReadonlyArray<string>> = {
      eip155: ['eip3009', 'permit2'], // EVM
      solana: ['svm'],
      algorand: ['algorand'],
      aptos: ['aptos'],
    }
    for (const [network, facs] of Object.entries(KNOWN_FACILITATORS)) {
      const namespace = network.split(':')[0]!
      const allowed = familyMethods[namespace]
      expect(allowed, `no expected settle method for namespace "${namespace}" (seed under an unknown family?)`).toBeDefined()
      for (const f of facs) {
        // All seeded facilitators are keyless (no API key → sponsors gas for BOTH sides) and exact-only.
        expect(f.keyless, `${f.url} on ${network} must be keyless`).toBe(true)
        expect([...f.schemes]).toEqual(['exact'])
        // Every settle method must belong to this chain's family — no cross-family paste.
        for (const m of f.settles) {
          expect(allowed, `${f.url} settles "${m}" which is not valid for ${namespace}`).toContain(m)
        }
        // THE RULE: each entry carries a dated live-settle note with a tx reference.
        expect(typeof f.note).toBe('string')
        expect(f.note, `${f.url} on ${network} needs a dated live-settle note`).toMatch(/202\d-\d\d-\d\d|tx /i)
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

  it('reads optional x402Version (top-level) + extra.assetTransferMethod when present (additive)', () => {
    const body = {
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:56' }, // AEON-shaped BNB kind
        { scheme: 'exact', network: 'eip155:8453', extra: { assetTransferMethod: 'eip3009' } },
      ],
    }
    const kinds = parseFacilitatorSupported(body)
    expect(kinds[0]).toMatchObject({ scheme: 'exact', network: 'eip155:56', x402Version: 2 })
    expect(kinds[1]).toMatchObject({ scheme: 'exact', network: 'eip155:8453', assetTransferMethod: 'eip3009' })
  })

  it('omits x402Version / assetTransferMethod ENTIRELY when absent (no undefined keys leak)', () => {
    const [k] = parseFacilitatorSupported({ kinds: [{ scheme: 'exact', network: 'eip155:8453' }] })
    expect(k).toEqual({ scheme: 'exact', network: 'eip155:8453' }) // strict — additive, no extra keys
    expect('x402Version' in k!).toBe(false)
    expect('assetTransferMethod' in k!).toBe(false)
  })

  it('returns [] (never throws) on malformed / empty bodies', () => {
    expect(parseFacilitatorSupported(null)).toEqual([])
    expect(parseFacilitatorSupported({})).toEqual([])
    expect(parseFacilitatorSupported({ kinds: 'nope' })).toEqual([])
    expect(parseFacilitatorSupported({ kinds: [null, 42, { scheme: 'exact' }, { network: 'x' }] })).toEqual([])
    expect(parseFacilitatorSupported('garbage')).toEqual([])
  })
})
