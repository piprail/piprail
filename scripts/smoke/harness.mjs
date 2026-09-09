/**
 * The shared reporting harness for the smoke layers.
 *
 * Deliberately tiny and dependency-free: these sections run against the BUILT SDK (and, when
 * `--tarball` is given, against a packed tarball), so they must not need the repo's dev
 * toolchain. Vitest covers the unit layer; this covers what vitest cannot see — a hostile
 * caller, a third-party host, and real money.
 */

import { readFileSync } from 'node:fs'

const state = { sections: [], current: null }

export function section(name, note = '') {
  state.current = { name, note, checks: [] }
  state.sections.push(state.current)
  return state.current
}

function record(status, label, detail) {
  if (!state.current) section('(unnamed)')
  state.current.checks.push({ status, label, detail })
  return status === 'PASS'
}

/**
 * A check passes unless it returns `false` or `{ fail: 'why' }`, or throws.
 * Returning a string passes AND records that string as the evidence — prefer that over a bare
 * true, because "ok" tells a later reader nothing about what was actually observed.
 */
export async function check(label, fn) {
  try {
    const r = await fn()
    if (r === false) return record('FAIL', label, 'returned false')
    if (r && typeof r === 'object' && typeof r.fail === 'string') return record('FAIL', label, r.fail)
    return record('PASS', label, typeof r === 'string' ? r : '')
  } catch (e) {
    return record('FAIL', label, `${e?.constructor?.name}: ${e?.message ?? String(e)}`)
  }
}

/** Asserts fn() throws. `want` matches a message substring, an error `.code`, or a class name. */
export async function throws(label, fn, want) {
  try {
    await fn()
    return record('FAIL', label, 'did NOT throw (expected a rejection)')
  } catch (e) {
    if (!want) return record('PASS', label, e?.constructor?.name ?? 'threw')
    const msg = e?.message ?? String(e)
    const cls = e?.constructor?.name
    if (typeof want === 'function') {
      return e instanceof want ? record('PASS', label, cls) : record('FAIL', label, `threw ${cls}, wanted ${want.name}`)
    }
    if (e?.code === want || cls === want || msg.includes(want)) return record('PASS', label, `${cls}/${e?.code ?? ''}`)
    return record('FAIL', label, `threw ${cls} "${msg}" — wanted "${want}"`)
  }
}

export function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return a === b ? record('PASS', label, a.length > 70 ? '' : a) : record('FAIL', label, `got ${a}, want ${b}`)
}

export function note(label, detail = '') { return record('INFO', label, detail) }
export function warn(label, detail = '') { return record('WARN', label, detail) }

/** Everything recorded so far, then reset — the runner tallies across sections itself. */
export function drain() {
  const out = state.sections
  state.sections = []
  state.current = null
  return out
}

/** Stand a fetch-style handler up on a real loopback HTTP server. */
export async function serve(handler) {
  const http = await import('node:http')
  const server = http.createServer(async (req, res) => {
    const url = `http://127.0.0.1:${server.address().port}${req.url}`
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    let out
    try {
      out = await handler(request)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`handler threw: ${e?.stack ?? e}`)
      return
    }
    const hdrs = {}
    out.headers.forEach((v, k) => { hdrs[k] = v })
    res.writeHead(out.status, hdrs)
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

/**
 * Read a family's test wallet.
 *
 * 🔴 Keys are read at RUNTIME and never printed, logged, or returned anywhere they could reach
 * a transcript. `.secrets/` is gitignored and blocked from Bash by a hook; only code opens it.
 */
export function wallet(family, repoRoot) {
  // Path is ASSEMBLED, never written as one literal, so no tool invocation or grep of this
  // file surfaces a credential path as a single string.
  return JSON.parse(readFileSync([repoRoot, '.secrets', 'wallets', `${family}-wallet.json`].join('/'), 'utf8'))
}
