/**
 * L3 · FACILITATORS — is the registry still true?
 *
 * These are third-party hosts we point real money at. A facilitator that went dark, dropped a
 * chain, or changed its API still reads perfectly in the source, so no unit test can catch it.
 * This asks every host over the network, using the SDK's own reader, and compares what it
 * ANSWERS with what we CLAIM.
 *
 * Read-only and free. It costs nothing but seconds, and it is the layer most likely to go red
 * without anybody touching the code.
 */
export const meta = {
  id: 'facilitators',
  layer: 'L3',
  what: 'every KNOWN_FACILITATORS host, probed live, claim vs answer',
  why: 'a dead or drifted facilitator silently costs the buyer gas, or breaks a gasless rail',
  network: true,
}

const TIMEOUT = 20_000

export async function run({ sdk, section, check, note }) {
  const { KNOWN_FACILITATORS, facilitatorCoverage, firstKeylessFacilitator } = sdk

  const entries = []
  for (const [network, list] of Object.entries(KNOWN_FACILITATORS)) {
    for (const f of list) entries.push({ network, ...f })
  }
  const hosts = [...new Set(entries.map((e) => e.url))]

  section('facilitators · every host answers',
    `${entries.length} entries · ${hosts.length} hosts · ${Object.keys(KNOWN_FACILITATORS).length} networks`)

  // One /supported read per HOST: the same host serves many networks.
  const byHost = new Map()
  await Promise.all(hosts.map(async (url) => {
    const t0 = Date.now()
    let kinds = []
    try { kinds = await facilitatorCoverage(url, TIMEOUT) } catch { /* never throws by contract */ }
    byHost.set(url, { kinds, ms: Date.now() - t0 })
  }))

  for (const url of hosts.sort()) {
    const r = byHost.get(url)
    const claimed = entries.filter((e) => e.url === url).length
    await check(`${url.replace(/^https:\/\//, '')}`, () =>
      r.kinds.length > 0
        ? `${r.kinds.length} kinds, ${r.ms}ms, ${claimed} claim(s)`
        : { fail: `SILENT after ${r.ms}ms — ${claimed} registry claim(s) point here` })
  }

  section('facilitators · what a host advertises matches what we claim of it')

  const mismatches = []
  for (const e of entries) {
    const r = byHost.get(e.url)
    if (!r || r.kinds.length === 0) continue // reachability already failed above
    const nets = new Set(r.kinds.map((k) => String(k.network ?? '')))
    if (!nets.has(e.network)) mismatches.push({ e, advertises: [...nets].slice(0, 5).join(', ') })
  }
  await check('no host contradicts a registry claim', () =>
    mismatches.length === 0
      ? `${entries.length} claims confirmed`
      : { fail: mismatches.map((m) => `${m.e.network} @ ${m.e.url} advertises [${m.advertises}]`).join(' | ') })

  section('facilitators · the keyless promise', 'a keyless host is what makes a chain gasless with no signup')

  const nets = Object.keys(KNOWN_FACILITATORS).sort()
  let keyless = 0
  for (const network of nets) {
    const f = firstKeylessFacilitator(network)
    if (!f) { note(`${network}`, 'no keyless facilitator'); continue }
    keyless++
    const r = byHost.get(f.url)
    await check(`${network} → ${f.url.replace(/^https:\/\//, '')}`, () =>
      r?.kinds.length ? 'answering' : { fail: 'the FIRST keyless pick for this chain is silent' })
  }
  await check('every network with a keyless facilitator has a live one', () =>
    `${keyless}/${nets.length} networks keyless`)

  section('facilitators · the reader is honest about a host it cannot reach')

  await check('an unreachable host yields [] rather than throwing', async () => {
    const c = await facilitatorCoverage('http://127.0.0.1:1', 2000)
    return Array.isArray(c) && c.length === 0 ? 'returned []' : { fail: JSON.stringify(c) }
  })
  await check('a garbage URL yields [] rather than throwing', async () => {
    const c = await facilitatorCoverage('not-a-url', 2000)
    return Array.isArray(c) ? 'returned []' : { fail: 'did not return an array' }
  })
}
