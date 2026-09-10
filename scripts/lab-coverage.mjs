/**
 * ── DOES THE LAB ACTUALLY EXERCISE THE WHOLE SDK? ───────────────────────────────────
 *
 *   npm run lab:coverage           # the summary + anything uncovered
 *   npm run lab:coverage -- --list # every symbol and the test that claims it
 *
 * /demo says it is a lab for the SDK. That claim is worth exactly as much as the proof
 * behind it, and prose cannot carry it: a symbol added to the SDK on Tuesday does not
 * appear on the page on Wednesday, and nothing anywhere goes red. The page just quietly
 * covers less of the thing it claims to cover.
 *
 * So the claim is computed. This script reads the PUBLIC SURFACE out of the built SDK
 * (every runtime export, plus the public members of the classes and interfaces a caller
 * actually holds) and the `uses` declarations out of the lab manifest, and fails when a
 * symbol exists that no lab test claims.
 *
 * ── THE ESCAPE HATCH, AND WHY IT IS NARROW ──────────────────────────────────────────
 * A handful of calls must not fire from a public web page — not because they are hard,
 * but because firing them would write junk into someone else's directory or move real
 * money. Those live in `OFF_THE_BENCH` in the manifest, each with a reason, and the page
 * RENDERS that reason rather than hiding the gap. An exemption without a reason fails
 * here, and so does a stale one whose symbol no longer exists.
 *
 * ── WHY IT READS THE BUILT DIST ─────────────────────────────────────────────────────
 * The lab loads the PUBLISHED package. Reading `sdk/src` would measure a surface the page
 * cannot reach and would go green while /demo was broken, which is the failure this whole
 * script exists to prevent. Build the SDK first; `--dist` points elsewhere if you must.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const WANT_LIST = argv.includes('--list')
const distArg = argv.find((a) => a.startsWith('--dist='))
const DIST = distArg ? resolve(distArg.slice(7)) : resolve(ROOT, 'sdk/dist/index.js')

/**
 * Every .d.ts in the dist, concatenated.
 *
 * The bundler splits shared declarations into content-hashed chunks, so `SpendLedger` is
 * declared in `ledger-<hash>.d.ts` and merely re-exported from `index.d.ts`. Reading only
 * the entry point found the class missing and threw, which is the honest failure: the
 * surface is spread across the folder, so the folder is what gets read.
 */
const typeSurface = (dist) => {
  const dir = dirname(dist)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.d.ts'))
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .join('\n')
}

/**
 * The classes and interfaces whose MEMBERS count as surface, not just the name.
 *
 * `PipRailClient` is the one a buyer holds, `PaymentGate` the one a merchant holds: a lab
 * that imported both and called two methods between them would pass a name-only check
 * while demonstrating almost nothing. The members are where the capability lives.
 */
const MEMBER_TYPES = [
  { kind: 'class', name: 'PipRailClient' },
  { kind: 'interface', name: 'PaymentGate' },
  { kind: 'class', name: 'SpendLedger' },
  { kind: 'class', name: 'MultiChainPayer' },
]

/** Members every object has, or that carry no capability of their own. */
const IGNORED_MEMBERS = new Set(['constructor', 'toString', 'toJSON'])

/**
 * Pull the public members of one declaration out of the .d.ts.
 *
 * `private` is a COMPILE-TIME marker: it is gone at runtime, so reading the prototype
 * would count 54 members on a class that offers 30, and the lab would be asked to
 * demonstrate internals a caller cannot even call. The types are the only place the
 * public/private line still exists, so that is what gets read.
 */
function publicMembers(dts, kind, name) {
  const start = dts.search(new RegExp(`^(declare )?${kind} ${name}\\b`, 'm'))
  if (start === -1) throw new Error(`lab-coverage: no ${kind} ${name} in the dist types`)
  let i = dts.indexOf('{', start)
  let depth = 0
  let end = i
  for (; end < dts.length; end++) {
    if (dts[end] === '{') depth++
    else if (dts[end] === '}' && --depth === 0) break
  }
  const body = dts.slice(i + 1, end)

  // Only depth-1 lines are members; anything nested is part of an inline object type.
  const members = new Set()
  let d = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (d === 0 && trimmed && !trimmed.startsWith('*') && !trimmed.startsWith('//')) {
      const m = /^(?:static\s+)?(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(<:?]/.exec(trimmed)
      if (m && !trimmed.startsWith('private') && !trimmed.startsWith('#') && !IGNORED_MEMBERS.has(m[1])) {
        members.add(`${name}#${m[1]}`)
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') d++
      else if (ch === '}' || ch === ')' || ch === ']') d--
    }
  }
  return [...members]
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`lab-coverage: no built SDK at ${DIST}\n  run: npm run build:sdk`)
    process.exit(1)
  }
  const sdk = await import(DIST)
  const dts = typeSurface(DIST)

  // The surface: every runtime export, plus the public members of the held types. Type-only
  // exports are deliberately absent — they have no runtime existence for a lab to call.
  const surface = new Set(Object.keys(sdk).filter((k) => k !== 'default'))
  for (const t of MEMBER_TYPES) for (const m of publicMembers(dts, t.kind, t.name)) surface.add(m)

  const { LAB_TESTS, OFF_THE_BENCH } = await import(resolve(ROOT, 'site/src/lib/lab/manifest.ts'))

  const claimedBy = new Map()
  for (const test of LAB_TESTS) {
    for (const symbol of test.uses) {
      if (!claimedBy.has(symbol)) claimedBy.set(symbol, [])
      claimedBy.get(symbol).push(test.id)
    }
  }

  const exempt = new Map(OFF_THE_BENCH.map((e) => [e.symbol, e.reason]))
  const problems = []

  // 1. Everything in the surface is claimed by a test, or exempt with a reason.
  const uncovered = [...surface].filter((s) => !claimedBy.has(s) && !exempt.has(s)).sort()
  if (uncovered.length) {
    problems.push(
      `${uncovered.length} public symbol(s) no lab test exercises:\n` +
        uncovered.map((s) => `    ${s}`).join('\n') +
        `\n  Add each to a test's \`uses\`, or to OFF_THE_BENCH with the reason it cannot run in a browser.`
    )
  }

  // 2. No test claims a symbol that has since been renamed or removed. A stale `uses`
  //    entry is worse than a missing one: the count still looks right.
  const phantom = [...claimedBy.keys()].filter((s) => !surface.has(s)).sort()
  if (phantom.length) {
    problems.push(
      `${phantom.length} symbol(s) claimed by a lab test but not in the SDK:\n` +
        phantom.map((s) => `    ${s}  (claimed by ${claimedBy.get(s).join(', ')})`).join('\n')
    )
  }

  // 3. No exemption outlives the symbol it excuses.
  const staleExempt = [...exempt.keys()].filter((s) => !surface.has(s)).sort()
  if (staleExempt.length) {
    problems.push(
      `${staleExempt.length} OFF_THE_BENCH entr(ies) for a symbol that no longer exists:\n` +
        staleExempt.map((s) => `    ${s}`).join('\n')
    )
  }

  // 4. Every test in the manifest has a runner, and every runner is in the manifest.
  //    The page renders its bench from the manifest, so an id with no runner is a button
  //    that throws when a visitor clicks it, and a runner with no id is dead code nobody
  //    can reach. Neither shows up in a type check, because the two live in different files
  //    and are joined by a string at runtime.
  const runnersSrc = readFileSync(resolve(ROOT, 'site/public/lab/runners.js'), 'utf8')
  const runnersBlock = runnersSrc.slice(runnersSrc.indexOf('export const RUNNERS = {'))
  const runnerIds = new Set([...runnersBlock.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]))
  const missingRunner = LAB_TESTS.filter((t) => !runnerIds.has(t.id)).map((t) => t.id)
  const orphanRunner = [...runnerIds].filter((id) => !LAB_TESTS.some((t) => t.id === id))
  if (missingRunner.length) problems.push(`lab test(s) with no runner in runners.js: ${missingRunner.join(', ')}`)
  if (orphanRunner.length) problems.push(`runner(s) in runners.js that no lab test lists: ${orphanRunner.join(', ')}`)

  // 5. An exemption must say why, and a symbol cannot be both run and excused.
  for (const e of OFF_THE_BENCH) {
    if (!e.reason || e.reason.length < 20) problems.push(`OFF_THE_BENCH ${e.symbol} needs a real reason`)
    if (claimedBy.has(e.symbol)) problems.push(`${e.symbol} is both exercised and exempt — pick one`)
  }

  const covered = surface.size - uncovered.length - exempt.size
  const pct = ((covered / surface.size) * 100).toFixed(1)

  if (WANT_LIST) {
    for (const s of [...surface].sort()) {
      const where = claimedBy.get(s)?.join(', ') ?? (exempt.has(s) ? 'OFF THE BENCH' : '—')
      console.log(`  ${s.padEnd(38)} ${where}`)
    }
    console.log('')
  }

  console.log(
    `lab coverage: ${covered}/${surface.size} (${pct}%) of the SDK's public surface is on the bench` +
      `\n  ${LAB_TESTS.length} tests · ${exempt.size} deliberately off the bench · ${uncovered.length} unclaimed`
  )

  if (problems.length) {
    console.error('\n' + problems.map((p) => `  ✗ ${p}`).join('\n\n'))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`lab-coverage: ${err?.stack ?? err}`)
  process.exit(1)
})
