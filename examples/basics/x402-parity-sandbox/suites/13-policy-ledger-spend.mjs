// Suite 13 — SPEND POLICY + LEDGER decision surface  (POL-1 leash, deeper than suite 03)
//
// The spend policy is a SECURITY boundary: it is the only thing standing between a headless
// agent and an unbounded wallet. This suite hammers the pure decision surface OFFLINE — the
// full deny matrix (every PolicyDenyCode), the never-throw ledger under corrupt persistence,
// and the human-facing helpers — with hostile / malformed / overflow-shaped inputs. No money,
// no chain: the whole point is to break the LOGIC, not to spend.
//
//   evaluatePolicy   — decision matrix: allow / per-call / per-asset / per-denom / count / window
//                      / chain / host / token / session caps; zero, near-MAX_SAFE_INTEGER, and
//                      bigint-overflow-shaped amounts; first-failure-wins ordering.
//   PipRailClient    — the documented validation BOUNDARY: a malformed cap is rejected at
//                      construction (TypeError), so evaluatePolicy only ever sees a clean cap.
//   SpendLedger      — record / readback / totals; an UNTRUSTED store (corrupt/negative/missing
//   + memorySpendStore  records, a throwing load/append) fails SAFE — drops the record, never throws.
//   fileSpendStore   — (@piprail/sdk/node) durable JSONL round-trip incl. decimals+denom, skips a
//                      corrupt line, then cleans up the temp dir.
//   formatSpendReport / summarizePlan / explainDecline / decorateOutcome — the agent-readable
//                      one-liners over their CONTRACTED inputs (and a light hostile probe).
//
import {
  evaluatePolicy, denomOf, PipRailClient, SpendLedger, memorySpendStore,
  formatSpendReport, summarizePlan, explainDecline, decorateOutcome,
  PaymentTimeoutError, ConfirmationTimeoutError, MaxRetriesExceededError,
} from '@piprail/sdk'
import { fileSpendStore } from '@piprail/sdk/node'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, DUMMY_KEY } from '../lib/env.mjs'
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

banner('13 · SPEND POLICY + LEDGER (POL-1 decision surface)')

// A canonical, recognized USDC-on-Base intent the matrix reasons over.
const INTENT = Object.freeze({
  host: 'api.example.com', chain: 'base', network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amountBase: 1000n,
  decimals: 6, symbol: 'USDC', recognized: true,
})
const ctx = (over = {}) => ({ now: 1_000, sessionStart: 0, spentInWindowBase: 0n, ...over })
// A well-formed SpendRecord (string base units, ISO `at`) the ledger can tally.
const rec = (over = {}) => ({
  url: 'http://127.0.0.1:1/r', host: 'x', network: 'eip155:8453',
  asset: INTENT.asset, amountBase: '1000', amountFormatted: '0.001',
  symbol: 'USDC', decimals: 6, denom: 'USD', ref: '0xabc', at: new Date().toISOString(), ...over,
})

/** Call `fn`; FAIL `msg` if it THROWS (the never-throw contract), else return its result. */
function noThrow(label, fn) {
  try { return { ok: true, value: fn() } }
  catch (e) { check(false, `${label} threw (${e?.constructor?.name}: ${String(e?.message).slice(0, 80)})`); return { ok: false } }
}

// ════════════════════════ evaluatePolicy — the deny matrix ════════════════════════
group('evaluatePolicy — allow / no-policy / first-failure ordering')
{
  check(typeof evaluatePolicy === 'function', 'evaluatePolicy is exported (the pure decision fn)')
  // No policy / null / undefined / empty {} all ALLOW (a missing leash is unguarded by design).
  for (const [label, pol] of [['undefined', undefined], ['null', null], ['empty {}', {}]]) {
    const d = evaluatePolicy(INTENT, pol, 0n)
    check(d?.allowed === true, `policy=${label} → allowed:true (no leash = unguarded, default)`)
  }
  const within = evaluatePolicy(INTENT, { maxTotal: '0.002' }, 0n)
  check(within.allowed === true && within.code === undefined, 'within maxTotal (0.001 ≤ 0.002) → allow, no code')
}

group('evaluatePolicy — every PolicyDenyCode fires with the right typed code')
{
  // The DOCUMENTED PolicyDenyCode union; every deny path below must produce one of these and nothing else.
  const CODES = new Set(['CHAIN', 'HOST', 'UNKNOWN_TOKEN', 'TOKEN', 'MAX_AMOUNT', 'MAX_TOTAL', 'MAX_TOTAL_DENOM', 'MAX_PAYMENTS', 'SESSION_EXPIRED', 'WINDOW_TOTAL', 'WINDOW_COUNT'])
  const seen = new Set()
  const denies = [
    ['MAX_AMOUNT (per-call cap)', INTENT, { maxAmount: '0.0005' }, 0n, undefined],
    ['MAX_TOTAL (per-asset lifetime cap)', INTENT, { maxTotal: '0.0005' }, 0n, undefined],
    ['MAX_TOTAL (running total pushes over)', INTENT, { maxTotal: '0.001' }, 500n, undefined],
    ['TOKEN (symbol not in allowlist)', INTENT, { tokens: ['USDT'] }, 0n, undefined],
    ['CHAIN (chain not in allowlist)', INTENT, { chains: ['solana'] }, 0n, undefined],
    ['HOST (host not in allowlist)', INTENT, { hosts: ['other.example.com'] }, 0n, undefined],
    ['UNKNOWN_TOKEN (unrecognized, no override)', { ...INTENT, recognized: false, symbol: undefined }, {}, 0n, undefined],
    ['SESSION_EXPIRED (ttl elapsed)', INTENT, { ttlSeconds: 0 }, 0n, ctx({ now: 1 })],
    ['SESSION_EXPIRED (expiresAt past)', INTENT, { expiresAt: 500 }, 0n, ctx({ now: 1_000 })],
    ['MAX_PAYMENTS (count cap)', INTENT, { maxPayments: 2 }, 0n, ctx({ paymentCount: 2 })],
    ['MAX_TOTAL_DENOM (cross-token grand total)', INTENT, { maxTotalPerDenom: { USD: '0.0005' } }, 0n, ctx({ spentInDenomScaled: 0n })],
    ['WINDOW_TOTAL (rolling amount cap)', INTENT, { windowTotal: '0.0005', windowSeconds: 60 }, 0n, ctx({ spentInWindowBase: 0n })],
    ['WINDOW_COUNT (rolling count cap)', INTENT, { maxPaymentsPerWindow: 1, windowSeconds: 60 }, 0n, ctx({ paymentCountInWindow: 1 })],
  ]
  for (const [label, intent, policy, spent, c] of denies) {
    const d = noThrow(`evaluatePolicy ${label}`, () => evaluatePolicy(intent, policy, spent, c))
    if (!d.ok) continue
    const dec = d.value
    const expected = label.split(' ')[0]
    check(dec?.allowed === false, `deny — ${label} → allowed:false`)
    check(dec?.code === expected, `deny — ${label} → code === ${expected} (got ${dec?.code})`)
    check(CODES.has(dec?.code), `deny — ${label}: code is from the documented PolicyDenyCode set`)
    check(typeof dec?.reason === 'string' && dec.reason.length > 0, `deny — ${label}: carries a non-empty human reason`)
    seen.add(dec?.code)
  }
  // We exercised every code except the (validation-time) ones; assert broad coverage.
  check(seen.size >= 9, `the deny matrix exercised ${seen.size} distinct PolicyDenyCodes (≥9)`)
}

group('evaluatePolicy — allow paths: allowlist hits, native alias, unknown-token override')
{
  check(evaluatePolicy(INTENT, { tokens: ['usdc'] }, 0n).allowed === true, 'token allowlist is case-insensitive on the TRUE symbol (usdc ~ USDC)')
  check(evaluatePolicy(INTENT, { hosts: ['*.example.com'] }, 0n).allowed === true, 'host wildcard *.example.com matches api.example.com')
  check(evaluatePolicy({ ...INTENT, asset: 'native', symbol: 'ETH' }, { tokens: ['native'] }, 0n).allowed === true, "tokens:['native'] is the chain-agnostic native-coin alias")
  check(evaluatePolicy({ ...INTENT, recognized: false, symbol: undefined }, { allowUnknownTokens: true }, 0n).allowed === true, 'allowUnknownTokens:true lets an unrecognized asset through (explicit opt-in risk)')
}

group('evaluatePolicy — first-failure-wins ordering (session expiry is reported first)')
{
  // Expiry is session-global; it must win over an also-failing chain/host/token gate so the
  // reported reason is the most fundamental one.
  const d = evaluatePolicy(INTENT, { ttlSeconds: 0, chains: ['solana'], tokens: ['USDT'] }, 0n, ctx({ now: 1 }))
  check(d.code === 'SESSION_EXPIRED', 'an expired session reports SESSION_EXPIRED even when chain+token would ALSO fail')
}

group('evaluatePolicy — zero / near-MAX_SAFE_INTEGER / bigint-overflow-shaped amounts')
{
  // A zero cap denies any positive payment (it is not silently treated as "no cap").
  check(evaluatePolicy(INTENT, { maxTotal: '0' }, 0n).code === 'MAX_TOTAL', "maxTotal:'0' is a real cap → denies a 0.001 payment (not 'unlimited')")
  check(evaluatePolicy(INTENT, { maxAmount: '0' }, 0n).code === 'MAX_AMOUNT', "maxAmount:'0' denies any positive payment")
  // A cap at MAX_SAFE_INTEGER (a huge but valid decimal string) must allow and must not overflow.
  const huge = String(Number.MAX_SAFE_INTEGER) // 9007199254740991
  check(evaluatePolicy(INTENT, { maxTotal: huge }, 0n).allowed === true, 'maxTotal near Number.MAX_SAFE_INTEGER → allow (no overflow / coercion bug)')
  // Amounts ABOVE MAX_SAFE_INTEGER stay exact: the SDK budgets in bigint base units, never Number.
  const overMax = { ...INTENT, amountBase: 9_007_199_254_740_993n, decimals: 0 } // > 2^53, would lose precision as a Number
  check(evaluatePolicy(overMax, { maxTotal: '99999999999999999999' }, 0n).allowed === true, 'an amount > MAX_SAFE_INTEGER (bigint) with a bigger cap → allow (no Number() precision loss)')
  check(evaluatePolicy(overMax, { maxTotal: '1' }, 0n).code === 'MAX_TOTAL', 'the same >MAX_SAFE amount against a tiny cap → MAX_TOTAL (the bigint compare is exact)')
  // spent + amount both past MAX_SAFE: the SUM must not overflow into a false allow/deny.
  check(evaluatePolicy(overMax, { maxTotal: '99999999999999999999999' }, 9_007_199_254_740_993n).allowed === true, 'huge spent + huge amount, both bigint → the SUM is exact (no overflow)')
}

group('denomOf — pure denomination resolution (no oracle, no chain read)')
{
  check(noThrow('denomOf USDC', () => denomOf('USDC', INTENT.asset, undefined)).value === 'USD', 'denomOf(USDC) → USD (built-in label)')
  check(denomOf('ETH', 'native', undefined) === undefined, 'denomOf(native) → undefined (native coin is in no denomination bucket)')
  check(denomOf('TOTALLYFAKE', '0xdead', undefined) === undefined, 'denomOf(unknown) → undefined (not summed into any grand total)')
  check(denomOf('PYUSD', '0xabc', { denomFor: { PYUSD: 'USD' } }) === 'USD', "denomFor override folds a custom token into 'USD'")
}

// ════════════════════════ malformed policy / records — never an UNHANDLED crash ════════════════════════
group('malformed policies — the CLIENT constructor is the documented validation boundary')
{
  // A malformed amount cap is a programmer error: it must be caught LOUDLY at construction (a
  // half-armed leash is forbidden), NOT lazily inside a never-throw read. Pin the throw + type.
  const ctorThrows = (label, policy) => {
    let threw = null
    try { new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, policy }) } catch (e) { threw = e }
    check(threw instanceof TypeError, `ctor rejects ${label} with a TypeError (got ${threw?.constructor?.name ?? 'no throw'})`)
  }
  ctorThrows("maxTotal:'abc' (not a decimal)", { maxTotal: 'abc' })
  ctorThrows("maxAmount:'-5' (negative)", { maxAmount: '-5' })
  ctorThrows("maxAmount: 5 (number, not string)", { maxAmount: 5 })
  ctorThrows('windowTotal without windowSeconds (half-armed leash)', { windowTotal: '1.00' })
  ctorThrows("maxTotalPerDenom:{ USD: 'x' } (bad amount)", { maxTotalPerDenom: { USD: 'x' } })
  // A WELL-FORMED policy constructs cleanly and exposes itself.
  const good = noThrow('ctor with a good policy', () => new PipRailClient({ chain: 'base', wallet: { key: DUMMY_KEY }, policy: { maxTotal: '0.10', tokens: ['USDC'] } }))
  check(good.ok && typeof good.value?.policy === 'function', 'a well-formed policy constructs and is readable via client.policy()')
}

group('evaluatePolicy — structurally-odd-but-typed intents return a decision (no crash)')
{
  // An intent with missing fields (recognized:undefined → falsy) must still DECIDE, not throw.
  const d1 = noThrow('evaluatePolicy({}, {maxAmount})', () => evaluatePolicy({}, { allowUnknownTokens: false }, 0n))
  check(d1.ok && d1.value?.allowed === false, 'a bare {} intent against a guarded policy → a DECISION (denied UNKNOWN_TOKEN), not a throw')
}

// ════════════════════════ SpendLedger + memorySpendStore — record / readback / fail-safe ════════════════════════
group('SpendLedger + memorySpendStore — spend accumulates, the summary reflects totals')
{
  const L = new SpendLedger()
  const s0 = L.summary()
  check(s0.count === 0 && s0.byAsset.length === 0 && s0.records.length === 0, 'a fresh ledger summary is empty (count 0, no buckets, no records)')

  L.record(rec({ ref: '0x1' }), 6, 'USD')
  L.record(rec({ amountBase: '2000', amountFormatted: '0.002', ref: '0x2' }), 6, 'USD')
  const s = L.summary()
  check(s.count === 2, 'after 2 settles the summary count === 2')
  check(s.byAsset[0]?.totalBase === '3000', 'per-asset running total accumulates exactly (1000 + 2000 = 3000 base)')
  check(s.byAsset[0]?.count === 2, 'the per-asset bucket counts both payments')
  check(L.totalFor('eip155:8453', INTENT.asset) === 3000n, 'totalFor(network,asset) === 3000n (the cap denominator)')
  check(L.totalForDenom('USD') === L.totalForDenom('usd'), 'totalForDenom is case-insensitive (USD === usd)')
  check(L.count() === 2, 'ledger.count() === 2 (powers maxPayments)')
  check(s.byDenom[0]?.denom === 'USD' && s.byDenom[0]?.count === 2, 'the cross-token grand total bucket is USD with count 2')
  check(s.byDenom[0]?.totalFormatted === '0.003', "the USD grand total formats to '0.003' (1:1 sum, no price oracle)")

  // An over-budget call is declined by the SPECIFIC cap, using the ledger's real running total.
  const over = evaluatePolicy(INTENT, { maxTotal: '0.003' }, L.totalFor('eip155:8453', INTENT.asset))
  check(over.code === 'MAX_TOTAL', 'a payment that pushes the LEDGER total past maxTotal is declined by MAX_TOTAL specifically (0.003 + 0.001 > 0.003)')
}

group('SpendLedger — an UNTRUSTED store cannot brick a read or the constructor (fail-safe)')
{
  // Hydrate from corrupt / hostile records: each bad record is DROPPED, never throws.
  for (const [label, bad] of [
    ['non-numeric amountBase', rec({ amountBase: 'not-a-number' })],
    ['negative amountBase', rec({ amountBase: '-100' })],
    ['fractional amountBase', rec({ amountBase: '1.5' })],
    ['decimals out of range (999)', rec({ decimals: 999 })],
    ['empty {} record', {}],
  ]) {
    const r = noThrow(`new SpendLedger(store[${label}])`, () => new SpendLedger(memorySpendStore([bad])).summary())
    if (r.ok) check(r.value.count === 0, `a corrupt hydrated record (${label}) is DROPPED, not tallied (count 0)`)
  }
  // A valid record alongside a corrupt one: the good one still lands.
  const mixed = noThrow('mixed good+corrupt hydrate', () => new SpendLedger(memorySpendStore([rec({ ref: '0xgood' }), rec({ amountBase: 'NaN', ref: '0xbad' })])).summary())
  if (mixed.ok) check(mixed.value.count === 1, 'a good record survives next to a corrupt one (count 1)')

  // A store whose load() THROWS → ledger fails safe to empty, never throws at construction.
  const throwingLoad = noThrow('new SpendLedger(throwing load)', () => new SpendLedger({ load() { throw new Error('disk gone') }, append() {} }).summary())
  if (throwingLoad.ok) check(throwingLoad.value.count === 0, 'a throwing store.load() fails SAFE to an empty ledger (never blocks construction)')

  // A store whose append() THROWS → record() swallows it (the contract: append MUST NOT throw out).
  const throwingAppend = noThrow('record() with a throwing append', () => {
    const L = new SpendLedger({ load() { return [] }, append() { throw new Error('disk full') } })
    L.record(rec(), 6, 'USD')
    return L.summary()
  })
  if (throwingAppend.ok) check(throwingAppend.value.count === 1, 'a throwing store.append() never escapes record() — the in-memory tally still updates')
}

group('memorySpendStore — seed round-trips through the ledger and live appends are visible')
{
  const store = memorySpendStore([rec({ amountBase: '5000', ref: '0xseed' })])
  check(store.load().length === 1, 'memorySpendStore(seed) exposes the seed via load()')
  const L = new SpendLedger(store)
  check(L.summary().byAsset[0]?.totalBase === '5000', 'the ledger HYDRATES from the seed (5000 base)')
  L.record(rec({ amountBase: '1000', ref: '0xnew' }), 6, 'USD')
  check(store.load().length === 2, 'a live record() APPENDS back to the store (seed + new = 2)')
}

// ════════════════════════ fileSpendStore (@piprail/sdk/node) — durable JSONL round-trip ════════════════════════
group('fileSpendStore — durable JSONL round-trip (decimals+denom), skips corrupt line, then cleans up')
{
  const dir = mkdtempSync(join(tmpdir(), 'piprail-spend-13-'))
  const path = join(dir, 'spend.jsonl')
  try {
    const store = noThrow('fileSpendStore(fresh)', () => fileSpendStore(path))
    if (store.ok) {
      check(store.value.load().length === 0 && !existsSync(path), 'a fresh fileSpendStore loads [] and does not create the file until first write')
      store.value.append(rec({ ref: '0xf1' }))
      store.value.append(rec({ amountBase: '2000', ref: '0xf2' }))
      check(existsSync(path), 'append() creates the JSONL log on first write')

      // Reload from disk in a SEPARATE store instance — the whole record round-trips.
      const reloaded = fileSpendStore(path).load()
      check(reloaded.length === 2, 'a separate fileSpendStore reloads both records from disk')
      check(reloaded[0]?.ref === '0xf1' && reloaded[1]?.amountBase === '2000', 'ref + amountBase round-trip intact')
      check(reloaded[0]?.decimals === 6 && reloaded[0]?.denom === 'USD', 'decimals + denom round-trip (so totals + the grand total rebuild exactly)')

      // The ledger rebuilds the exact running total + count from the file.
      const L = new SpendLedger(fileSpendStore(path))
      check(L.totalFor('eip155:8453', INTENT.asset) === 3000n && L.count() === 2, 'a ledger backed by the file rebuilds totals exactly (3000 base, count 2)')

      // A corrupt line is skipped, never fatal; a following good line still loads.
      appendFileSync(path, 'this is not json\n')
      appendFileSync(path, JSON.stringify(rec({ ref: '0xf3' })) + '\n')
      const afterCorrupt = noThrow('fileSpendStore load after a corrupt line', () => new SpendLedger(fileSpendStore(path)).count())
      if (afterCorrupt.ok) check(afterCorrupt.value === 3, 'a corrupt JSONL line is SKIPPED (not fatal); the good lines around it still load (count 3)')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    check(!existsSync(dir), 'temp spend dir cleaned up')
  }
}

// ════════════════════════ formatSpendReport / summarizePlan / explainDecline / decorateOutcome ════════════════════════
group('formatSpendReport — a one-line spend summary over a REAL ledger summary')
{
  const empty = new SpendLedger().summary()
  const r0 = noThrow('formatSpendReport(empty)', () => formatSpendReport(empty))
  if (r0.ok) check(typeof r0.value === 'string' && /no payments yet/i.test(r0.value), "formatSpendReport(empty) → 'no payments yet'")

  const L = new SpendLedger()
  L.record(rec({ ref: '0xr1' }), 6, 'USD')
  L.record(rec({ amountBase: '2000', ref: '0xr2' }), 6, 'USD')
  const r = noThrow('formatSpendReport(2 payments)', () => formatSpendReport(L.summary()))
  if (r.ok) {
    check(typeof r.value === 'string' && r.value.length > 0, 'formatSpendReport returns a non-empty one-liner')
    check(/USDC/.test(r.value) && /USD total/i.test(r.value), "the report names the asset (USDC) and the cross-token grand total ('USD total')")
  }
}

group('summarizePlan — never throws on null / contracted PaymentPlan-ish inputs')
{
  // Documented: null → "no payment required". A plan-shaped object summarizes its rails.
  check(noThrow('summarizePlan(null)', () => summarizePlan(null)).value.length > 0, 'summarizePlan(null) → a non-empty "no payment required" line (no throw)')
  check(noThrow('summarizePlan(undefined)', () => summarizePlan(undefined)).value.length > 0, 'summarizePlan(undefined) → a non-empty line (no throw)')
  const odd = noThrow('summarizePlan({})', () => summarizePlan({}))
  check(odd.ok && typeof odd.value === 'string', 'summarizePlan({}) returns a string, never throws (defensive on a malformed plan)')
}

group('explainDecline — a one-line, agent-actionable string for any failure (never throws)')
{
  for (const [label, err] of [
    ['a plain Error', new Error('boom')],
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'nope'],
    ['a number', 42],
    ['a plain object', { code: 'X', message: 'y' }],
  ]) {
    const r = noThrow(`explainDecline(${label})`, () => explainDecline(err))
    if (r.ok) check(typeof r.value === 'string' && r.value.length > 0, `explainDecline(${label}) → a non-empty string (never throws)`)
  }
  // The LOAD-BEARING recovery rule: a broadcast-but-unconfirmed timeout must tell the agent to
  // recover via .ref and NEVER re-pay (a fresh payment would double-spend).
  const to = noThrow('explainDecline(PaymentTimeoutError)', () => explainDecline(new PaymentTimeoutError('timeout', { ref: '0xref' })))
  if (to.ok) check(/never re-pay/i.test(to.value) && /\.ref/i.test(to.value), 'an unconfirmed-timeout decline carries the recover-via-.ref / never-re-pay rule (double-spend safety)')
  check(typeof ConfirmationTimeoutError === 'function' && typeof MaxRetriesExceededError === 'function', 'the unconfirmed-recovery error types are exported')
}

group('decorateOutcome — projects lifecycle facts onto a REAL RegisterOutcome (idempotent)')
{
  // Contracted input: a RegisterOutcome from register402Index/registerX402Scan.
  const okOut = noThrow('decorateOutcome(ok 402index)', () => decorateOutcome({ source: '402index', ok: true }))
  if (okOut.ok) {
    check(okOut.value?.visibility === 'pending-review', 'a successful 402index outcome → visibility:pending-review (it reviews before publishing)')
    check(typeof okOut.value?.note === 'string' && okOut.value.note.length > 0, 'the outcome gains an agent-readable note')
  }
  const failOut = noThrow('decorateOutcome(failed 402index)', () => decorateOutcome({ source: '402index', ok: false }))
  if (failOut.ok) check(failOut.value?.visibility === 'not-listable', 'a FAILED outcome is always visibility:not-listable')
  // Idempotent: decorating twice yields the same projection.
  const once = decorateOutcome({ source: 'x402scan', ok: true })
  const twice = noThrow('decorateOutcome(twice)', () => decorateOutcome(once))
  if (twice.ok) check(twice.value?.visibility === once.visibility && twice.value?.note === once.note, 'decorateOutcome is idempotent (re-decorating is a no-op)')
}

// LIVE: nothing here needs the chain — the whole decision surface is pure. Note the skip explicitly.
if (!loadWallet() || process.env.PIPRAIL_LIVE !== '1') {
  skip('policy + ledger are a PURE decision surface — no live on-chain leg (all assertions ran offline)')
}

done('13 policy-ledger-spend')
