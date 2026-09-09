#!/usr/bin/env node
/**
 * ── THE SDK SWEEP ────────────────────────────────────────────────────────────────────
 *
 * `npm test` answers "is anything broken?" with one number over 135 files. That is the
 * wrong shape for working on a subsystem: a red run tells you the SDK is broken, not that
 * SWAPS are broken, and 2,000 passing tests hide which surfaces were exercised at all.
 *
 * The sweep runs the SAME suite in named SECTIONS — swaps, facilitators, the gate, the
 * drivers — one vitest process each, reporting per section. Work on swaps, run
 * `npm run sweep -- swaps`, and you get a two-second answer about that surface alone.
 *
 *   npm run sweep                  every section, one line each
 *   npm run sweep -- swaps gate    only these
 *   npm run sweep -- --list        what the sections are
 *   npm run sweep -- --files       which files each section claims
 *   npm run sweep -- --bail        stop at the first failing section
 *
 * 🔴 EVERY test file must belong to exactly one section. A file in none is a surface
 * nobody sweeps, and a file in two is counted twice, so the runner FAILS on either. That
 * is what stops this list rotting the way a hand-written checklist does: add a test file
 * outside every pattern and the sweep tells you, with the filename.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST_DIR = join(ROOT, 'sdk', 'test')

/**
 * A section owns a set of test files by predicate. `why` is the one-line reason the
 * section exists — what breaks in the real world when it goes red.
 */
const SECTIONS = [
  {
    name: 'wire',
    why: 'the x402 envelope on the network: what a non-PipRail client parses',
    match: (f) => f.startsWith('x402') || f === 'receipt-wire' || f === 'conformance' || f === 'units',
  },
  {
    name: 'gate',
    why: 'the merchant money path: verify, replay, receipts, the exact + upto rails',
    match: (f) => f.startsWith('server') || f === 'verify' || f === 'replay-concurrency' || f === 'merchant',
  },
  {
    name: 'client',
    why: 'the buyer: quote, plan, fetch, retries, receipt verification',
    match: (f) => f.startsWith('client') || f === 'plan-payment' || f === 'routing' || f === 'cost' ||
      f === 'recipient-ready' || f === 'notify-both-sides' || f === 'native-reserve',
  },
  {
    name: 'policy',
    why: 'the spend leash: caps, allowlists, windows, the ledger arithmetic',
    match: (f) => f.startsWith('policy') || f.startsWith('ledger') || f.startsWith('budget') || f === 'node-spendstore',
  },
  {
    name: 'agent',
    why: 'authority modes and the sovereign selling half (sell, collect, earnings)',
    match: (f) => f.startsWith('agent') && f !== 'agentGuide',
  },
  {
    name: 'swaps',
    why: 'moving an agent\'s own funds between denominations, and the ceiling on it',
    match: (f) => f.startsWith('swap'),
  },
  {
    name: 'facilitators',
    why: 'who sponsors gas, and the registry that points real money at a host',
    match: (f) => f.startsWith('facilitator'),
  },
  {
    name: 'chains',
    why: 'presets, the token catalog, multi-chain accepts, driver registration',
    match: (f) => f === 'chains' || f === 'registry' || f === 'config-validation' ||
      f.startsWith('multi-') || f === 'describe-asset' || f === 'driver-addressof' ||
      f === 'exact-family-strings' || f === 'exact-transfer-method',
  },
  {
    name: 'drivers',
    why: 'each chain family: pay + verify, mirrored file for file',
    match: (f, isDir) => (isDir && f !== 'transports') || f === 'util',
  },
  {
    name: 'discovery',
    why: 'being findable: well-known, OpenAPI, indexes, the landing page',
    match: (f) => f.startsWith('discovery') || f === 'discover' || f === 'indexes' ||
      f === 'selfdescribe' || f === 'landing' || f === 'render' || f === 'register' ||
      f === 'classify' || f === 'agentGuide',
  },
  {
    name: 'transports',
    why: 'the same payment over A2A and MCP, not just HTTP',
    match: (f, isDir) => (isDir && f === 'transports') || f === 'adapters' || f === 'receipts',
  },
  {
    name: 'adversarial',
    why: 'the hostile cases: fuzzing, edge cases, and the bugs that already shipped once',
    match: (f) => f === 'fuzz-payment-paths' || f === 'edge-cases' || f === 'breakit-2141' || f === 'errors',
  },
]

// ── discover every test file / suite directory under sdk/test ────────────────────────
function inventory() {
  const out = []
  for (const entry of readdirSync(TEST_DIR)) {
    const full = join(TEST_DIR, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'fixtures') continue // shared data, not a suite
      out.push({ id: entry, isDir: true, glob: `sdk/test/${entry}/` })
      continue
    }
    if (!entry.endsWith('.test.ts')) continue // helpers like _dual-rail.ts
    const id = entry.replace(/\.test\.ts$/, '')
    out.push({ id, isDir: false, glob: `sdk/test/${entry}` })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function assign(items) {
  const claims = new Map(SECTIONS.map((s) => [s.name, []]))
  const orphans = []
  const contested = []
  for (const it of items) {
    const owners = SECTIONS.filter((s) => s.match(it.id, it.isDir))
    if (owners.length === 0) orphans.push(it.id)
    else if (owners.length > 1) contested.push(`${it.id} → ${owners.map((o) => o.name).join(' + ')}`)
    else claims.get(owners[0].name).push(it)
  }
  return { claims, orphans, contested }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const wanted = argv.filter((a) => !a.startsWith('--'))

const items = inventory()
const { claims, orphans, contested } = assign(items)

// The coverage invariant runs FIRST and always, whatever the caller asked for.
if (orphans.length || contested.length) {
  console.error('\n\x1b[31m✘ sweep coverage is broken\x1b[0m')
  if (orphans.length) {
    console.error(`\n  ${orphans.length} test file(s) belong to NO section, so nothing sweeps them:`)
    for (const o of orphans) console.error(`    · sdk/test/${o}`)
    console.error('\n  Add them to a section in scripts/sweep.mjs (that file is the map).')
  }
  if (contested.length) {
    console.error(`\n  ${contested.length} test file(s) belong to MORE THAN ONE section:`)
    for (const c of contested) console.error(`    · ${c}`)
  }
  process.exit(1)
}

if (flags.has('--list') || flags.has('--files')) {
  console.log(`\n  ${items.length} suites across ${SECTIONS.length} sections\n`)
  for (const s of SECTIONS) {
    const mine = claims.get(s.name)
    console.log(`  \x1b[1m${s.name.padEnd(13)}\x1b[0m ${String(mine.length).padStart(3)} suites  \x1b[90m${s.why}\x1b[0m`)
    if (flags.has('--files')) for (const m of mine) console.log(`                  · ${m.id}`)
  }
  console.log()
  process.exit(0)
}

const unknown = wanted.filter((w) => !SECTIONS.some((s) => s.name === w))
if (unknown.length) {
  console.error(`\n  Unknown section(s): ${unknown.join(', ')}`)
  console.error(`  Known: ${SECTIONS.map((s) => s.name).join(', ')}\n`)
  process.exit(1)
}

const run = SECTIONS.filter((s) => wanted.length === 0 || wanted.includes(s.name))

console.log(`\n\x1b[1m  SDK SWEEP\x1b[0m  ${run.length} section(s), ${items.length} suites total\n`)

const results = []
let failed = 0
for (const s of run) {
  const globs = claims.get(s.name).map((m) => m.glob)
  const started = Date.now()
  const outDir = mkdtempSync(join(tmpdir(), 'piprail-sweep-'))
  const outFile = join(outDir, 'report.json')
  const proc = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`, ...globs],
    // Inherit the environment UNCHANGED. Setting PIPRAIL_NO_HINTS here to quieten the output
    // silently broke server-exact.test.ts, which asserts that very hint is printed; a suite that
    // wants quiet sets the flag itself.
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  let tests = 0
  let fails = 0
  try {
    const json = JSON.parse(readFileSync(outFile, 'utf8'))
    tests = json.numTotalTests ?? 0
    fails = json.numFailedTests ?? 0
  } catch { /* no report written (a crash / no files) → fall back to the exit code */ }
  rmSync(outDir, { recursive: true, force: true })
  const ok = proc.status === 0 && fails === 0
  if (!ok) failed++
  results.push({ name: s.name, why: s.why, suites: globs.length, tests, fails, secs, ok, proc })

  const mark = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'
  const count = ok ? `${String(tests).padStart(4)} passed` : `\x1b[31m${fails} FAILED\x1b[0m of ${tests}`
  console.log(`  ${mark} ${s.name.padEnd(13)} ${String(globs.length).padStart(3)} suites  ${count}  \x1b[90m${secs}s\x1b[0m`)
  if (!ok) {
    const detail = (proc.stdout ?? '').split('\n').filter((l) => /FAIL|×|AssertionError/.test(l)).slice(0, 12)
    for (const d of detail) console.log(`      \x1b[90m${d.trim().slice(0, 150)}\x1b[0m`)
    if (proc.status !== 0 && !tests) console.log(`      \x1b[90m${(proc.stderr ?? '').trim().split('\n').slice(-4).join('\n      ')}\x1b[0m`)
    if (flags.has('--bail')) break
  }
}

const totalTests = results.reduce((n, r) => n + r.tests, 0)
const totalFails = results.reduce((n, r) => n + r.fails, 0)
console.log(`\n  ${'─'.repeat(62)}`)
console.log(
  failed === 0
    ? `  \x1b[32mall ${run.length} sections green\x1b[0m · ${totalTests} tests`
    : `  \x1b[31m${failed} of ${run.length} sections FAILED\x1b[0m · ${totalFails} failing tests of ${totalTests}`
)
console.log(`  ${'─'.repeat(62)}\n`)
process.exit(failed === 0 ? 0 : 1)
