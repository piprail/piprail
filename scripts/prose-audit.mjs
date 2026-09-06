#!/usr/bin/env node
/**
 * prose-audit.mjs — the slop gate for the two surfaces a stranger reads.
 *
 * 🔴 WHY THIS EXISTS AND WHY IT IS SO SMALL.
 *
 * `.claude/skills/humanizer/PIPRAIL.md` is the house voice, and it is written for a model
 * to read before writing a page. Guidance nobody can measure rots: the docs carried 3,320
 * em dashes before the 2026-09-06 sweep, every one of them added by somebody who had, in
 * principle, read the guidance.
 *
 * So the mechanically certain half lives here and fails the build, and the skill stays the
 * place you go to learn WHY a thing is a tell. The two are not redundant. This list is the
 * deliberately small, certain subset: a gate that fires on correct copy is a gate people
 * start passing --force to, and there is no --force here.
 *
 * What it CANNOT see is shape — the rule of three, uniform paragraph length, negative
 * parallelism, the -ing gloss. Those need a human read. PIPRAIL.md lists them under
 * "What the checker cannot catch".
 *
 * Usage:
 *   node scripts/prose-audit.mjs            # audit, exit 1 on findings
 *   node scripts/prose-audit.mjs --json     # machine-readable
 *   node scripts/prose-audit.mjs site/src   # narrow to a subtree
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
/*
 * `.ts` and `.css` are in scope because under `site/src` and `docs/src` they are not just code:
 * `data/*.ts` holds the blog registry, the glossary definitions, the facilitator notes and the
 * code-card captions that render on the page, and the stylesheets carry authored comments. A
 * reader sees this text, so the house voice applies to it.
 */
const EXTS = new Set(['.md', '.mdx', '.astro', '.ts', '.css', '.mjs'])
/*
 * The two Astro configs are in scope even though they are not under `src`, because each one
 * holds strings that render into EVERY page of its site: the `og:image:alt`, the site
 * description, the JSON-LD blurb. Missing them is how the docs shipped an em dash on all 93
 * pages while the gate reported clean. Their CODE COMMENTS are not in scope (see
 * `stripComments`): the house voice is for text a stranger reads, not for notes to ourselves.
 */
const DEFAULT_ROOTS = ['site/src', 'docs/src', 'site/astro.config.mjs', 'docs/astro.config.mjs']
const COMMENTS_EXEMPT = new Set(['site/astro.config.mjs', 'docs/astro.config.mjs'])

/**
 * Blank out `//` and block comments, keeping line and column numbers intact so a finding
 * still points at the right place. Deliberately naive: a `//` inside a string literal would
 * be blanked too. That direction is safe (it can only hide a finding in a URL-ish string,
 * never invent one), and the alternative is parsing JS to lint prose.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}
const ALLOW_FILE = join(REPO, 'scripts/prose-allow.json')

const C = process.stdout.isTTY && !process.env.NO_COLOR
const red = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s)
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s)

/**
 * The tells. Each is a regex over one line plus the fix to reach for.
 *
 * `dash` is the only one with zero tolerance, and it is first because it is the loudest.
 * The rest are brochure vocabulary and inflated-significance patterns, kept narrow enough
 * that a legitimate technical use does not trip them (we say "key" about a private key
 * constantly, so `key role` is matched, `key` alone is not).
 */
export const TELLS = [
  {
    key: 'em-dash',
    re: /—/g,
    note: 'no em dashes. Colon for a definition, full stop for two clauses, brackets for an aside',
  },
  {
    key: 'en-dash',
    re: /–/g,
    note: 'no en dashes. A hyphen, or the word "to" for a range',
  },
  {
    key: 'not-only-but',
    re: /\bnot\s+only\b[^.\n]{0,60}\bbut\s+(also\s+)?/gi,
    note: 'negative parallelism. Say the second thing and drop the first clause',
  },
  {
    key: 'isnt-just-its',
    re: /\b(is|are|was|were)\s*n[o']t\s+(just|merely|simply|only)\b[^.\n]{0,40}\bit(?:'s| is)\b/gi,
    note: '"it isn\'t X, it\'s Y". Just say what it is',
  },
  {
    key: 'delve',
    re: /\b(delve|delves|delving)\s+into\b/gi,
    note: 'the single most reported AI verb',
  },
  {
    key: 'ai-vocab',
    re: /\b(leverage|leveraging|utilize|utilise|seamless|seamlessly|cutting[-\s]edge|game[-\s]?changer|revolutioni[sz]e|unlock\s+the\s+power|harness\s+the\s+power|elevate\s+your|supercharge|best[-\s]in[-\s]class|world[-\s]class|state[-\s]of[-\s]the[-\s]art)\b/gi,
    note: 'brochure vocabulary. Use the plain word: use, strong, fast',
  },
  {
    key: 'significance-puff',
    re: /\b(stands|serves)\s+as\s+a\b|\bis\s+a\s+testament\s+to\b|\b(underscore[sd]?|highlight[sd]?)\s+the\s+(importance|significance)\b|\bplays\s+a\s+(vital|crucial|pivotal|key)\s+role\b|\bpivotal\s+moment\b/gi,
    note: 'inflated significance. State the fact and let it be significant',
  },
  {
    key: 'evolving-landscape',
    re: /\b(ever[-\s])?(evolving|changing|rapidly\s+changing)\s+(landscape|world|ecosystem)\b|\bin\s+today'?s\s+(fast[-\s]paced|digital)\b|\bdigital\s+age\b/gi,
    note: 'throat-clearing. Delete the sentence',
  },
  {
    key: 'vague-attribution',
    re: /\b(industry\s+experts|many\s+(believe|argue)|it\s+is\s+widely\s+(known|believed)|studies\s+(show|suggest)|observers\s+have)\b/gi,
    note: 'name the source or drop the claim',
  },
  {
    key: 'tapestry',
    re: /\b(rich\s+tapestry|vibrant\s+(ecosystem|community)|treasure\s+trove|myriad\s+of)\b/gi,
    note: 'decoration. Say the number or the thing',
  },
]

/**
 * The allowlist. Two exceptions only, both from PIPRAIL.md: text quoted verbatim from a
 * third party, and literal terminal output where the dash is what the tool printed.
 *
 * An entry is { file, snippet, why } and suppresses findings on any line of that file
 * containing that exact snippet. It is deliberately substring-exact rather than a line
 * number, so the suppression travels with the text when the file is edited.
 */
function loadAllow() {
  if (!existsSync(ALLOW_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'))
    return Array.isArray(parsed?.allow) ? parsed.allow : []
  } catch (err) {
    console.error(red(`  could not parse ${relative(REPO, ALLOW_FILE)}: ${err.message}`))
    process.exit(2)
  }
}

function walk(dir, out = []) {
  // A target may be a single file (`node scripts/prose-audit.mjs docs/src/index.mdx`).
  if (existsSync(dir) && statSync(dir).isFile()) {
    if (EXTS.has(extname(dir))) out.push(dir)
    return out
  }
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.has(extname(name))) out.push(full)
  }
  return out
}

function auditFile(file, allow) {
  const rel = relative(REPO, file)
  const mine = allow.filter((a) => a.file === rel || a.file === '*')
  const findings = []
  const raw = readFileSync(file, 'utf8')
  const lines = (COMMENTS_EXEMPT.has(rel) ? stripComments(raw) : raw).split('\n')
  lines.forEach((line, i) => {
    if (mine.some((a) => line.includes(a.snippet))) return
    for (const tell of TELLS) {
      tell.re.lastIndex = 0
      const hits = line.match(tell.re)
      if (!hits) continue
      findings.push({
        file: rel,
        line: i + 1,
        key: tell.key,
        count: hits.length,
        note: tell.note,
        text: line.trim().slice(0, 120),
      })
    }
  })
  return findings
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const roots = args.filter((a) => !a.startsWith('--'))
const targets = (roots.length ? roots : DEFAULT_ROOTS).map((r) => join(REPO, r))

const allow = loadAllow()
const files = targets.flatMap((t) => walk(t)).sort()
const findings = files.flatMap((f) => auditFile(f, allow))

if (asJson) {
  // exitCode, not exit(): process.exit() truncates a large piped stdout mid-write.
  console.log(JSON.stringify({ files: files.length, findings }, null, 2))
  process.exitCode = findings.length ? 1 : 0
} else if (!findings.length) {
  console.log(green('  \u2713 prose clean') + dim(`  ${files.length} files, no AI tells`))
} else {
  const total = findings.reduce((n, f) => n + f.count, 0)
  console.log(`\n${bold('Prose audit')}  ${dim(`${files.length} files scanned`)}\n`)
  let current = null
  for (const f of findings) {
    if (f.file !== current) {
      current = f.file
      console.log(`  ${bold(current)}`)
    }
    const n = f.count > 1 ? dim(` x${f.count}`) : ''
    console.log(`    ${dim(`${String(f.line).padStart(5)}:`)} ${red(f.key)}${n}  ${dim(f.text)}`)
  }

  const byKey = new Map()
  for (const f of findings) byKey.set(f.key, (byKey.get(f.key) ?? 0) + f.count)
  console.log(`\n  ${bold('Summary')}`)
  for (const [key, n] of [...byKey].sort((a, b) => b[1] - a[1])) {
    const note = TELLS.find((t) => t.key === key).note
    console.log(`    ${String(n).padStart(5)}  ${red(key.padEnd(20))} ${dim(note)}`)
  }
  console.log(`\n  ${red(`${total} finding(s)`)} across ${new Set(findings.map((f) => f.file)).size} file(s).`)
  console.log(dim('  House voice: .claude/skills/humanizer/PIPRAIL.md'))
  console.log(dim('  Genuine exception (quoted text, literal output)? Add it to scripts/prose-allow.json\n'))
  process.exitCode = 1
}
