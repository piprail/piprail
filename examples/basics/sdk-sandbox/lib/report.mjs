// Dependency-free check runner: record pass/fail, keep going on failure, print a
// grouped summary, and return a non-zero exit code if anything failed. It's an
// ES-module singleton, so every suite shares one results list — run-all.mjs runs
// them all and summarize()s once at the end.

const results = []
let currentGroup = '(ungrouped)'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', bold: '\x1b[1m',
}

export function group(name) {
  currentGroup = name
  console.log(`\n${C.bold}${C.cyan}▸ ${name}${C.reset}`)
}

export function check(label, cond, detail = '') {
  const ok = Boolean(cond)
  results.push({ group: currentGroup, label, ok })
  const mark = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
  console.log(`  ${mark} ${label}${ok && detail ? ` ${C.dim}${detail}${C.reset}` : ''}`)
  if (!ok && detail) console.log(`      ${C.red}${detail}${C.reset}`)
  return ok
}

export function note(msg) {
  console.log(`  ${C.yellow}•${C.reset} ${C.dim}${msg}${C.reset}`)
}

export function summarize() {
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n${C.bold}── summary ──${C.reset}`)
  if (results.length === 0) {
    // A suite that recorded ZERO checks proved nothing (it skipped — no anvil, no RPC,
    // no @x402, …). Never report that as success: flag it and exit non-zero so a skip is
    // never mistaken for a pass. (run-all always records checks, so it's unaffected.)
    console.log(`${C.yellow}${C.bold}⚠ NO CHECKS RAN — nothing was proven (skipped).${C.reset}`)
    return 1
  }
  if (failed === 0) {
    console.log(`${C.green}${C.bold}ALL ${passed} CHECKS PASSED${C.reset}`)
  } else {
    console.log(`${C.red}${C.bold}${failed} FAILED${C.reset}, ${C.green}${passed} passed${C.reset}`)
    for (const r of results.filter((x) => !x.ok)) console.log(`  ${C.red}✗${C.reset} [${r.group}] ${r.label}`)
  }
  return failed === 0 ? 0 : 1
}
