#!/usr/bin/env node
/**
 * Deploy sync guard — now a thin delegator to the repo-wide checker.
 *
 * ── WHY THIS FILE STILL EXISTS ──────────────────────────────────────────────────────
 * It is wired into four places that should not have to change: the site's `prebuild`
 * hook (so it runs on every local, CI and Netlify build), `release.yml`,
 * `mcp-release.yml`, and the `deploy` skill's checklist. Keeping the path stable means
 * all of that keeps working while the checks behind it got much broader.
 *
 * ── WHAT CHANGED (2026-08-28) ───────────────────────────────────────────────────────
 * This used to hold its own copies of the facts it was guarding — most notably a
 * hard-coded array of the eight MCP tool names, which made it a THIRD copy of a list
 * that already existed in the SDK and in `mcp/src/banner.ts`. A guard that can itself
 * drift is not a guard.
 *
 * Everything now lives in `scripts/sync/`, where each fact is DERIVED from the code that
 * owns it, and each rule declares its source and its mirrors — so the same definitions
 * that run the check also print the map:
 *
 *   npm run sync                                       # everything
 *   npm run sync -- --graph                            # what is linked to what
 *   npm run sync -- --touched sdk/src/facilitators.ts  # "I changed this — what else?"
 *
 * Coverage went from 2 facts (versions, tool names) to 20 rules across 7 domains:
 * chains · packages · mcp · facilitators · discovery · site · docs. Human map:
 * `.claude/SURFACES.md`.
 *
 * Note: the `site` rules inspect `site/dist`, which does not exist at prebuild time, so
 * they SKIP here with a reason and run properly in a post-build `npm run sync`.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const result = spawnSync(process.execPath, [join(repo, 'scripts', 'sync', 'check.mjs')], {
  stdio: 'inherit',
  cwd: repo,
})
process.exit(result.status ?? 1)
