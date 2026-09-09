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
import { dependents, dependencies, blastRadius, bucket, moduleGraph } from './graph.mjs'
import { documentedIn, describes, anchorsFor, exportedSymbols } from './links.mjs'

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
      for (const v of r.verify ?? []) console.log(`      ${c.cyan('verify')}  ${v}`)
      console.log('')
    }
  }
  console.log(c.dim('  A change to a `source` must be propagated to every `mirror` beneath it,'))
  console.log(c.dim('  and proven by every `verify` command beside it.\n'))
}


/* ───────────────────────── the architecture half of the map ───────────────────────── */

/**
 * `rules.mjs` answers "where else is this FACT stated?". This answers "what does this FILE
 * reach, and what prose describes it?" — the question that had no answer at all until now.
 * Both halves print from derived data, so neither can rot into a stale diagram.
 */
function printArchitecture(path, { full = false } = {}) {
  const { files } = moduleGraph()
  const isCode = files.includes(path)
  const up = isCode ? dependents(path) : []
  const down = isCode ? dependencies(path) : []
  const radius = isCode ? blastRadius(path) : []
  const prose = documentedIn(path)
  const anchors = anchorsFor(path)
  // Computed BEFORE the early return: a docs page has no exports and no imports, so every
  // other signal is empty and the whole section used to be skipped — for exactly the files
  // where "what code does this describe?" is the only question worth asking.
  const about = isCode ? [] : describes(path)

  if (!isCode && !prose.length && !anchors.length && !about.length) return

  if (isCode) {
    console.log(`  ${c.bold('ARCHITECTURE')} ${c.dim('— what links to this (derived from real imports)')}`)
  }
  if (isCode) {
    const list = (label, arr, colour) => {
      if (!arr.length) return console.log(`    ${label} ${c.dim('none')}`)
      const shown = full ? arr : arr.slice(0, 8)
      console.log(`    ${label} ${colour(String(arr.length))}`)
      for (const f of shown) console.log(`        ${f}`)
      if (arr.length > shown.length) console.log(c.dim(`        …and ${arr.length - shown.length} more (--map for all)`))
    }
    list('imports         ', down, c.dim)
    list('imported by     ', up, c.yellow)
    if (radius.length) {
      const spread = bucket(radius).map(([g, v]) => `${g} ${v.length}`).join(' · ')
      console.log(`    blast radius     ${c.red(String(radius.length))} ${c.dim(`files — ${spread}`)}`)
    }
  }

  /*
   * The reverse direction, for when you are editing the PROSE. A docs page cannot import the
   * module it documents, so without this, `--touched` on a docs page could only tell you your
   * SDK imports must be real — which does not help you notice the page now describes behaviour
   * the module no longer has.
   */
  if (!isCode) {
    if (about.length) {
      console.log(`  ${c.bold('CODE this describes')} ${c.dim('— derived from the symbols it names')}`)
      for (const a of (full ? about : about.slice(0, 6))) {
        console.log(`        ${a.file} ${c.dim(`(${a.score} symbols: ${a.symbols.join(', ')})`)}`)
      }
      if (!full && about.length > 6) console.log(c.dim(`        …and ${about.length - 6} more (--map for all)`))
      console.log(c.dim('        check the page against these, not against your memory of them'))
      console.log('')
    }
  }

  if (prose.length) {
    console.log(`\n  ${c.bold('PROSE that describes it')} ${c.dim('— derived from the symbols it exports')}`)
    const shown = full ? prose : prose.slice(0, 10)
    for (const p of shown) console.log(`        ${p.file} ${c.dim(`(${p.symbols.join(', ')})`)}`)
    if (prose.length > shown.length) console.log(c.dim(`        …and ${prose.length - shown.length} more (--map for all)`))
    console.log(c.dim('        rename an export and every one of these goes stale silently'))
  }
  if (anchors.length) {
    console.log(`\n  ${c.bold('DECLARED surfaces')} ${c.dim('— links no derivation can find')}`)
    for (const a of anchors) console.log(`        ${a.file} ${c.dim(`— ${a.why}`)}`)
  }
  console.log('')
}

/* ───────────────────────────────── --map ───────────────────────────────── */

/** The whole picture for one file: the facts it states, what it links to, what proves it. */
function printMap(path) {
  console.log(`\n${c.bold('MAP:')} ${path}\n`)
  const syms = exportedSymbols(path)
  if (syms.length) console.log(c.dim(`  exports ${syms.length} symbol(s): ${syms.slice(0, 12).join(', ')}${syms.length > 12 ? ', …' : ''}\n`))
  printArchitecture(path, { full: true })
  printTouched(path, { skipHeader: true })
}

/** A bird's-eye view: the most-depended-on modules, which is where risk concentrates. */
function printArchOverview() {
  const { imports, importedBy, files } = moduleGraph()
  let edges = 0
  for (const s of imports.values()) edges += s.size
  console.log(`\n${c.bold('PipRail architecture')} — ${files.length} modules, ${edges} import edges\n`)
  const ranked = [...importedBy.entries()]
    .map(([f, s]) => [f, s.size, blastRadius(f).length])
    .sort((a, b) => b[2] - a[2])
    .slice(0, 20)
  console.log(c.dim('  The modules the most code depends on. A change here is the most expensive'))
  console.log(c.dim('  kind to get wrong, and the one most worth a test before it ships.\n'))
  console.log(`  ${'module'.padEnd(46)}${'direct'.padStart(7)}${'reach'.padStart(7)}`)
  for (const [f, direct, reach] of ranked) {
    console.log(`  ${f.padEnd(46)}${String(direct).padStart(7)}${c.red(String(reach).padStart(7))}`)
  }
  console.log(c.dim('\n  One file: npm run sync -- --map <file>\n'))
}

/* ─────────────────────────────── --touched ─────────────────────────────── */

/**
 * "I edited this file — what else has to change?" Matches loosely (substring, and the
 * glob-ish `<family>` / `*` placeholders the rules use) because a mirror entry is a
 * human-readable location, not a literal path.
 */
function printTouched(path, { skipHeader = false } = {}) {
  const loose = (pattern, p) => {
    const base = pattern.replace(/<[^>]+>|\*+/g, '').replace(/\/{2,}/g, '/')
    return base.length > 3 && (p.includes(base.replace(/\/$/, '')) || base.includes(p))
  }
  const hits = RULES.filter((r) => loose(r.source.file, path) || r.mirrors.some((m) => loose(m.file, path)))

  if (!skipHeader) {
    console.log(`\n${c.bold('Touched:')} ${path}\n`)
    // The architecture half goes FIRST: "what does this reach?" is the question you need
    // answered before you decide how careful to be, and the fact list is the follow-up.
    printArchitecture(path)
  }
  if (!hits.length) {
    console.log(`  ${c.bold('FACTS this file states')}`)
    console.log(c.dim('    No rule references this path. Either it is not a mirrored surface, or'))
    console.log(c.dim('    it should be — add a rule to scripts/sync/rules.mjs.\n'))
    return
  }
  console.log(`  ${c.bold('FACTS this file states')} ${c.dim('— every other place they are repeated')}`)
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

  /*
   * The whole point of the map is that ONE query answers both halves: where does this fact
   * also live, and what proves it still holds. Printing the union (in rule order, deduped)
   * means touching three files gives one runnable list rather than three overlapping ones.
   */
  const cmds = [...new Set(hits.flatMap((r) => r.verify ?? []))]
  console.log(`  ${c.bold('→ then verify:')}`)
  for (const cmd of cmds) console.log(`        ${c.cyan(cmd)}`)
  console.log(c.dim(`\n  Always, before you finish: npm run sync   ·   npm run verify-gate\n`))
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
  console.log(c.dim('  Map: npm run sync -- --touched <file>   (what it reaches · what states the same facts · what to run)'))
  console.log(c.dim('       npm run sync -- --map <file>   ·   npm run map   ·   npm run sync -- --graph\n'))
}

const graph = flag('graph')
const mapFlag = flag('map')
const touched = flag('touched')
if (graph) printGraph(typeof graph === 'string' ? graph : undefined)
else if (mapFlag === true) printArchOverview()
else if (mapFlag) printMap(String(mapFlag))
else if (touched) printTouched(String(touched))
else run()
