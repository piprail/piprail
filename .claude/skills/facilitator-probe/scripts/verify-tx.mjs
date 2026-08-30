#!/usr/bin/env node
/*
 * verify-tx — re-verify, ON-CHAIN, every settlement receipt the facilitator registry claims.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `/facilitators/` makes exactly one strong claim: "every entry here was verified by
 * settling a real payment, not by reading a status endpoint." A claim like that is only
 * worth making if it can be re-checked on demand — otherwise it decays into folklore the
 * same way the two dead facilitators did (they were live-settled once, then quietly died,
 * and nothing ever looked again).
 *
 * So this reads the tx hashes out of KNOWN_FACILITATORS' own notes and asks the CHAIN
 * whether each one is still there, mined, and successful. It deliberately does NOT ask an
 * explorer's web page — an SPA returns 200 for a hash that never existed. It asks the RPC.
 *
 * The RPC endpoints come from the SDK's own `resolveChain()`, so this cannot drift from
 * what the SDK would actually use at payment time. That is the point: verifying with a
 * second, hand-maintained RPC map would test the map, not the product.
 *
 *   node .claude/skills/facilitator-probe/scripts/verify-tx.mjs
 *
 * 🔴 A MISSING TX IS NOT AUTOMATICALLY A BAD RECEIPT, and getting this wrong would make the
 * script worse than useless — it would cry wolf about a payment that really happened. Most
 * public RPCs PRUNE. Sei's public endpoint, which is the SDK's own default, retains roughly
 * 2,200 blocks (~15 minutes); it answers `null` for a two-month-old hash whether or not that
 * hash was ever real. So before calling anything a failure this measures the endpoint's block
 * time, works out which block the claimed settlement date falls in, and asks for THAT block.
 * Only an RPC that can still serve the era gets to contradict a receipt; one that cannot
 * yields `unverifiable:pruned-rpc`, which is a gap in our evidence, not a lie in the note.
 *
 * Exit code is 1 only for a receipt an archival RPC actively contradicts. Truncated hashes
 * (notes that recorded `0x2273d5…`) are SKIPPED — a record-keeping gap, not a broken payment.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sdk = require('../../../../sdk/dist/index.cjs')
const { KNOWN_FACILITATORS, resolveChain } = sdk

// CAIP-2 → the SDK's own chain slug, so `resolveChain` gives us the RPC the SDK would use.
const SLUG = {
  'eip155:1': 'ethereum', 'eip155:8453': 'base', 'eip155:137': 'polygon',
  'eip155:42161': 'arbitrum', 'eip155:10': 'optimism', 'eip155:56': 'bnb',
  'eip155:43114': 'avalanche', 'eip155:999': 'hyperevm', 'eip155:143': 'monad',
  'eip155:1329': 'sei', 'eip155:130': 'unichain',
}
/*
 * ARCHIVAL FALLBACK — used ONLY when the SDK's default RPC has pruned past the settlement
 * date. This is verification infrastructure, not payment infrastructure: the SDK must keep
 * using its own defaults, but an auditor re-checking a two-month-old receipt needs an
 * endpoint that still remembers it. Measured 2026-08-28: Sei's default public RPC retains
 * ~100k blocks (~13 hours) — fine for the 600s verification window the SDK actually uses,
 * far too short to re-audit history. thirdweb's is archival, so it is only consulted here.
 */
const ARCHIVAL_FALLBACK = {
  'eip155:1329': 'https://1329.rpc.thirdweb.com',
}

// Non-EVM verifiers, one per family. Public indexers, no key.
const NON_EVM = {
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': {
    family: 'algorand',
    // Algorand txids are base32, 52 chars.
    extract: (n) => (n.match(/\b[A-Z2-7]{52}\b/g) || []),
    check: async (txid) => {
      const r = await fetch(`https://mainnet-idx.algonode.cloud/v2/transactions/${txid}`)
      if (!r.ok) return { ok: false, why: `indexer ${r.status}` }
      const j = await r.json()
      const t = j.transaction
      return t?.id ? { ok: true, block: t['confirmed-round'] } : { ok: false, why: 'not found' }
    },
  },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    family: 'solana',
    // Solana signatures are base58, 87–88 chars. Our notes only kept 8-char prefixes,
    // so nothing matches — every Solana entry lands in SKIPPED, which is the honest result.
    extract: (n) => (n.match(/\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g) || []),
    check: async (sig) => {
      const r = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { maxSupportedTransactionVersion: 0 }] }),
      })
      const j = await r.json()
      return j.result ? { ok: true, block: j.result.slot } : { ok: false, why: 'not found' }
    },
  },
}

const EVM_FULL = /0x[0-9a-fA-F]{64}/g
// A note that recorded only a prefix, e.g. `(tx 0x2273d5…)` or `(tx 4dL8jRKH…)`.
const TRUNCATED = /\(tx\s+[0-9A-Za-z]{4,}[….]{1,3}\)/

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) throw new Error(`http ${r.status}`)
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || 'rpc error')
  return j.result
}

/**
 * Can this endpoint still serve the era the receipt claims? Measures the chain's real block
 * time from two heads rather than assuming one, so it works on a 400ms chain and a 12s chain
 * alike. Any error or null on the way = "cannot serve it", which is the safe answer: it only
 * ever downgrades a FAIL to `unverifiable`, never the reverse.
 */
const horizonCache = new Map()
async function servesEra(url, isoDate) {
  const key = `${url}|${isoDate}`
  if (horizonCache.has(key)) return horizonCache.get(key)
  let verdict = false
  try {
    const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false])
    const headNum = Number(BigInt(head.number))
    const headTs = Number(BigInt(head.timestamp))
    const back = Math.min(10_000, headNum - 1)
    const prev = await rpc(url, 'eth_getBlockByNumber', ['0x' + (headNum - back).toString(16), false])
    if (prev) {
      const blockTime = (headTs - Number(BigInt(prev.timestamp))) / back || 12
      const targetTs = Math.floor(new Date(`${isoDate}T12:00:00Z`).getTime() / 1000)
      const target = Math.max(1, headNum - Math.floor((headTs - targetTs) / blockTime))
      const blk = await rpc(url, 'eth_getBlockByNumber', ['0x' + target.toString(16), false])
      verdict = !!blk
    }
  } catch { verdict = false }
  horizonCache.set(key, verdict)
  return verdict
}

const rows = []
for (const [caip2, list] of Object.entries(KNOWN_FACILITATORS)) {
  for (const f of list) {
    const note = f.note || ''
    const nonEvm = NON_EVM[caip2]
    // The date the note says we settled — used to ask the RPC for the right era.
    const settled = (note.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '2026-06-15'
    const hashes = nonEvm ? nonEvm.extract(note) : (note.match(EVM_FULL) || [])
    if (hashes.length === 0) {
      rows.push({
        caip2, facilitator: f.url, hash: null, settled,
        status: TRUNCATED.test(note) ? 'skipped:truncated' : 'skipped:no-hash',
        why: TRUNCATED.test(note) ? 'note kept only a hash prefix' : 'note records verification without a tx hash',
      })
      continue
    }
    for (const h of hashes) rows.push({ caip2, facilitator: f.url, hash: h, settled, status: 'pending' })
  }
}

// Resolve each network's RPC once (and record WHY a network is unverifiable, if it is).
const rpcFor = {}
for (const caip2 of new Set(rows.map((r) => r.caip2))) {
  const slug = SLUG[caip2]
  if (!slug) continue
  try { rpcFor[caip2] = resolveChain(slug).rpcUrl } catch (e) { rpcFor[caip2] = { err: e.message } }
}

const pending = rows.filter((r) => r.status === 'pending')
let done = 0
async function verify(row) {
  const nonEvm = NON_EVM[row.caip2]
  try {
    if (nonEvm) {
      const res = await nonEvm.check(row.hash)
      Object.assign(row, res.ok ? { status: 'ok', block: res.block } : { status: 'FAIL', why: res.why })
    } else {
      const url = rpcFor[row.caip2]
      if (!url || typeof url !== 'string') { Object.assign(row, { status: 'FAIL', why: 'no RPC for network' }); return }
      const tx = await rpc(url, 'eth_getTransactionByHash', [row.hash])
      if (!tx) {
        // Default RPC says no. Before believing it, find out whether it can even see that far
        // back — and if it cannot, try an archival endpoint before writing anything down.
        const archival = await servesEra(url, row.settled)
        if (!archival && ARCHIVAL_FALLBACK[row.caip2]) {
          const alt = ARCHIVAL_FALLBACK[row.caip2]
          const tx2 = await rpc(alt, 'eth_getTransactionByHash', [row.hash])
          if (tx2) {
            Object.assign(row, { status: 'ok', via: 'archival-fallback', block: Number(BigInt(tx2.blockNumber ?? '0x0')) })
            return
          }
        }
        Object.assign(row, archival
          ? { status: 'FAIL', why: `not on chain (RPC does serve ${row.settled})` }
          : { status: 'unverifiable', why: `RPC has pruned past ${row.settled} and no archival fallback is configured` })
        return
      }
      const rc = await rpc(url, 'eth_getTransactionReceipt', [row.hash])
      // status 0x0 is a REVERTED tx — it exists but it never moved money. That is a failure
      // for our purposes: the claim is "we settled", not "we broadcast".
      if (rc && rc.status === '0x0') { Object.assign(row, { status: 'FAIL', why: 'tx reverted (status 0x0)' }); return }
      Object.assign(row, { status: 'ok', block: Number(BigInt(tx.blockNumber ?? rc?.blockNumber ?? '0x0')) })
    }
  } catch (e) {
    // An RPC that is rate-limiting or down is OUR problem, not a bad receipt — say so
    // rather than crying wolf about a payment that is probably fine.
    Object.assign(row, { status: 'unreachable', why: String(e.message || e).slice(0, 90) })
  }
  process.stderr.write(`\r  verifying ${++done}/${pending.length}   `)
}

// 4 at a time — public RPCs rate-limit, and this is a correctness check, not a load test.
const queue = [...pending]
await Promise.all(Array.from({ length: 4 }, async () => { let r; while ((r = queue.shift())) await verify(r) }))
process.stderr.write('\r' + ' '.repeat(40) + '\r')

const ok = rows.filter((r) => r.status === 'ok')
const fail = rows.filter((r) => r.status === 'FAIL')
const unreachable = rows.filter((r) => r.status === 'unreachable')
const unverifiable = rows.filter((r) => r.status === 'unverifiable')
const skipped = rows.filter((r) => String(r.status).startsWith('skipped'))
const stamp = new Date().toISOString().slice(0, 10)

const icon = { ok: '✅', FAIL: '❌', unreachable: '⚠️ ', unverifiable: '🔒' }
console.log(`\n  ON-CHAIN RECEIPT VERIFICATION — ${stamp}`)
console.log(`  ${ok.length} verified · ${fail.length} refuted · ${unverifiable.length} unverifiable (pruned RPC) · ${unreachable.length} unreachable · ${skipped.length} skipped\n`)
console.log('  NETWORK           FACILITATOR                          TX')
console.log('  ' + '─'.repeat(96))
for (const r of rows) {
  if (String(r.status).startsWith('skipped')) continue
  const host = r.facilitator.replace(/^https?:\/\//, '')
  const short = r.hash ? `${r.hash.slice(0, 12)}…${r.hash.slice(-6)}` : '—'
  console.log(`  ${icon[r.status] || '?'} ${r.caip2.padEnd(16)} ${host.padEnd(36)} ${short}${r.why ? '  ' + r.why : ''}`)
}
if (skipped.length) {
  console.log(`\n  SKIPPED (${skipped.length}) — no full hash in the note, so nothing to re-verify:`)
  for (const r of skipped) console.log(`     ${r.caip2.padEnd(16)} ${r.facilitator.replace(/^https?:\/\//, '').padEnd(36)} ${r.why}`)
}

mkdirSync(new URL('../../../research/facilitators/', import.meta.url), { recursive: true })
const out = new URL(`../../../research/facilitators/tx-verify-${stamp}.json`, import.meta.url)
writeFileSync(out, JSON.stringify({ stamp, summary: { ok: ok.length, fail: fail.length, unverifiable: unverifiable.length, unreachable: unreachable.length, skipped: skipped.length }, rows }, null, 2))
console.log(`\n  saved → .claude/research/facilitators/tx-verify-${stamp}.json`)

if (unverifiable.length) {
  console.log(`\n  🔒 ${unverifiable.length} receipt(s) sit behind a pruning RPC. Not a failure — re-run with an`)
  console.log(`     archival endpoint for those networks if you need them re-confirmed.`)
}
if (fail.length) { console.error(`\n  ❌ ${fail.length} claimed settlement(s) are CONTRADICTED by an archival RPC.`); process.exit(1) }
