/**
 * ── THE LINK RULES ──────────────────────────────────────────────────────────────────
 *
 * One entry per fact that PipRail states in more than one place.
 *
 * Each rule is BOTH a check and a map. `source` says who owns the fact, `mirrors` says
 * who restates it — so `npm run sync -- --graph` can answer "I changed X, what else must
 * change?" without anyone maintaining a separate prose checklist that itself goes stale.
 *
 * Shape:
 *   domain   grouping for the report
 *   id       stable slug, usable with `--only`
 *   what     one line a human reads in the report
 *   source   { file, note } — who OWNS this fact
 *   mirrors  [{ file, note }] — who must agree with it
 *   verify   [command] — what to RUN to prove it still holds, beyond this checker
 *   check()  → { ok, detail } | { skip, detail } | { ok, detail, warn: true }
 *
 * `verify` is what turns the map from "where do I edit?" into "and what do I run?".
 * `--touched <file>` prints the union of these across every rule that file appears in, so
 * one query answers both halves of the question. Every command is checked for existence by
 * the `rules-are-well-formed` rule, because a map that points at a script nobody wrote is
 * the failure RELEASING.md already shipped once: it said "never skip `npm run verify-gate`"
 * for weeks before that script existed.
 *
 * A rule that cannot run (SDK not built, optional file absent) must SKIP with a reason,
 * never silently pass. A guard that quietly does nothing is worse than no guard.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO, read, exists, readJson, walk, sdk, sdkMissing, chainFacts, siteChains, siteTokens,
  packages, pkgVersion, mcpTools, sovereignTools, mcpBannerTools, facilitatorHosts, KNOWN_DEAD_FACILITATORS,
  slugToCaip2, lsDirs, DRIVER_MIRROR_FILES, sdkExportSurface, sdkImportsInSamples, mcpEnvVars,
} from './sources.mjs'

import { BUSINESS_CONTACT, FRONT_FACING, personalAddressRe } from '../contacts.mjs'
import { moduleGraph } from './graph.mjs'
import { documentedIn, describes, ANCHORS } from './links.mjs'

const require = createRequire(import.meta.url)

/* Shared helpers for the artifact-inspecting rules. */
const htmlPages = (dist) => walk(dist, ['.html'])
/** Does a path resolve to a built page or a shipped asset under `dist`/`pub`? */
const resolves = (p, dist, pub) =>
  exists(`${dist}${p}${p.endsWith('/') ? 'index.html' : '/index.html'}`) ||
  exists(`${dist}${p}`) || exists(`${pub}${p}`)

const ok = (detail) => ({ ok: true, detail })
const bad = (detail) => ({ ok: false, detail })
const skip = (detail) => ({ skip: true, detail })
const warn = (detail) => ({ ok: true, warn: true, detail })

/** Reports which of `files` fail `test`, as a ready-to-print list. */
const offenders = (files, test) =>
  files.map((f) => ({ f, why: test(read(f), f) })).filter((r) => r.why)

export const RULES = [
  /* ══════════════════════════════ CHAINS ══════════════════════════════ */
  {
    domain: 'chains',
    id: 'chain-count-prose',
    verify: [
      "npm run sync -- --only chain-count-prose",
      "npm run build",
    ],
    what: 'The chain + family counts agree everywhere they are written out',
    source: { file: 'sdk/src/drivers/', note: 'one folder per family; EVM presets in evm/chains.ts' },
    mirrors: [
      { file: 'README.md', note: '🔴 shields.io badge — URL-ENCODED, a plain grep for the number MISSES it' },
      { file: 'AGENTS.md', note: 'intro sentence' },
      { file: 'sdk/package.json', note: 'the npm `description` — shows on the npm page' },
      { file: 'site/public/llms.txt', note: 'AEO summary + the chain bullet' },
      { file: 'site/public/llms-full.txt', note: 'several places incl. "The N chains, by family"' },
      { file: 'site/src/layouts/Layout.astro', note: 'JSON-LD featureList + meta description' },
      { file: 'site/src/data/posts.ts', note: 'blog post descriptions' },
      { file: 'site/src/pages/index.astro', note: 'stat tile + hero prose + FAQs' },
      { file: 'site/src/pages/demo.astro', note: 'the live browser demo states the count in its copy and its JSON-LD' },
      { file: 'piprail/.github → profile/README.md', note: '⚠️ SEPARATE REPO — nothing here updates it' },
    ],
    check() {
      if (!sdk()) return skip(sdkMissing())
      const { total, familyCount, evmCount } = chainFacts()

      /*
       * EVERY occurrence must be right, not just one.
       *
       * The first version of this rule asked "does the file say '29 chains' anywhere?", which a
       * PARTIAL edit walks straight past: llms.txt states the count five times, so changing four
       * of them left the rule green. Verified against the real files — every `N chains` in the
       * list below is currently the global total and every `N EVM` is the EVM sub-count, so
       * scanning exhaustively is safe here.
       *
       * ⚠️ Only files where a bare "N chains" ALWAYS means the global total belong in this list.
       * /facilitators legitimately says "13 chains" and is deliberately absent.
       */
      const COUNT_MIRRORS = [
        'AGENTS.md', 'sdk/package.json', 'site/public/llms.txt', 'site/public/llms-full.txt',
        'site/src/layouts/Layout.astro', 'site/src/data/posts.ts',
      ].filter(exists)

      const problems = []
      for (const f of COUNT_MIRRORS) {
        const txt = read(f)
        // `\s+` misses the ADJECTIVE form. "a 29-chain SDK" sat in llms-full.txt for a day
        // past the Robinhood ship precisely because a hyphen is not a space. The lookbehind
        // then keeps SLUGS out: `x402-chains` is a URL, not a claim about 402 chains.
        const chainHits = [...txt.matchAll(/(?<![\w-])(\d+)[\s-](?:chains?|blockchains?)\b/g)]
        const evmHits = [...txt.matchAll(/(\d+)\s+EVM\b/g)]
        if (!chainHits.length) problems.push(`${f}: states no chain count at all`)
        for (const h of chainHits) {
          if (Number(h[1]) !== total) problems.push(`${f}: says "${h[0]}" — want ${total}`)
        }
        for (const h of evmHits) {
          if (Number(h[1]) !== evmCount) problems.push(`${f}: says "${h[0]}" — want ${evmCount}`)
        }
      }

      // The README carries the count ONLY inside a URL-encoded shields badge, so a plain-number
      // grep misses it entirely. This is the single easiest surface to forget.
      const badge = read('README.md').match(/chains-(\d+)%20across%20(\d+)%20families/)
      if (!badge) problems.push('README.md: shields.io chains badge not found')
      else if (Number(badge[1]) !== total || Number(badge[2]) !== familyCount) {
        problems.push(`README.md: badge says ${badge[1]} chains / ${badge[2]} families — want ${total} / ${familyCount}`)
      }

      /*
       * ── THE STALE-TOTAL SWEEP ────────────────────────────────────────────────────
       *
       * The list above is a curated allowlist, and that is its weakness: a bare "N chains"
       * only means the global total in SOME files, so pages like /mcp, /demo and the blog were
       * never scanned at all. They went on advertising 29 chains for as long as nobody looked.
       *
       * This sweeps EVERY shipped page instead, but only for a NEAR-MISS of the current total.
       * That is the whole trick: a genuinely different count is never near the total (13
       * facilitator chains, 14 gasless chains, 10 families), while a stale total is by
       * definition the previous one. So it catches the drift class with no allowlist to
       * maintain, and stays quiet about counts that legitimately differ.
       */
      const NEAR = [total - 1, total - 2, total - 3].filter((n) => n > 0)
      const swept = walk('site/src', ['.astro', '.ts'])
        .concat(walk('site/public', ['.txt']))
        .concat(walk('docs/src', ['.md', '.mdx']))
        // integrations/ SHIPS to npm, and sat outside every scan: the n8n README told readers
        // "the PipRail SDK reaches 29 chains" for as long as nobody happened to grep for it.
        .concat(walk('integrations', ['.md']))
      const stale = []
      for (const f of swept) {
        for (const m of read(f).matchAll(/(?<![\w-])(\d+)[\s-](?:chains?|blockchains?)\b/g)) {
          if (NEAR.includes(Number(m[1]))) stale.push(`${f}: "${m[0].trim()}" looks like a stale total (now ${total})`)
        }
      }
      // Cap the report: one file with the old number in ten places is one mistake, not ten.
      if (stale.length) problems.push(...stale.slice(0, 6), ...(stale.length > 6 ? [`…and ${stale.length - 6} more`] : []))

      const occurrences = COUNT_MIRRORS.reduce(
        (n, f) => n + [...read(f).matchAll(/(\d+)\s+(?:chains|blockchains|EVM)\b/g)].length, 0,
      )
      return problems.length
        ? bad(`${total} chains / ${familyCount} families / ${evmCount} EVM —\n      ${problems.join('\n      ')}`)
        : ok(`${total} chains · ${familyCount} families · ${evmCount} EVM — ${occurrences} occurrences across ${COUNT_MIRRORS.length} files + the README badge`)
    },
  },

  {
    domain: 'chains',
    id: 'driver-mirror',
    verify: [
      "npm run test:sdk",
    ],
    what: 'Every driver family mirrors the same five files (CLAUDE.md: "drivers mirror each other")',
    source: { file: 'sdk/src/drivers/evm/', note: 'the template every family copies' },
    mirrors: [{ file: 'sdk/src/drivers/<family>/', note: 'chains · wallet · pay · verify · index' }],
    check() {
      const families = lsDirs('sdk/src/drivers')
      if (!families.length) return skip('no driver families found')
      const problems = families.flatMap((f) =>
        DRIVER_MIRROR_FILES.filter((m) => !exists(`sdk/src/drivers/${f}/${m}.ts`)).map((m) => `${f}/ is missing ${m}.ts`),
      )
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${families.length} families × ${DRIVER_MIRROR_FILES.length} mirrored files`)
    },
  },

  {
    domain: 'chains',
    id: 'driver-tests',
    verify: [
      "npm run test:sdk",
    ],
    what: 'Every driver family has a test directory (tests are the canonical contract)',
    source: { file: 'sdk/src/drivers/', note: 'the families that exist' },
    mirrors: [{ file: 'sdk/test/<family>/', note: 'one folder per non-EVM family' }],
    check() {
      const families = lsDirs('sdk/src/drivers')
      const missing = families.filter((f) => !exists(`sdk/test/${f}`))
      return missing.length
        ? bad(`no sdk/test/ folder for: ${missing.join(', ')}`)
        : ok(`all ${families.length} families have tests`)
    },
  },

  {
    domain: 'chains',
    id: 'site-chain-assets',
    verify: [
      "npm run build",
    ],
    what: 'Every chain and token the site renders has a logo shipped for it',
    source: { file: 'site/src/data/chains.ts', note: 'the public chain grid' },
    mirrors: [
      { file: 'site/public/chains/<slug>.svg', note: 'one per chain' },
      { file: 'site/public/tokens/<symbol>.svg', note: 'one per token badge' },
      { file: 'site/src/pages/chains.astro', note: 'the public chain directory — renders the catalog and both asset sets' },
    ],
    check() {
      const chains = siteChains()
      if (!chains.length) return skip('could not parse site/src/data/chains.ts')
      const missingChain = chains.filter((c) => !exists(`site/public/chains/${c.slug}.svg`)).map((c) => c.slug)
      const missingToken = siteTokens().filter((t) => !exists(`site/public/tokens/${t}.svg`))
      const problems = [
        ...(missingChain.length ? [`missing chain logos: ${missingChain.join(', ')}`] : []),
        ...(missingToken.length ? [`missing token badges: ${missingToken.join(', ')}`] : []),
      ]
      return problems.length ? bad(problems.join('; ')) : ok(`${chains.length} chain logos + ${siteTokens().length} token badges present`)
    },
  },

  {
    domain: 'chains',
    id: 'docs-family-pages',
    verify: [
      "npm run build:docs",
    ],
    what: 'Every non-EVM driver family has a docs page',
    source: { file: 'sdk/src/drivers/', note: 'the families that exist' },
    mirrors: [{ file: 'docs/src/content/docs/chains/', note: 'one page per non-EVM family' }],
    check() {
      const { nonEvmFamilies } = chainFacts()
      if (!nonEvmFamilies.length) return skip('no families resolved')
      const pages = walk('docs/src/content/docs/chains', ['.md', '.mdx']).map((p) => p.toLowerCase())
      const missing = nonEvmFamilies.filter((f) => !pages.some((p) => p.includes(f)))
      return missing.length
        ? bad(`no docs/chains page for: ${missing.join(', ')}`)
        : ok(`${nonEvmFamilies.length} non-EVM families documented`)
    },
  },

  /* ══════════════════════════════ PACKAGES ══════════════════════════════ */
  {
    domain: 'packages',
    id: 'sdk-dist-fresh',
    verify: [
      "npm run build:sdk",
    ],
    what: 'The built SDK is not older than its source (a stale build silently weakens every rule below)',
    source: { file: 'sdk/src/', note: 'the TypeScript the SDK is actually written in' },
    mirrors: [{ file: 'sdk/dist/index.cjs', note: 'rebuild: npm run build:sdk' }],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * Roughly a third of the rules below read the BUILT SDK (`sdk/dist/index.cjs`) rather
       * than the source, because facts like the facilitator registry and the swap registry are
       * only reachable through the build. The site's data generators read the same dist.
       *
       * So an unbuilt edit is invisible in a specific and nasty way: the generator writes the
       * OLD registry into the site data, and the rule then compares old against old and reports
       * green. Both halves are wrong and they agree, which is the one failure a consistency
       * checker cannot see. Caught in the act on 2026-09-08 while editing SWAP_PROVIDERS: the
       * regenerated site data silently kept the previous text.
       *
       * The gate always builds first, so this only ever fires on a bare `npm run sync` — which
       * is exactly when a human is trusting it most.
       */
      const dist = 'sdk/dist/index.cjs'
      if (!exists(dist)) return skip(sdkMissing() ?? 'sdk/dist not built')
      let builtAt
      try {
        builtAt = statSync(join(REPO, dist)).mtimeMs
      } catch {
        return skip('could not stat the built SDK')
      }
      const newer = walk('sdk/src', ['.ts'])
        .map((f) => ({ f, at: statSync(join(REPO, f)).mtimeMs }))
        .filter((x) => x.at > builtAt)
        .sort((a, b) => b.at - a.at)
      if (!newer.length) return ok('sdk/dist is newer than every source file')
      const names = newer.slice(0, 3).map((x) => x.f.replace('sdk/src/', '')).join(', ')
      return bad(
        `${newer.length} source file(s) newer than the build (${names}${newer.length > 3 ? ', …' : ''}) — ` +
          'run `npm run build:sdk`, then regenerate the site data. Rules that read the built SDK are ' +
          'currently checking the PREVIOUS version.'
      )
    },
  },

  {
    domain: 'packages',
    id: 'llms-version-headers',
    verify: [
      "npm run sync -- --only llms-version-headers",
    ],
    what: 'The llms.txt version headers match the published packages',
    source: { file: 'sdk/package.json + mcp/package.json', note: 'the versions actually shipped' },
    mirrors: [
      { file: 'site/public/llms.txt', note: 'SDK-Version / MCP-Version headers (AI crawlers read these)' },
      { file: 'site/public/llms-full.txt', note: 'same headers' },
    ],
    check() {
      const sdkV = pkgVersion('sdk/package.json')
      const mcpV = pkgVersion('mcp/package.json')
      const problems = []
      for (const f of ['site/public/llms.txt', 'site/public/llms-full.txt']) {
        const txt = read(f)
        const got = (label) => txt.match(new RegExp(`${label}:\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`))?.[1]
        if (got('SDK-Version') !== sdkV) problems.push(`${f}: SDK-Version=${got('SDK-Version') ?? '(missing)'} want ${sdkV}`)
        if (got('MCP-Version') !== mcpV) problems.push(`${f}: MCP-Version=${got('MCP-Version') ?? '(missing)'} want ${mcpV}`)
      }
      return problems.length ? bad(problems.join('; ')) : ok(`SDK ${sdkV} · MCP ${mcpV}`)
    },
  },

  {
    domain: 'packages',
    id: 'mcp-server-json',
    verify: [
      "npm run test:mcp",
    ],
    what: 'mcp/server.json (the MCP registry manifest) matches mcp/package.json',
    source: { file: 'mcp/package.json', note: 'the npm version' },
    mirrors: [{ file: 'mcp/server.json', note: '🔴 the version appears TWICE — top level AND packages[].version' }],
    check() {
      if (!exists('mcp/server.json')) return skip('mcp/server.json not present')
      const mcpV = pkgVersion('mcp/package.json')
      const j = readJson('mcp/server.json')
      const inner = (j.packages ?? []).map((p) => p.version)
      const wrong = [
        ...(j.version !== mcpV ? [`top-level version=${j.version}`] : []),
        ...inner.filter((v) => v !== mcpV).map((v) => `packages[].version=${v}`),
      ]
      return wrong.length ? bad(`${wrong.join(', ')} — want ${mcpV}`) : ok(`server.json pinned to ${mcpV} in ${1 + inner.length} place(s)`)
    },
  },

  {
    domain: 'packages',
    id: 'integration-pins',
    verify: [
      "npm run sync -- --only integration-pins",
    ],
    what: 'Integrations that PIN a published version are pinned to the current one',
    source: { file: 'mcp/package.json + sdk/package.json', note: 'the versions actually on npm' },
    mirrors: [
      { file: 'integrations/hermes/piprail/manifest.yaml', note: 'pins @piprail/mcp@X in its install args' },
      { file: 'integrations/*/piprail/*', note: 'any other pinned install string' },
    ],
    check() {
      const mcpV = pkgVersion('mcp/package.json')
      const sdkV = pkgVersion('sdk/package.json')
      const files = walk('integrations', ['.yaml', '.yml', '.json', '.md'])
        .filter((f) => !f.includes('node_modules') && !f.includes('package-lock'))
      const problems = []
      for (const f of files) {
        for (const m of read(f).matchAll(/@piprail\/(mcp|sdk)@(\d+\.\d+\.\d+)/g)) {
          const want = m[1] === 'mcp' ? mcpV : sdkV
          if (m[2] !== want) problems.push(`${f}: @piprail/${m[1]}@${m[2]} — want ${want}`)
        }
      }
      const pinned = files.flatMap((f) => [...read(f).matchAll(/@piprail\/(?:mcp|sdk)@\d+\.\d+\.\d+/g)]).length
      return problems.length
        ? bad(problems.join('; '))
        : ok(pinned ? `${pinned} pinned reference(s), all current` : 'no pinned versions (install strings are floating — good)')
    },
  },

  {
    domain: 'packages',
    id: 'published-packages-documented',
    verify: [
      "npm run sync -- --only published-packages-documented",
    ],
    what: 'Every PUBLISHED package is named in the repo README and the AEO files',
    source: { file: '*/package.json', note: 'anything without `private: true`' },
    mirrors: [
      { file: 'README.md', note: 'the "what is in here" section' },
      { file: 'site/public/llms.txt', note: 'what an AI crawler is told exists' },
      { file: 'site/public/llms-full.txt', note: 'same' },
    ],
    check() {
      const pub = packages().filter((p) => p.published)
      const surfaces = ['README.md', 'site/public/llms.txt', 'site/public/llms-full.txt'].filter(exists)
      const problems = []
      for (const p of pub) {
        const absent = surfaces.filter((f) => !read(f).includes(p.name))
        if (absent.length) problems.push(`${p.name} (${p.path}) missing from: ${absent.join(', ')}`)
      }
      return problems.length
        ? bad(`${pub.length} published packages —\n      ${problems.join('\n      ')}`)
        : ok(`all ${pub.length} published packages documented`)
    },
  },

  /* ══════════════════════════════ MCP ══════════════════════════════ */
  {
    domain: 'mcp',
    id: 'tool-names',
    verify: [
      "npm run test:mcp",
      "npx vitest run test/agent.test.ts",
    ],
    what: 'The MCP tool list is identical everywhere it is enumerated',
    source: { file: 'sdk/src/agent.ts → paymentTools()', note: '⭐ the ONE authoritative list' },
    mirrors: [
      { file: 'mcp/src/banner.ts', note: 'TOOL_NAMES — a hand-copy of paymentTools()' },
      { file: 'site/src/pages/mcp.astro', note: 'the public MCP page — the tool table a reader sees' },
      { file: 'mcp/README.md', note: 'the tools table' },
      { file: 'site/public/llms.txt', note: 'the MCP section' },
      { file: 'site/public/llms-full.txt', note: 'the MCP section' },
    ],
    check() {
      const tools = mcpTools()
      if (!tools) return skip(sdkMissing() ?? 'paymentTools() not exported')
      const problems = []
      const banner = mcpBannerTools()
      if (banner.join(',') !== tools.join(',')) {
        problems.push(`mcp/src/banner.ts TOOL_NAMES differs: [${banner.join(', ')}]`)
      }
      for (const f of ['mcp/README.md', 'site/public/llms.txt', 'site/public/llms-full.txt'].filter(exists)) {
        const missing = tools.filter((t) => !read(f).includes(t))
        if (missing.length) problems.push(`${f} missing: ${missing.join(', ')}`)
      }
      return problems.length ? bad(problems.join('; ')) : ok(`${tools.length} tools consistent across 4 mirrors`)
    },
  },

  /* ══════════════════════════ FACILITATORS ══════════════════════════ */
  {
    domain: 'facilitators',
    id: 'dead-hosts',
    verify: [
      "npx vitest run test/facilitators-surface.test.ts",
    ],
    what: 'No shipped surface presents a dead facilitator as usable',
    source: { file: 'sdk/src/facilitators.ts', note: '⭐ KNOWN_FACILITATORS — the only source of truth' },
    mirrors: [
      { file: 'docs/…/facilitator-coverage.md', note: 'table + copy-paste URL list + seed bullets' },
      { file: 'docs/…/gasless-payments.md', note: 'the Solana facilitator table' },
      { file: 'site/src/data/facilitators.ts', note: 'GENERATED — node site/scripts/gen-facilitators.mjs' },
      { file: 'examples/…/live-*.mjs', note: 'live probes that point at a facilitator URL' },
    ],
    check() {
      const files = [
        ...walk('docs/src', ['.md', '.mdx']), ...walk('site/src', ['.astro', '.ts']),
        ...walk('sdk/src', ['.ts']), ...walk('examples', ['.mjs']),
      ]
      const obituary = /removed|nxdomain|died|dead|deleted|no longer|⚰️|offline|container app/i
      const problems = []
      for (const dead of KNOWN_DEAD_FACILITATORS) {
        for (const f of files) {
          const lines = read(f).split('\n')
          lines.forEach((line, i) => {
            if (!line.includes(dead)) return
            const ctx = lines.slice(Math.max(0, i - 3), i + 4).join('\n')
            if (!obituary.test(ctx)) problems.push(`${f}:${i + 1} advertises ${dead}`)
          })
        }
      }
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${KNOWN_DEAD_FACILITATORS.length} dead hosts absent from ${files.length} shipped files`)
    },
  },

  {
    domain: 'swaps',
    id: 'swap-surfaces',
    verify: [
      "npx vitest run test/swap-providers-surface.test.ts",
      "npm run verify:proofs",
      "npm run build",
    ],
    what: 'The swap registry, the generated site data, the logos and the docs all agree',
    source: { file: 'sdk/src/swapProviders.ts', note: '⭐ SWAP_PROVIDERS — the only source of truth' },
    mirrors: [
      { file: 'site/src/data/swap-providers.ts', note: 'GENERATED: node site/scripts/gen-swap-providers.mjs' },
      { file: 'site/src/pages/swaps.astro', note: 'the public swap page, every number derived from the generated data' },
      { file: 'site/src/pages/sdk.astro', note: 'the signpost card, whose counts are derived from the same data' },
      { file: 'site/public/swaps/', note: 'one logo per provider id' },
      { file: 'docs/src/content/docs/making-payments/swapping.md', note: 'the guide + the proof table' },
      { file: 'sdk/src/swap.ts', note: 'the module docstring names every tier-2 route' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * "What can swap where, and what proves it" is now restated in four places. That is the
       * exact shape that rotted the facilitator data: the registry was corrected and three other
       * surfaces kept advertising two dead hosts for the rest of the day. Same fact, same guard.
       *
       * It also enforces the ADMISSION RULE, which is the part a human is most likely to erode
       * under pressure: a provider with no live mainnet proof must never ship, because a coverage
       * table assembled from documentation is marketing, not evidence.
       */
      const s = sdk()
      if (!s?.SWAP_PROVIDERS) return skip(sdkMissing() ?? 'SWAP_PROVIDERS not exported')
      const reg = s.SWAP_PROVIDERS
      const problems = []

      // 1. Every entry must carry a real, checkable proof. No proof, no ship.
      for (const p of reg) {
        // A route may ship without a proof ONLY if it says plainly why, and that reason is
        // printed on the site and in the docs. Silence is the thing this forbids.
        if (!p.proofs?.length && !p.unproven) {
          problems.push(`${p.id} has NO mainnet proof and no stated reason (never ship an unexplained route)`)
        }
        if (p.proofs?.length && p.unproven) {
          problems.push(`${p.id} carries proofs but is ALSO marked unproven — one or the other`)
        }
        if (!p.keyless) problems.push(`${p.id} is not keyless (every shipped route must need no API key)`)
      }

      // 2. Every provider needs a logo, or the site renders a broken image. The format
      //    follows what the provider actually publishes: a vector where they ship one,
      //    WebP where they only ship a raster.
      for (const p of reg) {
        const has = ['svg', 'webp', 'png'].some((e) => exists(`site/public/swaps/${p.id}.${e}`))
        if (!has) problems.push(`no logo at site/public/swaps/${p.id}.{svg,webp,png}`)
      }

      // 3. The generated site data must match the registry.
      if (exists('site/src/data/swap-providers.ts')) {
        const src = read('site/src/data/swap-providers.ts')
        const gen = JSON.parse(src.slice(src.indexOf('SWAP_PROVIDERS: SwapProviderView[] = ') + 36, src.lastIndexOf(']') + 1))
        const want = reg.map((p) => p.id).join(',')
        const got = gen.map((p) => p.id).join(',')
        if (want !== got) problems.push('site data differs from the registry — re-run: node site/scripts/gen-swap-providers.mjs')
        const wantProofs = reg.reduce((n, p) => n + p.proofs.length, 0)
        const gotProofs = gen.reduce((n, p) => n + p.proofs.length, 0)
        if (wantProofs !== gotProofs) problems.push(`proof count differs (${wantProofs} vs ${gotProofs}) — regenerate`)
      } else {
        problems.push('site/src/data/swap-providers.ts missing — run: node site/scripts/gen-swap-providers.mjs')
      }

      // 4. The docs must name every shipped provider, and must carry its proofs.
      const doc = exists('docs/src/content/docs/making-payments/swapping.md')
        ? read('docs/src/content/docs/making-payments/swapping.md')
        : ''
      if (doc) {
        for (const p of reg) {
          if (!doc.includes(p.name)) problems.push(`docs never mention ${p.name}`)
          for (const t of p.proofs) {
            if (!doc.includes(t.tx.slice(0, 8))) problems.push(`docs missing proof ${t.tx.slice(0, 8)}… for ${p.id}`)
          }
        }
        /*
         * The docs render each proof as `[\`abc123…\`](explorer/abc123fullhash). The two halves
         * are typed separately, so the visible text can disagree with where the link goes — and
         * base58 hashes are CASE-SENSITIVE, which is how a Sui proof came to display `Gtykrnlx…`
         * while linking to `GtykrnLx…`. A reader comparing the page against a block explorer sees
         * a mismatch and has no way to tell which half is wrong.
         */
        for (const m of doc.matchAll(/\[`([0-9A-Za-z]{6,})…`\]\((https?:\/\/[^)]+)\)/g)) {
          const shown = m[1]
          const linked = m[2].replace(/\/$/, '').split('/').pop() ?? ''
          if (!linked.startsWith(shown)) {
            problems.push(`docs link text \`${shown}…\` does not match its href (${linked.slice(0, 12)}…)`)
          }
        }
      }

      // 5. Both surfaces must exist and both must be driven by the generated data. The
      // dedicated page carries the detail; the SDK page keeps a signpost whose numbers come
      // from the same source, so the two can never quote different totals.
      for (const f of ['site/src/pages/swaps.astro', 'site/src/pages/sdk.astro']) {
        if (!exists(f)) {
          problems.push(`${f} is missing (the swap surface must exist)`)
          continue
        }
        if (!read(f).includes("from '../data/swap-providers'")) {
          problems.push(`${f} does not import the generated swap data (a hand-written copy is the bug)`)
        }
      }
      // The dedicated page must be reachable, or it is a page nobody can find.
      for (const nav of ['site/src/components/Navigation.astro', 'site/src/components/Footer.astro']) {
        if (exists(nav) && !read(nav).includes("/swaps/")) {
          problems.push(`${nav} does not link to /swaps/ (an unreachable page)`)
        }
      }

      /*
       * 7. A SUMMARY surface that names some venues must name them ALL.
       *
       * The incomplete list is the quiet failure mode. `AGENTS.md` — the file an AI agent reads
       * to learn what PipRail does — said "Solana → Jupiter, 8 live-probed EVM chains →
       * KyberSwap" and then "TON, Tron, NEAR, Aptos, Algorand, Sui have none yet", long after
       * all six had shipped swaps. Every count in it was right, so no count rule could see it:
       * the defect was a LIST that had stopped growing. The swap example's README had the same
       * shape ("Solana, 8 EVM chains").
       *
       * Driver modules legitimately name only their own venue, so the check is scoped to the
       * surfaces that summarise coverage, and needs two names before it calls something a list.
       */
      /*
       * 8. Every per-chain docs page must tell the reader whether that chain can swap.
       *
       * All ten said nothing at all: a reader landing on `chains/aptos.md` to learn what Aptos
       * can do finished the page without discovering Hyperion, exact-output pricing, or that
       * swapping exists there. Every count and every list elsewhere was correct; the defect was
       * a whole surface that had never been written. The chain page is where a reader with a
       * chain in mind actually arrives, so it is the one that must not stay silent.
       */
      for (const f of walk('docs/src/content/docs/chains', ['.md'])) {
        const body = read(f)
        if (!/^## Swapping on /m.test(body)) {
          problems.push(`${f} has no "Swapping on …" section — say whether this chain can swap`)
        } else if (!body.includes('/making-payments/swapping/')) {
          problems.push(`${f} describes swapping but never links the full guide`)
        }
      }

      const SUMMARY_SURFACES = [
        'AGENTS.md',
        'examples/basics/swap/README.md',
        'site/public/llms.txt',
        'site/public/llms-full.txt',
        'docs/src/content/docs/making-payments/swapping.md',
        'sdk/src/swap.ts',
      ]
      const venueNames = reg.map((p) => p.name)
      /*
       * A surface may legitimately name a FEW venues as illustration (llms.txt calls out the
       * three exact-output routes, and that is not a coverage claim). The defect is a list that
       * sets out to be complete and is not, so only treat it as one past a clear majority.
       */
      const LIST_THRESHOLD = 0.6
      for (const f of SUMMARY_SURFACES.filter(exists)) {
        const body = read(f)
        const named = venueNames.filter((n) => body.includes(n))
        if (named.length >= venueNames.length * LIST_THRESHOLD && named.length < venueNames.length) {
          const missing = venueNames.filter((n) => !named.includes(n))
          problems.push(`${f} lists ${named.length}/${venueNames.length} venues — missing ${missing.join(', ')}`)
        }
      }

      /*
       * 6. The module docstring in swap.ts is a PROSE copy of this registry — the first thing
       * an SDK reader sees, and the one surface no generator touches. It was already stale
       * once: it listed five tier-2 routes and "8 live-probed chains" for a whole day after
       * the registry held eight routes across nine. Prose rots silently, so guard it.
       */
      if (exists('sdk/src/swap.ts')) {
        const header = read('sdk/src/swap.ts').split('*/')[0] ?? ''
        for (const p of reg) {
          if (!header.includes(p.name)) problems.push(`sdk/src/swap.ts docstring never names ${p.name}`)
        }
        // The one count it states must match the registry rather than a memory of it.
        const evmChains = reg.find((p) => p.id === 'kyberswap')?.networks.length ?? 0
        if (evmChains && !header.includes(`(${evmChains} live-probed chains)`)) {
          problems.push(`sdk/src/swap.ts docstring EVM chain count is stale (registry says ${evmChains})`)
        }
      }

      const proofs = reg.reduce((n, p) => n + p.proofs.length, 0)
      return problems.length
        ? bad(problems.join(' · '))
        : ok(`${reg.length} routes · ${proofs} mainnet proofs · docstring, logos, site data and docs all agree`)
    },
  },
  {
    domain: 'facilitators',
    id: 'site-data-generated',
    verify: [
      "node site/scripts/gen-facilitators.mjs",
      "npm run build",
    ],
    what: 'The website facilitator data matches the SDK registry (networks AND order)',
    source: { file: 'sdk/src/facilitators.ts', note: 'KNOWN_FACILITATORS' },
    mirrors: [
      { file: 'site/src/data/facilitators.ts', note: 'regenerate: node site/scripts/gen-facilitators.mjs' },
      { file: 'site/src/pages/facilitators.astro', note: 'the public page — renders the generated data, never a hand-written copy' },
    ],
    check() {
      const s = sdk()
      if (!s?.KNOWN_FACILITATORS) return skip(sdkMissing() ?? 'KNOWN_FACILITATORS not exported')
      if (!exists('site/src/data/facilitators.ts')) return skip('site data not generated yet')
      const src = read('site/src/data/facilitators.ts')
      const gen = JSON.parse(src.slice(src.indexOf('= [') + 2))
      const problems = []
      const want = Object.keys(s.KNOWN_FACILITATORS).sort()
      const got = gen.map((c) => c.caip2).sort()
      if (want.join(',') !== got.join(',')) problems.push('network set differs')
      for (const c of gen) {
        const reg = s.KNOWN_FACILITATORS[c.caip2]
        if (!reg) { problems.push(`${c.caip2} not in registry`); continue }
        // Order matters: it is what firstKeylessFacilitator() returns.
        if (c.facilitators.map((f) => f.url).join(',') !== reg.map((f) => f.url).join(',')) {
          problems.push(`${c.caip2} URLs or order differ`)
        }
      }
      return problems.length
        ? bad(`${problems.join('; ')} — re-run: node site/scripts/gen-facilitators.mjs`)
        : ok(`${gen.length} chains · ${facilitatorHosts().length} facilitators in sync`)
    },
  },

  {
    domain: 'facilitators',
    id: 'dead-list-agrees',
    verify: [
      "npx vitest run test/facilitators.test.ts",
    ],
    what: 'The dead-facilitator list is identical in the checker and the test suite',
    source: { file: 'scripts/sync/sources.mjs', note: 'KNOWN_DEAD_FACILITATORS' },
    mirrors: [{ file: 'sdk/test/facilitators-surface.test.ts', note: 'KNOWN_DEAD' }],
    check() {
      const f = 'sdk/test/facilitators-surface.test.ts'
      if (!exists(f)) return skip('surface test not present')
      const src = read(f)
      const block = src.slice(src.indexOf('KNOWN_DEAD'))
      const inTest = [...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
      const mine = [...KNOWN_DEAD_FACILITATORS].sort()
      return inTest.join(',') === mine.join(',')
        ? ok(`${mine.length} dead hosts, both lists agree`)
        : bad(`checker has [${mine.join(', ')}], test has [${inTest.join(', ')}]`)
    },
  },

  /* ══════════════════════════ DISCOVERY ══════════════════════════ */
  {
    domain: 'discovery',
    id: 'nonevm-caip2',
    verify: [
      "npx vitest run test/x402-network-aliases.test.ts",
    ],
    what: 'Every non-EVM slug in SLUG_TO_CAIP2 matches its driver’s own CAIP-2 id',
    source: { file: 'sdk/src/drivers/<family>/', note: 'each driver binds its own CAIP-2' },
    mirrors: [
      { file: 'sdk/src/indexes.ts', note: 'SLUG_TO_CAIP2 — exact for non-EVM; the EVM half is COMPLETE (every preset) and guarded by sdk/test/x402-network-aliases.test.ts' },
      { file: 'site/src/pages/discovery.astro', note: 'the public page — names each open index the client can read' },
    ],
    check() {
      const map = slugToCaip2()
      const nonEvm = Object.entries(map).filter(([, v]) => !v.startsWith('eip155:'))
      if (!nonEvm.length) return skip('could not parse SLUG_TO_CAIP2')
      const problems = nonEvm.filter(([slug, caip2]) => {
        if (!exists(`sdk/src/drivers/${slug}`)) return false // no same-named family; not a mirror
        return !walk(`sdk/src/drivers/${slug}`, ['.ts']).some((f) => read(f).includes(caip2))
      }).map(([slug, caip2]) => `${slug}: ${caip2} not found in its driver`)
      return problems.length ? bad(problems.join('; ')) : ok(`${nonEvm.length} non-EVM CAIP-2 ids match their drivers`)
    },
  },

  /* ══════════════════════════════ SITE ══════════════════════════════ */
  {
    domain: 'site',
    id: 'code-blocks-highlighted',
    verify: [
      "npm run build",
    ],
    what: 'Every <CodeWindow /> snippet is syntax-highlighted, not plain text',
    source: { file: 'site/src/lib/highlight.ts', note: 'the tokenizer every snippet must go through' },
    mirrors: [
      { file: 'site/src/data/snippets.ts', note: 'the shared snippets (hand-written tok-* spans)' },
      { file: 'site/src/pages/*.astro', note: 'page-local snippets — must call highlight()' },
    ],
    check() {
      if (!exists('site/dist')) return skip('site not built — run `npm run build`')
      const pages = walk('site/dist', ['.html'])
      /*
       * The site has TWO legitimate highlighters and this rule must know both, or it cries
       * wolf. Markdown fences in the blog go through Astro's built-in Shiki, which wraps
       * every line in `class="line"` and colours with inline styles; `<CodeWindow />`
       * snippets carry our own `tok-*` classes. A block with NEITHER marker is a raw string
       * handed to CodeWindow — the actual bug.
       *
       * A Shiki block with no colours at all is still fine: that is a `text`-language fence,
       * e.g. an ASCII directory diagram, which is meant to be plain.
       */
      const highlighted = (html) => html.includes('tok-') || html.includes('class="line"')
      const plain = []
      for (const f of pages) {
        for (const m of read(f).matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)) {
          if (m[1].trim().length > 40 && !highlighted(m[1])) plain.push(f)
        }
      }
      return plain.length
        ? bad(`unhighlighted code block(s) in: ${[...new Set(plain)].join(', ')} — wrap the snippet in highlight()`)
        : ok(`${pages.length} built pages, every code block highlighted`)
    },
  },

  {
    domain: 'site',
    id: 'structured-data',
    verify: [
      "npm run build",
    ],
    what: 'Every built page carries valid, parseable JSON-LD',
    source: { file: 'site/src/layouts/Layout.astro', note: 'the site-wide entity graph' },
    mirrors: [{ file: 'site/dist/**/index.html', note: 'per-page blocks (Dataset, FAQPage, …)' }],
    check() {
      if (!exists('site/dist')) return skip('site not built — run `npm run build`')
      const pages = walk('site/dist', ['.html'])
      const problems = []
      for (const f of pages) {
        const blocks = [...read(f).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
        if (!blocks.length) { problems.push(`${f}: no JSON-LD`); continue }
        for (const b of blocks) {
          try { JSON.parse(b[1]) } catch (e) { problems.push(`${f}: unparseable JSON-LD (${e.message.slice(0, 40)})`) }
        }
      }
      return problems.length ? bad(problems.join('; ')) : ok(`${pages.length} pages, all JSON-LD parses`)
    },
  },

  {
    domain: 'site',
    id: 'internal-links',
    verify: [
      "npm run build",
    ],
    what: 'Every internal link on the built site resolves to a real page',
    source: { file: 'site/src/pages/', note: 'the pages that exist' },
    mirrors: [{ file: 'site/dist/**/index.html', note: 'every href="/..." across the site' }],
    check() {
      if (!exists('site/dist')) return skip('site not built — run `npm run build`')
      const pages = walk('site/dist', ['.html'])
      const broken = new Set()
      for (const f of pages) {
        for (const m of read(f).matchAll(/href="(\/[^"#?]*)"/g)) {
          const href = m[1]
          if (/\.(svg|png|jpg|webp|txt|xml|ico|json|pdf|mp4|webmanifest)$/.test(href)) {
            if (!exists(`site/public${href}`) && !exists(`site/dist${href}`)) broken.add(`${href} (from ${f})`)
            continue
          }
          const target = href.endsWith('/') ? `site/dist${href}index.html` : `site/dist${href}/index.html`
          if (!exists(target) && !exists(`site/dist${href}`)) broken.add(`${href} (from ${f})`)
        }
      }
      return broken.size ? bad([...broken].join('; ')) : ok(`${pages.length} pages, no broken internal links`)
    },
  },

  {
    domain: 'site',
    id: 'sitemap-covers-pages',
    verify: [
      "npm run build",
    ],
    what: 'Every built page appears in the sitemap',
    source: { file: 'site/dist/', note: 'the pages actually built' },
    mirrors: [{ file: 'site/dist/sitemap-*.xml', note: 'generated by @astrojs/sitemap' }],
    check() {
      if (!exists('site/dist')) return skip('site not built — run `npm run build`')
      const maps = walk('site/dist', ['.xml']).filter((f) => f.includes('sitemap'))
      if (!maps.length) return bad('no sitemap produced')
      const urls = maps.flatMap((m) => [...read(m).matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]))
      const pages = walk('site/dist', ['.html']).filter((f) => f.endsWith('index.html'))
      const missing = pages.filter((p) => {
        const path = p.replace('site/dist', '').replace(/\/index\.html$/, '/') || '/'
        return !urls.some((u) => new URL(u).pathname === path)
      })
      return missing.length ? bad(`not in sitemap: ${missing.join(', ')}`) : ok(`${pages.length} pages, all in the sitemap`)
    },
  },

  /* ══════════════════════════ DOCUMENTATION ══════════════════════════ */
  {
    domain: 'docs',
    id: 'surfaces-index',
    verify: [
      "npm run sync -- --only surfaces-index",
    ],
    what: 'Every domain in this checker is described in SURFACES.md, and CLAUDE.md states the right totals',
    source: { file: 'scripts/sync/rules.mjs', note: 'the domains and the rule count that exist' },
    mirrors: [
      { file: '.claude/SURFACES.md', note: 'the human-readable map — one section per domain' },
      { file: 'CLAUDE.md', note: 'the START-HERE block quotes "N rules across M domains" + the domain list' },
      { file: 'RELEASING.md', note: 'the deploy-guard section quotes the same totals' },
    ],
    check() {
      /*
       * 🔴 `.claude/` is gitignored by design (an allowlist of six skills is the only tracked
       * part), so SURFACES.md is ABSENT in every clean clone — which is exactly what CI and the
       * Netlify build are. This rule used to hard-fail there, and since the site's `prebuild`
       * runs the checker, that would have failed the production deploy the first time this
       * directory shipped. Caught by building a tree from the git index and running the guard
       * in it, which is the only way to see it: it passes locally forever.
       *
       * SKIP when the workspace itself isn't present; FAIL only when it is and the map is gone.
       */
      /*
       * 🔴 SURFACES.md is GITIGNORED — `.claude/` ships only an allowlist of six skills, so the
       * human map is absent from every clean clone, which is exactly what CI and the Netlify
       * build are. This rule used to hard-fail there; since the site's `prebuild` runs the
       * checker, that would have broken the production deploy the first time `scripts/` shipped.
       *
       * So: SKIP with a reason, the same contract the build-dependent rules follow. Nothing is
       * lost — the map can only drift on a maintainer's machine, where the file IS present and
       * the rule DOES run (and `npm run verify-gate` runs it before every release).
       *
       * (Testing `exists('.claude')` does NOT work: the directory exists in a clone because of
       * those six allowlisted skills. Found by building a tree from the git index and running
       * the guard inside it — this passes locally forever.)
       */
      if (!exists('.claude/SURFACES.md')) {
        return skip('.claude/SURFACES.md is gitignored and absent here (clean clone / CI) — runs on a maintainer machine')
      }
      const txt = read('.claude/SURFACES.md')
      const domains = [...new Set(RULES.map((r) => r.domain))]
      const problems = []
      const missing = domains.filter((d) => !txt.includes(`\`${d}\``))
      if (missing.length) problems.push(`SURFACES.md does not cover: ${missing.join(', ')}`)

      /*
       * CLAUDE.md advertises the totals in the block every session is told to read first, and
       * nothing guarded them: adding the `skills` domain left it reading "45 rules across 12
       * domains" — the map's own headline was the drift. Guard the two numbers AND the inline
       * domain list, since a stale list is the same lie in a slower form.
       */
      if (exists('CLAUDE.md')) {
        const claude = read('CLAUDE.md')
        const m = claude.match(/\*\*(\d+) rules across (\d+) domains\*\*/)
        if (!m) problems.push('CLAUDE.md no longer states "**N rules across M domains**"')
        else {
          if (Number(m[1]) !== RULES.length) problems.push(`CLAUDE.md says ${m[1]} rules; there are ${RULES.length}`)
          if (Number(m[2]) !== domains.length) problems.push(`CLAUDE.md says ${m[2]} domains; there are ${domains.length}`)
        }
        const absent = domains.filter((d) => !new RegExp(`[·(]\\s*${d}\\b`).test(claude))
        if (absent.length) problems.push(`CLAUDE.md's domain list omits: ${absent.join(', ')}`)
      }

      /*
       * RELEASING.md quotes the same totals in its deploy-guard section, and nothing watched it:
       * it still read "20 rules across 7 domains" long after the map had grown to 47/13. A
       * release doc that misdescribes the guard is worse than one that omits it.
       */
      if (exists('RELEASING.md')) {
        const rel = read('RELEASING.md')
        const m = rel.match(/\*\*(\d+) rules across (\d+) domains\*\*/)
        if (!m) problems.push('RELEASING.md no longer states "**N rules across M domains**"')
        else {
          if (Number(m[1]) !== RULES.length) problems.push(`RELEASING.md says ${m[1]} rules; there are ${RULES.length}`)
          if (Number(m[2]) !== domains.length) problems.push(`RELEASING.md says ${m[2]} domains; there are ${domains.length}`)
        }
      }

      return problems.length ? bad(problems.join('; ')) : ok(`${domains.length} domains + ${RULES.length} rules documented in all 3 maps`)
    },
  },

  {
    domain: 'docs',
    id: 'x402-coverage-figure',
    verify: [
      "npm run x402:coverage",
    ],
    what: 'Every quoted x402-coverage figure comes from the audit’s generated coverage.json',
    source: {
      file: 'scripts/x402-corpus/coverage.json',
      note: 'GENERATED by `npm run x402:coverage -- --json …` — the only place a coverage number is allowed to originate',
    },
    mirrors: [
      { file: 'sdk/CHANGELOG.md', note: 'the release headline quotes the before/after shares' },
      { file: 'docs/src/content/docs/making-payments/exact-buyer.md', note: 'the catalogue totals the prose cites' },
    ],
    check() {
      /*
       * Why this exists: the CDP Bazaar moves INTRADAY. On 2026-09-06 a morning run measured
       * 16,540 resources / 41,310 rails / 99.0%, and an afternoon run of the same script measured
       * 15,686 / 40,388 / 98.8%. Five surfaces ended up quoting the morning numbers under the
       * afternoon's date — every one of them individually "correct when written", and collectively
       * a contradiction. A human cannot spot that by reading; the totals are the giveaway.
       *
       * So: don't police the SHARE (prose rounds it, and a share is cheap to re-derive) — police
       * the DENOMINATORS. If a surface names a resource or rail total, it must be the one in
       * coverage.json. Re-run the audit, then update the prose it prints.
       */
      const path = 'scripts/x402-corpus/coverage.json'
      if (!exists(path)) return skip('coverage.json absent — run `npm run x402:coverage -- --json ' + path + '`')
      const cov = readJson(path)
      const resources = cov?.source?.resources
      const rails = cov?.source?.exactRails
      if (!resources || !rails) return skip('coverage.json has no source totals')

      const group = (n) => n.toLocaleString('en-US') // 15686 → "15,686", the form prose uses
      const okTotals = new Set([group(resources), group(rails)])
      // Any 5-digit grouped number that looks like a catalogue total but is not the current one.
      // 🔴 NOT when it carries a unit. A chain fee written as "10,001 lamports" matches the
      // shape exactly and is not a coverage figure at all; the 2.16.1 GoPlausible entry tripped
      // this and the prose was correct. A gate that fires on a correct line is the one people
      // learn to wave through, so the unit is excluded rather than the sentence reworded.
      const UNITS = String.raw`lamports?|gwei|wei|satoshis?|sats|drops?|stroops?|microalgos?|nanotons?|yocto\w*`
      const suspicious = new RegExp(
        String.raw`\b(1[0-9],[0-9]{3}|[34][0-9],[0-9]{3})\b(?![\s-]*(?:${UNITS})\b)`,
        'g',
      )
      const problems = []
      for (const f of [
        'sdk/CHANGELOG.md',
        'docs/src/content/docs/making-payments/exact-buyer.md',
      ]) {
        if (!exists(f)) continue
        const stale = [...new Set(read(f).match(suspicious) ?? [])].filter((n) => !okTotals.has(n))
        if (stale.length) problems.push(`${f} quotes ${stale.join(', ')} — coverage.json says ${group(resources)} resources / ${group(rails)} rails`)
      }
      return problems.length
        ? bad(problems.join(' · ') + ' — re-run `npm run x402:coverage -- --json ' + path + '` and repin the prose')
        : ok(`${group(resources)} resources / ${group(rails)} rails, quoted consistently (measured ${cov.measuredAt})`)
    },
  },

  {
    domain: 'docs',
    id: 'changelog-unreleased',
    verify: [
      "npm run sync -- --only changelog-unreleased",
    ],
    what: 'Uncommitted SDK source changes have a CHANGELOG entry',
    source: { file: 'sdk/src/', note: 'the code that changed' },
    mirrors: [{ file: 'sdk/CHANGELOG.md', note: 'an [Unreleased] section' }],
    check() {
      const log = read('sdk/CHANGELOG.md')
      return /##\s*\[Unreleased\]/i.test(log)
        ? ok('an [Unreleased] section exists')
        : warn('no [Unreleased] section — fine right after a release, add one when you change sdk/src')
    },
  },

  /* ══════════════════════════════ API SURFACE ══════════════════════════════ */
  {
    domain: 'api',
    id: 'sdk-imports-in-samples',
    verify: [
      "npm run typecheck",
    ],
    what: 'Every `import { … } from "@piprail/sdk"` in the docs, site and examples is real',
    source: { file: 'sdk/dist/index.d.ts + index.cjs', note: '⭐ the actual export surface — values AND types' },
    mirrors: [
      { file: 'docs/src/content/docs/**', note: '~90 pages of code samples' },
      { file: 'site/src/**', note: 'page snippets' },
      { file: 'examples/**', note: 'runnable demos + their prose' },
      { file: 'README.md', note: 'the repo readme’s samples' },
      { file: 'sdk/README.md', note: 'the SDK readme’s samples' },
      { file: 'AGENTS.md', note: 'the agent-facing ground truth' },
      { file: 'mcp/README.md', note: 'the MCP readme’s samples' },
    ],
    check() {
      const surface = sdkExportSurface()
      if (!surface) return skip(sdkMissing())
      const { found, count, fileCount } = sdkImportsInSamples()
      // NB: not named `bad` — that would shadow the bad() helper and make the failure path
      // throw a TypeError instead of reporting the actual problem.
      const unknown = [...found.entries()].filter(([id]) => !surface.has(id))
      return unknown.length
        ? bad(`${unknown.length} identifier(s) not exported: ${unknown.map(([id, files]) => `${id} (${[...files][0]})`).join('; ')}`)
        : ok(`${count} identifiers across ${fileCount} files, all in the ${surface.size}-symbol export surface`)
    },
  },

  {
    domain: 'api',
    id: 'scaffolder-api',
    verify: [
      "npm run typecheck",
    ],
    what: 'create-piprail generates code against real SDK exports and real gate methods',
    source: { file: 'sdk/src/', note: 'the exports and the gate contract' },
    mirrors: [{ file: 'create-piprail/src/render.ts', note: 'every merchant app this writes depends on them' }],
    check() {
      const s = sdk()
      if (!s) return skip(sdkMissing())
      if (!exists('create-piprail/src/render.ts')) return skip('create-piprail not present')
      const src = read('create-piprail/src/render.ts')
      const surface = sdkExportSurface()

      const emitted = [...new Set([...src.matchAll(
        /\b(createPaywall|createTipJar|requirePayment|createPaymentGate|toWorker|toFetchHandler|proxyTo|PipRailClient|paymentTools)\b/g,
      )].map((m) => m[1]))]
      const missingExports = emitted.filter((e) => !surface.has(e))

      // The generated app calls these on the gate. A rename in the SDK silently breaks every
      // scaffolded merchant, and nothing else in the repo would notice.
      const methods = [...new Set([...src.matchAll(/gate\.(\w+)\(/g)].map((m) => m[1]))]
      let gate
      try {
        gate = s.createPaymentGate({
          chain: { id: 8453, rpcUrl: 'https://mainnet.base.org' },
          token: 'USDC', amount: '0.05', payTo: '0x3333333333333333333333333333333333333333',
        })
      } catch (err) {
        return skip(`could not construct a gate to introspect (${err.message.slice(0, 60)})`)
      }
      const missingMethods = methods.filter((m) => typeof gate[m] !== 'function')

      const problems = [
        ...missingExports.map((e) => `emits ${e}, which the SDK does not export`),
        ...missingMethods.map((m) => `calls gate.${m}(), which does not exist`),
      ]
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${emitted.length} SDK exports + ${methods.length} gate methods, all real`)
    },
  },

  /* ══════════════════════════════ ERRORS ══════════════════════════════ */
  {
    domain: 'errors',
    id: 'error-codes-documented',
    verify: [
      "npx vitest run test/errors.test.ts",
      "npm run build:docs",
    ],
    what: 'Every error class and code is exported and documented in both error references',
    source: { file: 'sdk/src/errors.ts', note: '⭐ the class + its stable `.code`' },
    mirrors: [
      { file: 'sdk/ERRORS.md', note: 'the internal error standard drivers conform to' },
      { file: 'docs/src/content/docs/errors/', note: 'the public error model (4 pages)' },
      { file: 'sdk/src/index.ts', note: 'every class must be publicly exported to be catchable' },
    ],
    check() {
      const surface = sdkExportSurface()
      if (!surface) return skip(sdkMissing())
      const src = read('sdk/src/errors.ts')
      const codes = [...new Set([...src.matchAll(/readonly code = '([A-Z_]+)'/g)].map((m) => m[1]))]
      const classes = [...new Set([...src.matchAll(/export class (\w+Error)/g)].map((m) => m[1]))]
      if (!codes.length) return skip('could not parse sdk/src/errors.ts')

      const docs = walk('docs/src/content/docs/errors', ['.md', '.mdx']).map(read).join('\n')
      const standard = exists('sdk/ERRORS.md') ? read('sdk/ERRORS.md') : ''
      const problems = [
        ...codes.filter((c) => !docs.includes(c)).map((c) => `${c} absent from docs/errors`),
        ...codes.filter((c) => !standard.includes(c)).map((c) => `${c} absent from sdk/ERRORS.md`),
        // A class you cannot import is a class you cannot catch with instanceof.
        ...classes.filter((c) => !surface.has(c)).map((c) => `${c} is not exported`),
        ...classes.filter((c) => !docs.includes(c)).map((c) => `${c} absent from docs/errors`),
      ]
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${codes.length} codes · ${classes.length} classes — exported and documented in both references`)
    },
  },

  /* ══════════════════════════ MCP CONFIGURATION ══════════════════════════ */
  {
    domain: 'mcp',
    id: 'env-vars-documented',
    verify: [
      "npm run test:mcp",
    ],
    what: 'Every env var the MCP server accepts is documented',
    source: { file: 'mcp/src/config.ts', note: '⭐ KNOWN_PIPRAIL_VARS — the STRICT allowlist; anything else refuses to start' },
    mirrors: [{ file: 'docs/src/content/docs/mcp/', note: 'the canonical env reference (READMEs are deliberately compact signposts)' }],
    check() {
      const vars = mcpEnvVars()
      if (!vars) return skip('could not parse KNOWN_PIPRAIL_VARS')
      const docs = walk('docs/src/content/docs/mcp', ['.md', '.mdx']).map(read).join('\n')
      const missing = vars.filter((v) => !docs.includes(v))
      /*
       * Deliberately ONE-WAY. The reverse ("a var in the docs the server would reject") sounds
       * appealing and produces false alarms: the security page shows `PIPRAIL_MAX_AMUONT` on
       * purpose to demonstrate the typo guard, and `PIPRAIL_AGENT_GUIDE` is an SDK export
       * constant, not an env var. Both matched a naive reverse check.
       */
      return missing.length
        ? bad(`not documented in docs/mcp: ${missing.join(', ')}`)
        : ok(`all ${vars.length} accepted env vars documented`)
    },
  },

  /* ══════════════════════════ CROSS-HOST + ASSETS ══════════════════════════ */
  {
    domain: 'site',
    id: 'assets-exist',
    verify: [
      "npm run build",
    ],
    what: 'Every image, icon and file referenced by the built HTML actually ships',
    source: { file: 'site/public/', note: 'the apex assets that exist' },
    mirrors: [
      { file: 'docs/public/', note: 'the docs-host assets that exist' },
      { file: 'site/dist/', note: 'src/href/content references in built apex pages' },
      { file: 'docs/dist/', note: 'src/href/content references in built docs pages' },
    ],
    check() {
      const hosts = [['site', 'site/dist', 'site/public'], ['docs', 'docs/dist', 'docs/public']]
      const problems = []
      let total = 0
      for (const [label, dist, pub] of hosts) {
        if (!exists(dist)) continue
        const refs = new Map()
        for (const f of htmlPages(dist)) {
          const html = read(f)
          const add = (r) => refs.set(r, (refs.get(r) ?? 0) + 1)
          for (const m of html.matchAll(/(?:src|href|content)="(\/[\w./-]+\.(?:png|svg|jpg|jpeg|webp|ico|mp4|pdf|webmanifest))"/g)) add(m[1])
          for (const m of html.matchAll(/content="https:\/\/(?:docs\.)?piprail\.com(\/[\w./-]+\.(?:png|svg|jpg|webp))"/g)) add(m[1])
        }
        total += refs.size
        // Check the ARTIFACT, not the source: an earlier draft scanned site/src and flagged
        // `/og-sdk.png`, which appears only inside a JSDoc example of what you could pass.
        for (const r of refs.keys()) {
          if (!exists(`${dist}${r}`) && !exists(`${pub}${r}`)) problems.push(`${label}: ${r} (${refs.get(r)} refs)`)
        }
      }
      if (!total) return skip('nothing built — run `npm run build` and `npm run build:docs`')
      return problems.length ? bad(problems.join('; ')) : ok(`${total} distinct asset references, all present`)
    },
  },

  {
    domain: 'site',
    id: 'cross-host-links',
    verify: [
      "npm run build",
      "npm run build:docs",
    ],
    what: 'Links between piprail.com and docs.piprail.com resolve on the other host',
    source: { file: 'site/dist/', note: 'the pages the apex actually builds' },
    mirrors: [
      { file: 'site/src/**', note: 'links out to docs.piprail.com/…' },
      { file: 'docs/src/content/docs/**', note: 'links back to piprail.com/…' },
    ],
    check() {
      if (!exists('site/dist') || !exists('docs/dist')) return skip('both sites must be built (npm run build && npm run build:docs)')
      // Routes served by a Netlify Function rather than a static file — real, but never in dist.
      const fnRoutes = new Set(walk('site/netlify/functions', ['.mjs', '.js', '.ts']).map(() => null).filter(Boolean))
      const dynamic = new Set(['/x402/demo'])
      const problems = []
      let checked = 0

      for (const f of htmlPages('site/dist')) {
        for (const m of read(f).matchAll(/href="https:\/\/docs\.piprail\.com([^"#]*)/g)) {
          const p = m[1] || '/'
          checked++
          if (!resolves(p, 'docs/dist', 'docs/public')) problems.push(`site → docs${p}`)
        }
      }
      for (const f of htmlPages('docs/dist')) {
        for (const m of read(f).matchAll(/href="https:\/\/(?:www\.)?piprail\.com([^"#]*)/g)) {
          const p = m[1] || '/'
          // Skip HTML-escaped fragments from code samples; a real href has no entities.
          if (p.includes('&#')) continue
          checked++
          if (!dynamic.has(p) && !fnRoutes.has(p) && !resolves(p, 'site/dist', 'site/public')) problems.push(`docs → piprail.com${p}`)
        }
      }
      return problems.length
        ? bad(`${problems.length} broken: ${[...new Set(problems)].slice(0, 8).join(', ')}`)
        : ok(`${checked} cross-host links resolve`)
    },
  },

  {
    domain: 'site',
    id: 'jsonld-shared-ids',
    verify: [
      "npm run build",
    ],
    what: 'Apex @ids that the docs reference are actually defined by the apex',
    source: { file: 'site/src/layouts/Layout.astro', note: '⭐ defines piprail.com/#organization and /#sdk' },
    mirrors: [{ file: 'docs/src/components/Head.astro', note: 'references them so BOTH hosts resolve to one entity graph' }],
    check() {
      if (!exists('site/dist') || !exists('docs/dist')) return skip('both sites must be built')
      const idsIn = (dist) => {
        const defined = new Set()
        for (const f of htmlPages(dist)) {
          for (const m of read(f).matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
            try {
              for (const x of JSON.stringify(JSON.parse(m[1])).matchAll(/"@id":"([^"]+)"/g)) defined.add(x[1])
            } catch { /* the structured-data rule owns malformed JSON-LD */ }
          }
        }
        return defined
      }
      const apex = idsIn('site/dist')
      const docsIds = idsIn('docs/dist')
      // Only apex-hosted ids matter here; docs' own ids live on the docs host.
      const referenced = [...docsIds].filter((i) => /^https:\/\/piprail\.com\/#/.test(i))
      const orphaned = referenced.filter((i) => !apex.has(i))
      return orphaned.length
        ? bad(`docs reference apex @id(s) the apex does not define: ${orphaned.join(', ')} — renaming one silently breaks the shared graph`)
        : ok(`${referenced.length} shared apex @id(s) resolve (${[...referenced].join(', ') || 'none'})`)
    },
  },

  /* ══════════════════════════════ DOCS SITE ══════════════════════════════ */
  {
    domain: 'docs',
    id: 'docs-internal-links',
    verify: [
      "npm run build:docs",
    ],
    what: 'Every internal link on the built docs site resolves',
    source: { file: 'docs/src/content/docs/', note: 'the pages that exist' },
    mirrors: [{ file: 'docs/dist/**', note: 'every href="/…" across ~107 built pages' }],
    check() {
      if (!exists('docs/dist')) return skip('docs not built — run `npm run build:docs`')
      const pages = htmlPages('docs/dist')
      const broken = new Set()
      for (const f of pages) {
        for (const m of read(f).matchAll(/href="(\/[^"#?]*)"/g)) {
          const h = m[1]
          if (/\.(svg|png|jpg|jpeg|webp|txt|xml|ico|json|pdf|css|js|woff2?|mp4)$/.test(h)) continue
          if (!resolves(h, 'docs/dist', 'docs/public')) broken.add(h)
        }
      }
      return broken.size
        ? bad(`${broken.size} broken: ${[...broken].slice(0, 10).join(', ')}`)
        : ok(`${pages.length} pages, no broken internal links`)
    },
  },

  {
    domain: 'docs',
    id: 'integration-surfaces',
    verify: [
      "npm run sync -- --only integration-surfaces",
    ],
    what: 'Every integration is present on all four of its surfaces',
    source: { file: 'integrations/<framework>/piprail/', note: 'the integrations that exist' },
    mirrors: [
      { file: 'integrations/README.md', note: 'the status table' },
      { file: 'docs/src/content/docs/integrations/', note: 'one page per integration' },
      { file: 'site/src/data/integrations.ts', note: 'the site cards' },
      { file: 'integrations/<framework>/piprail/README.md', note: 'its own readme' },
    ],
    check() {
      const dirs = lsDirs('integrations')
      if (!dirs.length) return skip('no integrations')
      const docPages = walk('docs/src/content/docs/integrations', ['.md', '.mdx']).map((p) => p.toLowerCase())
      const siteData = exists('site/src/data/integrations.ts') ? read('site/src/data/integrations.ts').toLowerCase() : ''
      const hub = exists('integrations/README.md') ? read('integrations/README.md').toLowerCase() : ''
      const problems = []
      for (const d of dirs) {
        if (!exists(`integrations/${d}/piprail/README.md`)) problems.push(`${d}: no own README`)
        if (!docPages.some((p) => p.includes(d))) problems.push(`${d}: no docs page`)
        if (!siteData.includes(d)) problems.push(`${d}: absent from site/src/data/integrations.ts`)
        if (!hub.includes(d)) problems.push(`${d}: absent from integrations/README.md`)
      }
      return problems.length ? bad(problems.join('; ')) : ok(`${dirs.length} integrations × 4 surfaces`)
    },
  },

  /* ══════════════════════════════ CI ══════════════════════════════ */
  {
    domain: 'ci',
    id: 'workflow-paths',
    verify: [
      "npm run sync -- --only workflow-paths",
    ],
    what: 'Every script path a GitHub workflow invokes exists',
    source: { file: 'the repo tree', note: 'the scripts that exist' },
    mirrors: [{ file: '.github/workflows/*.yml', note: 'a renamed script fails only when the workflow next runs' }],
    check() {
      const wf = walk('.github/workflows', ['.yml', '.yaml'])
      if (!wf.length) return skip('no workflows')
      const problems = []
      let refs = 0
      for (const f of wf) {
        for (const m of read(f).matchAll(/(?:node|bash|sh)\s+((?:site|sdk|mcp|scripts|docs|examples|create-piprail|integrations)\/[\w./-]+)/g)) {
          refs++
          if (!exists(m[1])) problems.push(`${f}: ${m[1]}`)
        }
      }
      return problems.length ? bad(`missing: ${problems.join(', ')}`) : ok(`${refs} script paths across ${wf.length} workflows`)
    },
  },

  {
    domain: 'ci',
    id: 'sweep-covers-tests',
    verify: [
      "npm run sweep -- --list",
    ],
    what: 'Every SDK test suite belongs to exactly one sweep section (no unswept surface)',
    source: { file: 'sdk/test/', note: 'the suites that exist on disk' },
    mirrors: [
      { file: 'scripts/sweep.mjs', note: 'SECTIONS — the section each suite is swept under' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * `npm run sweep` runs the suite in named sections so a red run names the SUBSYSTEM, not
       * just the SDK. That only holds while every suite is claimed by a section: a file matched
       * by no section is never swept, and one matched by two is counted twice and reported twice.
       *
       * The sweep already fails on either, but only when somebody runs it. This puts the same
       * invariant in the map, so adding `sdk/test/whatever.test.ts` without giving it a section
       * fails the ordinary `npm run sync` the CLAUDE.md workflow starts with.
       */
      const script = 'scripts/sweep.mjs'
      if (!exists(script)) return bad('scripts/sweep.mjs is missing — the sweep is the map of the suite')
      let out
      try {
        out = execFileSync('node', [join(REPO, script), '--list'], { cwd: REPO, encoding: 'utf8' })
      } catch (e) {
        const said = String(e.stdout ?? '') + String(e.stderr ?? '')
        const names = [...said.matchAll(/· sdk\/test\/(\S+)/g)].map((m) => m[1])
        return bad(
          names.length
            ? `${names.length} suite(s) outside every sweep section: ${names.slice(0, 4).join(', ')}` +
                `${names.length > 4 ? ', …' : ''} — give them a section in scripts/sweep.mjs`
            : `npm run sweep -- --list failed: ${said.trim().split('\n').slice(-2).join(' ')}`
        )
      }
      const m = out.match(/(\d+) suites across (\d+) sections/)
      return m ? ok(`${m[1]} suites across ${m[2]} sections, all claimed`) : ok('sweep sections resolve')
    },
  },

  {
    domain: 'ci',
    id: 'smoke-sections-declared',
    verify: [
      "npm run smoke -- --list",
    ],
    what: 'Every smoke section declares its layer + purpose, and the protocol documents them all',
    source: { file: 'scripts/smoke/', note: 'the adversarial + live sections that exist on disk' },
    mirrors: [
      { file: 'TESTING.md', note: 'the ordered protocol — every section named in its layer table' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * `npm run sweep` covers the UNIT layer and guards its own coverage. The layers that find
       * the real bugs — a hostile caller (L2), a third-party host that went dark (L3), a payment
       * that must actually settle (L4) — live in scripts/smoke/, and a section nobody documented
       * is a section nobody runs. Two things must stay true: every section declares what layer it
       * belongs to and why it exists, and the protocol doc names it.
       */
      const dir = 'scripts/smoke'
      if (!exists(dir)) return bad('scripts/smoke/ is missing — the adversarial + live layers')
      const files = readdirSync(join(REPO, dir)).filter((f) => /^l\d-.*\.mjs$/.test(f))
      if (!files.length) return bad('no l<N>-*.mjs sections in scripts/smoke/')
      const doc = 'TESTING.md'
      if (!exists(doc)) return bad(`${doc} is missing — the protocol IS the map of these layers`)
      const prose = read(doc)
      const problems = []
      const ids = []
      for (const f of files) {
        const src = read(`${dir}/${f}`)
        const id = src.match(/id:\s*'([^']+)'/)?.[1]
        const layer = src.match(/layer:\s*'(L\d)'/)?.[1]
        const why = src.match(/why:\s*'/)
        if (!id) { problems.push(`${f}: no meta.id`); continue }
        ids.push(id)
        if (!layer) problems.push(`${f}: no meta.layer`)
        if (!why) problems.push(`${f}: no meta.why (say what breaks in the real world)`)
        if (!prose.includes(`\`${id}\``)) problems.push(`${id}: not named in ${doc}`)
      }
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${ids.length} sections declared + documented: ${ids.sort().join(', ')}`)
    },
  },

  /* ══════════════════════ DRIVER CONTRACT ══════════════════════ */
  {
    domain: 'chains',
    id: 'driver-contract',
    verify: [
      "npm run test:sdk",
    ],
    what: 'Every driver family implements every REQUIRED ResolvedNetwork method',
    source: { file: 'sdk/src/drivers/types.ts', note: '⭐ the ResolvedNetwork interface — 11 required, 10 optional' },
    mirrors: [{ file: 'sdk/src/drivers/<family>/', note: 'a missing required method fails only when that chain is used' }],
    check() {
      const types = read('sdk/src/drivers/types.ts')
      const start = types.indexOf('interface ResolvedNetwork')
      if (start < 0) return skip('could not find the ResolvedNetwork interface')
      const block = types.slice(start, types.indexOf('\n}', start))
      const required = []
      const optional = []
      for (const m of block.matchAll(/^ {2}(\w+)(\??)\s*[(:]/gm)) (m[2] === '?' ? optional : required).push(m[1])
      if (!required.length) return skip('could not parse the interface members')

      /*
       * Only the REQUIRED members. The optional ten (payExact, settleExactSelf, payUpto, the
       * Permit2 helpers, …) are deliberately EVM- or family-specific — an early draft flagged
       * nine families for "missing" methods they are not supposed to have.
       */
      const problems = []
      for (const f of lsDirs('sdk/src/drivers')) {
        const src = walk(`sdk/src/drivers/${f}`, ['.ts']).map(read).join('')
        const missing = required.filter((m) => !new RegExp(`\\b${m}\\s*[:(]`).test(src))
        if (missing.length) problems.push(`${f}: ${missing.join(', ')}`)
      }
      return problems.length
        ? bad(problems.join('; '))
        : ok(`${lsDirs('sdk/src/drivers').length} families × ${required.length} required methods (${optional.length} optional, correctly family-specific)`)
    },
  },

  /* ══════════════════════ CONTENT INDEXES ══════════════════════ */
  {
    domain: 'site',
    id: 'blog-pages',
    verify: [
      "npm run build",
    ],
    what: 'Every blog post in the data has a page, and every page is in the data',
    source: { file: 'site/src/data/posts.ts', note: 'drives the index, the JSON-LD and the sitemap' },
    mirrors: [{ file: 'site/src/pages/blog/<slug>.astro', note: 'the page itself' }],
    check() {
      if (!exists('site/src/data/posts.ts')) return skip('no posts data')
      const slugs = [...read('site/src/data/posts.ts').matchAll(/slug:\s*'([^']+)'/g)].map((m) => m[1])
      const pages = walk('site/src/pages/blog', ['.astro'])
        .map((f) => f.split('/').pop().replace('.astro', ''))
        .filter((n) => n !== 'index')
      const problems = [
        // A post in the data with no page = a 404 in the index AND in the sitemap.
        ...slugs.filter((s) => !pages.includes(s)).map((s) => `${s}: in posts.ts, no page`),
        // A page absent from the data is unlinked — invisible to readers and crawlers.
        ...pages.filter((p) => !slugs.includes(p)).map((p) => `${p}: page exists, not in posts.ts`),
      ]
      return problems.length ? bad(problems.join('; ')) : ok(`${slugs.length} posts, data and pages agree`)
    },
  },

  {
    domain: 'site',
    id: 'linkedin-page-feed',
    verify: [
      "npm run sync -- --only linkedin-page-feed",
    ],
    what: 'Every LinkedIn company-page post in the registry is publishable as-is: unique id, image present, no first person, under the length cap',
    source: { file: 'site/src/data/linkedin-page.ts', note: 'the registry; each entry is one page post' },
    mirrors: [
      { file: 'site/src/pages/linkedin-page.xml.ts', note: 'the RSS feed the Zapier Zap reads and posts from' },
      { file: 'site/public/linkedin/', note: 'the images the feed points Zapier at' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS. Posting as the page goes through a Zap that fires on a NEW
       * <guid> within 15 minutes of a deploy, and a fired post cannot be un-fired. There is
       * no human between a merge and LinkedIn. So the checks a person would do before pasting
       * run here instead, and a failure blocks the build, which blocks the deploy, which
       * blocks the post. The company page has no "I": first person singular is the one
       * error that reads as a mistake on an organisation's page and it is the easiest to
       * make when adapting a personal draft.
       */
      const src = 'site/src/data/linkedin-page.ts'
      if (!exists(src)) return skip('no linkedin-page registry')
      if (!exists('site/src/pages/linkedin-page.xml.ts')) return bad('registry exists but the feed endpoint is missing')
      const text = read(src)
      const entries = [...text.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?date:\s*'([^']+)'[\s\S]*?title:\s*'([^']+)'[\s\S]*?(?:image:\s*'([^']*)'[\s\S]*?)?text:\s*`([\s\S]*?)`/g)]
      if (!entries.length) return skip('registry has no entries yet')
      const problems = []
      const ids = new Set()
      for (const [, id, date, , image, body] of entries) {
        if (ids.has(id)) problems.push(`${id}: duplicate id (Zapier would treat one of them as already posted)`)
        ids.add(id)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`${id}: date "${date}" is not YYYY-MM-DD`)
        if (image && !exists('site/public' + image)) problems.push(`${id}: image ${image} is not under site/public (Zapier fetches it by URL)`)
        if (body.length > 3000) problems.push(`${id}: ${body.length} chars, LinkedIn caps a post at 3,000`)
        // First person singular, as a whole word, ignoring URLs. "I", "I'm", "I've", "my", "me".
        const prose = body.replace(/https?:\/\/\S+/g, '')
        const fp = prose.match(/\b(I|I'm|I've|I'd|I'll|my|me|mine)\b/g)
        if (fp) problems.push(`${id}: first person singular (${[...new Set(fp)].join(', ')}), the page has no "I"`)
        if (/—|–/.test(body)) problems.push(`${id}: em/en dash in the post text`)
      }
      return problems.length ? bad(problems.join(' · ')) : ok(`${entries.length} page post(s), all publishable as-is`)
    },
  },

  {
    domain: 'docs',
    id: 'examples-indexed',
    verify: [
      "npm run sync -- --only examples-indexed",
    ],
    what: 'Every example directory is listed in examples/README.md',
    source: { file: 'examples/', note: 'the examples that exist' },
    mirrors: [{ file: 'examples/README.md', note: 'the index someone actually navigates from' }],
    check() {
      const dirs = lsDirs('examples')
      if (!dirs.length) return skip('no examples')
      const readme = read('examples/README.md')
      const missing = dirs.filter((d) => !readme.includes(d))
      return missing.length
        ? bad(`unlisted (a reader will never find them): ${missing.join(', ')}`)
        : ok(`${dirs.length} example directories, all indexed`)
    },
  },

  {
    domain: 'docs',
    id: 'docs-sidebar-reachable',
    verify: [
      "npm run build:docs",
    ],
    what: 'Every docs page is reachable from the sidebar',
    source: { file: 'docs/src/content/docs/', note: 'the pages that exist' },
    mirrors: [{ file: 'docs/astro.config.mjs', note: 'the Starlight sidebar config' }],
    check() {
      if (!exists('docs/dist')) return skip('docs not built — run `npm run build:docs`')
      /*
       * Read the sidebar from a CONTENT page, not the home page: the index uses Starlight's
       * splash template, which renders no sidebar at all — sampling it reports 8 links and
       * every page as orphaned.
       */
      const sample = walk('docs/dist', ['.html'])
        .find((f) => f.includes('/accepting-payments/') && f.endsWith('index.html'))
      if (!sample) return skip('no content page found to read the sidebar from')
      const nav = new Set([...read(sample).matchAll(/href="(\/[a-z0-9/-]*\/)"/g)].map((m) => m[1]))

      const orphans = []
      for (const f of walk('docs/src/content/docs', ['.md', '.mdx'])) {
        if (f.endsWith('404.md') || f.endsWith('index.mdx')) continue
        const slug = `/${f.replace('docs/src/content/docs/', '').replace(/\.(md|mdx)$/, '')}/`.replace(/\/index\/$/, '/')
        if (!nav.has(slug)) orphans.push(slug)
      }
      return orphans.length
        ? bad(`unreachable from the sidebar (invisible to readers AND crawlers): ${orphans.slice(0, 10).join(' ')}`)
        : ok(`${nav.size} sidebar links cover every page`)
    },
  },

  /* ══════════════════════════════ SECURITY ══════════════════════════════ */
  {
    domain: 'security',
    id: 'mcp-cannot-swap',
    verify: [
      "npm run test:mcp",
      "npm run sync -- --only mcp-cannot-swap",
    ],
    what: 'Swapping is never on by default for an agent, and sovereign mode cannot unlock it without a ceiling',
    source: { file: 'sdk/src/agent.ts → paymentTools()', note: '⭐ the authoritative tool list' },
    mirrors: [
      { file: 'mcp/src/server.ts', note: 'must not reach the SDK swap methods' },
      { file: 'mcp/README.md', note: 'states the refusal and why' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * Every budget cap in `@piprail/mcp` governs PAYING A MERCHANT. A swap is not a payment:
       * it moves the holder's own funds between denominations, so no `maxPerRequest` or daily
       * cap constrains it. A model handed a swap tool could therefore drain a wallet through
       * fees and slippage without exceeding a single limit it was given, and every transaction
       * would look authorised.
       *
       * `mcp/README.md` says all of this and says "there will not be one". Nothing enforced it,
       * so the reasoning lived only in prose that a later change could contradict without any
       * signal. The absence is a security property; treat it like one.
       */
      const tools = mcpTools()
      if (!tools) return skip(sdkMissing() ?? 'paymentTools() not exported')
      const problems = []

      /*
       * ── THE CONTRACT MOVED, AND IT MOVED DELIBERATELY ──────────────────────────────
       *
       * This used to assert that NO agent surface could ever swap. That was the right rule
       * while capability was gated on TRANSPORT: a model driving the MCP could not swap, a
       * model driving the SDK could, and the difference was which package got imported.
       *
       * `AgentMode` moved the decision onto authority instead. The invariant is now sharper,
       * not weaker: the DEFAULT still offers no swap tool, so every operator who does not
       * opt in is exactly where they were, and the forty-odd "8 tools" claims stay true.
       * Sovereign mode APPENDS, and only after the operator declared it.
       */
      const defaultSwapTools = tools.filter((t) => /swap/i.test(t))
      if (defaultSwapTools.length) {
        problems.push(
          `the DEFAULT paymentTools() now offers ${defaultSwapTools.join(', ')} — swapping must stay ` +
            'opt-in behind mode:"sovereign", never on by default'
        )
      }
      if (tools.length !== 8) {
        problems.push(`the default tool list is ${tools.length}, not 8 — every "8 tools" claim is now wrong`)
      }

      /*
       * The tool list is not the only way in: a handler could call the SDK's swap methods from
       * inside another tool. Comments are stripped first, so the README-style explanation of
       * WHY there is no swap tool never trips its own guard.
       *
       * 🔴 The MCP is not the only AGENT surface either. The elizaOS plugin exposes actions and
       * the n8n node exposes operations, and a model driving either is in exactly the position
       * this rule exists to protect: its spend caps govern paying a merchant, and a swap sits
       * outside all of them. Guarding only `mcp/` would have left two open doors to the same room.
       */
      const AGENT_SURFACES = [
        'mcp/src/server.ts', 'mcp/src/index.ts', 'mcp/src/start.ts',
        'integrations/elizaos/piprail/src/actions.ts',
        'integrations/elizaos/piprail/src/client.ts',
        'integrations/elizaos/piprail/src/index.ts',
      ]
      for (const f of AGENT_SURFACES.filter(exists)) {
        const code = read(f)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        const call = code.match(/\.(swap|quoteSwap)\s*\(/)
        if (call) problems.push(`${f} calls ${call[1]}() — no agent surface may be able to swap`)
      }

      // The reasoning must stay documented, so the next reader learns WHY the default withholds
      // it and what unlocking it actually costs, not just that a flag exists.
      if (exists('mcp/README.md') && !/no swap tool/i.test(read('mcp/README.md'))) {
        problems.push('mcp/README.md no longer explains why the default has no swap tool')
      }
      /*
       * 🔴 Sovereign mode must never be reachable without a ceiling. `PIPRAIL_MAX_PER_SWAP` is
       * the whole reason unlocking the capability is defensible: the payment caps cannot bound
       * a swap, so if that refusal is ever removed the feature becomes the unguarded thing it
       * was designed not to be.
       */
      if (exists('mcp/src/config.ts')) {
        const cfg = read('mcp/src/config.ts')
        if (!cfg.includes('PIPRAIL_MODE')) problems.push('mcp/src/config.ts no longer reads PIPRAIL_MODE')
        if (!/sovereign' && parsed\.maxPerSwap === undefined/.test(cfg)) {
          problems.push('sovereign mode no longer REQUIRES PIPRAIL_MAX_PER_SWAP — the unlock has lost its guard')
        }
      }

      return problems.length
        ? bad(problems.join(' · '))
        : ok(`${tools.length} default tools, none can swap · sovereign needs an explicit ceiling · documented`)
    },
  },
  {
    domain: 'security',
    id: 'agent-modes',
    verify: [
      "npm run sync -- --only agent-modes",
      "npx vitest run test/agent-modes.test.ts test/agent-selling.test.ts test/agentGuide.test.ts",
      "npm run test:mcp",
    ],
    what: 'What each agent MODE grants is stated identically everywhere, and sovereign owns both halves of the wallet',
    source: {
      file: 'sdk/src/agent.ts → paymentTools() + sdk/src/client.ts → AGENT_MODES',
      note: '⭐ the modes and the tools each one unlocks — derived, never typed out',
    },
    mirrors: [
      { file: 'sdk/src/agentGuide.ts', note: 'what the MODEL is told it may do in each mode' },
      { file: 'sdk/src/client.ts', note: "refuses mode:'supervised' with no onBeforePay to perform it" },
      { file: 'mcp/src/config.ts', note: 'PIPRAIL_MODE · wires confirm for supervised · the sovereign ceiling refusal' },
      { file: 'mcp/src/banner.ts', note: 'the tool list an operator SEES at boot' },
      { file: 'mcp/README.md', note: 'the default 8 and the sovereign 13' },
      { file: 'docs/src/content/docs/mcp/configuration.md', note: 'the mode contract + the earning half' },
      { file: 'docs/src/content/docs/mcp/tools.md', note: 'the per-tool reference, including the seller tools' },
      { file: 'site/src/pages/mcp.astro', note: 'sovereignTools — the public tool table' },
      { file: 'site/public/llms.txt', note: 'the MCP section an AI crawler reads' },
      { file: 'site/public/llms-full.txt', note: 'the long-form MCP section' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * `mcp-cannot-swap` guards the DEFAULT: eight tools, none of which can swap. That is the
       * half a hundred surfaces already quote, so it would be noticed if it moved. Nothing
       * guarded the OTHER half. Sovereign mode shipped, and within one change the docs were
       * already lying: `mcp/README.md` and the tools reference both still said the MCP has "no
       * swap tool, and there will not be one", which had been false since the day modes landed.
       * No count was wrong, so no count rule could see it.
       *
       * That is the failure mode CLAUDE.md names: the missing surface, not the wrong number. So
       * this rule owns the MODE surface itself. Both tool lists are DERIVED from the SDK, and
       * every place that describes what a mode grants must agree with them.
       */
      const base = mcpTools()
      const sov = sovereignTools()
      if (!base || !sov) return skip(sdkMissing() ?? 'paymentTools() not exported')
      const problems = []

      // 1. The three modes are the three modes.
      const modes = sdk()?.AGENT_MODES
      const MODES = ['budgeted', 'sovereign', 'supervised']
      if (!modes || [...modes].sort().join(',') !== MODES.join(',')) {
        problems.push(`AGENT_MODES is [${[...(modes ?? [])].join(', ')}], expected ${MODES.join(', ')}`)
      }
      if (sdk()?.DEFAULT_AGENT_MODE !== 'budgeted') {
        problems.push(`DEFAULT_AGENT_MODE is ${sdk()?.DEFAULT_AGENT_MODE}, not 'budgeted' — the default changed`)
      }

      /*
       * 2. Sovereign APPENDS. Every "8 tools" claim across the repo is true only while the
       * default is untouched and the extra tools come after it, in order.
       */
      const EXTRA = [
        'piprail_quote_swap', 'piprail_swap',
        'piprail_sell', 'piprail_collect', 'piprail_earnings',
        'piprail_wallet',
      ]
      if (sov.slice(0, base.length).join(',') !== base.join(',')) {
        problems.push('sovereign mode no longer APPENDS to the default list — it reorders or replaces it')
      }
      if (sov.slice(base.length).join(',') !== EXTRA.join(',')) {
        problems.push(`sovereign adds [${sov.slice(base.length).join(', ')}], expected [${EXTRA.join(', ')}]`)
      }

      /*
       * 3. Selling is the EARNING half, and it must never leak into the default. A model given
       * a spend cap and a sell tool can commit to deliveries nobody authorised.
       */
      const leaked = base.filter((t) => /sell|collect|earnings|swap/i.test(t))
      if (leaked.length) problems.push(`the DEFAULT list now contains ${leaked.join(', ')} — earning and swapping are sovereign-only`)

      /*
       * 4. Nothing may still promise that swapping will never exist. This is the exact claim
       * that rotted, and prose is where it rots: a count stays right while a sentence goes wrong.
       */
      const FOREVER = /(no swap tool|never be a swap|there will not be one|deliberately withheld from models)/i
      for (const f of ['mcp/README.md', 'docs/src/content/docs/mcp/tools.md'].filter(exists)) {
        const body = read(f)
        if (/there will not be one/i.test(body)) {
          problems.push(`${f} still says swapping "will not" exist — sovereign mode makes that false`)
        }
        if (FOREVER.test(body) && !/sovereign/i.test(body)) {
          problems.push(`${f} explains the swap refusal without ever naming sovereign mode, which lifts it`)
        }
      }

      /*
       * 5. Every mirror that enumerates the agent's surface must name the SELLER tools. An agent
       * only knows it can earn because something told it so: a missing mention here is not a
       * cosmetic gap, it removes the capability in practice.
       */
      const SELLER = ['piprail_sell', 'piprail_collect', 'piprail_earnings', 'piprail_wallet']
      const ENUMERATORS = [
        'sdk/src/agentGuide.ts',
        'mcp/README.md',
        'docs/src/content/docs/mcp/tools.md',
        'docs/src/content/docs/mcp/configuration.md',
        'site/src/pages/mcp.astro',
        'site/public/llms.txt',
        'site/public/llms-full.txt',
      ]
      for (const f of ENUMERATORS.filter(exists)) {
        const missing = SELLER.filter((t) => !read(f).includes(t))
        if (missing.length) problems.push(`${f} never mentions ${missing.join(', ')}`)
      }

      /*
       * 5b. Any WRITTEN sovereign count must equal the real one. `tool-count-claims` scans the
       * phrase "N tools" and so cannot see "(13 in sovereign)", which is exactly how a stale 13
       * survived a tool being added. Scan the sovereign phrasings too.
       */
      const WORDS = { eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 }
      for (const f of ENUMERATORS.filter(exists)) {
        for (const line of read(f).split('\n')) {
          // Past-tense narrative ("had thirteen tools") is history, not a claim about today.
          if (/\b(had|used to|previously|before this|was)\b/i.test(line)) continue
          // Only a number DIRECTLY describing the sovereign count: "14 in sovereign",
          // "14 tools in sovereign". Deliberately narrow, so "8 default tools (14 in
          // sovereign)" reads the 14 and never the 8.
          for (const m of line.matchAll(
            /\b(\d{1,2}|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+(?:tools?\s+)?in\s+sovereign\b/gi
          )) {
            const n = WORDS[m[1].toLowerCase()] ?? Number(m[1])
            if (Number.isFinite(n) && n >= 8 && n !== sov.length) {
              problems.push(`${f} claims ${m[1]} tools in sovereign; there are ${sov.length}`)
            }
          }
        }
      }

      // 6. Each mode NAME must be documented where an operator configures it.
      for (const f of ['docs/src/content/docs/mcp/configuration.md'].filter(exists)) {
        const missing = MODES.filter((m) => !read(f).includes(m))
        if (missing.length) problems.push(`${f} does not document the ${missing.join(', ')} mode(s)`)
      }

      // 7. The banner must be able to report the REAL list, not a hardcoded one.
      if (exists('mcp/src/start.ts') && !/printBanner\(config,/.test(read('mcp/src/start.ts'))) {
        problems.push('mcp/src/start.ts no longer passes the real tool list to the banner — it will under-report sovereign')
      }

      /*
       * 8. 🔴 EVERY MODE MUST KEEP THE PROMISE ITS NAME MAKES.
       *
       * The restrictions were never the weak part: the two non-sovereign modes correctly get
       * eight tools and no way to swap or sell, which checks 2 and 3 above already pin.
       * `'supervised'` was the weak part, and it failed in the quietest possible way: the
       * mode↔confirm inference ran ONE WAY, so `PIPRAIL_CONFIRM=1` meant supervised but naming
       * the mode wired nothing. An operator asking for a human in the loop got an agent that
       * spent without asking anyone, with the banner, the docs and the mode name all agreeing
       * it was supervised. No count was wrong, so nothing could see it.
       *
       * Both halves are guarded here: the MCP must WIRE supervision from the mode, and the SDK
       * must REFUSE to claim supervision it cannot perform.
       */
      if (exists('mcp/src/config.ts')) {
        const cfg = read('mcp/src/config.ts')
        if (!/parsed\.mode === 'supervised'[\s\S]{0,600}parsed\.confirm = true/.test(cfg)) {
          problems.push(
            "mcp/src/config.ts no longer forces confirm for PIPRAIL_MODE=supervised — the mode would " +
              'be a label again, and nothing would ask a human'
          )
        }
      }
      if (exists('sdk/src/client.ts') && !/'supervised' && typeof opts\.onBeforePay !== 'function'/.test(read('sdk/src/client.ts'))) {
        problems.push(
          "sdk/src/client.ts no longer refuses mode:'supervised' without onBeforePay — a client can " +
            'again claim supervision that nothing performs'
        )
      }

      return problems.length
        ? bad(problems.join(' · '))
        : ok(
            `3 modes, each enforced (supervised wires a human · budgeted is policy-only · sovereign +${EXTRA.length}) · ` +
              `${base.length} default tools → ${sov.length} · consistent across ${ENUMERATORS.length} mirrors`
          )
    },
  },
  {
    domain: 'security',
    id: 'contact-addresses-split',
    verify: [
      "npm run sync -- --only contact-addresses-split",
    ],
    what: 'Front-facing surfaces publish the business address, never the personal one',
    source: { file: 'scripts/contacts.mjs', note: '⭐ BUSINESS_CONTACT + the personal-webmail matcher — the only place the split is defined' },
    mirrors: FRONT_FACING.map((f) => ({ file: f.file, note: f.note })),
    check() {
      /*
       * Two addresses, on purpose. The personal one OWNS the accounts (GitHub, Netlify,
       * npm, Google OAuth, git authorship) and must never be published; the piprail.com
       * one is the invitation to make contact and must be the only address a stranger
       * sees. This rule guards ONE direction — a leak of ANY free-webmail address onto
       * a published surface — because that is the direction that is always a mistake.
       * It matches the CLASS, not a literal, so it also catches a different personal
       * address added later, and so this tracked file never republishes the real one.
       * The reverse (an account moved onto the newer mailbox) is a human decision that
       * a grep cannot safely judge, so it is documented in contacts.mjs and not gated.
       */
      const leaked = []
      const missing = []
      for (const f of FRONT_FACING) {
        if (!exists(f.file)) continue
        const body = read(f.file)
        const hit = body.match(personalAddressRe())
        if (hit) leaked.push(`${f.file} (${hit[0]})`)
        else if (f.requires && !body.includes(BUSINESS_CONTACT)) missing.push(f.file)
      }
      if (leaked.length)
        return bad(`personal webmail published on: ${leaked.join(', ')} — use ${BUSINESS_CONTACT}`)
      if (missing.length)
        return bad(`no contact address on: ${missing.join(' ')} — expected ${BUSINESS_CONTACT}`)
      const n = FRONT_FACING.filter((f) => exists(f.file)).length
      return ok(`${n} front-facing surfaces carry ${BUSINESS_CONTACT} only`)
    },
  },
  {
    domain: 'security',
    id: 'secrets-untracked',
    verify: [
      "npm run sync -- --only secrets-untracked",
    ],
    what: 'No secret file is tracked by git, and the secret paths stay ignored',
    source: { file: '.gitignore', note: '⭐ .env and .secrets/ must be ignored' },
    mirrors: [
      { file: '.env', note: 'local config — must never be committed' },
      { file: '.env.local', note: 'same' },
      { file: '.secrets/wallets/*.json', note: 'funded mainnet test wallets — the worst possible leak' },
    ],
    check() {
      const { execFileSync } = require('node:child_process')
      let tracked = []
      try {
        tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n')
      } catch {
        return skip('not a git checkout')
      }
      /*
       * `.env.example` files are SUPPOSED to be tracked — they are the template. Only a real
       * `.env`, anything under `.secrets/`, or a wallet/key JSON is a leak.
       */
      const leaks = tracked.filter((f) =>
        /(^|\/)\.env$/.test(f) || /(^|\/)\.env\.(local|production)$/.test(f) ||
        f.startsWith('.secrets/') || /(^|\/)[\w-]*wallet[\w-]*\.json$/i.test(f))
      const ignore = exists('.gitignore') ? read('.gitignore') : ''
      const unignored = ['.env', '.secrets'].filter(
        (pattern) => exists(pattern) && !new RegExp(`^\\s*/?${pattern.replace('.', '\\.')}/?\\s*$`, 'm').test(ignore),
      )
      const problems = [
        ...leaks.map((f) => `TRACKED SECRET: ${f}`),
        ...unignored.map((f) => `${f} exists but is not in .gitignore`),
      ]
      return problems.length
        ? bad(problems.join('; '))
        : ok(`no secrets tracked; .env + .secrets/ ignored (${tracked.filter((f) => f.endsWith('.env.example')).length} .env.example templates are correctly tracked)`)
    },
  },

  /* ══════════════════════════ TOKEN REGISTRY ══════════════════════════ */
  {
    domain: 'chains',
    id: 'token-registry',
    /*
     * The deeper check is `node .claude/skills/wallet-audit/verify-tokens.mjs`, which reads each
     * token's on-chain `symbol` and `decimals` and compares them to what the SDK ships. It is
     * NOT listed here: `.claude/skills/*` is gitignored, so a `verify` naming it would point at
     * a file a fresh clone does not have, and the clean-clone guard rightly fails that. The map
     * only ever points at commands anyone holding this repo can actually run.
     */
    verify: [
      "npm run sync -- --only token-registry",
      "npm run test:sdk",
    ],
    what: 'Every built-in EVM token is a checksummed address with a matching symbol and sane decimals',
    source: { file: 'sdk/src/drivers/evm/chains.ts', note: '⭐ CHAINS[...].tokens — every address verified on-chain before shipping' },
    mirrors: [{ file: 'site/public/tokens/<sym>.svg', note: 'the badge the site renders (covered by site-chain-assets)' }],
    check() {
      const s = sdk()
      if (!s?.CHAINS) return skip(sdkMissing())
      let getAddress
      try { ({ getAddress } = require('viem')) } catch { return skip('viem not resolvable') }
      const problems = []
      let n = 0
      for (const [slug, preset] of Object.entries(s.CHAINS)) {
        for (const [sym, t] of Object.entries(preset.tokens ?? {})) {
          n++
          // A non-checksummed address still works, but it breaks string equality against
          // anything read back from a chain or an explorer — including our own verify path.
          try {
            if (getAddress(t.address) !== t.address) problems.push(`${slug}/${sym}: not EIP-55 checksummed`)
          } catch {
            problems.push(`${slug}/${sym}: invalid address ${t.address}`)
          }
          if (t.symbol !== sym) problems.push(`${slug}/${sym}: key does not match symbol "${t.symbol}"`)
          if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
            problems.push(`${slug}/${sym}: implausible decimals ${t.decimals}`)
          }
        }
      }
      /*
       * Deliberately OFFLINE. On-chain confirmation (does this address exist, with this symbol
       * and these decimals?) is the add-chain-integration skill's job at authoring time; making
       * `npm run sync` hit ~20 RPCs would make it slow and flaky, and a rate-limited node would
       * report a false failure about a token that is perfectly fine.
       */
      return problems.length ? bad(problems.join('; ')) : ok(`${n} EVM token entries — checksummed, symbol-matched, sane decimals`)
    },
  },

  /* ══════════════════════════════ SEO ══════════════════════════════ */
  {
    domain: 'seo',
    id: 'indexnow-key',
    verify: [
      "npm run sync -- --only indexnow-key",
    ],
    what: 'The IndexNow key file is named exactly as its own contents (both hosts)',
    source: { file: 'the key itself', note: 'issued once, shared by both hosts' },
    mirrors: [
      { file: 'site/public/<key>.txt', note: 'served at piprail.com/<key>.txt' },
      { file: 'docs/public/<key>.txt', note: 'served at docs.piprail.com/<key>.txt' },
    ],
    check() {
      const problems = []
      const found = []
      for (const host of ['site', 'docs']) {
        /*
         * An IndexNow key is a 32-char hex filename. Matching "any .txt that isn't robots or
         * llms" also swept up security.txt — identify the key by its SHAPE instead of by
         * excluding everything it is not.
         */
        const keys = walk(`${host}/public`, ['.txt']).filter((f) => /\/[0-9a-f]{32}\.txt$/.test(f))
        if (!keys.length) { problems.push(`${host}: no IndexNow key file`); continue }
        for (const f of keys) {
          const name = f.split('/').pop().replace('.txt', '')
          const body = read(f).trim()
          // The spec is literal: the file must be named <key>.txt AND contain <key>. A mismatch
          // makes every submission fail verification silently — nothing errors on our side.
          if (name !== body) problems.push(`${host}: ${name}.txt contains "${body.slice(0, 24)}"`)
          else found.push(`${host}:${name.slice(0, 8)}…`)
        }
      }
      return problems.length ? bad(problems.join('; ')) : ok(`key verified on both hosts (${found.join(' ')})`)
    },
  },

  {
    domain: 'seo',
    id: 'robots-sitemaps',
    verify: [
      "npm run build",
    ],
    what: 'Every Sitemap: line in robots.txt points at a sitemap that is actually built',
    source: { file: 'site/dist', note: 'the sitemaps @astrojs/sitemap emits (both hosts)' },
    mirrors: [
      { file: 'site/public/robots.txt', note: 'declares BOTH hosts’ sitemaps' },
      { file: 'docs/public/robots.txt', note: 'cross-declares the apex sitemap too' },
    ],
    check() {
      if (!exists('site/dist') || !exists('docs/dist')) return skip('both sites must be built')
      const problems = []
      let n = 0
      for (const host of ['site', 'docs']) {
        const robots = `${host}/public/robots.txt`
        if (!exists(robots)) { problems.push(`${host}: no robots.txt`); continue }
        for (const line of read(robots).split('\n').filter((l) => /^sitemap:/i.test(l))) {
          const url = line.slice(line.indexOf(':') + 1).trim()
          let u
          try { u = new URL(url) } catch { problems.push(`${host}: unparseable "${url}"`); continue }
          n++
          // Resolve against the host the URL names, not the host that declared it — robots.txt
          // cross-declares the other property, so checking locally would silently pass.
          const dist = u.host.startsWith('docs.') ? 'docs/dist' : 'site/dist'
          if (!exists(dist + u.pathname)) problems.push(`${host}/robots.txt → ${url} (not built at ${dist}${u.pathname})`)
        }
      }
      return problems.length ? bad(problems.join('; ')) : ok(`${n} sitemap declarations across 2 hosts, all resolve`)
    },
  },

  /* ══════════════════════ SCHEMES ══════════════════════ */
  {
    domain: 'api',
    id: 'schemes-documented',
    verify: [
      "npx vitest run test/conformance.test.ts",
    ],
    what: 'Every payment scheme the wire layer knows is documented',
    source: { file: 'sdk/src/x402.ts', note: '⭐ the scheme literals the envelope accepts' },
    mirrors: [{ file: 'docs/src/content/docs/**', note: 'a scheme nobody documents is a scheme nobody uses' }],
    check() {
      const x = read('sdk/src/x402.ts')
      const schemes = [...new Set([...x.matchAll(/'(onchain-proof|exact|upto)'/g)].map((m) => m[1]))]
      if (!schemes.length) return skip('no scheme literals found')
      const docs = walk('docs/src/content/docs', ['.md', '.mdx']).map(read).join('\n')
      const missing = schemes.filter((s) => !docs.includes(s))
      return missing.length
        ? bad(`undocumented scheme(s): ${missing.join(', ')}`)
        : ok(`${schemes.length} schemes documented (${schemes.join(', ')})`)
    },
  },

  /* ════════════════ SDK → DOCS PROPAGATION (the big one) ════════════════ */
  {
    domain: 'api',
    id: 'exports-documented',
    verify: [
      "npm run typecheck",
      "npm run build:sdk",
    ],
    what: 'Every public SDK export is mentioned somewhere in the docs',
    source: { file: 'sdk/dist/index.cjs', note: '⭐ the 152 runtime values a user can import' },
    mirrors: [{ file: 'docs/src/content/docs/**', note: 'ship a new export without documenting it and nobody can find it' }],
    check() {
      const s = sdk()
      if (!s) return skip(sdkMissing())
      const exportsList = Object.keys(s)
      const docs = walk('docs/src/content/docs', ['.md', '.mdx']).map(read).join('\n')
      const undocumented = exportsList.filter((v) => !docs.includes(v))
      /*
       * This is the SDK → docs propagation the whole map exists for: adding a public export is
       * the single most common change, and forgetting the docs page is the single most common
       * omission. Runtime VALUES only — a type that only appears in a signature does not need
       * its own prose, and `sdk-imports-in-samples` already proves the samples' types resolve.
       */
      return undocumented.length
        ? bad(`${undocumented.length} export(s) documented nowhere: ${undocumented.join(', ')}`)
        : ok(`all ${exportsList.length} public exports appear in the docs`)
    },
  },

  {
    domain: 'mcp',
    id: 'tool-count-claims',
    verify: [
      "npm run test:mcp",
    ],
    what: 'Every written "N tools" claim matches the real tool count',
    source: { file: 'sdk/src/agent.ts → paymentTools()', note: '⭐ the count is derived, never typed' },
    mirrors: [
      { file: 'integrations/**', note: 'READMEs, SKILL.md files, TESTING.md, manifests' },
      { file: 'docs/…/integrations/**', note: 'the per-integration pages' },
      { file: 'site/public/llms.txt', note: 'the AEO summary' },
      { file: 'site/public/llms-full.txt', note: 'the long AEO file' },
      { file: 'mcp/README.md', note: 'the MCP readme' },
      { file: 'README.md', note: 'the repo readme' },
    ],
    check() {
      const tools = mcpTools()
      if (!tools) return skip(sdkMissing() ?? 'paymentTools() not exported')
      const n = tools.length
      const WORDS = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
      const files = [
        ...walk('integrations', ['.md', '.yaml', '.json']),
        ...walk('docs/src/content/docs/integrations', ['.md', '.mdx']),
        ...['site/src/data/integrations.ts', 'site/public/llms.txt', 'site/public/llms-full.txt', 'mcp/README.md', 'README.md'].filter(exists),
      ]
      const problems = []
      let claims = 0
      for (const f of files) {
        for (const line of read(f).split('\n')) {
          /*
           * The qualifier is often wrapped in markdown, and backticks are not whitespace: the
           * literal text is ``8 `piprail_*` tools``. Without allowing them, `integrations/TESTING.md`
           * claiming "the 7 `piprail_*` tools" walked straight past this rule, in the same file
           * that says "same 8 tools" four lines earlier.
           */
          for (const m of line.matchAll(/\b(\d+|five|six|seven|eight|nine|ten)\s+(?:[`*_]*(?:piprail_\*|PipRail)[`*_]*\s+)?tools\b/gi)) {
            /*
             * SUBSET claims are legitimate and must not be flagged. openclaw's SKILL.md says
             * "Six tools — discover, quote, register, budget, guide, verify_receipt — work with
             * no key at all", which is true: six of the eight are keyless. A claim that names
             * specific tools, or qualifies itself with keyless/no-key/of-the, is about a subset.
             */
            const subset = /no key|keyless|without a key|subset|of the (?:eight|\d+)/i.test(line) ||
              (line.match(/`?piprail_\w+/g) ?? []).length >= 3 ||
              (line.match(/`\w+`/g) ?? []).length >= 3
            if (subset) continue
            claims++
            const value = WORDS[m[1].toLowerCase()] ?? Number(m[1])
            if (value !== n) problems.push(`${f}: "${m[0]}" — want ${n}`)
          }
        }
      }
      return problems.length
        ? bad(`${problems.length} stale claim(s): ${problems.join('; ')}`)
        : ok(`${claims} "N tools" claims across ${files.length} files, all say ${n}`)
    },
  },

  /* ══════════════════════ COMMANDS THE DOCS TELL YOU TO RUN ══════════════════════ */
  {
    domain: 'docs',
    id: 'npm-scripts-referenced',
    verify: [
      "npm run sync -- --only npm-scripts-referenced",
    ],
    what: 'Every `npm run X` the docs and skills tell you to run is a real script',
    source: { file: 'package.json', note: '⭐ root scripts — plus every workspace and nested package.json' },
    mirrors: [
      { file: 'README.md', note: 'quickstart commands' },
      { file: 'CLAUDE.md', note: 'the START-HERE block + conventions' },
      { file: 'AGENTS.md', note: 'agent-facing commands' },
      { file: 'RELEASING.md', note: 'the release checklist' },
      { file: 'CONTRIBUTING.md', note: 'contributor setup' },
      { file: '.claude/skills/**', note: 'every playbook that hands you a command to paste' },
    ],
    check() {
      const scripts = new Set()
      // Root + workspaces + any nested package.json a skill might legitimately reference
      // (the pitch deck under .claude/skills/branding has its own `assets`/`build`/`all`).
      const manifests = [
        'package.json',
        ...['sdk', 'mcp', 'site', 'docs', 'create-piprail'].map((w) => `${w}/package.json`),
        ...lsDirs('integrations').map((d) => `integrations/${d}/piprail/package.json`),
        ...walk('.claude/skills', ['package.json']),
      ].filter(exists)
      for (const m of manifests) for (const k of Object.keys(readJson(m).scripts ?? {})) scripts.add(k)

      const files = [
        ...['README.md', 'CLAUDE.md', 'AGENTS.md', 'RELEASING.md', 'CONTRIBUTING.md'].filter(exists),
        ...walk('.claude/skills', ['.md']),
      ]
      const missing = new Map()
      let refs = 0
      for (const f of files) {
        for (const m of read(f).matchAll(/npm run ([a-zA-Z:_-]+)/g)) {
          refs++
          if (!scripts.has(m[1])) {
            if (!missing.has(m[1])) missing.set(m[1], new Set())
            missing.get(m[1]).add(f)
          }
        }
      }
      /*
       * This caught RELEASING.md instructing "never skip `npm run verify-gate`" — a script that
       * did not exist, so following the release doc literally produced `npm error Missing
       * script`. The fix was to make the script real (scripts/verify-gate.mjs), not to soften
       * the doc.
       */
      return missing.size
        ? bad(`${missing.size} command(s) that do not exist: ${[...missing].map(([k, v]) => `npm run ${k} (${[...v][0]})`).join('; ')}`)
        : ok(`${refs} \`npm run\` references across ${files.length} files, all real (${scripts.size} scripts)`)
    },
  },

  {
    domain: 'docs',
    id: 'stubs-stay-stubs',
    verify: [
      "npm run sync -- --only stubs-stay-stubs",
    ],
    what: 'Files deliberately reduced to pointers have not regrown a table that will rot',
    source: { file: 'docs.piprail.com', note: '⭐ the canonical reference these files defer to' },
    mirrors: [
      { file: 'sdk/CHAINS.md', note: 'a STUB pointing at docs/chains — must not regrow a chain table' },
      { file: 'sdk/DISCOVERY.md', note: 'a pointer + the live-integration log' },
    ],
    check() {
      const problems = []
      /*
       * These were deliberately gutted: a chain table in sdk/CHAINS.md duplicated
       * docs/chains and went stale on every new chain. If one regrows, the duplication —
       * and the rot — comes straight back. A cheap proxy for "it regrew": length, plus a
       * markdown table of chain rows.
       */
      const limits = [
        ['sdk/CHAINS.md', 3000, /\|\s*(Ethereum|Base|Polygon)\s*\|/],
        ['sdk/DISCOVERY.md', 20000, null],
      ]
      for (const [f, maxBytes, tableRe] of limits) {
        if (!exists(f)) continue
        const txt = read(f)
        if (txt.length > maxBytes) problems.push(`${f}: ${txt.length}b (>${maxBytes}) — has it regrown?`)
        if (tableRe && tableRe.test(txt)) problems.push(`${f}: contains a chain table — that belongs in docs/chains only`)
        if (!/docs\.piprail\.com|\/chains\/|\/discovery\//.test(txt)) problems.push(`${f}: no longer points at the canonical docs`)
      }
      return problems.length ? bad(problems.join('; ')) : ok('stub files still point at the docs instead of duplicating them')
    },
  },

  {
    domain: 'docs',
    id: 'standards-gate-real',
    verify: [
      "npm run verify-gate",
    ],
    what: 'Every command in the STANDARDS.md verification gate actually exists',
    source: { file: 'package.json', note: 'the scripts that exist' },
    mirrors: [
      { file: 'sdk/STANDARDS.md', note: '§6 — the gate that must be green before "done"' },
      { file: '.claude/skills/verify-gate/SKILL.md', note: 'the same gate as a playbook' },
      { file: 'scripts/verify-gate.mjs', note: 'the gate as ONE runnable command' },
    ],
    check() {
      if (!exists('sdk/STANDARDS.md')) return skip('no STANDARDS.md')
      const scripts = new Set(Object.keys(readJson('package.json').scripts ?? {}))
      for (const w of ['sdk', 'mcp', 'site']) {
        if (exists(`${w}/package.json`)) for (const k of Object.keys(readJson(`${w}/package.json`).scripts ?? {})) scripts.add(k)
      }
      const txt = read('sdk/STANDARDS.md')
      const cmds = [...new Set([...txt.matchAll(/npm run ([a-zA-Z:_-]+)/g)].map((m) => m[1]))]
      const missing = cmds.filter((c) => !scripts.has(c))
      const hasRunner = exists('scripts/verify-gate.mjs')
      const problems = [
        ...missing.map((c) => `STANDARDS.md §6 names \`npm run ${c}\`, which does not exist`),
        ...(hasRunner ? [] : ['scripts/verify-gate.mjs is missing — the gate is copy-paste-only again']),
      ]
      return problems.length ? bad(problems.join('; ')) : ok(`${cmds.length} gate commands exist, and the one-shot runner is present`)
    },
  },

  /* ══════════════════════ THE CHECKER CHECKS ITSELF ══════════════════════ */
  {
    domain: 'docs',
    id: 'architecture-map-resolves',
    verify: [
      "npm run sync -- --only architecture-map-resolves",
      "npm run map",
    ],
    what: 'The architecture half of the map actually resolves — imports, prose links and the anchors',
    source: { file: 'scripts/sync/graph.mjs', note: '⭐ the import graph, derived from real source' },
    mirrors: [
      { file: 'scripts/sync/links.mjs', note: 'code → prose links, derived from exported symbols' },
      { file: '.claude/SURFACES.md', note: 'the architecture section describes both' },
    ],
    check() {
      /*
       * ── A MAP THAT RESOLVES NOTHING LOOKS EXACTLY LIKE A CLEAN CODEBASE ────────────
       *
       * The import graph resolves specifiers by hand, and the SDK is ESM TypeScript: `./chains.js`
       * in the source is `./chains.ts` on disk. Get that wrong and every edge silently vanishes.
       * The failure is not an error — it is `--touched` cheerfully reporting "imported by: none"
       * for a module fifty files depend on, which is worse than having no map, because it looks
       * like an answer.
       *
       * So assert the graph is ALIVE: a plausible size, a high resolution rate, and a few links
       * that must exist by construction. Same reasoning as `rules-are-well-formed`: a guard that
       * cannot fail is not a guard, and neither is a map that cannot be wrong.
       */
      const problems = []
      let graph
      try {
        graph = moduleGraph()
      } catch (err) {
        return bad(`the module graph threw: ${err.message}`)
      }
      const edges = [...graph.imports.values()].reduce((n, s) => n + s.size, 0)
      if (graph.files.length < 150) problems.push(`only ${graph.files.length} modules parsed — the walk is not reaching the source`)
      if (edges < 400) problems.push(`only ${edges} import edges — specifier resolution has degraded`)

      /*
       * Links that must hold as long as PipRail is PipRail. Each one is a different resolution
       * path: a `.js`-suffixed relative import, a workspace package name, and a driver reaching
       * the contract that makes the driver abstraction real.
       */
      const MUST = [
        ['sdk/src/client.ts', 'sdk/src/drivers/types.ts', 'the client depends on the driver contract'],
        ['sdk/src/drivers/evm/index.ts', 'sdk/src/drivers/types.ts', 'every driver implements the contract'],
        ['mcp/src/server.ts', 'sdk/src/index.ts', 'the MCP wraps the SDK'],
      ]
      for (const [from, to, why] of MUST) {
        if (!graph.imports.get(from)?.has(to)) {
          problems.push(`${from} → ${to} is missing from the graph (${why}) — resolution is broken`)
        }
      }

      /*
       * The prose layer is the half that finds code→docs drift, and BOTH directions must work.
       * Symbol matching dying is silent in the same way resolution dying is: you get an empty
       * list, which reads as "nothing to check here".
       */
      const prose = documentedIn('sdk/src/server.ts')
      if (prose.length < 3) problems.push(`sdk/src/server.ts resolves to only ${prose.length} prose surfaces — symbol matching has broken`)
      const about = describes('docs/src/content/docs/spend-controls/payment-policy.md')
      if (!about.some((a) => a.file === 'sdk/src/policy.ts')) {
        problems.push('the spend-controls page no longer resolves to sdk/src/policy.ts — the prose→code index has broken')
      }

      // Every declared anchor must point at a file that exists, or it is a stale note.
      for (const a of ANCHORS) {
        if (!exists(a.file)) problems.push(`anchor names a missing file: ${a.file}`)
        for (const surf of a.surfaces) {
          if (!exists(surf) && !surf.endsWith('/')) problems.push(`anchor ${a.file} names a missing surface: ${surf}`)
        }
      }

      return problems.length
        ? bad(problems.join(' · '))
        : ok(`${graph.files.length} modules · ${edges} import edges · ${ANCHORS.length} declared anchors`)
    },
  },
  {
    domain: 'site',
    id: 'lab-covers-sdk',
    verify: [
      "npm run lab:coverage",
    ],
    what: 'The /demo lab exercises every public SDK symbol, or names the reason it cannot',
    source: { file: 'sdk/dist/index.js', note: '⭐ the BUILT package the lab actually loads' },
    mirrors: [
      { file: 'site/src/lib/lab/manifest.ts', note: 'each test declares the symbols it calls, plus the deliberate gaps' },
      { file: 'site/public/lab/runners.js', note: 'one runner per test id, both directions' },
    ],
    check() {
      if (sdkMissing()) return skip('SDK not built — run `npm run build:sdk`')
      try {
        const out = execFileSync('node', [join(REPO, 'scripts/lab-coverage.mjs')], { cwd: REPO, encoding: 'utf8' })
        const m = /lab coverage: (\d+)\/(\d+) \(([\d.]+)%\)/.exec(out)
        const tests = /(\d+) tests/.exec(out)?.[1] ?? '?'
        return m
          ? ok(`${m[1]}/${m[2]} public symbols on the bench (${m[3]}%) across ${tests} tests`)
          : ok(out.trim().split('\n')[0])
      } catch (e) {
        const said = (String(e.stdout ?? '') + String(e.stderr ?? '')).trim()
        const first = said.split('\n').find((l) => l.includes('✗'))?.replace(/^\s*✗\s*/, '')
        return bad(first ?? `npm run lab:coverage failed: ${said.split('\n').slice(-2).join(' ')}`)
      }
    },
  },

  {
    domain: 'docs',
    id: 'map-covers-pages',
    verify: [
      "npm run sync -- --only map-covers-pages",
    ],
    what: 'Every public page is ON the map — named by a rule or the contact registry, never floating',
    source: { file: 'site/src/pages/', note: '⭐ the pages a stranger can actually open' },
    mirrors: [
      { file: 'scripts/sync/rules.mjs', note: 'each page named as the source or a mirror of the fact it renders' },
      { file: 'scripts/contacts.mjs', note: 'FRONT_FACING — pages that carry a contact address' },
    ],
    check() {
      /*
       * ── WHY A PAGE MUST BE ON THE MAP ──────────────────────────────────────────────
       *
       * The map's promise is that `--touched <file>` tells you what else must change and what
       * to run. A page nobody mapped breaks that promise silently: the query answers "no rule
       * references this path", which reads like "nothing else to do" and is usually wrong.
       *
       * It was wrong for six of ten pages. /facilitators renders the facilitator registry and
       * /mcp restates the tool list, yet neither was linked to the fact it displays, so editing
       * either told you nothing. /mcp and /demo then advertised 29 chains for as long as nobody
       * happened to look, because no rule had them in scope.
       *
       * A page is "mapped" when a rule names it (as a source or a mirror) or the contact
       * registry does. That is a low bar on purpose: the point is that somebody consciously
       * answered "what fact does this page restate?" rather than leaving it floating.
       */
      const dir = 'site/src/pages'
      const pages = exists(dir)
        ? readdirSync(join(REPO, dir)).filter((f) => f.endsWith('.astro')).filter((f) => exists(`${dir}/${f}`))
        : []
      if (!pages.length) return skip('no pages found (clean-clone or a moved directory)')

      const named = new Set([
        ...RULES.flatMap((r) => [r.source.file, ...r.mirrors.map((m) => m.file)]),
        ...FRONT_FACING.map((f) => f.file),
      ])
      const refs = [...named].join(' | ')
      const floating = pages.filter((f) => !refs.includes(`${dir}/${f}`))

      return floating.length
        ? bad(
            `not on the map: ${floating.map((f) => `${dir}/${f}`).join(', ')} — add each one as a mirror of ` +
              'the fact it renders in scripts/sync/rules.mjs (or to FRONT_FACING if it carries a contact address)'
          )
        : ok(`${pages.length} public pages, every one named by a rule or the contact registry`)
    },
  },
  {
    domain: 'docs',
    id: 'rules-are-well-formed',
    verify: [
      "npm run sync -- --only rules-are-well-formed",
    ],
    what: 'Every rule can actually fail, has a source and mirrors, and a unique id',
    source: { file: 'scripts/sync/rules.mjs', note: '⭐ the rules themselves' },
    mirrors: [{ file: '.claude/SURFACES.md', note: 'the human map they generate' }],
    check() {
      /*
       * A guard that cannot fail is worse than no guard — it reads as coverage while providing
       * none. Three of the rules in this file went through a draft that passed on every input
       * (an `.ok` field that is always undefined; a file walker that quietly returned []), so
       * this asserts the shape that makes such a draft impossible to leave in.
       */
      const src = read('scripts/sync/rules.mjs')
      const WARN_ONLY = ['changelog-unreleased'] // deliberately advisory; uses warn(), never bad()
      const scripts = new Set(Object.keys(readJson('package.json').scripts ?? {}))
      const problems = []
      const ids = RULES.map((r) => r.id)

      for (const r of RULES) {
        const at = src.indexOf(`id: '${r.id}'`)
        const from = src.indexOf('check()', at)
        const body = from < 0 ? '' : src.slice(from, src.indexOf('\n  },', from))
        if (!/\bbad\(/.test(body) && !WARN_ONLY.includes(r.id)) {
          problems.push(`${r.id}: no bad() path — it can never fail`)
        }
        if (!r.source?.file) problems.push(`${r.id}: no source`)
        if (!r.mirrors?.length) problems.push(`${r.id}: no mirrors — nothing to propagate to`)
        // A `·`-joined location string reads fine in --graph but makes --touched blind to every
        // file after the first, because the matcher works one path at a time.
        for (const loc of [r.source?.file, ...(r.mirrors ?? []).map((m) => m.file)]) {
          if (loc?.includes('·')) problems.push(`${r.id}: "${loc}" packs several paths into one entry — split them, or --touched cannot match them`)
        }

        /*
         * ── EVERY RULE MUST SAY WHAT TO RUN ────────────────────────────────────────
         *
         * The map answers "where else does this fact live?". Without `verify` it stops
         * there, and the person who just edited a mirror is left to guess which test proves
         * it. So a rule declares its commands, and they must be REAL: a map pointing at a
         * script nobody wrote is not a map. RELEASING.md told people for weeks to "never
         * skip `npm run verify-gate`" while that script did not exist, and following the
         * instruction literally produced `npm error Missing script`.
         */
        if (!r.verify?.length) {
          problems.push(`${r.id}: no verify — say what to RUN to prove this fact still holds`)
        }
        for (const cmd of r.verify ?? []) {
          const script = cmd.match(/^npm run ([\w:-]+)/)?.[1]
          if (script && !scripts.has(script)) {
            problems.push(`${r.id}: verify runs "npm run ${script}", which is not in package.json`)
          }
          const file = cmd.match(/(?:vitest run|node(?: --test)?) ([\w./-]+)/)?.[1]
          if (file) {
            /*
             * vitest paths are relative to the workspace root that owns the test. `exists()` is
             * clean-clone aware, so this ALSO rejects a command pointing at a gitignored file:
             * a verification a fresh clone cannot run is not a verification. (Caught exactly
             * that on the first pass, where token-registry named a tool under `.claude/skills/`.)
             */
            const candidates = [file, `sdk/${file}`, `mcp/${file}`]
            if (!candidates.some(exists)) {
              problems.push(`${r.id}: verify runs "${cmd}", but ${file} is not a file this repo ships`)
            }
          }
        }
      }
      const dupes = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))]
      problems.push(...dupes.map((d) => `duplicate rule id: ${d}`))

      return problems.length
        ? bad(problems.join('; '))
        : ok(
            `${RULES.length} rules — all can fail, all declare source + mirrors + verify, ` +
              `${new Set(RULES.flatMap((r) => r.verify)).size} distinct verify commands all exist, ids unique`
          )
    },
  },
  /*
   * ── THE GITIGNORED-CONSUMER GAP ──────────────────────────────────────────────────
   * Every other rule here guards a TRACKED file against a TRACKED source. `.claude/` is
   * gitignored, so a skill that hard-codes a tracked path is invisible to BOTH git-based
   * review and every rule above it — a refactor "updates all refs", the diff looks complete,
   * and the skill silently rots.
   *
   * That is not hypothetical. Commit 8451271 moved the sandboxes to `examples/basics/`; the
   * `sdk-audit` skill kept pointing at `examples/sdk-sandbox/` and was DEAD for ~10 weeks —
   * the one tool whose whole job is "prove the SDK works" could not start. Found 2026-08-28
   * by running it, which is exactly the accident this rule removes the need for.
   */
  {
    domain: 'docs',
    id: 'prose-gate-wired',
    verify: [
      "npm run prose",
    ],
    what: 'The no-slop gate exists, runs in verify-gate, and the house-voice doc points at the real script',
    source: {
      file: 'scripts/prose-audit.mjs',
      note: 'the gate itself — the only thing that can actually fail a build on an em dash',
    },
    mirrors: [
      { file: 'package.json', note: 'exposes it as `npm run prose`' },
      { file: 'scripts/verify-gate.mjs', note: 'runs it in the release gate, so a regression fails the build' },
      { file: '.claude/skills/humanizer/PIPRAIL.md', note: 'the house voice tells a writer the gate exists' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * The standing rule is that every page written for the site or the docs goes through the
       * humanizer skill. Guidance nobody can measure rots: the docs carried 3,320 em dashes
       * before the 2026-09-06 sweep, every one added by somebody who had, in principle, read the
       * guidance. `npm run prose` is what makes it real, and it is only real while it is WIRED —
       * a gate that has quietly fallen out of `verify-gate.mjs` is worse than no gate, because
       * PIPRAIL.md keeps promising a red build that can no longer happen.
       *
       * So this guards the wiring, not the prose. The prose is the gate's own job.
       *
       * PIPRAIL.md lives under the gitignored `.claude/`, so it is ABSENT in a clean clone
       * (CI, and the Netlify build that runs this checker as the site's prebuild). Its half of
       * the check therefore degrades to a note rather than a failure, exactly like the other
       * `.claude/`-dependent rules.
       */
      const problems = []
      if (!exists('scripts/prose-audit.mjs')) problems.push('scripts/prose-audit.mjs is missing')
      if (!/"prose":\s*"node scripts\/prose-audit\.mjs"/.test(read('package.json')))
        problems.push('package.json has no `prose` script pointing at scripts/prose-audit.mjs')
      if (!/\['prose', 'npm', \['run', 'prose'\]/.test(read('scripts/verify-gate.mjs')))
        problems.push('scripts/verify-gate.mjs does not run `npm run prose`')

      const voice = '.claude/skills/humanizer/PIPRAIL.md'
      let note = 'PIPRAIL.md absent (clean clone)'
      if (exists(voice)) {
        note = 'PIPRAIL.md names the gate'
        if (!read(voice).includes('scripts/prose-audit.mjs'))
          problems.push(`${voice} does not point at scripts/prose-audit.mjs`)
      }

      return problems.length
        ? bad(problems.join(' · '))
        : ok(`gate wired: npm run prose → verify-gate · ${note}`)
    },
  },
  {
    domain: 'skills',
    id: 'skill-paths-resolve',
    verify: [
      "npm run sync -- --only skill-paths-resolve",
    ],
    what: 'Every repo path a skill imports or cites still exists (skills are gitignored — no refactor updates them)',
    source: { file: 'the repo tree', note: '⭐ the real files — moving one silently orphans its gitignored callers' },
    mirrors: [
      { file: '.claude/skills/**/*.mjs', note: 'relative imports that reach OUT of .claude into the repo' },
      { file: '.claude/skills/**/*.md', note: 'playbook paths a human is told to run or open' },
    ],
    check() {
      const files = [...walk('.claude/skills', ['.mjs']), ...walk('.claude/skills', ['.md'])]
      if (!files.length) return skip('.claude/skills not present')

      // Only top-level dirs that are real, tracked product surfaces. Anything else in a code
      // fence is prose, a URL, or a path inside .claude itself — not this rule's business.
      const ROOTS = '(?:sdk|mcp|site|docs|examples|integrations|create-piprail|scripts)'
      const bad_ = new Map()
      let refs = 0
      const flag = (target, f) => {
        if (!bad_.has(target)) bad_.set(target, new Set())
        bad_.get(target).add(f)
      }

      for (const f of files) {
        const src = read(f)
        const dir = f.slice(0, f.lastIndexOf('/'))

        if (f.endsWith('.mjs')) {
          // A relative specifier that climbs out of .claude/ and into the repo proper.
          for (const m of src.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]|import\(\s*['"](\.\.\/[^'"]+)['"]/g)) {
            const spec = m[1] ?? m[2]
            if (!spec.includes('../../')) continue
            // Resolve the relative path by hand (no fs.realpath — this must stay pure).
            const parts = `${dir}/${spec}`.split('/')
            const out = []
            for (const seg of parts) {
              if (seg === '.' || seg === '') continue
              if (seg === '..') out.pop()
              else out.push(seg)
            }
            const target = out.join('/')
            if (!new RegExp(`^${ROOTS}/`).test(target)) continue
            // `sdk/dist` + `mcp/dist` only exist after a build — absence there is "not built",
            // not "wrong path", and the build-dependent rules already report that.
            if (/^(sdk|mcp)\/dist\//.test(target)) continue
            refs++
            if (!exists(target)) flag(target, f)
          }

          // ── and repo paths built by INTERPOLATION or held in a plain string ──
          // `sh('…', `${ROOT}examples/basics/sdk-sandbox/run-all.mjs`)` is neither an import nor
          // markdown, so the scan above misses it entirely. That is precisely the form the dead
          // sdk-audit stages used — the first version of this rule scored 133/133 "all resolve"
          // against the very bug it was written for. Match a repo path that follows a template
          // interpolation `}` or an opening quote.
          const CODE_PATH = new RegExp('[}\'"`](' + ROOTS + '/[A-Za-z0-9._/-]+\\.[a-z]{2,5})', 'g')
          for (const m of src.matchAll(CODE_PATH)) {
            const target = m[1]
            if (target.includes('..')) continue
            if (/^(sdk|mcp)\/dist\//.test(target)) continue
            refs++
            if (!exists(target)) flag(target, f)
          }

          /*
           * ── and repo paths ASSEMBLED SEGMENT BY SEGMENT WITH join() ──
           *
           * 🔴 THIS FORM SHIPPED A BROKEN PATH PAST BOTH SCANS ABOVE.
           *
           * `execFileSync('node', [join(ROOT, 'scripts', 'mail-check.mjs')])` names a
           * sister project's file that does not exist here. It is not an import and it
           * is not one string, so neither earlier scan could see it, and the rule
           * reported "170 references, all resolve" while every send died on a raw
           * MODULE_NOT_FOUND. A path split across arguments is still a path.
           *
           * `.claude` is allowed as a root here, unlike the scans above: a join() chain
           * is unambiguously a filesystem path, so there is no prose to mistake it for.
           */
          const JOIN_ROOTS = new RegExp('^(?:' + ROOTS.slice(4, -1) + '|\\.claude)/')
          for (const m of src.matchAll(/\bjoin\(([^)]*)\)/g)) {
            const segs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
            if (!segs.length) continue
            if (segs.some((x) => x === '..' || x.includes('..'))) continue
            const target = segs.join('/').replace(/\/+/g, '/')
            if (!JOIN_ROOTS.test(target)) continue
            if (!/\.[a-z]{2,5}$/.test(target)) continue
            if (/^(sdk|mcp)\/dist\//.test(target)) continue
            refs++
            if (!exists(target)) flag(target, f)
          }
        } else {
          // Markdown: only `backticked/paths/like-this.mjs` — an inline code span with a slash
          // and a file extension. Prose, bare words and URLs can't match, which keeps this
          // rule quiet enough to be trusted.
          const MD_PATH = new RegExp('`(' + ROOTS + '/[A-Za-z0-9._/-]+\\.[a-z]{2,5})`', 'g')
          for (const m of src.matchAll(MD_PATH)) {
            const target = m[1]
            // Prose elision, not a path: skills write `docs/.../chains/overview.md` to keep a
            // long path readable. The dots are legal in the char class, so this must be dropped
            // explicitly — it was this rule's only false positive on first run.
            if (target.includes('..')) continue
            if (/^(sdk|mcp)\/dist\//.test(target)) continue
            refs++
            if (!exists(target)) flag(target, f)
          }
        }
      }

      return bad_.size
        ? bad(
            `${bad_.size} path(s) referenced by a skill no longer exist: ` +
              [...bad_].map(([t, fs]) => `${t} (in ${[...fs].join(', ')})`).join('; ')
          )
        : ok(`${refs} skill→repo path references, all resolve`)
    },
  },
  /*
   * ── ONE PLACE FOR CREDENTIALS ────────────────────────────────────────────────────
   * PipRail's operational secrets used to sit in three stores (`.env`,
   * `.secrets/live-matrix.env`, `.secrets/x-api.env`) behind five hand-rolled parsers that
   * disagreed — one stripped surrounding quotes, another didn't, which is how
   * RPC_TON='https://…' reached the SDK quotes-and-all and produced `TypeError: Invalid URL`.
   * Now: one file (`.env`), one parser (`scripts/load-env.mjs`), one map (`.env.example`).
   * This rule keeps the map honest and keeps real values out of git.
   */
  {
    domain: 'security',
    id: 'env-example-documents-secrets',
    verify: [
      "node --test scripts/load-env.test.mjs",
    ],
    what: 'Every operational credential is documented in .env.example, with no real value committed',
    source: { file: 'scripts/load-env.mjs', note: '⭐ the one loader — plus what the ops tooling actually reads' },
    mirrors: [
      { file: '.env.example', note: 'the tracked map: every var, its purpose, where to get it' },
      { file: '.env', note: 'the real local values (gitignored) — must not contain an undocumented var' },
    ],
    check() {
      if (!exists('.env.example')) return bad('.env.example is missing — the map of where every credential lives')
      const example = read('.env.example')
      const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
      if (!documented.size) return bad('.env.example declares no variables')
      const problems = []

      // 1. A tracked file must never carry a real value.
      const filled = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)].map((m) => m[1])
      if (filled.length) problems.push(`.env.example has VALUES for ${filled.join(', ')} — it is tracked; keys only`)

      /*
       * 2. Every credential-shaped var the OPS tooling reads must be documented.
       * Scoped deliberately:
       *  · only executable ops code (.mjs/.sh) — not .md/.html;
       *  · `/design/`, `/drafts/`, `/content-studio/` are EXCLUDED. Those are marketing
       *    artefacts whose code samples show a USER how to configure the SDK
       *    (`wallet: { key: process.env.EVM_KEY }`). They are illustrations, not credentials
       *    we hold — documenting them in our .env.example would be a lie.
       */
      const opsFiles = [...walk('.claude/skills', ['.mjs', '.sh']), ...walk('scripts', ['.mjs'])]
        // `scripts/sync/` is excluded too: the checker reads no credentials, and this very
        // rule names example vars in its own comments — without this it flags itself.
        .filter((f) => !/\/(design|drafts|content-studio)\//.test(f) && !f.startsWith('scripts/sync/'))
      const CREDENTIAL_SHAPED = /(KEY|SECRET|TOKEN|PASSWORD|LOGIN|_API|^RPC_|^API_)/
      // Vars the loader SYNTHESISES (e.g. TONCENTER_API_KEY from RPC_TON's api_key) are
      // configured via their source var, so they are covered without their own entry.
      const derived = new Set(
        [...read('scripts/load-env.mjs').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*=/g)].map((m) => m[1])
      )
      const undocumented = new Map()
      for (const f of opsFiles) {
        for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          const v = m[1]
          if (!CREDENTIAL_SHAPED.test(v) || documented.has(v) || derived.has(v)) continue
          if (!undocumented.has(v)) undocumented.set(v, new Set())
          undocumented.get(v).add(f)
        }
      }
      if (undocumented.size) {
        problems.push(
          `read by ops tooling but absent from .env.example: ` +
            [...undocumented].map(([v, fs]) => `${v} (${[...fs].join(', ')})`).join('; ')
        )
      }

      // 3. The real .env must not hold a var the map never mentions (gitignored → may be absent).
      if (exists('.env')) {
        const live = [...read('.env').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1])
        const undoc = [...new Set(live.filter((v) => !documented.has(v)))]
        if (undoc.length) problems.push(`.env holds undocumented var(s): ${undoc.join(', ')} — add them to .env.example`)
      }

      return problems.length
        ? bad(problems.join('; '))
        : ok(`${documented.size} credentials documented, no values committed`)
    },
  },
  {
    domain: 'site',
    id: 'deck-published-matches-master',
    verify: [
      "npm run sync -- --only deck-published-matches-master",
    ],
    what: 'The pitch deck served from piprail.com is byte-identical to the repo-root master',
    source: { file: 'PipRail-deck.pdf', note: 'the master the branding skill builds and the README links' },
    mirrors: [
      { file: 'site/public/PipRail-deck.pdf', note: 'the copy piprail.com serves — linked by the grant-foundation outreach email' },
    ],
    check() {
      const master = 'PipRail-deck.pdf'
      const published = 'site/public/PipRail-deck.pdf'
      if (!exists(master)) return skip('no deck at the repo root')
      if (!exists(published)) {
        return bad(
          `${published} is missing, so https://piprail.com/PipRail-deck.pdf 404s. ` +
            `The grant-foundation outreach template links that URL in an email that cannot be recalled.`
        )
      }
      /*
       * 🔴 BYTES, NOT MTIME OR SIZE.
       *
       * This is a published-artifact copy, which the repo's own rule says must be
       * generated, derived or GUARDED. Nothing regenerates it: a rebuilt deck lands at
       * the root and the site keeps serving the old one, silently, at a URL a grant
       * reviewer was emailed. Size alone would not catch a re-render at the same length.
       */
      const a = readFileSync(join(REPO, master))
      const b = readFileSync(join(REPO, published))
      return a.equals(b)
        ? ok(`published deck matches the master (${(a.length / 1024).toFixed(0)} KB)`)
        : bad(`site/public/PipRail-deck.pdf differs from the root master — re-copy it: cp PipRail-deck.pdf site/public/`)
    },
  },
  /* ══════════════════════════════ CUSTODY ══════════════════════════════ */
  {
    domain: 'security',
    id: 'custody-claim-mirrors',
    verify: [
      "npm run verify-gate",
    ],
    what: 'The "nobody holds it / no account, no API key" claim is machine-guarded and stated consistently everywhere',
    source: {
      file: 'sdk/src/server.ts',
      note: '⭐ the gate takes an ADDRESS, never a secret — that fact is what every mirror below asserts',
    },
    mirrors: [
      { file: 'scripts/verify-gate.mjs', note: 'the `custody invariant` step — the machine guard; deleting it silently unguards the claim' },
      { file: 'site/src/pages/index.astro', note: 'hero subhead + the "nothing to sign up for" trust line' },
      { file: 'README.md', note: 'the one-line pitch' },
      { file: 'sdk/README.md', note: 'the one-line pitch' },
      { file: '.claude/skills/content-studio/BRAND.md', note: '⚠️ GITIGNORED — the lead line every piece of content inherits, but absent from a clean clone, so checked ONLY when present' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * "No account, no API key" is now the lead marketing claim (BRAND.md), and it is only true
       * because `RequirePaymentOptions` asks for no secret. That single fact is restated on the
       * landing hero, in two READMEs and in the brand bible — five copies of one fact, which is
       * exactly the shape this checker exists to guard.
       *
       * Two distinct failures are possible and both are silent:
       *   1. The CODE grows a credential → every marketing surface becomes a lie.
       *   2. The GUARD is deleted from verify-gate → (1) can then happen unnoticed.
       * So this rule checks the guard still exists AND the claim is stated consistently. The
       * deep code assertion itself lives in the gate (it needs comment-stripping); duplicating
       * it here would be the second copy this repo forbids.
       */
      if (!exists('scripts/verify-gate.mjs')) return skip('scripts/verify-gate.mjs not present')
      const gate = read('scripts/verify-gate.mjs')
      if (!gate.includes("label === 'custody invariant'")) {
        return bad('the `custody invariant` step is gone from verify-gate.mjs — the no-credential claim is now unguarded')
      }

      if (exists('sdk/src/server.ts') && /^\s{2}(apiKey|secret|privateKey|credentials)\??:/m.test(read('sdk/src/server.ts'))) {
        return bad('sdk/src/server.ts now asks the merchant for a secret — every "no API key" claim below is false')
      }

      /*
       * Each marketing surface must actually make the claim — a silent drop is how positioning rots.
       *
       * 🔴 `exists()` FIRST, ALWAYS. `read()` THROWS ENOENT; it does not return a falsy value, so
       * `const src = read(f); return src && …` looks defensive and is not. That exact mistake made
       * this rule fail in a clean clone (BRAND.md lives under the gitignored `.claude/*`, so it is
       * absent from every clone) — which would have failed the Netlify build, since the site's
       * `prebuild` runs this checker. Caught only by the deploy runbook's clean-clone test.
       *
       * BRAND.md is therefore checked when present (locally, where it is the real mirror) and
       * skipped when not (CI/Netlify). The four shipped surfaces are always checked.
       */
      const claims = [
        ['site/src/pages/index.astro', /no\s+API\s+key/i],
        ['README.md', /no\s+API\s+key/i],
        ['sdk/README.md', /no\s+API\s+key/i],
        ['.claude/skills/content-studio/BRAND.md', /nothing to sign up for/i],
      ]
      const missing = claims.filter(([f, re]) => exists(f) && !re.test(read(f)))
      if (missing.length) {
        return bad(`the credential claim is missing from: ${missing.map(([f]) => f).join(', ')}`)
      }

      return ok('guard live in verify-gate · gate needs no secret · claim stated on 4 surfaces')
    },
  },
  /* ═════════════════════════ IDENTITY (sameAs) ═════════════════════════ */
  {
    domain: 'seo',
    id: 'sameas-mirrors',
    verify: [
      "npm run build",
    ],
    what: 'The Organization.sameAs identity list is identical on both hosts, and every entry is a real profile URL',
    source: {
      file: 'site/src/layouts/Layout.astro',
      note: 'the canonical sameAs list — every other copy follows this one',
    },
    mirrors: [
      { file: 'docs/src/components/Head.astro', note: 'the docs host repeats the same Organization node' },
    ],
    check() {
      /*
       * WHY THIS RULE EXISTS.
       *
       * `sameAs` is a machine-readable identity claim: it tells an answer engine "these accounts
       * are also us". Two hand-kept copies of one list is the shape this checker exists to guard,
       * and the failure is silent — a profile added to one host and not the other splits our
       * identity graph in half without breaking a page or a test.
       *
       * 🔴 AND A sameAs THAT DOES NOT RESOLVE IS WORSE THAN SAYING NOTHING. The trap that
       * prompted this rule is LinkedIn's: a new company page hands you
       * `/company/<numeric-id>/`, which serves a SIGN-IN WALL when logged out while still
       * answering HTTP 200 — so a status check passes it and the crawler, which is logged out by
       * definition, sees a login screen where our identity should be. A sister project shipped
       * exactly that across its whole site. This rule therefore refuses the numeric form.
       *
       * It checks SHAPE, not liveness: a rule that made network calls could not run in a build.
       */
      const files = ['site/src/layouts/Layout.astro', 'docs/src/components/Head.astro']
      const present = files.filter(exists)
      if (present.length < 2) return skip('both Organization nodes not present')

      const lists = present.map((f) => {
        const m = read(f).match(/sameAs:\s*\[([^\]]*)\]/)
        return { f, urls: m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null }
      })

      const empty = lists.filter((l) => !l.urls || !l.urls.length)
      if (empty.length) return bad(`no sameAs list found in: ${empty.map((l) => l.f).join(', ')}`)

      const [a, b] = lists
      const only = (x, y) => x.urls.filter((u) => !y.urls.includes(u))
      const diff = [...only(a, b).map((u) => `${u} (only in ${a.f})`), ...only(b, a).map((u) => `${u} (only in ${b.f})`)]
      if (diff.length) {
        return bad(`the two sameAs lists disagree — an identity claim on one host and not the other:\n      ${diff.join('\n      ')}`)
      }

      /* 🔴 The numeric LinkedIn company URL is a sign-in wall to anyone logged out, which is
         every crawler. Only the vanity form is a real identity claim. */
      const numericLinkedIn = a.urls.filter((u) => /linkedin\.com\/company\/\d+/.test(u))
      if (numericLinkedIn.length) {
        return bad(
          `numeric LinkedIn company URL in sameAs (${numericLinkedIn.join(', ')}) — logged out that ` +
            `serves a SIGN-IN WALL at HTTP 200, so it points our identity at a login screen. ` +
            `Use the vanity form: linkedin.com/company/piprail`
        )
      }

      const bare = a.urls.filter((u) => !/^https:\/\//.test(u))
      if (bare.length) return bad(`sameAs entries must be absolute https URLs: ${bare.join(', ')}`)

      return ok(`${a.urls.length} identity URLs, identical on both hosts`)
    },
  },
]

export const DOMAINS = [...new Set(RULES.map((r) => r.domain))]
