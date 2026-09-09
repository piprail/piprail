/**
 * ── CROSS-MEDIUM LINKS: WHICH PROSE DESCRIBES WHICH CODE ────────────────────────────
 *
 * `graph.mjs` follows imports, which covers code-to-code. But the most expensive misses at
 * PipRail are code-to-PROSE: you rename a client method and the docs page describing it, the
 * llms files an AI crawler reads, and the marketing page quoting it all keep the old name.
 * No import connects any of those, so the import graph cannot see them.
 *
 * 🔴 STILL DERIVED, NOT TYPED OUT. The link is found through the SYMBOL: a module exports
 * `planPayment`, a docs page writes `client.planPayment(url)` inside a fence, so that page
 * documents that module. Rename the export and the link moves with it. A hand-written table
 * of "module → docs page" would be a second copy of a fact, which is the failure the whole
 * sync system exists to prevent.
 *
 * The one hand-declared part is {@link ANCHORS}: a handful of surfaces whose subject no symbol
 * reveals, because the page renders DATA rather than calling an API. `/facilitators` shows the
 * facilitator registry without importing anything from the SDK, so nothing but a person can
 * say so. Each entry says why it cannot be derived.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** Prose and sample surfaces: everything a human or a crawler reads, rather than imports. */
const PROSE_ROOTS = [
  ['docs/src/content/docs', ['.md', '.mdx']],
  ['site/src/pages', ['.astro']],
  ['site/public', ['.txt']],
  ['examples', ['.mjs', '.md', '.ts']],
  ['integrations', ['.md']],
  ['mcp', ['.md']],
  ['sdk', ['.md']],
]

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = readdirSync(join(REPO, dir))
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const rel = `${dir}/${name}`
    let st
    try {
      st = statSync(join(REPO, rel))
    } catch {
      continue
    }
    if (st.isDirectory()) walk(rel, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(rel)
  }
  return out
}

/**
 * The identifiers a module exports. Deliberately source-parsed rather than read off the built
 * bundle: this must work in a fresh clone, and it must attribute a symbol to the FILE that
 * declares it, which `sdk/dist` has already flattened away.
 */
export function exportedSymbols(file) {
  let src
  try {
    src = readFileSync(join(REPO, file), 'utf8')
  } catch {
    return []
  }
  const out = new Set()
  const decl = /export\s+(?:async\s+)?(?:declare\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  for (const m of src.matchAll(decl)) out.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const id = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (id && /^[A-Za-z_$][\w$]*$/.test(id)) out.add(id)
    }
  }
  /*
   * Single-letter and two-letter names match far too much prose to be evidence of anything,
   * and a symbol shared with a common English word ("type", "get") would link every page.
   */
  return [...out].filter((s) => s.length >= 4)
}

let proseCache = null
function proseFiles() {
  if (!proseCache) proseCache = PROSE_ROOTS.flatMap(([d, e]) => walk(d, e))
  return proseCache
}

const contentCache = new Map()
function contentOf(f) {
  if (!contentCache.has(f)) {
    try {
      contentCache.set(f, readFileSync(join(REPO, f), 'utf8'))
    } catch {
      contentCache.set(f, '')
    }
  }
  return contentCache.get(f)
}

/**
 * Prose surfaces that name at least `min` of this module's exported symbols.
 *
 * The threshold matters. One passing mention of a widely-used type is not "this page documents
 * that module"; a page that names several of its symbols is. Two is the point where the noise
 * from shared vocabulary drops away without losing real single-purpose pages.
 */
export function documentedIn(file, { min = 2 } = {}) {
  const symbols = exportedSymbols(file)
  if (!symbols.length) return []
  const hits = []
  for (const f of proseFiles()) {
    const body = contentOf(f)
    let n = 0
    const matched = []
    for (const s of symbols) {
      // Word-boundary match, so `pay` never matches inside `payment`.
      if (new RegExp(`\\b${s.replace(/\$/g, '\\$')}\\b`).test(body)) {
        n += 1
        matched.push(s)
      }
      if (n >= min && matched.length >= min) break
    }
    if (n >= min) hits.push({ file: f, symbols: matched.slice(0, 4) })
  }
  return hits
}

/**
 * The code modules a prose surface DESCRIBES — the inverse of {@link documentedIn}.
 *
 * This is the direction you are in when the risk is highest. Editing `payment-policy.md` you
 * need to know it documents `sdk/src/policy.ts`, so you can check the page against the code
 * rather than against your memory of it. Without it, `--touched` on a docs page could only say
 * "your SDK imports must be real", which does not help you notice the page now describes
 * behaviour the module no longer has.
 */
export function describes(proseFile, { min = 2 } = {}) {
  const body = contentOf(proseFile)
  if (!body) return []
  const hits = []
  for (const mod of codeModules()) {
    const symbols = exportedSymbols(mod)
    if (symbols.length < min) continue
    const matched = symbols.filter((sym) => new RegExp(`\\b${sym.replace(/\$/g, '\\$')}\\b`).test(body))
    if (matched.length >= min) hits.push({ file: mod, symbols: matched.slice(0, 4), score: matched.length })
  }
  // Most symbols in common first: that is the module the page is actually about.
  return hits.sort((a, b) => b.score - a.score)
}

/**
 * Every shipped code module whose exports could be described in prose.
 *
 * Barrels are excluded. `sdk/src/index.ts` re-exports the entire public surface, so it shares
 * symbols with EVERY page and would rank first for all of them — technically true and entirely
 * useless. What you want to know is which real module a page is about.
 */
let modCache = null
function codeModules() {
  if (!modCache) {
    modCache = [...walk('sdk/src', ['.ts']), ...walk('mcp/src', ['.ts'])]
      .filter((f) => !f.endsWith('.d.ts'))
      .filter((f) => f !== 'sdk/src/index.ts' && f !== 'mcp/src/index.ts')
  }
  return modCache
}

/**
 * ── THE HAND-DECLARED REMAINDER ──────────────────────────────────────────────────────
 *
 * Every entry here exists because NO derivation can find the link, and each says why. Keep
 * this list short and suspicious: if a link can be derived, deriving it is always right, and
 * a growing table here means something that should be generated is being typed instead.
 */
export const ANCHORS = [
  {
    file: 'sdk/src/facilitators.ts',
    surfaces: ['site/src/pages/facilitators.astro', 'site/src/data/facilitators.ts'],
    why: 'the page renders GENERATED data and imports nothing from the SDK, so no symbol connects them',
  },
  {
    file: 'sdk/src/swapProviders.ts',
    surfaces: ['site/src/pages/swaps.astro', 'site/src/pages/sdk.astro', 'site/src/data/swap-providers.ts'],
    why: 'same shape as the facilitator registry: generated data, no shared symbol',
  },
  {
    file: 'sdk/src/drivers/evm/chains.ts',
    surfaces: ['site/src/data/chains.ts', 'site/src/pages/chains.astro'],
    why: 'the catalog MIRRORS the presets by hand (names and slugs), so nothing is imported',
  },
  {
    file: 'sdk/src/agent.ts',
    surfaces: ['mcp/src/banner.ts', 'mcp/README.md', 'site/src/pages/mcp.astro'],
    why: 'banner.ts hand-copies TOOL_NAMES as a string array rather than importing paymentTools()',
  },
  {
    file: 'mcp/src/config.ts',
    surfaces: ['docs/src/content/docs/mcp/', '.env.example'],
    why: 'env var names are strings read at runtime, never imported anywhere',
  },
]

/** The declared surfaces for a file, if any. */
export function anchorsFor(file) {
  return ANCHORS.filter((a) => a.file === file).flatMap((a) => a.surfaces.map((s) => ({ file: s, why: a.why })))
}

export { REPO }
