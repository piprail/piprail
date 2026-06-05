// Dependency-free check runner: record pass/fail, keep going on failure, print a
// grouped summary, and return a non-zero exit code if anything failed.
//
// It's an ES-module singleton, so every suite that imports it shares one results
// list — run-all.mjs can run them all and summarize() once at the very end.

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

/** Assert truthy. `detail` is shown dimmed on pass, loud on failure. */
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

/** Print the summary; return the process exit code (0 = all passed). */
export function summarize() {
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n${C.bold}── summary ──${C.reset}`)
  if (failed === 0) {
    console.log(`${C.green}${C.bold}ALL ${passed} CHECKS PASSED${C.reset}`)
  } else {
    console.log(`${C.red}${C.bold}${failed} FAILED${C.reset}, ${C.green}${passed} passed${C.reset}`)
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ${C.red}✗${C.reset} [${r.group}] ${r.label}`)
    }
  }
  return failed === 0 ? 0 : 1
}
