// Run every SDK-sandbox suite in one process; one combined summary at the end.
// report.mjs is an ES-module singleton, so check() results accumulate across suites.

import { check, group, summarize } from './lib/report.mjs'
import { run as s01 } from './suites/01-merchant-gate.mjs'
import { run as s02 } from './suites/02-client-readonly.mjs'
import { run as s03 } from './suites/03-policy.mjs'
import { run as s04 } from './suites/04-wire-and-errors.mjs'
import { run as s05 } from './suites/05-live-roundtrip.mjs'

const suites = [
  ['01 merchant gate', s01],
  ['02 client read-only', s02],
  ['03 spend policy', s03],
  ['04 wire & errors', s04],
  ['05 live round-trip', s05],
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
