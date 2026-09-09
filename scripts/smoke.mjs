#!/usr/bin/env node
/**
 * ── THE SMOKE LAYERS ─────────────────────────────────────────────────────────────────
 *
 * `npm run sweep` runs the unit suite in sections. It cannot see three things:
 *   a hostile CALLER (vitest asserts what the code does, not what an attacker gets),
 *   the WORLD (a facilitator that went dark, a DEX that stopped routing),
 *   and MONEY (whether a payment actually settles on a chain).
 *
 * This runs those, in LAYERS, cheapest first:
 *
 *   L2  adversarial   offline, fake drivers        seconds   free
 *   L3  reality       live, READ-ONLY              ~1 min    free
 *   L4  money         live, real mainnet spend     minutes   costs money
 *
 * (L0 package integrity and L1 the unit sections live in `npm run sweep`; run that first.)
 *
 * 🔴 THE ORDER IS THE POINT. A layer only means anything if the one before it is green:
 *   · Never spend money to find a bug a free test would have caught.
 *   · A red L2 makes L3 and L4 noise — the code is broken, so of course the world disagrees.
 *   · L2 red usually means WE broke something. L3 red usually means the WORLD changed
 *     underneath us. They need different responses, which is why they are different layers.
 *   · L4 proves one chain. It is never evidence about another family.
 *
 * By default the runner STOPS at the first failing layer, for exactly that reason.
 *
 *   npm run smoke                    L2 and L3 (safe: nothing is spent)
 *   npm run smoke -- --money         all layers, including real mainnet payments
 *   npm run smoke -- gate modes      named sections only
 *   npm run smoke -- --layer L3      one whole layer
 *   npm run smoke -- --list          what exists
 *   npm run smoke -- --keep-going    do not stop at the first failing layer
 *   npm run smoke -- --each          run EVERY section on its own, and print a matrix
 *
 * `--each` is the audit mode. It runs every section as if it were the only one, never stops
 * early, and reports a per-section grid — so one red section is visibly one red section rather
 * than a run that halted somewhere. Use it for a full audit; use the default for a quick gate.
 *
 * Keys are read from the gitignored wallet store at RUNTIME by the sections that need them,
 * and are never printed. See TESTING.md for the full protocol.
 */
import { readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SMOKE_DIR = join(REPO, 'scripts', 'smoke')

// ── load the sections ────────────────────────────────────────────────────────────────
const modules = []
for (const f of readdirSync(SMOKE_DIR).sort()) {
  if (!/^l\d-.*\.mjs$/.test(f)) continue
  const mod = await import(join(SMOKE_DIR, f))
  if (!mod.meta?.id || !mod.run) {
    console.error(`  scripts/smoke/${f} exports no { meta, run } — every section must declare both`)
    process.exit(1)
  }
  modules.push({ file: f, ...mod })
}

const LAYERS = ['L2', 'L3', 'L4']
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const layerArg = (() => {
  const i = argv.indexOf('--layer')
  return i >= 0 ? argv[i + 1] : null
})()
const wanted = positional.filter((p) => p !== layerArg)

if (flags.has('--list')) {
  console.log(`\n  ${modules.length} sections across ${LAYERS.length} layers\n`)
  for (const L of LAYERS) {
    const mine = modules.filter((m) => m.meta.layer === L)
    if (!mine.length) continue
    const cost = L === 'L4' ? 'REAL MONEY' : L === 'L3' ? 'live, read-only' : 'offline'
    console.log(`  \x1b[1m${L}\x1b[0m  \x1b[90m${cost}\x1b[0m`)
    for (const m of mine) {
      console.log(`    ${m.meta.id.padEnd(14)} ${m.meta.what}`)
      console.log(`    ${' '.repeat(14)} \x1b[90m${m.meta.why}\x1b[0m`)
    }
    console.log()
  }
  process.exit(0)
}

// L4 spends real money, so it is opt-in even when the caller names it.
const wantMoney = flags.has('--money')
let selected = modules.filter((m) => {
  if (layerArg && m.meta.layer !== layerArg) return false
  if (wanted.length && !wanted.includes(m.meta.id)) return false
  if (m.meta.spends && !wantMoney) return false
  return true
})

if (!selected.length) {
  const named = wanted.length || layerArg
  console.error(
    named
      ? `\n  Nothing selected. Sections: ${modules.map((m) => m.meta.id).join(', ')}` +
          `\n  (L4 sections spend real money and need --money.)\n`
      : '\n  Nothing to run.\n'
  )
  process.exit(1)
}

// ── the SDK under test ───────────────────────────────────────────────────────────────
if (!existsSync(join(REPO, 'sdk', 'dist', 'index.js'))) {
  console.error('\n  sdk/dist is not built — run `npm run build:sdk` first.\n')
  process.exit(1)
}

// ── run, layer by layer ──────────────────────────────────────────────────────────────
const C = { PASS: '\x1b[32m✔\x1b[0m', FAIL: '\x1b[31m✘\x1b[0m', WARN: '\x1b[33m▲\x1b[0m', INFO: '\x1b[36mi\x1b[0m' }

const each = flags.has('--each')
if (each) flags.add('--keep-going') // an audit surveys everything; it never stops at the first red

console.log(
  `\n\x1b[1m  SMOKE\x1b[0m  ${selected.length} section(s)` +
    `${each ? '  \x1b[36m· AUDIT: every section run individually\x1b[0m' : ''}` +
    `${wantMoney ? '  \x1b[33m· L4 WILL SPEND REAL MONEY\x1b[0m' : ''}\n`
)

/** Per-section tallies, for the audit matrix at the end. */
const grid = []

let totalPass = 0
let totalFail = 0
const failures = []
let stopped = null

for (const L of LAYERS) {
  const mine = selected.filter((m) => m.meta.layer === L)
  if (!mine.length) continue
  if (stopped) {
    console.log(`  \x1b[90m${L} skipped — ${stopped} failed, and a later layer cannot be trusted over it\x1b[0m\n`)
    continue
  }

  console.log(`\x1b[1m  ── ${L} ${'─'.repeat(66)}\x1b[0m`)
  let layerFailed = 0

  for (const m of mine) {
    const t0 = Date.now()
    // Own process per section: an L2 fake driver must never still be registered when L3 asks
    // a real chain a real question. See scripts/smoke/run-one.mjs.
    // Forward only the words that are NOT section names: a section's own id is a selector for
    // this runner, and passing it down as a row filter made `smoke -- payments` match no rows
    // and report "all green · 0 checks".
    const rowFilters = wanted.filter((w) => !modules.some((mm) => mm.meta.id === w))
    const proc = spawnSync('node', [join(SMOKE_DIR, 'run-one.mjs'), m.file, ...rowFilters], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    let sections = []
    const marker = proc.stdout?.lastIndexOf('__SMOKE_JSON__')
    if (marker >= 0) {
      try { sections = JSON.parse(proc.stdout.slice(marker + '__SMOKE_JSON__'.length)).sections ?? [] }
      catch (e) { sections = [{ name: `${m.meta.id} · unreadable result`, checks: [{ status: 'FAIL', label: 'parse results', detail: String(e.message) }] }] }
    } else {
      const tail = (proc.stderr || proc.stdout || '').trim().split('\n').slice(-4).join(' | ')
      sections = [{ name: `${m.meta.id} · CRASHED`, checks: [{ status: 'FAIL', label: 'section produced no result', detail: tail.slice(0, 300) }] }]
    }
    let pass = sections.reduce((n, s) => n + s.checks.filter((c) => c.status === 'PASS').length, 0)
    let fail = sections.reduce((n, s) => n + s.checks.filter((c) => c.status === 'FAIL').length, 0)
    /*
     * 🔴 A section that asserted NOTHING is a failure, not a pass.
     *
     * A filter that matches no rows, a wallet that would not load, an early return — each
     * leaves zero checks, and "all green · 0 checks" reads exactly like a clean run. Silence
     * is the one result a test harness must never report as success.
     */
    const warns = sections.reduce((n, s) => n + s.checks.filter((c) => c.status === 'WARN').length, 0)
    if (pass + fail + warns === 0) {
      sections = [{ name: `${m.meta.id} · NOTHING RAN`, checks: [{ status: 'FAIL', label: 'the section asserted nothing', detail: 'zero checks — a filter matched no rows, or it returned early' }] }]
      fail = 1
    }
    totalPass += pass
    totalFail += fail
    layerFailed += fail

    grid.push({ layer: L, id: m.meta.id, pass, fail, secs })
    const head = fail ? `\x1b[31m${fail} FAILED\x1b[0m of ${pass + fail}` : `\x1b[32m${pass} passed\x1b[0m`
    console.log(`\n  \x1b[1m${m.meta.id}\x1b[0m  ${head}  \x1b[90m${secs}s · ${m.meta.what}\x1b[0m`)
    for (const s of sections) {
      const f = s.checks.filter((c) => c.status === 'FAIL').length
      console.log(`    \x1b[90m${s.name}\x1b[0m${f ? ` \x1b[31m(${f} failed)\x1b[0m` : ''}`)
      for (const c of s.checks) {
        // Keep a green run readable: show every failure, and only the evidence-bearing passes.
        if (c.status === 'PASS' && !c.detail) continue
        console.log(`      ${C[c.status]} ${c.label}${c.detail ? `  \x1b[90m${c.detail}\x1b[0m` : ''}`)
        if (c.status === 'FAIL') failures.push(`${m.meta.id} :: ${c.label} — ${c.detail}`)
      }
    }
  }

  console.log()
  if (layerFailed && !flags.has('--keep-going')) stopped = L
}

if (each) {
  console.log(`\n\x1b[1m  AUDIT MATRIX\x1b[0m  each section run on its own\n`)
  for (const g of grid) {
    const mark = g.fail ? '\x1b[31m✘\x1b[0m' : '\x1b[32m✔\x1b[0m'
    const count = g.fail ? `\x1b[31m${g.fail} failed\x1b[0m of ${g.pass + g.fail}` : `${String(g.pass).padStart(3)} passed`
    console.log(`  ${mark} ${g.layer}  ${g.id.padEnd(14)} ${count}  \x1b[90m${g.secs}s\x1b[0m`)
  }
  console.log()
}

console.log('  ' + '─'.repeat(70))
if (totalFail === 0) {
  console.log(`  \x1b[32mall green\x1b[0m · ${totalPass} checks`)
} else {
  console.log(`  \x1b[31m${totalFail} FAILED\x1b[0m · ${totalPass} passed`)
  console.log(`\n  \x1b[31mFAILURES:\x1b[0m`)
  failures.forEach((f, i) => console.log(`   ${i + 1}. ${f}`))
  if (stopped) console.log(`\n  Stopped after ${stopped}. Fix it before trusting a later layer (--keep-going overrides).`)
}
console.log('  ' + '─'.repeat(70) + '\n')
process.exit(totalFail === 0 ? 0 : 1)
