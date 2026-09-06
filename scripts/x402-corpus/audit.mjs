#!/usr/bin/env node
/**
 * `npm run x402:coverage` — how much of the x402 web can a PipRail buyer actually pay?
 *
 * THE OWNER OF THAT NUMBER. Every coverage figure quoted in the CHANGELOG, the docs, the site or
 * a plan comes from a run of this script; none is ever typed by hand. It exists because on
 * 2026-09-06 the SDK had 1,636 green tests, a live suite against our own gate, and a docs page
 * titled "Pay any x402 server" — while a probe of seven real third-party 402s paid zero of them.
 * Unit tests proved the code matched its fixtures; nothing proved the fixtures matched the world.
 *
 * It pages the LIVE CDP Bazaar catalog (the same URL `discover()` reads), classifies every
 * `accepts[]` rail, and scores two things:
 *   • resource-level — a resource counts once if ANY of its rails is payable
 *   • rail-level     — per network, i.e. what an agent holding funds on THAT chain experiences
 * The "today" column replays the real `gatherCandidates` predicate; the later columns model the
 * remaining stages of `.claude/plans/x402-max-coverage/`.
 *
 *   npm run x402:coverage                                  # offline classification
 *   npm run x402:coverage -- --live                        # + a real quote() against live URLs
 *   npm run x402:coverage -- --json scripts/x402-corpus/coverage.json
 *   npm run x402:coverage -- --fixture sdk/test/fixtures/x402-corpus
 *   npm run x402:coverage -- --cache /tmp/x402-corpus      # reuse the 17 pages between runs
 *
 * Read-only and key-less. `--live` builds a client from a THROWAWAY generated key and only ever
 * calls `quote()` — it parses a 402, it never signs and never pays. No secret is read.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }

// Same URL as sdk/src/indexes.ts BAZAAR_URL — keep in lockstep.
const BAZAAR = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'
const PAGE = 1000

/* ------------------------------------------------------------------ facts about PipRail */
// EVM presets = the ids in sdk/src/drivers/evm/chains.ts CHAINS (read live when dist exists).
let EVM_PRESET_IDS = new Set([1, 8453, 42161, 10, 137, 56, 43114, 5000, 146, 59144, 534352, 42220, 324, 130, 480, 1329, 1776, 999, 143, 8217]) // = CHAINS at 2.15.1; overwritten from dist when importable
let EVM_PRESET_TOKENS = null // Map<chainId, Set<lowercase address>> when dist is importable
const ALGO_SPEC = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k' // scheme_exact_algo.md canonical (32-char)
const ALGO_PADDED = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' // what PipRail emits/matches today
// Non-EVM families with a payExact SPI today (drivers/*/index.ts).
const NONEVM_EXACT_TODAY = new Set(['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', ALGO_PADDED, 'aptos:1', 'near:mainnet'])
// Stage 04 targets (spec exists, PipRail ships the family, no exact buyer yet).
const NONEVM_STAGE4 = new Set(['xrpl:0', 'stellar:pubnet', 'hedera:mainnet'])
// Stage 03 presets.
const STAGE3_EVM = new Set([196, 4663, 4326])
const TESTNET_EVM = new Set([84532, 11155111, 421614, 80002, 97, 43113])
const SLUGS = { base: 'eip155:8453', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', polygon: 'eip155:137', arbitrum: 'eip155:42161', optimism: 'eip155:10', ethereum: 'eip155:1', avalanche: 'eip155:43114', bsc: 'eip155:56', bnb: 'eip155:56', 'base-sepolia': 'eip155:84532' }

/* The two rules below are the SDK's, not this script's — imported from the built dist when it
 * exists so the ruler can never drift from the code it measures (the whole failure mode this
 * script was written to catch). The literals are only a fallback for a dist-less checkout. */
let isSettleableMethod = (a) =>
  new Set(['eip3009', 'permit2', 'permit2-exact', 'svm', 'algorand', 'aptos', 'near']).has(
    a.extra?.assetTransferMethod ?? 'eip3009'
  )
let canonicalNetwork = (n) => (SLUGS[n] ? SLUGS[n] : n === ALGO_SPEC ? ALGO_PADDED : n)

/**
 * The predicate as it stood at 2.15.1 — kept ONLY to quantify the before/after, never as "today".
 * Faithful to both gathers of that release: `exact` REQUIRED `extra.assetTransferMethod`, `upto`
 * required `extra.facilitatorAddress` (and never the marker), neither could parse a v1 body, and
 * both matched the network by exact string (no slug or Algorand-alias canonicalisation).
 */
const payableAt_2_15_1 = (a, x402Version) =>
  x402Version === 2 &&
  a.network === canonicalNetwork(a.network) &&
  (a.scheme === 'upto'
    ? typeof a.extra?.facilitatorAddress === 'string'
    : typeof a.extra?.assetTransferMethod === 'string')

async function loadSdkFacts() {
  try {
    const sdk = await import(join(REPO, 'sdk', 'dist', 'index.js'))
    if (sdk.isSettleableExactMethod) isSettleableMethod = sdk.isSettleableExactMethod
    if (sdk.normalizeNetwork) canonicalNetwork = sdk.normalizeNetwork
    if (sdk.CHAINS) {
      EVM_PRESET_IDS = new Set(Object.values(sdk.CHAINS).map((p) => p.chain.id))
      EVM_PRESET_TOKENS = new Map(Object.values(sdk.CHAINS).map((p) => [p.chain.id, new Set(Object.values(p.tokens).map((t) => t.address.toLowerCase()))]))
    }
    return sdk
  } catch {
    console.error('(sdk/dist not importable — using the hard-coded preset list; run `npm run build -w @piprail/sdk` for live facts)')
    return null
  }
}

/* ------------------------------------------------------------------ fetch */
async function fetchCorpus(cacheDir) {
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  const first = await page(0, cacheDir)
  const total = first.pagination?.total ?? first.items.length
  const offsets = []
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o)
  const rest = await Promise.all(offsets.map((o) => page(o, cacheDir)))
  const seen = new Map()
  for (const p of [first, ...rest]) for (const r of p.items ?? []) { const u = r.resource ?? r.url; if (u && !seen.has(u)) seen.set(u, r) }
  return { total, resources: [...seen.values()] }
}
async function page(offset, cacheDir) {
  const f = cacheDir && join(cacheDir, `bz_${offset}.json`)
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  const res = await fetch(`${BAZAAR}?limit=${PAGE}&offset=${offset}`, { signal: AbortSignal.timeout(90_000) })
  if (!res.ok) throw new Error(`Bazaar ${res.status} at offset ${offset}`)
  const j = await res.json()
  if (f) writeFileSync(f, JSON.stringify(j))
  return j
}

/* ------------------------------------------------------------------ classify */
const evmId = (n) => { const m = /^eip155:(\d+)$/.exec(n ?? ''); return m ? Number(m[1]) : null }
const normalize = (n) => (n ? canonicalNetwork(n) : n)
const tokenRecognised = (a, id) => !EVM_PRESET_TOKENS || !EVM_PRESET_TOKENS.has(id) || EVM_PRESET_TOKENS.get(id).has(String(a.asset).toLowerCase())

/**
 * Which bucket does ONE rail fall in?
 *   'today'   — the CURRENT build can pay it (this mirrors `client.gatherCandidates`, and borrows
 *               the SDK's own `isSettleableExactMethod` + `normalizeNetwork` so it cannot drift)
 *   'stage03' — needs an EVM preset we haven't shipped (X Layer / Robinhood / MegaETH)
 *   'stage04' — needs a non-EVM `exact` BUYER we haven't built (XRPL / Stellar / Hedera)
 *   null      — out of scope by design (testnets, unknown chains, non-x402 schemes)
 */
function railStage(a, x402Version = 2) {
  if (a.scheme !== 'exact' && a.scheme !== 'upto') return null
  const okTimeout = Number.isInteger(a.maxTimeoutSeconds) && a.maxTimeoutSeconds > 0
  if (!okTimeout || a.asset === 'native') return null
  if (!isSettleableMethod(a)) return null // names a method no driver implements (e.g. erc7710)
  const net = normalize(a.network ?? '')
  const id = evmId(net)
  if (id !== null && TESTNET_EVM.has(id)) return null
  if (a.scheme === 'upto') { // opt-in, EVM-Permit2, needs the spec-mandated facilitatorAddress
    return id !== null && EVM_PRESET_IDS.has(id) && tokenRecognised(a, id) && typeof a.extra?.facilitatorAddress === 'string' ? 'today' : null
  }
  // v1 bodies and slug/aliased networks are all handled by the current build (parse + wire).
  if ((id !== null && EVM_PRESET_IDS.has(id) && tokenRecognised(a, id)) || NONEVM_EXACT_TODAY.has(net)) return 'today'
  if (id !== null && STAGE3_EVM.has(id)) return 'stage03'
  if (NONEVM_STAGE4.has(net)) return 'stage04'
  return null
}
const ORDER = ['today', 'stage03', 'stage04']
const rank = (s) => (s === null ? 99 : ORDER.indexOf(s))

function classify(resources) {
  const perStage = Object.fromEntries(ORDER.map((s) => [s, 0]))
  let never = 0
  let baseline = 0 // resources the 2.15.1 predicate could pay — the before/after
  let baselineRails = 0 // …and the same predicate counted per RAIL, for the rail-level before/after
  const perNet = new Map()
  const v1 = []
  for (const r of resources) {
    if (r.x402Version === 1) v1.push(r)
    let best = null
    for (const a of r.accepts ?? []) {
      const s = railStage(a, r.x402Version)
      if (rank(s) < rank(best)) best = s
      if (a.scheme === 'exact') {
        const n = a.network ?? '?'
        const p = perNet.get(n) ?? { rails: 0, byStage: Object.fromEntries(ORDER.map((x) => [x, 0])), never: 0 }
        p.rails += 1
        if (s === null) p.never += 1; else p.byStage[s] += 1
        perNet.set(n, p)
        if (s !== null && payableAt_2_15_1(a, r.x402Version)) baselineRails += 1
      }
    }
    if ((r.accepts ?? []).some((a) => (a.scheme === 'exact' || a.scheme === 'upto') && railStage(a, r.x402Version) !== null && payableAt_2_15_1(a, r.x402Version))) baseline += 1
    if (best === null) never += 1; else perStage[best] += 1
  }
  return { perStage, never, perNet, v1, baseline, baselineRails }
}

/* ------------------------------------------------------------------ report */
function report({ total, resources }, c) {
  const T = resources.length
  const pct = (n, d = T) => `${((100 * n) / d).toFixed(1)}%`.padStart(6)
  console.log(`\nCDP Bazaar: ${total} listed · ${T} unique resources · fetched ${new Date().toLocaleDateString('en-CA')}\n`)
  console.log('RESOURCE-LEVEL (any rail payable) — cumulative')
  let cum = 0
  const label = { today: 'THIS BUILD can pay', stage03: '+ stage 03 EVM presets', stage04: '+ stage 04 non-EVM exact buyers' }
  for (const s of ORDER) { cum += c.perStage[s]; console.log(`  ${label[s].padEnd(38)} ${String(c.perStage[s]).padStart(6)}  → ${String(cum).padStart(6)}  ${pct(cum)}`) }
  console.log(`  ${'unreachable by design'.padEnd(38)} ${String(c.never).padStart(6)}           ${pct(c.never)}`)
  console.log(`\n  for reference, the 2.15.1 predicate (required extra.assetTransferMethod, no v1): ${c.baseline} = ${pct(c.baseline).trim()}`)
  console.log('\nRAIL-LEVEL by network (exact rails)')
  console.log(`  ${'network'.padEnd(52)} ${'rails'.padStart(6)} ${'now'.padStart(7)} ${'+03'.padStart(7)} ${'+04'.padStart(7)}  never`)
  const rows = [...c.perNet.entries()].sort((a, b) => b[1].rails - a[1].rails).slice(0, 30)
  let allRails = 0, allByStage = Object.fromEntries(ORDER.map((x) => [x, 0]))
  for (const [, p] of c.perNet) { allRails += p.rails; for (const s of ORDER) allByStage[s] += p.byStage[s] }
  for (const [n, p] of rows) {
    let acc = 0; const cells = ORDER.map((s) => { acc += p.byStage[s]; return String(acc).padStart(6) })
    console.log(`  ${n.padEnd(52)} ${String(p.rails).padStart(6)} ${cells.join(' ')}  ${p.never}`)
  }
  let acc = 0
  const allCells = ORDER.map((s) => { acc += allByStage[s]; return `${String(acc).padStart(6)} (${pct(acc, allRails).trim()})` })
  console.log(`  ${'ALL'.padEnd(52)} ${String(allRails).padStart(6)} ${allCells.join(' ')}`)
  console.log(`  for reference, the 2.15.1 predicate at RAIL level: ${c.baselineRails} = ${pct(c.baselineRails, allRails).trim()}`)
  const shipped = rows.filter(([n]) => evmId(n) !== null ? EVM_PRESET_IDS.has(evmId(n)) : NONEVM_EXACT_TODAY.has(normalize(n)))
  const weak = shipped.filter(([, p]) => p.byStage.today / p.rails < 0.95)
  console.log(`\nGATE: shipped mainnets below 95% rail-level in THIS build: ${weak.length ? weak.map(([n]) => n).join(', ') : 'none'}`)
}

/* ------------------------------------------------------------------ --live */
function sample(resources, n = 12) {
  const pick = (pred, k) => resources.filter((r) => (r.accepts ?? []).some(pred)).slice(0, k).map((r) => r.resource ?? r.url)
  const out = [
    ...pick((a) => a.scheme === 'exact' && a.network === 'eip155:8453' && a.extra?.name && !a.extra?.assetTransferMethod, 3).map((u) => ['v2 domain-only Base', u]),
    ...pick((a) => a.scheme === 'exact' && a.network === 'eip155:8453' && typeof a.extra?.assetTransferMethod === 'string', 2).map((u) => ['v2 marker Base', u]),
    ...pick((a) => a.scheme === 'exact' && a.network === 'base', 2).map((u) => ['v1 slug base', u]),
    ...pick((a) => a.scheme === 'exact' && a.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' && a.extra?.feePayer, 2).map((u) => ['v2 Solana feePayer', u]),
    ...pick((a) => a.scheme === 'exact' && a.network === ALGO_SPEC, 1).map((u) => ['v2 Algorand spec-id', u]),
    ...pick((a) => a.scheme === 'upto', 1).map((u) => ['v2 upto', u]),
    ...pick((a) => a.scheme === 'exact' && a.network === 'xrpl:0', 1).map((u) => ['v2 XRPL', u]),
  ]
  const seen = new Set()
  return out.filter(([, u]) => (seen.has(u) ? false : seen.add(u))).slice(0, n)
}
/**
 * Bind one read-only client per family, each on a THROWAWAY key. A quote never signs, so the key
 * only has to be well-formed — but it must be the right SHAPE per family, or the driver refuses
 * to bind and every rail on that chain reports a false failure (which is how the Solana, Algorand
 * and XRPL rows used to come back "not wired" and hide real coverage).
 */
async function liveClients(sdk) {
  const out = {}
  const bind = (name, fn) => { try { out[name] = fn() } catch (e) { out[name] = { _err: e } } }
  const { generatePrivateKey } = await import(join(REPO, 'node_modules', 'viem', '_esm', 'accounts', 'index.js'))
  const schemes = ['onchain-proof', 'exact', 'upto']
  bind('evm', () => new sdk.PipRailClient({ chain: 'base', privateKey: generatePrivateKey(), schemes }))
  try {
    const { Keypair } = await import(join(REPO, 'node_modules', '@solana', 'web3.js', 'lib', 'index.cjs.js'))
    const secret = Buffer.from(Keypair.generate().secretKey).toString('base64')
    bind('solana', () => new sdk.PipRailClient({ chain: 'solana', privateKey: secret, schemes }))
  } catch (e) { out.solana = { _err: e } }
  try {
    const algosdk = (await import(join(REPO, 'node_modules', 'algosdk', 'dist', 'cjs', 'index.js'))).default
    const acct = algosdk.generateAccount()
    bind('algorand', () => new sdk.PipRailClient({ chain: 'algorand', privateKey: algosdk.secretKeyToMnemonic(acct.sk), schemes }))
  } catch (e) { out.algorand = { _err: e } }
  try {
    const { Wallet } = await import(join(REPO, 'node_modules', 'xrpl', 'dist', 'npm', 'index.js'))
    bind('xrpl', () => new sdk.PipRailClient({ chain: 'xrpl', privateKey: Wallet.generate().seed, schemes }))
  } catch (e) { out.xrpl = { _err: e } }
  return out
}

async function live(sdk, resources) {
  if (!sdk) { console.error('--live needs sdk/dist (npm run build:sdk)'); return [] }
  const clients = await liveClients(sdk)
  const rows = []
  console.log('\nLIVE quote() — real SDK against real third-party 402s, read-only, throwaway keys')
  for (const [kind, url] of sample(resources)) {
    const fam = /Solana/.test(kind) ? 'solana' : /Algorand/.test(kind) ? 'algorand' : /XRPL/.test(kind) ? 'xrpl' : 'evm'
    const c = clients[fam]
    if (!c || c._err) {
      console.log(`  ⏭  ${kind.padEnd(22)} ${fam} client unavailable: ${c?._err?.message?.slice(0, 60) ?? 'not built'}  ${url}`)
      rows.push({ kind, url, ok: null })
      continue
    }
    try {
      const q = await c.quote(url)
      if (q === null) {
        // Not a coverage failure: `quote()` contractually returns null when the URL did not answer
        // 402 at all. Common in the catalog — a POST-only endpoint 405s a probe GET, and a listing
        // can outlive its endpoint. Counted separately so it can never be read as "unpayable".
        console.log(`  ➖ ${kind.padEnd(22)} no 402 on GET (POST-only or delisted)  ${url}`)
        rows.push({ kind, url, ok: null, reason: 'not-gated-on-GET' })
        continue
      }
      console.log(`  ✅ ${kind.padEnd(22)} ${q.network} ${q.amountFormatted} ${q.symbol ?? q.asset} recognized=${q.recognized}  ${url}`)
      rows.push({ kind, url, ok: true, network: q.network, amount: q.amountFormatted, symbol: q.symbol })
    } catch (e) {
      console.log(`  ❌ ${kind.padEnd(22)} ${e.code ?? e.name}: ${String(e.message).slice(0, 90)}  ${url}`)
      rows.push({ kind, url, ok: false, code: e.code ?? e.name })
    }
  }
  const tried = rows.filter((r) => r.ok !== null)
  console.log(`  → ${tried.filter((r) => r.ok).length}/${tried.length} live third-party 402s quotable`)
  return rows
}

/* ------------------------------------------------------------------ --fixture */
function writeFixtures(dir, resources) {
  mkdirSync(dir, { recursive: true })
  /*
   * [tag, predicate, count, expected verdict from the CURRENT build, why]
   * `expect` is a deliberate, human-reviewed assertion — NOT `railStage`'s own output, or the
   * regression test would just be this script agreeing with itself. The test drives the real
   * PipRailClient against each fixture and compares against these.
   */
  /*
   * Each `pick` returns THE RAIL the shape is about, or undefined if the resource doesn't match.
   * Returning the rail (not just a boolean) matters: most resources offer several rails, so the
   * manifest has to record which network the fixture is testing. An xrpl-tagged resource that also
   * co-offers Base would otherwise be "payable" via the Base rail and prove nothing about XRPL.
   */
  const evmExact = (a) => a.scheme === 'exact' && EVM_PRESET_IDS.has(evmId(a.network) ?? -1)
  const shapes = [
    ['v2-domain-only', (r) => (r.x402Version === 2 ? r.accepts.find((a) => evmExact(a) && a.extra?.name && !a.extra?.assetTransferMethod) : undefined), 20, 'payable', 'no marker → spec default eip3009'],
    ['v2-marker', (r) => r.accepts.find((a) => evmExact(a) && typeof a.extra?.assetTransferMethod === 'string'), 5, 'payable', 'names a method we implement'],
    ['v1-slug', (r) => (r.x402Version === 1 ? r.accepts.find((a) => a.scheme === 'exact') : undefined), 8, 'payable', 'v1 body is normalized; answered on the v1 wire'],
    ['solana', (r) => r.accepts.find((a) => a.scheme === 'exact' && a.network.startsWith('solana:5eykt') && a.extra?.feePayer), 8, 'payable', 'SVM scheme defines no marker; feePayer is its required key'],
    ['algorand-spec-id', (r) => r.accepts.find((a) => a.network === ALGO_SPEC), 5, 'payable', 'the spec 32-char CAIP-2 aliases to our padded id'],
    ['algorand-padded', (r) => r.accepts.find((a) => a.network === ALGO_PADDED), 2, 'payable', 'our own bound id'],
    ['upto', (r) => r.accepts.find((a) => a.scheme === 'upto' && typeof a.extra?.facilitatorAddress === 'string' && EVM_PRESET_IDS.has(evmId(a.network) ?? -1)), 4, 'payable', 'opt-in metered rail, conformant (carries the spec-mandated facilitatorAddress)'],
    // The upto spec REQUIRES extra.facilitatorAddress — the buyer signs it into the Permit2
    // witness, and only that address can settle. A rail without it cannot be signed safely, so
    // refusing it is correct behaviour, not a coverage gap. Locked here so nobody "fixes" it.
    ['upto-nonconformant', (r) => (r.accepts.some((a) => a.scheme === 'exact') ? undefined : r.accepts.find((a) => a.scheme === 'upto' && typeof a.extra?.facilitatorAddress !== 'string')), 2, 'blocked', 'upto rail missing the spec-mandated facilitatorAddress — correctly refused'],
    ['xrpl', (r) => r.accepts.find((a) => a.network === 'xrpl:0'), 4, 'blocked', 'stage 04 — no XRPL exact BUYER yet'],
    ['stellar', (r) => r.accepts.find((a) => a.network === 'stellar:pubnet'), 2, 'blocked', 'stage 04 — no Stellar exact BUYER yet'],
    ['batch-settlement-co-offer', (r) => (r.accepts.some((a) => a.scheme === 'batch-settlement') ? r.accepts.find(evmExact) : undefined), 2, 'payable', 'we ignore batch-settlement and pay the co-offered exact rail'],
  ]
  const manifest = []
  const used = new Set()
  for (const [tag, pick, k, expected, why] of shapes) {
    let i = 0
    for (const r of resources) {
      const u = r.resource ?? r.url
      if (used.has(u)) continue
      const rail = pick(r)
      if (!rail) continue
      used.add(u); i += 1
      // The catalog is a PROJECTION of the live 402, not the wire body: the resource URL is a top-level
      // string, `description` sits beside it, and v2 accepts gain catalog-only `maxAmountRequired`/`currency`/
      // `recipient` duplicates. Rebuild the wire shape the client actually parses (v2: a `resource` OBJECT;
      // v1: per-accept `resource` string, no top-level object) so isValidChallenge sees what a server sends.
      const trunc = (d) => (d ? { description: String(d).slice(0, 80) } : {})
      const accepts = r.accepts.map((a) => { const { outputSchema, description, ...rest } = a; return { ...rest, ...trunc(description) } })
      const fixture = r.x402Version === 1
        ? { x402Version: 1, accepts }
        : { x402Version: 2, resource: { url: String(r.resource ?? r.url), ...trunc(r.description) }, accepts }
      const name = `${tag}-${String(i).padStart(2, '0')}.json`
      writeFileSync(join(dir, name), JSON.stringify(fixture, null, 2) + '\n')
      // `network` is the rail the fixture is ABOUT — the test binds a client to it, so a
      // co-offered rail on another chain can never stand in for the one under test.
      manifest.push({ file: name, shape: tag, source: u, network: String(rail.network), scheme: String(rail.scheme), fetched: new Date().toLocaleDateString('en-CA'), expect: expected, why })
      if (i >= k) break
    }
  }
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\nwrote ${manifest.length} fixtures + MANIFEST.json → ${dir}`)
}

/* ------------------------------------------------------------------ main */
const sdk = await loadSdkFacts()
const corpus = await fetchCorpus(opt('--cache'))
const c = classify(corpus.resources)
report(corpus, c)
const liveRows = flag('--live') ? await live(sdk, corpus.resources) : null
if (opt('--fixture')) writeFixtures(opt('--fixture'), corpus.resources)

// The single machine-readable owner of the coverage figure. Every doc/site/CHANGELOG line that
// quotes a percentage cites THIS file's `resourceLevel.today`, so the number can never be
// hand-edited into disagreeing with the measurement.
if (opt('--json')) {
  const T = corpus.resources.length
  let cum = 0
  const resourceLevel = {}
  for (const s of ORDER) {
    cum += c.perStage[s]
    resourceLevel[s] = { resources: cum, share: Number(((100 * cum) / T).toFixed(1)) }
  }
  let railTotal = 0
  const railByStage = Object.fromEntries(ORDER.map((s) => [s, 0]))
  for (const [, p] of c.perNet) {
    railTotal += p.rails
    for (const s of ORDER) railByStage[s] += p.byStage[s]
  }
  let racc = 0
  const railLevel = {}
  for (const s of ORDER) {
    racc += railByStage[s]
    railLevel[s] = { rails: racc, share: Number(((100 * racc) / railTotal).toFixed(1)) }
  }
  const payload = {
    $comment:
      'GENERATED by `npm run x402:coverage -- --json <path>`. Never hand-edit: every coverage ' +
      'figure quoted anywhere in this repo cites resourceLevel.today.share from here.',
    measuredAt: new Date().toLocaleDateString('en-CA'),
    baselineBefore216: {
      resources: c.baseline,
      share: Number(((100 * c.baseline) / T).toFixed(1)),
      // The same 2.15.1 predicate counted per RAIL. Present so the CHANGELOG's rail-level
      // before/after cites this file too, instead of a number somebody worked out by hand.
      rails: c.baselineRails,
      railShare: Number(((100 * c.baselineRails) / railTotal).toFixed(1)),
    },
    source: { index: 'CDP Bazaar', url: BAZAAR, resources: T, exactRails: railTotal },
    resourceLevel,
    railLevel,
    ...(liveRows ? { liveProbe: liveRows } : {}),
  }
  writeFileSync(opt('--json'), JSON.stringify(payload, null, 2) + '\n')
  console.log(`\nwrote ${opt('--json')} (resource-level today: ${resourceLevel.today.share}%)`)
}
