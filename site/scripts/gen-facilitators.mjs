#!/usr/bin/env node
/*
 * Generates site/src/data/facilitators.ts from the SDK's KNOWN_FACILITATORS map.
 *
 * The site does not depend on @piprail/sdk (same as chains.ts), so this mirrors the data at
 * build time instead. Re-run after any change to sdk/src/facilitators.ts:
 *   node site/scripts/gen-facilitators.mjs
 *
 * WHY IT PARSES THE NOTES
 * ───────────────────────
 * The registry's `note` is one dense sentence written for a developer reading source — it
 * carries the keyless flag, who pays gas, the settlement floor, the token standard, the date,
 * and a 66-character transaction hash, all in prose. Rendering that verbatim is what made the
 * first version of /facilitators look like a log file.
 *
 * So the note is decomposed here, once, at build time: badges become badges, the hash becomes
 * a link to a block explorer, and only genuine caveats stay as prose. Nothing is invented —
 * every field is lifted from the note, and the raw note is carried through as `note` so the
 * provenance is never lost. If a note stops matching a pattern the field is simply null, which
 * degrades to "not shown" rather than to a wrong claim.
 *
 * The tx hashes are re-verified on-chain by
 * `.claude/skills/facilitator-probe/scripts/verify-tx.mjs` — 25/25 confirmed 2026-08-28.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { KNOWN_FACILITATORS } = require('../../sdk/dist/index.cjs')

// CAIP-2 → display name, the logo slug already shipped in site/public/chains/, and the
// canonical block explorer. Kept here rather than imported so the generated file is
// self-contained and readable in a diff.
const CHAIN_META = {
  'eip155:1':      { name: 'Ethereum',   slug: 'ethereum',  explorer: 'https://etherscan.io/tx/' },
  'eip155:8453':   { name: 'Base',       slug: 'base',      explorer: 'https://basescan.org/tx/' },
  'eip155:137':    { name: 'Polygon',    slug: 'polygon',   explorer: 'https://polygonscan.com/tx/' },
  'eip155:42161':  { name: 'Arbitrum',   slug: 'arbitrum',  explorer: 'https://arbiscan.io/tx/' },
  'eip155:10':     { name: 'Optimism',   slug: 'optimism',  explorer: 'https://optimistic.etherscan.io/tx/' },
  'eip155:56':     { name: 'BNB Chain',  slug: 'bnb',       explorer: 'https://bscscan.com/tx/' },
  'eip155:43114':  { name: 'Avalanche',  slug: 'avalanche', explorer: 'https://snowtrace.io/tx/' },
  'eip155:999':    { name: 'HyperEVM',   slug: 'hyperevm',  explorer: 'https://hyperevmscan.io/tx/' },
  'eip155:143':    { name: 'Monad',      slug: 'monad',     explorer: 'https://monadscan.com/tx/' },
  'eip155:1329':   { name: 'Sei',        slug: 'sei',       explorer: 'https://seitrace.com/tx/' },
  'eip155:130':    { name: 'Unichain',   slug: 'unichain',  explorer: 'https://uniscan.xyz/tx/' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', slug: 'solana', explorer: 'https://solscan.io/tx/' },
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': { name: 'Algorand', slug: 'algorand', explorer: 'https://allo.info/tx/' },
}

const EVM_HASH = /0x[0-9a-fA-F]{64}/g
const ALGO_HASH = /\b[A-Z2-7]{52}\b/g

/**
 * The facilitator's display name — the note's own leading label, which is how its operators
 * write it. A trailing parenthetical is split off rather than shown inline, so
 * "Polygon Labs (the official Polygon facilitator)" renders as a name plus a badge instead of
 * a name that wraps onto three lines on a phone.
 */
const label = (f) => {
  const m = (f.note || '').match(/^([^—]+)\s*—/)
  const raw = m
    ? m[1].trim()
    : f.url.replace(/^https?:\/\//, '').replace(/^(facilitator|pay|x402)\./, '').replace(/\/.*$/, '')
  const paren = raw.match(/^(.*?)\s*\(([^)]*)\)$/)
  return paren ? { name: paren[1].trim(), nameNote: paren[2].trim() } : { name: raw, nameNote: null }
}

/**
 * Split a note into clauses on `.` and `;` — but never inside parentheses, because several
 * notes carry a semicolon inside one, e.g. "(atomic-group fee pooling; both sides pay 0 ALGO)".
 * Decimal points are safe: a split only happens on punctuation followed by whitespace.
 */
function clauses(text) {
  const out = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    // 🔴 `next` must be tested for emptiness EXPLICITLY. `/\s|$/.test(next)` looks right and is
    // not: `$` matches the end of the one-character string, so every character passed and
    // "$0.001" split at the decimal point, yielding the caveat "Note: ~$0.".
    const next = text[i + 1] ?? ''
    const boundary = depth === 0 && (ch === '.' || ch === ';') && (next === '' || /\s/.test(next))
    if (boundary) { out.push(buf.trim()); buf = '' } else buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(Boolean)
}

// Descriptor words that become badges, so a clause made only of them carries no new information.
const DESCRIPTORS = /\b(keyless|zero-fee|no signup|100% gas-sponsored|gas-sponsored|sponsors gas|fee-payer sponsor|keyless fee-payer sponsor)\b/gi

/**
 * Pull the structured facts out of one note.
 *
 * The caveat line is built by DROPPING whole clauses that a badge already states, never by
 * cutting words out of the middle of one — an earlier version did the latter and turned
 * "LIVE-settled on Arbitrum 2026-06-18 at $0.005" into the caveat "005.", because the cut
 * stopped at the decimal point. Dropping whole clauses cannot produce a fragment.
 *
 * Every field is "find it or leave it null": a note that stops matching a pattern quietly
 * loses a badge rather than gaining a false one.
 */
function parseNote(note, caip2) {
  const meta = CHAIN_META[caip2]
  const settled = /LIVE-settled/i.test(note)
  const date = (note.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null

  // Full hashes get a link; a note that only kept a prefix (`tx 0x2273d5…`) is shown as
  // recorded, unlinked — the honest rendering of an incomplete record.
  const full = [...new Set(note.match(caip2.startsWith('algorand') ? ALGO_HASH : EVM_HASH) || [])]
  const truncated = [...new Set(note.match(/\(tx\s+([0-9A-Za-z]{4,})[….]{1,3}\)/g) || [])]
    .map((m) => m.replace(/^\(tx\s+/, '').replace(/\)$/, ''))
  const txs = [
    ...full.map((h) => ({ hash: h, url: meta ? meta.explorer + h : null, full: true })),
    ...truncated.map((h) => ({ hash: h, url: null, full: false })),
  ]

  // The token/standard parenthetical, e.g. "Base USDC EIP-3009" or "Solana SPL SVM".
  const asset = (note.match(/\((?:on\s+)?([A-Za-z0-9 ./₮-]*(?:EIP-3009|SPL|SVM|USDC[a-z]?)[A-Za-z0-9 ./₮,-]*)\)/) || [])[1] || null

  // "~$0.004 dynamic settlement floor (sub-floor → amount_too_low)" → badge + its explanation.
  const floorMatch = note.match(/~?\$([\d.]+)\s+dynamic(?:\s+settlement)?\s+floor(?:\s*\(([^)]*)\))?/i)
  const floor = floorMatch ? `$${floorMatch[1]} min` : null
  const floorNote = floorMatch && floorMatch[2] ? floorMatch[2] : null

  const gasSponsored = /sponsors gas|gas-sponsored|fee-payer sponsor|fee pooling/i.test(note)

  const body = note.replace(/^[^—]+—\s*/, '').replace(/\(tx[^)]*\)/gi, '')
  const kept = clauses(body).filter((c) => {
    if (/LIVE-settled/i.test(c)) return false          // the date badge says this
    if (/^Verified \d{4}-\d{2}-\d{2}/i.test(c)) return false
    if (/dynamic(\s+settlement)?\s+floor/i.test(c)) return false   // the floor badge says this
    // A clause left empty once its badge-able words and the asset parenthetical are removed
    // is pure restatement — drop it. Anything else survives INTACT, so a sentence like
    // "The only keyless Algorand x402 facilitator" keeps the word the badge also uses.
    const residue = c.replace(DESCRIPTORS, '').replace(/\([^)]*(?:EIP-3009|SPL|SVM)[^)]*\)/gi, '').replace(/[\s,;.()]/g, '')
    return residue.length > 3
  })
  let caveat = kept
    // Only a LEADING descriptor run is trimmed — mid-sentence uses are meaning-bearing.
    .map((c) => c.replace(/^((keyless|zero-fee|no signup|100% gas-sponsored|gas-sponsored|sponsors gas|fee-payer sponsor)(,\s*)?)+/i, '').trim())
    .map((c) => c.replace(/^\(([^()]*)\)$/, '$1'))      // a clause that is all parenthetical reads better bare
    .filter(Boolean)
    // Each surviving clause becomes its own sentence, so capitalise each — joining first
    // would leave "…settleable). accepts U…" mid-caveat.
    .map((c) => c.replace(/^([a-z])/, (ch) => ch.toUpperCase()).replace(/\.?$/, '.'))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return { settled, date, txs, asset, floor, floorNote, gasSponsored, caveat }
}

const rows = []
for (const [caip2, list] of Object.entries(KNOWN_FACILITATORS)) {
  const meta = CHAIN_META[caip2] || { name: caip2, slug: caip2.toLowerCase().replace(/[^a-z0-9]+/g, '-'), explorer: null }
  rows.push({
    caip2,
    chain: meta.name,
    slug: meta.slug,
    facilitators: list.map((f) => ({
      ...label(f),
      url: f.url,
      host: f.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      keyless: !!f.keyless,
      schemes: f.schemes || [],
      settles: f.settles || [],
      note: f.note || '',
      ...parseNote(f.note || '', caip2),
    })),
  })
}
rows.sort((a, b) => b.facilitators.length - a.facilitators.length || a.chain.localeCompare(b.chain))

const out = `// ⚠️ GENERATED — do not edit by hand.
// Source: sdk/src/facilitators.ts (KNOWN_FACILITATORS)
// Regenerate: node site/scripts/gen-facilitators.mjs
//
// Every entry is a KEYLESS x402 facilitator that we settled a real payment through on the
// dated day. The raw registry note is carried through verbatim as \`note\`; the other fields
// are parsed out of it at build time so the page can render badges and explorer links instead
// of a wall of prose. Re-verify the hashes on-chain with:
//   node .claude/skills/facilitator-probe/scripts/verify-tx.mjs

export interface FacilitatorTx {
  /** Full 0x…/base32 hash, or the prefix the note recorded if that is all we kept. */
  hash: string
  /** Block-explorer URL — null when the hash is truncated and cannot be linked. */
  url: string | null
  full: boolean
}
export interface FacilitatorEntry {
  name: string
  /** A trailing parenthetical lifted off the name, e.g. "the official Polygon facilitator". */
  nameNote: string | null
  url: string
  host: string
  keyless: boolean
  schemes: string[]
  settles: string[]
  /** The registry note, verbatim — the source of every field below it. */
  note: string
  /** true when we settled a real payment; false when the entry rests on a lighter check. */
  settled: boolean
  date: string | null
  txs: FacilitatorTx[]
  /** Token + standard the settlement used, e.g. "Base USDC EIP-3009". */
  asset: string | null
  /** Minimum the facilitator will settle, where it enforces one. */
  floor: string | null
  /** What happens below the floor, when the note explains it. */
  floorNote: string | null
  gasSponsored: boolean
  /** What is left of the note once every badge-able fact is removed. May be empty. */
  caveat: string
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
const txCount = rows.flatMap((r) => r.facilitators).flatMap((f) => f.txs).filter((t) => t.full).length
console.log(`wrote ${rows.length} chains, ${distinct.size} distinct facilitators, ${txCount} linkable tx hashes`)
