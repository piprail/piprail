// Run every suite in order; exit non-zero if any fails. Offline assertions run anywhere;
// the live (on-chain) sections inside each suite self-skip when the .secrets wallet is absent.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, 'suites')
const suites = readdirSync(dir).filter((f) => /^\d.*\.mjs$/.test(f)).sort()

console.log(`\x1b[1m@piprail/sdk x402-parity sandbox — ${suites.length} suites (published packages)\x1b[0m`)

let failed = 0
for (const s of suites) {
  console.log(`\n\x1b[1m▶ ${s}\x1b[0m`)
  const r = spawnSync('node', [resolve(dir, s)], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.error(`\x1b[31m  ${s} exited ${r.status}\x1b[0m`)
  }
}

const ok = failed === 0
console.log(`\n${ok ? '\x1b[32m' : '\x1b[31m'}════════ ${suites.length - failed}/${suites.length} suites passed ════════\x1b[0m`)
process.exit(ok ? 0 : 1)
