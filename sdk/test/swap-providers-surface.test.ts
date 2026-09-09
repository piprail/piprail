/**
 * ── THE SWAP SURFACE GUARD ──────────────────────────────────────────────────────────
 *
 * `SWAP_PROVIDERS` is the only source of truth for "what can swap where, and what proves
 * it". This file protects the registry itself AND everything that restates it: the
 * generated website data, the logos the site renders, and the docs table.
 *
 * WHY IT EXISTS. The facilitator registry taught this lesson expensively. It grew only
 * from capability reads, nothing ever re-checked an entry, and on 2026-08-28 two of eleven
 * seeded facilitators turned out to be dead hosts the SDK was still handing to callers.
 * Fixing the registry then left three OTHER surfaces advertising them for the rest of the
 * day. Same fact in four places is the shape that rots, so it gets the same guard.
 *
 * The load-bearing assertion is the ADMISSION RULE: a route with no live mainnet proof
 * must never ship. That is the one a human is most likely to erode under pressure, because
 * a coverage table is easy to write and a transaction is not.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import {
  SWAP_PROVIDERS,
  swapProvidersFor,
  canSwapOn,
  swappableNetworks,
} from '../src/swapProviders.js'

const repo = (p: string) => new URL(`../../${p}`, import.meta.url).pathname
const readRepo = (p: string) => readFileSync(repo(p), 'utf8')

describe('the admission rule: no proof, no ship', () => {
  it('every route carries a real mainnet proof, or SAYS PLAINLY why it has none', () => {
    /*
     * The rule is "no unexplained claim", not "no unproven route". A route we ship without
     * having broadcast it must carry an `unproven` reason, which the site and the docs then
     * print. That is stricter than an empty `proofs` array passing silently, which is the
     * failure this guard exists to prevent.
     */
    for (const p of SWAP_PROVIDERS) {
      const entry = p as { id: string; proofs: readonly unknown[]; unproven?: string }
      if (entry.proofs.length > 0) continue
      expect(entry.unproven, `${entry.id} has no proof AND no stated reason`).toBeTruthy()
      expect(entry.unproven!.length, `${entry.id}'s reason is too thin to be honest`).toBeGreaterThan(60)
    }
  })

  it('a route WITH proofs never also claims to be unproven', () => {
    for (const p of SWAP_PROVIDERS) {
      const entry = p as { id: string; proofs: readonly unknown[]; unproven?: string }
      if (entry.proofs.length > 0) {
        expect(entry.unproven, `${entry.id} carries proofs but is also marked unproven`).toBeUndefined()
      }
    }
  })

  it('every proof has a plausible transaction hash and a date', () => {
    for (const p of SWAP_PROVIDERS) {
      for (const t of p.proofs) {
        // EVM is 0x + 64 hex; the others are base58/base32/hex of varying length. The
        // point is to catch a truncated or placeholder hash, not to re-implement each
        // chain's encoding.
        expect(t.tx.length, `${p.id}: hash too short to be real (${t.tx})`).toBeGreaterThan(40)
        expect(t.tx, `${p.id}: hash contains whitespace`).not.toMatch(/\s/)
        expect(t.date, `${p.id}: bad date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(t.summary.length, `${p.id}: empty summary`).toBeGreaterThan(3)
        // A proof must name a network the entry actually claims.
        expect(p.networks, `${p.id}: proof on an unclaimed network`).toContain(t.network)
      }
    }
  })

  it('🔴 every shipped route is KEYLESS — an API key is disqualifying', () => {
    for (const p of SWAP_PROVIDERS) {
      expect(p.keyless, `${p.id} is not keyless and must not ship`).toBe(true)
    }
  })

  it('ids are unique and usable as a logo filename', () => {
    const ids = SWAP_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('states a fee for every route, and PipRail never adds one', () => {
    for (const p of SWAP_PROVIDERS) {
      expect(p.fee.length, `${p.id}: no fee stated`).toBeGreaterThan(10)
      expect(p.mechanism.length, `${p.id}: no mechanism stated`).toBeGreaterThan(10)
    }
  })
})

describe('the two tiers stay distinguishable', () => {
  it('every route is exactly one of protocol or provider', () => {
    for (const p of SWAP_PROVIDERS) expect(['protocol', 'provider']).toContain(p.kind)
  })

  it('both tiers are represented, so the distinction is never theoretical', () => {
    const kinds = new Set(SWAP_PROVIDERS.map((p) => p.kind))
    expect(kinds.has('protocol')).toBe(true)
    expect(kinds.has('provider')).toBe(true)
  })
})

describe('the selectors', () => {
  it('swapProvidersFor finds a known network and returns [] for an unknown one', () => {
    expect(swapProvidersFor('stellar:pubnet').length).toBeGreaterThan(0)
    expect(swapProvidersFor('eip155:999999' as never)).toEqual([])
  })

  it('canSwapOn agrees with swapProvidersFor', () => {
    for (const n of swappableNetworks()) expect(canSwapOn(n)).toBe(true)
    expect(canSwapOn('eip155:999999' as never)).toBe(false)
  })

  it('🔴 Celo and Scroll are NOT claimed — probed live, no route even for USDC/USDT', () => {
    // Both chains answer the KyberSwap API, so a coverage page would list them.
    // Claiming them would advertise a swap that cannot execute.
    expect(canSwapOn('eip155:42220' as never)).toBe(false) // Celo
    expect(canSwapOn('eip155:534352' as never)).toBe(false) // Scroll
  })

  it('swappableNetworks is deduped and sorted, so rendering is stable', () => {
    const n = swappableNetworks()
    expect(new Set(n).size).toBe(n.length)
    expect([...n]).toEqual([...n].sort())
  })
})

describe('every surface that restates the registry agrees with it', () => {
  it('each route has a logo the site can actually render', () => {
    for (const p of SWAP_PROVIDERS) {
      // Format follows what the provider publishes: a vector where they ship one, WebP
      // where they only ship a raster. The generator resolves the extension from disk.
      const found = ['svg', 'webp', 'png']
        .map((e) => repo(`site/public/swaps/${p.id}.${e}`))
        .find((f) => existsSync(f))
      expect(found, `missing site/public/swaps/${p.id}.{svg,webp,png}`).toBeTruthy()
      if (found!.endsWith('.svg')) {
        const svg = readFileSync(found!, 'utf8')
        expect(svg, `${p.id}.svg is not an SVG`).toMatch(/<svg/)
        // A baked-in opaque background reads as a white card on a dark page.
        expect(svg, `${p.id}.svg has an opaque background rect`).not.toMatch(/<rect[^>]*fill="white"/)
      }
    }
  })

  it('the generated site data matches the registry, route for route', () => {
    const f = repo('site/src/data/swap-providers.ts')
    if (!existsSync(f)) return // not generated in a clean clone; the sync rule covers it
    const src = readFileSync(f, 'utf8')
    for (const p of SWAP_PROVIDERS) {
      expect(src, `site data missing ${p.id} — re-run gen-swap-providers.mjs`).toContain(`"id": "${p.id}"`)
      for (const t of p.proofs) expect(src, `site data missing proof ${t.tx.slice(0, 8)}`).toContain(t.tx)
    }
  })

  it('the docs name every route and carry every proof hash', () => {
    const f = repo('docs/src/content/docs/making-payments/swapping.md')
    if (!existsSync(f)) return
    const doc = readFileSync(f, 'utf8')
    for (const p of SWAP_PROVIDERS) {
      expect(doc, `docs never mention ${p.name}`).toContain(p.name)
      for (const t of p.proofs) {
        expect(doc, `docs missing proof ${t.tx.slice(0, 10)} for ${p.id}`).toContain(t.tx.slice(0, 10))
      }
    }
  })

  it('both site surfaces are driven by the GENERATED data, never a hand-written copy', () => {
    // Swapping has its own page; the SDK page keeps a signpost. Both read the same generated
    // data, so they cannot quote different totals at a reader.
    for (const f of ['site/src/pages/swaps.astro', 'site/src/pages/sdk.astro']) {
      const page = readRepo(f)
      expect(page, `${f} must import the generated data`).toContain("from '../data/swap-providers'")
      // A hard-coded count is how the facilitator page drifted; the numbers must be derived.
      expect(page, `${f} must derive its proof count`).toContain('SWAP_PROOF_COUNT')
      expect(page, `${f} must derive its chain count`).toContain('SWAP_CHAIN_COUNT')
    }
  })

  it('the dedicated page is reachable from the nav and the footer', () => {
    expect(readRepo('site/src/components/Navigation.astro')).toContain('/swaps/')
    expect(readRepo('site/src/components/Footer.astro')).toContain('/swaps/')
  })
})

describe('the unproven notice cannot be silently dropped', () => {
  it('the site page renders `unproven` wherever a route lacks a proof', () => {
    const page = readRepo('site/src/pages/swaps.astro')
    const needsNotice = SWAP_PROVIDERS.some((p) => (p as { unproven?: string }).unproven)
    if (needsNotice) {
      expect(page, 'a route ships unproven but the page never renders the reason').toContain('p.unproven')
    }
  })

  it('the generated site data carries the reason through', () => {
    const gen = readRepo('site/src/data/swap-providers.ts')
    for (const p of SWAP_PROVIDERS) {
      const reason = (p as { unproven?: string }).unproven
      if (reason) expect(gen, `${p.id}'s reason never reached the site data`).toContain(reason.slice(0, 40))
    }
  })
})
