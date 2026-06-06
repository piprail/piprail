#!/usr/bin/env node
/**
 * Deploy sync guard — fails the build if the site's AEO files (llms.txt, llms-full.txt)
 * have drifted from the published package versions, or if the MCP tool set is stale.
 *
 * Wired as `prebuild` in site/package.json, so it runs on EVERY `npm run build` — locally,
 * in CI (site.yml), and on the Netlify deploy. Also run in the SDK/MCP release workflows so a
 * release that forgets to bump the llms.txt headers fails before publish.
 *
 * Why it exists: the llms.txt header (`SDK-Version` / `MCP-Version`) is a hard fact that AI
 * crawlers read, and it silently fell behind a release once. This makes that impossible to ship.
 * See RELEASING.md (the deploy checklist) and the docs-sync skill for the human-facing surfaces map.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // site/scripts → site → repo root
const read = (p) => readFileSync(join(repo, p), 'utf8')
const pkgVersion = (p) => JSON.parse(read(p)).version

const sdkV = pkgVersion('sdk/package.json')
const mcpV = pkgVersion('mcp/package.json')

const TOOLS = ['piprail_discover', 'piprail_quote_payment', 'piprail_plan_payment', 'piprail_pay_request', 'piprail_register']
const AEO_FILES = ['site/public/llms.txt', 'site/public/llms-full.txt']

const checks = []
const check = (label, ok, detail = '') => checks.push({ label, ok, detail })

// 1. The llms.txt / llms-full.txt version headers must match the packages.
const headerVersion = (txt, label) => txt.match(new RegExp(`${label}:\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`))?.[1]
for (const file of AEO_FILES) {
  const txt = read(file)
  const sdk = headerVersion(txt, 'SDK-Version')
  const mcp = headerVersion(txt, 'MCP-Version')
  check(`${file} · SDK-Version matches sdk/package.json`, sdk === sdkV, `header=${sdk ?? '(missing)'} pkg=${sdkV}`)
  check(`${file} · MCP-Version matches mcp/package.json`, mcp === mcpV, `header=${mcp ?? '(missing)'} pkg=${mcpV}`)
}

// 2. The five MCP tool names must be present wherever the tool set is enumerated in prose
//    (guards against a silent revert to the old three-tool wording).
for (const file of [...AEO_FILES, 'mcp/README.md', 'sdk/README.md']) {
  const txt = read(file)
  const missing = TOOLS.filter((t) => !txt.includes(t))
  check(`${file} · lists all 5 MCP tools`, missing.length === 0, `missing: ${missing.join(', ')}`)
}

// Report.
let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `  — ${c.detail}`}`)
  if (!c.ok) failed++
}
console.log('')
if (failed) {
  console.error(`✗ docs-sync guard FAILED (${failed}). The site is out of sync with the packages.`)
  console.error('  Fix: update the SDK-Version / MCP-Version headers in site/public/llms.txt + llms-full.txt')
  console.error(`       to SDK ${sdkV} / MCP ${mcpV}, and keep all 5 tool names. See RELEASING.md → "Deploy checklist".`)
  process.exit(1)
}
console.log(`✓ docs in sync — llms.txt + llms-full.txt match SDK ${sdkV} / MCP ${mcpV}; all 5 MCP tools present.`)
