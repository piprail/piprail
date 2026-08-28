/**
 * ── GROUND TRUTH ────────────────────────────────────────────────────────────────────
 *
 * Every fact PipRail restates in more than one place, derived HERE from the code that
 * owns it. Nothing in this file is typed by hand: if a number appears below, it was
 * computed from `sdk/src/drivers/`, a `package.json`, or the built SDK.
 *
 * That is the whole point. The old guard (`site/scripts/check-sync.mjs`) hard-coded the
 * list of MCP tool names, which made it a THIRD copy of a list that already existed in
 * two places — a guard that can itself drift is not a guard.
 *
 * Read by scripts/sync/rules.mjs. Nothing else should import it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

export const read = (p) => readFileSync(join(REPO, p), 'utf8')
export const exists = (p) => existsSync(join(REPO, p))
export const readJson = (p) => JSON.parse(read(p))
export const lsDirs = (p) =>
  existsSync(join(REPO, p))
    ? readdirSync(join(REPO, p)).filter((n) => statSync(join(REPO, p, n)).isDirectory())
    : []

/**
 * The built SDK, when it exists. Several facts (the facilitator registry, the MCP tool
 * list) are only reachable through the build. A missing build is NOT a failure — it makes
 * those rules SKIP, so `npm run sync` still works in a fresh clone and says why.
 */
let builtSdk = null
let builtSdkError = null
try {
  builtSdk = require(join(REPO, 'sdk/dist/index.cjs'))
} catch (err) {
  builtSdkError = `sdk/dist not built — run \`npm run build:sdk\` (${err.code ?? err.message})`
}
export const sdk = () => builtSdk
export const sdkMissing = () => builtSdkError

/* ─────────────────────────── chains, families, drivers ─────────────────────────── */

/**
 * The chain set, derived the way CLAUDE.md says it is owned: `sdk/src/drivers/` is the
 * source of truth. One folder per family; the EVM family's presets are its chains.
 *
 * `total` is EVM presets + one per non-EVM family, which is exactly how the public "29
 * chains across 10 families" is counted. Deriving it means the count can never be stale
 * in the checker itself.
 */
export function chainFacts() {
  const families = lsDirs('sdk/src/drivers').sort()
  const evmPresets = builtSdk ? Object.keys(builtSdk.CHAINS) : []
  const nonEvmFamilies = families.filter((f) => f !== 'evm')
  return {
    families,
    familyCount: families.length,
    evmCount: evmPresets.length,
    evmPresets,
    nonEvmFamilies,
    total: evmPresets.length + nonEvmFamilies.length,
  }
}

/** The five files every driver family must mirror (CLAUDE.md: "drivers mirror each other"). */
export const DRIVER_MIRROR_FILES = ['chains', 'wallet', 'pay', 'verify', 'index']

/** What the site publishes as its chain grid — the public-facing list. */
export function siteChains() {
  const src = read('site/src/data/chains.ts')
  const entries = [...src.matchAll(/name:\s*'([^']+)'[\s\S]*?slug:\s*'([^']+)'[\s\S]*?family:\s*'([^']+)'/g)]
  return entries.map(([, name, slug, family]) => ({ name, slug, family }))
}

/** Token symbols the site's chain grid references, which each need a badge SVG. */
export function siteTokens() {
  const src = read('site/src/data/chains.ts')
  const inArrays = [...src.matchAll(/tokens:\s*\[([^\]]*)\]/g)].map((m) => m[1])
  return [...new Set(inArrays.flatMap((s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1])))].sort()
}

/* ─────────────────────────────────── packages ─────────────────────────────────── */

/**
 * Every workspace package, with whether it is actually published. `private: true` is the
 * marker; anything else with a name is on npm and therefore has version surfaces that can
 * rot (a README badge, an llms.txt header, a pinned install string in an integration).
 */
export function packages() {
  const paths = [
    'package.json', 'sdk/package.json', 'mcp/package.json', 'site/package.json',
    'docs/package.json', 'create-piprail/package.json',
    ...lsDirs('integrations').map((d) => `integrations/${d}/piprail/package.json`),
  ].filter(exists)
  return paths.map((p) => {
    const j = readJson(p)
    return { path: p, name: j.name ?? '(unnamed)', version: j.version ?? null, published: !j.private && !!j.name }
  })
}

export const pkgVersion = (p) => readJson(p).version

/* ────────────────────────────────── MCP tools ────────────────────────────────── */

/**
 * The authoritative tool list: the SDK's own `paymentTools()`. `mcp/src/banner.ts`
 * re-declares it as `TOOL_NAMES`, and prose in several files enumerates it — all of those
 * are mirrors of THIS.
 */
export function mcpTools() {
  if (!builtSdk?.paymentTools) return null
  const t = builtSdk.paymentTools({})
  const list = Array.isArray(t) ? t : Object.values(t)
  return list.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean)
}

/** The hand-maintained copy inside the MCP server. */
export function mcpBannerTools() {
  const src = read('mcp/src/banner.ts')
  const block = src.slice(src.indexOf('TOOL_NAMES'))
  return [...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/* ───────────────────────────────── facilitators ───────────────────────────────── */

export function facilitatorHosts() {
  if (!builtSdk?.KNOWN_FACILITATORS) return null
  return [...new Set(Object.values(builtSdk.KNOWN_FACILITATORS).flat().map((f) => new URL(f.url).host))].sort()
}

/**
 * Append-only. A host removed from here is a host that can silently come back.
 * Mirrored in sdk/test/facilitators-surface.test.ts — the two must agree.
 */
export const KNOWN_DEAD_FACILITATORS = ['facilitator.corbits.dev', 'facilitator.bitcoinsapi.com']

/* ────────────────────────────── indexes / discovery ────────────────────────────── */

/** `SLUG_TO_CAIP2` from sdk/src/indexes.ts — deliberately PARTIAL (see the rule that uses it). */
export function slugToCaip2() {
  const src = read('sdk/src/indexes.ts')
  const start = src.indexOf('const SLUG_TO_CAIP2')
  if (start < 0) return {}
  const block = src.slice(start, src.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/^\s*([a-zA-Z0-9]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]))
}

/* ─────────────────────────────── the API surface ─────────────────────────────── */

/**
 * Everything importable from `@piprail/sdk` — runtime VALUES plus every TYPE.
 *
 * 🔴 `Object.keys(require(...))` alone is not the export surface. It sees values only, so a
 * doc sample doing `import type { X402Challenge } from '@piprail/sdk'` looks like a broken
 * import when it is perfectly valid. An early version of the samples rule reported 24 false
 * failures for exactly that reason. The `.d.ts` bundle supplies the other half.
 */
export function sdkExportSurface() {
  if (!builtSdk) return null
  const surface = new Set(Object.keys(builtSdk))
  const dtsPath = 'sdk/dist/index.d.ts'
  if (exists(dtsPath)) {
    const dts = read(dtsPath)
    for (const m of dts.matchAll(/\b(?:declare\s+)?(?:type|interface|class|const|function|enum)\s+([A-Za-z_$][\w$]*)/g)) surface.add(m[1])
    for (const m of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const raw of m[1].split(',')) {
        const id = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (id) surface.add(id)
      }
    }
  }
  return surface
}

/** Every `import { … } from '@piprail/sdk'` in prose + samples, as {id → files}. */
export function sdkImportsInSamples() {
  const files = [
    ...walk('docs/src/content/docs', ['.md', '.mdx']),
    ...walk('site/src', ['.astro', '.ts']),
    // The live x402 demo endpoint is real shipped code that imports the SDK, and it lives
    // OUTSIDE site/src — so it was invisible to this rule until 2026-08-28.
    ...walk('site/netlify', ['.mjs', '.ts']),
    ...walk('examples', ['.mjs', '.md']),
    ...['sdk/README.md', 'README.md', 'AGENTS.md', 'mcp/README.md'].filter(exists),
  ]
  const found = new Map()
  let count = 0
  for (const f of files) {
    for (const m of read(f).matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@piprail\/sdk['"]/g)) {
      for (const raw of m[1].split(',')) {
        const id = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        // Multi-line import blocks pull in comment fragments and ellipses; a real identifier
        // is word characters only, so anything else is a parse artefact, not a bad import.
        if (!id || /[^A-Za-z0-9_$]/.test(id)) continue
        count++
        if (!found.has(id)) found.set(id, new Set())
        found.get(id).add(f)
      }
    }
  }
  return { found, count, fileCount: files.length }
}

/* ──────────────────────────── MCP configuration ──────────────────────────── */

/**
 * `KNOWN_PIPRAIL_VARS` — the STRICT allowlist the MCP server validates env against. A var
 * missing from the docs is a feature nobody can find; a var in the docs but not here would
 * make the server refuse to start.
 */
export function mcpEnvVars() {
  const src = read('mcp/src/config.ts')
  const start = src.indexOf('const KNOWN_PIPRAIL_VARS')
  if (start < 0) return null
  return [...src.slice(start, src.indexOf(']', start)).matchAll(/'(PIPRAIL_[A-Z_]+)'/g)].map((m) => m[1])
}

/* ──────────────────────────────── file helpers ──────────────────────────────── */

/** Every file under `dir` with one of `exts`, skipping build output and dependencies. */
export function walk(dir, exts, acc = []) {
  const full = join(REPO, dir)
  if (!existsSync(full)) return acc
  for (const name of readdirSync(full)) {
    if (['node_modules', 'dist', '.astro', '.git'].includes(name) || name.startsWith('.')) continue
    const rel = `${dir}/${name}`
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, exts, acc)
    else if (exts.some((e) => name.endsWith(e))) acc.push(rel)
  }
  return acc
}
