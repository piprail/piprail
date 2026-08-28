#!/usr/bin/env node
/**
 * ── THE SYNC CHECKER ────────────────────────────────────────────────────────────────
 *
 *   npm run sync                    # check everything
 *   npm run sync -- --graph         # print the map: what is linked to what
 *   npm run sync -- --domain chains # one domain
 *   npm run sync -- --only tool-names
 *   npm run sync -- --touched sdk/src/facilitators.ts   # "I changed this — what else?"
 *
 * PipRail states the same facts in a lot of places: the chain count lives in nine files
 * (one of them a URL-encoded shields badge that a plain grep for the number misses), the
 * MCP tool list exists in four, the facilitator registry in nine. Every one of those is a
 * chance to ship a contradiction.
 *
 * The rules in rules.mjs are BOTH the check and the map, so `--graph` and `--touched`
 * cannot go stale the way a hand-written checklist does — they are printed from the same
 * definitions that just ran.
 *
 * Exit code 1 on any failure. Warnings and skips never fail the build; a skip prints WHY,
 * because a check that quietly does nothing is worse than no check at all.
 */
import { RULES, DOMAINS } from './rules.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true) : undefined
}

const C = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  dim: (s) => (C ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (C ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (C ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (C ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (C ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (C ? `\x1b[36m${s}\x1b[0m` : s),
}

/* ─────────────────────────────── --graph ─────────────────────────────── */

function printGraph(filter) {
  console.log(`\n${c.bold('PipRail surface map')} — what is linked to what\n`)
  for (const domain of DOMAINS) {
    const rules = RULES.filter((r) => r.domain === domain && (!filter || r.domain === filter || r.id === filter))
    if (!rules.length) continue
    console.log(c.bold(c.cyan(`  ${domain.toUpperCase()}`)))
    for (const r of rules) {
      console.log(`    ${c.bold(r.id)} — ${r.what}`)
      console.log(`      ${c.green('source')}  ${r.source.file}`)
      console.log(`              ${c.dim(r.source.note)}`)
      for (const m of r.mirrors) {
        console.log(`      ${c.yellow('mirror')}  ${m.file}`)
        console.log(`              ${c.dim(m.note)}`)
      }
      console.log('')
    }
  }
  console.log(c.dim('  A change to a `source` must be propagated to every `mirror` beneath it.\n'))
}

/* ─────────────────────────────── --touched ─────────────────────────────── */

/**
 * "I edited this file — what else has to change?" Matches loosely (substring, and the
 * glob-ish `<family>` / `*` placeholders the rules use) because a mirror entry is a
 * human-readable location, not a literal path.
 */
function printTouched(path) {
  const loose = (pattern, p) => {
    const base = pattern.replace(/<[^>]+>|\*+/g, '').replace(/\/{2,}/g, '/')
    return base.length > 3 && (p.includes(base.replace(/\/$/, '')) || base.includes(p))
  }
  const hits = RULES.filter((r) => loose(r.source.file, path) || r.mirrors.some((m) => loose(m.file, path)))

  console.log(`\n${c.bold('Touched:')} ${path}\n`)
  if (!hits.length) {
    console.log(c.dim('  No rule references this path. Either it is not a mirrored surface, or'))
    console.log(c.dim('  it should be — add a rule to scripts/sync/rules.mjs.\n'))
    return
  }
  for (const r of hits) {
    const isSource = loose(r.source.file, path)
    console.log(`  ${c.bold(r.id)} ${c.dim(`(${r.domain})`)} — ${r.what}`)
    console.log(`    you touched the ${isSource ? c.green('SOURCE') : c.yellow('MIRROR')}`)
    if (isSource) {
      console.log(`    ${c.bold('→ now update:')}`)
      for (const m of r.mirrors) console.log(`        · ${m.file}  ${c.dim(m.note)}`)
    } else {
      console.log(`    ${c.dim(`source of truth: ${r.source.file}`)}`)
      console.log(`    ${c.dim('other mirrors that state the same fact:')}`)
      for (const m of r.mirrors) if (!loose(m.file, path)) console.log(`        · ${m.file}`)
    }
    console.log('')
  }
  console.log(c.dim(`  Then run: npm run sync\n`))
}

/* ─────────────────────────────── run checks ─────────────────────────────── */

function run() {
  const domain = flag('domain')
  const only = flag('only')
  /*
   * Group by domain for the report. Rules are appended to rules.mjs over time, so their file
   * order does not stay domain-contiguous — without this the report prints "CHAINS" twice and
   * reads like two separate runs. DOMAINS preserves first-appearance order.
   */
  const rules = RULES
    .filter((r) => (!domain || r.domain === domain) && (!only || r.id === only))
    .sort((a, b) => DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain))

  if (!rules.length) {
    console.error(`No rules matched. Domains: ${DOMAINS.join(', ')}`)
    process.exit(2)
  }

  let failed = 0
  let skipped = 0
  let warned = 0
  let lastDomain = null

  for (const rule of rules) {
    if (rule.domain !== lastDomain) {
      console.log(`\n${c.bold(c.cyan(rule.domain.toUpperCase()))}`)
      lastDomain = rule.domain
    }
    let res
    try {
      res = rule.check()
    } catch (err) {
      // A throwing rule is a broken rule, and must be loud — never swallowed into a pass.
      res = { ok: false, detail: `rule threw: ${err.message}` }
    }
    if (res.skip) {
      skipped++
      console.log(`  ${c.yellow('⊘')} ${rule.id}  ${c.dim(`skipped — ${res.detail}`)}`)
    } else if (!res.ok) {
      failed++
      console.log(`  ${c.red('✗')} ${c.bold(rule.id)} — ${rule.what}`)
      console.log(`      ${c.red(res.detail)}`)
      console.log(`      ${c.dim(`source: ${rule.source.file}`)}`)
      for (const m of rule.mirrors) console.log(`      ${c.dim(`mirror: ${m.file} — ${m.note}`)}`)
    } else if (res.warn) {
      warned++
      console.log(`  ${c.yellow('!')} ${rule.id}  ${c.dim(res.detail)}`)
    } else {
      console.log(`  ${c.green('✓')} ${rule.id}  ${c.dim(res.detail)}`)
    }
  }

  const passed = rules.length - failed - skipped - warned
  console.log(`\n${'─'.repeat(72)}`)
  console.log(
    `  ${c.green(`${passed} in sync`)}` +
      (warned ? ` · ${c.yellow(`${warned} warning`)}` : '') +
      (skipped ? ` · ${c.yellow(`${skipped} skipped`)}` : '') +
      (failed ? ` · ${c.red(`${failed} OUT OF SYNC`)}` : ''),
  )
  if (skipped) console.log(c.dim('  Skipped rules need a build first: npm run build:sdk && npm run build'))
  if (failed) {
    console.log(`\n  ${c.red('Fix the mirrors listed above, then re-run.')}`)
    console.log(c.dim('  Map of everything: npm run sync -- --graph   ·   .claude/SURFACES.md\n'))
    process.exit(1)
  }
  console.log(c.dim(`  Map: npm run sync -- --graph   ·   "what else changes?": npm run sync -- --touched <file>\n`))
}

const graph = flag('graph')
const touched = flag('touched')
if (graph) printGraph(typeof graph === 'string' ? graph : undefined)
else if (touched) printTouched(String(touched))
else run()
