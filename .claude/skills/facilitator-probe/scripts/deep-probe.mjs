#!/usr/bin/env node
/*
 * Deep-probe every keyless x402 facilitator: capture the FULL /supported payload, then
 * work out which networks each one advertises that PipRail does NOT currently seed.
 *
 * That gap is the point. KNOWN_FACILITATORS only ever grows from a real live settlement,
 * so it lags what facilitators actually offer — this shows where the next expansion is.
 *
 *   node .claude/skills/facilitator-probe/scripts/deep-probe.mjs
 *
 * Read-only. Writes .claude/research/facilitators/deep-<date>.json (full payloads).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const { KNOWN_FACILITATORS } = require(resolve(root, 'sdk/dist/index.cjs'))

const urls = [...new Set(Object.values(KNOWN_FACILITATORS).flat().map((f) => f.url))]
const seededByUrl = new Map()
for (const [net, list] of Object.entries(KNOWN_FACILITATORS))
  for (const f of list) {
    if (!seededByUrl.has(f.url)) seededByUrl.set(f.url, new Set())
    seededByUrl.get(f.url).add(net)
  }
const allSeeded = new Set(Object.keys(KNOWN_FACILITATORS))

const get = async (u, ms = 20000) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(u, { signal: c.signal, headers: { accept: 'application/json' } })
    const text = await r.text()
    let json = null; try { json = JSON.parse(text) } catch {}
    return { status: r.status, ok: r.ok, json, bytes: text.length }
  } catch (e) { return { status: 0, ok: false, error: String(e?.name || e) } }
  finally { clearTimeout(t) }
}

const out = []
for (const url of urls) {
  const base = url.replace(/\/+$/, '')
  const sup = await get(`${base}/supported`)
  const kinds = Array.isArray(sup.json?.kinds) ? sup.json.kinds : []
  const nets = [...new Set(kinds.map((k) => k?.network).filter(Boolean))]
  const schemes = [...new Set(kinds.map((k) => k?.scheme).filter(Boolean))]
  // networks it advertises that we do NOT seed anywhere
  const novel = nets.filter((n) => !allSeeded.has(n))
  out.push({
    url, reachable: sup.ok, status: sup.status, bytes: sup.bytes,
    kindCount: kinds.length, schemes,
    advertisedNetworks: nets,
    weSeedForIt: [...(seededByUrl.get(url) || [])],
    networksWeDoNotSeedAtAll: novel,
    sampleKinds: kinds.slice(0, 3),
  })
}

const stamp = new Date().toISOString().slice(0, 10)
const dir = resolve(root, '.claude/research/facilitators'); mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, `deep-${stamp}.json`), JSON.stringify({ probedAt: new Date().toISOString(), facilitators: out }, null, 2))

console.log(`\n  DEEP PROBE — ${out.filter(o=>o.reachable).length}/${out.length} reachable\n`)
for (const o of out.sort((a, b) => b.kindCount - a.kindCount)) {
  const host = o.url.replace(/^https?:\/\//, '')
  console.log(`  ${host}`)
  console.log(`     kinds ${o.kindCount} · schemes [${o.schemes.join(', ')}] · advertises ${o.advertisedNetworks.length} networks · we seed it on ${o.weSeedForIt.length}`)
  if (o.networksWeDoNotSeedAtAll.length)
    console.log(`     🟢 advertises ${o.networksWeDoNotSeedAtAll.length} networks PipRail seeds on NO facilitator: ${o.networksWeDoNotSeedAtAll.slice(0, 8).join(', ')}${o.networksWeDoNotSeedAtAll.length > 8 ? ' …' : ''}`)
}
const union = new Set(out.flatMap((o) => o.networksWeDoNotSeedAtAll))
console.log(`\n  TOTAL distinct networks advertised that PipRail does not seed: ${union.size}`)
console.log(`  saved → .claude/research/facilitators/deep-${stamp}.json\n`)
