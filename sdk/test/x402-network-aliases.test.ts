/**
 * The network-id canonicalisation contract — every way the same chain gets spelled on the wire.
 *
 * A payer and a merchant have to agree on what "this chain" is called before anything else can
 * match, and the x402 web does not spell it one way. Three dialects are live:
 *
 *  1. **Slugs** (`"base"`, `"solana"`) — every x402 **v1** server names the network this way, and
 *     143 v2 resources do too. A slug we can't resolve never matches `net.supports()`, because
 *     the EVM driver compares chain ids. Before 2.16.0 the table held 8 EVM slugs out of the 20
 *     chains we ship presets for, so a v1 challenge on (say) Celo was silently unpayable.
 *  2. **Superseded CAIP-2 ids** — TON moved `ton:-239` → `tvm:-239`.
 *  3. **A spelling where WE are the odd one out** — `scheme_exact_algo.md` gives Algorand mainnet
 *     as the genesis hash truncated to 32 chars; PipRail binds the padded 44-char form. The
 *     deployed web follows the spec (874 live rails vs 589 on ours).
 *
 * The rule this file locks: **accept every dialect, emit exactly one.** Changing what we EMIT
 * would break every deployed PipRail 2.x buyer, so that waits for a major.
 */
import { describe, it, expect } from 'vitest'
import { normalizeNetwork, CHAINS } from '../src/index.js'
// Internal on purpose: the spec id is a wire-compat detail the drivers share, not public API.
import { ALGORAND_SPEC_CAIP2 } from '../src/indexes.js'

const ALGO_PADDED = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='

describe('normalizeNetwork — slugs', () => {
  /*
   * THE DRIFT GUARD. Ship a new EVM preset without adding its slug and a v1 (or slug-labelled
   * v2) challenge on that chain quietly stops matching — the exact failure that made Celo,
   * Monad, Sei, Linea and nine others unpayable until 2.16.0. There is no way to notice by hand:
   * every symptom is a silent non-match, never an error.
   */
  it('every shipped EVM preset has a slug, and the slug resolves to its own chain id', () => {
    const missing: string[] = []
    const wrong: string[] = []
    for (const [slug, preset] of Object.entries(CHAINS)) {
      const resolved = normalizeNetwork(slug)
      if (!resolved.includes(':')) {
        missing.push(slug)
        continue
      }
      const expected = `eip155:${preset.chain.id}`
      if (resolved !== expected) wrong.push(`${slug} → ${resolved}, expected ${expected}`)
    }
    expect({ missing, wrong }).toEqual({ missing: [], wrong: [] })
    // sanity: the loop actually ran over the real preset table
    expect(Object.keys(CHAINS).length).toBeGreaterThanOrEqual(20)
  })

  it('resolves the aliases the reference SDKs emit', () => {
    // `bsc` and `world` are the foreign spellings of chains we key as `bnb` / `worldchain`.
    expect(normalizeNetwork('bsc')).toBe(normalizeNetwork('bnb'))
    expect(normalizeNetwork('world')).toBe(normalizeNetwork('worldchain'))
  })

  it('is case-insensitive on slugs (a server may shout)', () => {
    expect(normalizeNetwork('BASE')).toBe('eip155:8453')
    expect(normalizeNetwork('Solana')).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
  })

  it('leaves an UNKNOWN slug alone rather than guessing a chain', () => {
    // Returning it unchanged (no `:`) is the signal "unresolved — don't hide it". Guessing would
    // be far worse than failing: it could route a payment at the wrong chain.
    expect(normalizeNetwork('fantom')).toBe('fantom')
    expect(normalizeNetwork('')).toBe('')
  })

  it('maps every non-EVM family we ship', () => {
    for (const [slug, prefix] of [
      ['solana', 'solana:'],
      ['ton', 'tvm:'],
      ['tron', 'tron:'],
      ['near', 'near:'],
      ['sui', 'sui:'],
      ['aptos', 'aptos:'],
      ['algorand', 'algorand:'],
      ['stellar', 'stellar:'],
      ['xrpl', 'xrpl:'],
    ] as const) {
      expect(normalizeNetwork(slug).startsWith(prefix)).toBe(true)
    }
  })
})

describe('normalizeNetwork — CAIP-2 ids that name a chain we bind differently', () => {
  it('collapses the Algorand spec form onto the padded id we bind', () => {
    expect(normalizeNetwork(ALGORAND_SPEC_CAIP2)).toBe(ALGO_PADDED)
  })

  it('collapses the superseded TON id', () => {
    expect(normalizeNetwork('ton:-239')).toBe('tvm:-239')
  })

  it('is IDEMPOTENT — the canonical form of every alias is a fixed point', () => {
    // If this ever failed, `normalizeNetwork(a) === normalizeNetwork(b)` comparisons (which the
    // gate now relies on to select a rail) would depend on how many times it had been applied.
    for (const id of [ALGO_PADDED, 'tvm:-239', 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']) {
      expect(normalizeNetwork(id)).toBe(id)
      expect(normalizeNetwork(normalizeNetwork(id))).toBe(id)
    }
  })

  it('passes an unknown CAIP-2 id through untouched (never invents a mapping)', () => {
    expect(normalizeNetwork('eip155:999999')).toBe('eip155:999999')
    expect(normalizeNetwork('cosmos:cosmoshub-4')).toBe('cosmos:cosmoshub-4')
  })

  it('exports the spec id as ONE literal, so the driver cannot keep a second copy', () => {
    // The Algorand driver's `supports()` imports this. A genesis hash typed twice is a drift bug
    // waiting to happen, and a one-character difference would be invisible in review.
    expect(ALGORAND_SPEC_CAIP2).toBe('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k')
    expect(ALGO_PADDED.startsWith(ALGORAND_SPEC_CAIP2)).toBe(true) // the padded id EXTENDS it
  })
})
