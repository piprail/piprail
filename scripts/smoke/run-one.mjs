#!/usr/bin/env node
/**
 * Run ONE smoke section in its own process and emit its results as JSON.
 *
 * 🔴 The separate process is the whole point, not a convenience.
 *
 * The L2 sections install FAKE drivers with `registerDriver()`, which replaces a family in a
 * process-wide registry. Run in one process, an L2 fake EVM driver is still installed when L3
 * asks Base for a live swap quote, and every EVM chain fails with `UnsupportedNetworkError` —
 * nine false failures that have nothing to do with the code under test. The same leak could
 * just as easily hide a REAL failure behind a fake that always succeeds.
 *
 * So each section gets a clean module registry, exactly as each vitest file does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as H from './harness.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const file = process.argv[2]
const only = process.argv.slice(3)

const mod = await import(join(REPO, 'scripts', 'smoke', file))
const sdk = await import(join(REPO, 'sdk', 'dist', 'index.js'))

const env = {}
try {
  for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim().replace(/\s+#.*$/, '')
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    env[m[1]] = v
  }
} catch { /* optional */ }

let crashed = null
try {
  await mod.run({ sdk, REPO, env, only, ...H })
} catch (e) {
  crashed = `${e?.constructor?.name}: ${e?.message ?? String(e)}`
}

const sections = H.drain()
if (crashed) sections.push({ name: `${mod.meta.id} · CRASHED`, note: '', checks: [{ status: 'FAIL', label: 'section completed', detail: crashed }] })

// A sentinel keeps the payload findable even if a section wrote to stdout itself.
process.stdout.write(`\n__SMOKE_JSON__${JSON.stringify({ id: mod.meta.id, sections })}\n`)
