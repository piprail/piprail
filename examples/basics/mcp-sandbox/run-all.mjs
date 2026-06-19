// Run every suite in one process and print a single combined summary.
// report.mjs is an ES-module singleton, so check() results accumulate across all
// suites; summarize() runs once at the end and sets the exit code.

import { check, group, summarize } from './lib/report.mjs'
import { run as s01 } from './suites/01-protocol.mjs'
import { run as s02 } from './suites/02-tools.mjs'
import { run as s03 } from './suites/03-policy-attacks.mjs'
import { run as s04 } from './suites/04-config-surface.mjs'
import { run as s05 } from './suites/05-live-settlement.mjs'

const suites = [
  ['01 protocol & transport', s01],
  ['02 tool surface', s02],
  ['03 adversarial policy', s03],
  ['04 config / SDK surface', s04],
  ['05 live settlement', s05],
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
