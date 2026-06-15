// Run every SDK-sandbox suite in one process; one combined summary at the end.
// report.mjs is an ES-module singleton, so check() results accumulate across suites.

import { check, group, summarize } from './lib/report.mjs'
import { run as s01 } from './suites/01-merchant-gate.mjs'
import { run as s02 } from './suites/02-client-readonly.mjs'
import { run as s03 } from './suites/03-policy.mjs'
import { run as s04 } from './suites/04-wire-and-errors.mjs'
import { run as s05 } from './suites/05-live-roundtrip.mjs'
import { run as s06 } from './suites/06-discovery.mjs'
import { run as s12 } from './suites/12-discoverability.mjs'
// Suites 09–11 register FAKE drivers into the shared registry singleton (last-wins), so they
// run AFTER the real-driver suites 01–06 — nothing real-driver-dependent follows them.
import { run as s09 } from './suites/09-multichain.mjs'
import { run as s10 } from './suites/10-agent-toolkit.mjs'
import { run as s11 } from './suites/11-api-surface.mjs'

const suites = [
  ['01 merchant gate', s01],
  ['02 client read-only', s02],
  ['03 spend policy', s03],
  ['04 wire & errors', s04],
  ['05 live round-trip', s05],
  ['06 discovery', s06],
  ['12 discoverability 2.1.0', s12],
  ['09 multi-chain (MultiChainPayer)', s09],
  ['10 agent toolkit (7 tools)', s10],
  ['11 api-surface sweep', s11],
]

for (const [name, run] of suites) {
  try {
    await run()
  } catch (err) {
    group(`Suite crashed: ${name}`)
    check(`${name} ran without throwing`, false, err?.stack ?? String(err))
  }
}

process.exit(summarize())
