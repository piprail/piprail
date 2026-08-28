import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_FACILITATORS } from '../src/facilitators.js'

/*
 * ── THE SURFACE GUARD ───────────────────────────────────────────────────────────────
 *
 * facilitators.test.ts protects the registry. This file protects everything that TALKS
 * about the registry — the docs site, the marketing site, and the live example probes.
 *
 * WHY IT EXISTS. On 2026-08-28 a liveness sweep found two seeded facilitators had died:
 * facilitator.corbits.dev (NXDOMAIN) and facilitator.bitcoinsapi.com (deleted Azure
 * container app). Removing them from `KNOWN_FACILITATORS` fixed the SDK — and left three
 * OTHER surfaces still advertising them as live:
 *
 *   · docs.piprail.com listed both in the coverage table and the copy-paste URL list,
 *   · a docs code sample claimed Base had "eight" facilitators and named them,
 *   · examples/…/live-monad-keyless.mjs pointed a real mainnet probe at the dead host.
 *
 * A reader following any of those would have wired a payment rail to a domain that does
 * not resolve. The registry being right is not enough when four places restate it.
 *
 * These tests are deliberately about DRIFT, not about taste: they compare shipped prose
 * against the map itself, so the map stays the single source of truth.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

const seededHosts = new Set(
  Object.values(KNOWN_FACILITATORS).flat().map((f) => new URL(f.url).host),
)

/**
 * Hosts that were seeded, settled real payments, and then went offline. They must never
 * reappear anywhere as a live option. Keep this list append-only — an entry removed from
 * here is an entry that can silently come back.
 */
const KNOWN_DEAD = ['facilitator.corbits.dev', 'facilitator.bitcoinsapi.com']

/**
 * A dead host may be named only while being explained as dead. Without this escape the guard
 * would forbid its own documentation, and recording what was removed and why is exactly what
 * we want to keep writing.
 *
 * Matched against a WINDOW, not a single line: real prose puts the header ("Removed
 * 2026-08-28 — two facilitators went offline") a line or two above the hostname it is about,
 * so a line-at-a-time test flags the very obituaries it should permit.
 */
const OBITUARY = /removed|nxdomain|died|dead|deleted|no longer|⚰️|offline|was seeded|container app/i
const WINDOW = 3

/** Every text file under `dir` we care about, ignoring build output and dependencies. */
function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.astro' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, exts, acc)
    else if (exts.some((e) => name.endsWith(e))) acc.push(full)
  }
  return acc
}

describe('facilitator surface — no shipped surface may advertise a dead facilitator', () => {
  const files = [
    ...walk(join(REPO, 'docs', 'src'), ['.md', '.mdx', '.astro', '.ts']),
    ...walk(join(REPO, 'site', 'src'), ['.astro', '.ts', '.md']),
    ...walk(join(REPO, 'sdk', 'src'), ['.ts']),
    ...walk(join(REPO, 'examples'), ['.mjs']),
  ]

  it('finds the surfaces it is meant to police (guards against a silently empty scan)', () => {
    // A walker that quietly returns [] would make every assertion below vacuously pass —
    // the failure mode that makes a guard test worse than no test at all.
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => f.includes('facilitator-coverage'))).toBe(true)
  })

  it.each(KNOWN_DEAD)('%s is never presented as usable', (dead) => {
    const offences: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!line.includes(dead)) return
        const context = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n')
        if (!OBITUARY.test(context)) {
          offences.push(`${relative(REPO, file)}:${i + 1}  ${line.trim().slice(0, 110)}`)
        }
      })
    }
    expect(offences, `dead facilitator still advertised:\n${offences.join('\n')}`).toEqual([])
  })
})

describe('facilitator surface — the docs URL list matches the registry exactly', () => {
  const docPath = join(REPO, 'docs', 'src', 'content', 'docs', 'accepting-payments', 'facilitator-coverage.md')

  it('the copy-paste "Base URLs" line lists every seeded host and nothing else', () => {
    if (!existsSync(docPath)) return // SDK checked out standalone — nothing to police.
    const doc = readFileSync(docPath, 'utf8')
    const line = doc.split('\n').find((l) => l.startsWith('`https://') && l.includes('·'))
      ?? doc.split('**Base URLs**')[1]?.split('\n\n')[0]
    expect(line, 'could not locate the Base-URLs line in the coverage doc').toBeTruthy()

    const listed = new Set(
      [...line!.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]),
    )
    // Set equality, both directions: a missing host means the docs under-sell what ships,
    // an extra one means they point at something the SDK will not resolve.
    expect([...listed].sort()).toEqual([...seededHosts].sort())
  })
})

describe('facilitator surface — the website data is generated, not hand-typed', () => {
  const dataPath = join(REPO, 'site', 'src', 'data', 'facilitators.ts')

  it('site/src/data/facilitators.ts carries exactly the registry’s chains and URLs', () => {
    if (!existsSync(dataPath)) return
    const src = readFileSync(dataPath, 'utf8')
    const generated = JSON.parse(src.slice(src.indexOf('= [') + 2)) as {
      caip2: string
      facilitators: { url: string }[]
    }[]

    // Same networks…
    expect(generated.map((c) => c.caip2).sort()).toEqual(Object.keys(KNOWN_FACILITATORS).sort())

    // …and, per network, the same facilitator URLs in the same order. Order matters: it is
    // what `firstKeylessFacilitator` returns, so a page that reorders them misleads a reader
    // about which one their code will actually reach for.
    for (const chain of generated) {
      const registry = KNOWN_FACILITATORS[chain.caip2 as keyof typeof KNOWN_FACILITATORS]
      // The caip2-set assertion above already proves this lookup hits; assert it anyway so a
      // future edit to that assertion cannot silently turn this loop into a no-op.
      expect(registry, `${chain.caip2} is on the site but not in the registry`).toBeDefined()
      expect(
        chain.facilitators.map((f) => f.url),
        `site data for ${chain.caip2} is stale — re-run: node site/scripts/gen-facilitators.mjs`,
      ).toEqual(registry!.map((f) => f.url))
    }
  })

  it('every chain the site renders has a logo shipped for it', () => {
    if (!existsSync(dataPath)) return
    const src = readFileSync(dataPath, 'utf8')
    const slugs = [...src.matchAll(/"slug": "([^"]+)"/g)].map((m) => m[1])
    expect(slugs.length).toBeGreaterThan(0)
    const missing = slugs.filter((s) => !existsSync(join(REPO, 'site', 'public', 'chains', `${s}.svg`)))
    expect(missing, `chain logos missing from site/public/chains: ${missing.join(', ')}`).toEqual([])
  })
})
