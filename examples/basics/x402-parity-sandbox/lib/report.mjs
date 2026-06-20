// Tiny test reporter shared by every suite. Each suite is its own process; run-all.mjs
// aggregates by exit code, so all we track here is per-process pass/fail.
let total = 0
let failures = 0

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/** Assert `cond`; logs a ✓/✗ line and flips this process's exit code on failure. Returns the boolean. */
export function check(cond, msg) {
  total++
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${msg}`)
  } else {
    failures++
    process.exitCode = 1
    console.error(`  ${RED}✗ FAIL${RESET} ${msg}`)
  }
  return !!cond
}

export const banner = (t) => console.log(`\n${BOLD}════════ ${t} ════════${RESET}`)
export const group = (t) => console.log(`\n── ${t} ──`)
export const note = (t) => console.log(`  ${DIM}· ${t}${RESET}`)
export const skip = (t) => console.log(`  ${YELLOW}⤵ SKIP${RESET} ${DIM}${t}${RESET}`)

/** Print the suite verdict and force-exit (flushing stdout first, so any still-open server
 *  socket or RPC keep-alive can't keep the process hanging). */
export function done(label) {
  const ok = failures === 0
  console.log(`\n${ok ? GREEN : RED}════════ ${label}: ${ok ? 'PASSED ✓' : `FAILED ✗ (${failures}/${total})`} ════════${RESET}`)
  process.stdout.write('', () => process.exit(ok ? 0 : 1))
}
