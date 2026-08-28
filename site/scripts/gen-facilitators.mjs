#!/usr/bin/env node
/*
 * Generates site/src/data/facilitators.ts from the SDK's KNOWN_FACILITATORS map.
 *
 * The site does not depend on @piprail/sdk (same as chains.ts), so this mirrors the
 * data at build time instead. Re-run after any change to sdk/src/facilitators.ts:
 *   node site/scripts/gen-facilitators.mjs
 *
 * The map is the SEED of live-verified keyless facilitators — every entry was settled
 * with a real payment on the dated day, most with the tx hash in the note. That
 * provenance is the reason the page is citable, so it is carried through verbatim.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { KNOWN_FACILITATORS } = require('../../sdk/dist/index.cjs')

// CAIP-2 → human chain name. Kept here rather than imported so the generated file
// is self-contained and readable in a diff.
const NAMES = {
  'eip155:1': 'Ethereum', 'eip155:8453': 'Base', 'eip155:137': 'Polygon',
  'eip155:42161': 'Arbitrum', 'eip155:10': 'Optimism', 'eip155:56': 'BNB Chain',
  'eip155:43114': 'Avalanche', 'eip155:999': 'HyperEVM', 'eip155:143': 'Monad',
  'eip155:1329': 'Sei', 'eip155:130': 'Unichain',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': 'Algorand',
}
const SLUGS = {
  Ethereum:'ethereum', Base:'base', Polygon:'polygon', Arbitrum:'arbitrum', Optimism:'optimism',
  'BNB Chain':'bnb', Avalanche:'avalanche', HyperEVM:'hyperevm', Monad:'monad', Sei:'sei',
  Unichain:'unichain', Solana:'solana', Algorand:'algorand',
}
// Pretty name from the facilitator URL, preferring the note's leading label.
const label = (f) => {
  const m = (f.note || '').match(/^([^—-]+)\s*[—-]/)
  if (m) return m[1].trim()
  return f.url.replace(/^https?:\/\//, '').replace(/^(facilitator|pay|x402)\./, '').replace(/\/.*$/, '')
}
const rows = []
for (const [caip2, list] of Object.entries(KNOWN_FACILITATORS)) {
  const chain = NAMES[caip2] || caip2
  rows.push({
    caip2, chain, slug: SLUGS[chain] || chain.toLowerCase().replace(/\s+/g, '-'),
    facilitators: list.map((f) => ({
      name: label(f), url: f.url, keyless: !!f.keyless,
      schemes: f.schemes || [], settles: f.settles || [], note: f.note || '',
    })),
  })
}
rows.sort((a, b) => b.facilitators.length - a.facilitators.length || a.chain.localeCompare(b.chain))

const out = `// ⚠️ GENERATED — do not edit by hand.
// Source: sdk/src/facilitators.ts (KNOWN_FACILITATORS)
// Regenerate: node site/scripts/gen-facilitators.mjs
//
// Every entry is a KEYLESS x402 facilitator that we settled a real payment through on
// the dated day — most notes carry the transaction hash. That provenance is what makes
// this page citable rather than just another list.

export interface FacilitatorEntry {
  name: string
  url: string
  keyless: boolean
  schemes: string[]
  settles: string[]
  note: string
}
export interface FacilitatorChain {
  caip2: string
  chain: string
  slug: string
  facilitators: FacilitatorEntry[]
}

export const facilitatorCoverage: FacilitatorChain[] = ${JSON.stringify(rows, null, 2)}
`
writeFileSync(new URL('../src/data/facilitators.ts', import.meta.url), out)
const distinct = new Set(rows.flatMap((r) => r.facilitators.map((f) => f.url)))
console.log(`wrote ${rows.length} chains, ${distinct.size} distinct facilitators`)
