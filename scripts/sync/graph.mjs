/**
 * ── THE MODULE GRAPH: WHAT LINKS TO WHAT ────────────────────────────────────────────
 *
 * `rules.mjs` maps FACTS — the chain count, the tool list, the swap registry — and answers
 * "this number lives in nine files, here they all are". That is half the map.
 *
 * The other half is ARCHITECTURE: which module powers which surface. Ask the fact map about
 * `sdk/src/client.ts` and it says "rebuild the dist and add a changelog entry", which is true
 * and nearly useless. `client.ts` is the buyer side of the whole SDK: the MCP server wraps it,
 * `paymentTools()` exposes its methods to models, a dozen docs pages document them, and the
 * examples call them. None of that was on the map, so "what does this change reach?" had no
 * answer at all.
 *
 * 🔴 DERIVED FROM REAL IMPORTS, NEVER TYPED OUT. A hand-written architecture diagram is the
 * exact thing `npm run sync` exists to prevent: it is a second copy of a fact, and it starts
 * rotting the day it is written. This parses the actual `import` statements, so the graph is
 * whatever the code currently is. Delete a dependency and it leaves the map by itself.
 *
 * What it will NOT tell you: links that are not imports (a docs page describing a module, a
 * site page rendering a registry). Those are declared in `links.mjs`, where being hand-written
 * is unavoidable because no import connects the two.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The trees whose imports we follow. Deliberately the SHIPPED code plus the tests that pin it:
 * this is a blast-radius map, so `node_modules`, build output and scratch files are noise.
 */
const ROOTS = [
  'sdk/src',
  'sdk/test',
  'mcp/src',
  'mcp/test',
  'site/src',
  'site/scripts',
  'site/netlify',
  'create-piprail/src',
  'scripts',
]

const CODE = ['.ts', '.tsx', '.mjs', '.js', '.astro']

function walk(dir, out = []) {
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
    if (st.isDirectory()) walk(rel, out)
    else if (CODE.some((e) => name.endsWith(e))) out.push(rel)
  }
  return out
}

/**
 * Resolve an import specifier to a repo-relative file.
 *
 * The `.js` extension is the fiddly part: the SDK is ESM TypeScript, so `./chains.js` in the
 * source means `./chains.ts` on disk. Resolving that wrong silently produces an EMPTY graph
 * rather than an error, which is the worst possible failure for a map.
 */
function resolveSpec(spec, fromFile) {
  // Workspace packages resolve to their entry point, so `@piprail/sdk` links to the real module.
  if (spec === '@piprail/sdk') return 'sdk/src/index.ts'
  if (spec === '@piprail/mcp') return 'mcp/src/index.ts'
  if (!spec.startsWith('.')) return null // a third-party dependency is not part of our graph

  const base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, '/')
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mjs'),
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.astro`,
    `${base}/index.ts`,
    `${base}/index.mjs`,
  ]
  return candidates.find((c) => existsSync(join(REPO, c))) ?? null
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import\s[\s\S]*?from\s*|import\s*|export\s[\s\S]*?from\s*)['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

let cache = null

/**
 * Build (and memoise) the graph.
 * @returns {{ imports: Map<string,Set<string>>, importedBy: Map<string,Set<string>>, files: string[] }}
 */
export function moduleGraph() {
  if (cache) return cache
  const files = ROOTS.flatMap((r) => walk(r))
  const imports = new Map()
  const importedBy = new Map()

  for (const file of files) {
    let src
    try {
      src = readFileSync(join(REPO, file), 'utf8')
    } catch {
      continue
    }
    const targets = new Set()
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (!spec) continue
      const target = resolveSpec(spec, file)
      // Never record a self-edge: `index.ts` re-exporting itself would make the graph lie.
      if (target && target !== file) targets.add(target)
    }
    imports.set(file, targets)
    for (const t of targets) {
      if (!importedBy.has(t)) importedBy.set(t, new Set())
      importedBy.get(t).add(file)
    }
  }

  cache = { imports, importedBy, files }
  return cache
}

/** Everything that would be affected by changing `file`, one hop out. */
export function dependents(file) {
  return [...(moduleGraph().importedBy.get(file) ?? [])].sort()
}

/** Everything `file` depends on, one hop in. */
export function dependencies(file) {
  return [...(moduleGraph().imports.get(file) ?? [])].sort()
}

/**
 * Every module reachable FROM the dependents of `file` — the true blast radius, not just the
 * files that name it directly. Capped by depth because the answer is meant to be read.
 */
export function blastRadius(file, maxDepth = 3) {
  const { importedBy } = moduleGraph()
  const seen = new Set([file])
  let frontier = [file]
  for (let d = 0; d < maxDepth && frontier.length; d += 1) {
    const next = []
    for (const f of frontier) {
      for (const up of importedBy.get(f) ?? []) {
        if (seen.has(up)) continue
        seen.add(up)
        next.push(up)
      }
    }
    frontier = next
  }
  seen.delete(file)
  return [...seen].sort()
}

/** Split a file list into the buckets a human actually thinks in. */
export function bucket(files) {
  const groups = {
    'SDK core': [],
    'SDK drivers': [],
    'SDK tests': [],
    MCP: [],
    'MCP tests': [],
    Site: [],
    Scaffolder: [],
    Scripts: [],
    Other: [],
  }
  for (const f of files) {
    if (f.startsWith('sdk/src/drivers/')) groups['SDK drivers'].push(f)
    else if (f.startsWith('sdk/src/')) groups['SDK core'].push(f)
    else if (f.startsWith('sdk/test/')) groups['SDK tests'].push(f)
    else if (f.startsWith('mcp/src/')) groups.MCP.push(f)
    else if (f.startsWith('mcp/test/')) groups['MCP tests'].push(f)
    else if (f.startsWith('site/')) groups.Site.push(f)
    else if (f.startsWith('create-piprail/')) groups.Scaffolder.push(f)
    else if (f.startsWith('scripts/')) groups.Scripts.push(f)
    else groups.Other.push(f)
  }
  return Object.entries(groups).filter(([, v]) => v.length)
}

export { REPO }
