#!/usr/bin/env node
/*
 * Live-probe every keyless x402 facilitator PipRail ships in KNOWN_FACILITATORS.
 *
 *   node .claude/skills/facilitator-probe/scripts/probe.mjs            # probe + report
 *   node .claude/skills/facilitator-probe/scripts/probe.mjs --json     # machine-readable
 *
 * Reads GET /supported on each facilitator and compares what it ADVERTISES against what
 * our registry CLAIMS. This is the honesty check behind piprail.com/facilitators: the page
 * says every entry was live-settled, so a dead or drifted facilitator has to be caught.
 *
 * Never signs, never sends, never spends. Read-only HTTP.
 * Results are written to .claude/research/facilitators/probe-<date>.json — the JSON is
 * the asset, terminal output is ephemeral.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const { KNOWN_FACILITATORS } = require(resolve(root, 'sdk/dist/index.cjs'))

const JSON_OUT = process.argv.includes('--json')
const TIMEOUT = 15000

// url -> the set of CAIP-2 networks our registry claims it settles on
const claimed = new Map()
for (const [caip2, list] of Object.entries(KNOWN_FACILITATORS)) {
  for (const f of list) {
    if (!claimed.has(f.url)) claimed.set(f.url, { url: f.url, networks: new Set(), note: f.note, schemes: new Set(f.schemes || []) })
    claimed.get(f.url).networks.add(caip2)
  }
}

const probe = async (url) => {
  const base = url.replace(/\/+$/, '')
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(`${base}/supported`, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    const ms = Date.now() - started
    let body = null
    try { body = await res.json() } catch { /* not JSON */ }
    const kinds = Array.isArray(body?.kinds) ? body.kinds : []
    return {
      ok: res.ok, status: res.status, ms,
      kindCount: kinds.length,
      networks: [...new Set(kinds.map((k) => k?.network).filter(Boolean))],
      schemes: [...new Set(kinds.map((k) => k?.scheme).filter(Boolean))],
    }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(e?.name || e) }
  } finally { clearTimeout(timer) }
}

const results = []
for (const c of claimed.values()) {
  const r = await probe(c.url)
  results.push({
    url: c.url,
    claimedNetworks: [...c.networks],
    claimedSchemes: [...c.schemes],
    note: c.note,
    live: r,
    // Does what it advertises still cover what we claim? Facilitators report either a
    // CAIP-2 id or a slug, so compare loosely rather than reporting false drift.
    covers: r.ok
      ? [...c.networks].filter((n) => {
          const short = n.split(':')[0]
          return r.networks.some((x) => x === n || String(x).toLowerCase().includes(short))
        })
      : [],
  })
}

const stamp = new Date().toISOString().slice(0, 10)
const dir = resolve(root, '.claude/research/facilitators')
mkdirSync(dir, { recursive: true })
const payload = {
  probedAt: new Date().toISOString(),
  facilitators: results.length,
  reachable: results.filter((r) => r.live.ok).length,
  results,
}
writeFileSync(resolve(dir, `probe-${stamp}.json`), JSON.stringify(payload, null, 2))

if (JSON_OUT) { console.log(JSON.stringify(payload, null, 2)); process.exit(0) }

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n  x402 FACILITATOR LIVENESS — ${payload.probedAt.slice(0, 16).replace('T', ' ')} UTC`)
console.log(`  ${payload.reachable}/${payload.facilitators} reachable\n`)
console.log(`  ${pad('FACILITATOR', 42)} ${pad('STATUS', 8)} ${pad('ms', 6)} ${pad('KINDS', 6)} CLAIMED→SEEN`)
console.log('  ' + '─'.repeat(96))
for (const r of results.sort((a, b) => Number(b.live.ok) - Number(a.live.ok) || a.url.localeCompare(b.url))) {
  const host = r.url.replace(/^https?:\/\//, '')
  const status = r.live.ok ? `✅ ${r.live.status}` : `❌ ${r.live.error || r.live.status}`
  const cov = r.live.ok ? `${r.covers.length}/${r.claimedNetworks.length}` : '—'
  console.log(`  ${pad(host, 42)} ${pad(status, 8)} ${pad(r.live.ms, 6)} ${pad(r.live.kindCount ?? '-', 6)} ${cov}`)
}
const dead = results.filter((r) => !r.live.ok)
if (dead.length) {
  console.log(`\n  ⚠️  ${dead.length} UNREACHABLE — verify before trusting the /facilitators page:`)
  for (const d of dead) console.log(`     ${d.url}  (${d.live.error || d.live.status})`)
}
const drift = results.filter((r) => r.live.ok && r.covers.length < r.claimedNetworks.length)
if (drift.length) {
  console.log(`\n  ⚠️  ${drift.length} advertise FEWER networks than we claim:`)
  for (const d of drift) console.log(`     ${d.url}  claimed ${d.claimedNetworks.length}, seen ${d.covers.length}`)
}
console.log(`\n  saved → .claude/research/facilitators/probe-${stamp}.json\n`)
