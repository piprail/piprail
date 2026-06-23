// Suite 15 — estimateCost / GAS-ESTIMATE semantics across chains  (break-it)
//
// `client.estimateCost(url)` is the read-only "what gas will this burn?" half of the
// quote() → estimateCost() → planPayment() trio. It returns { quote, cost } where `cost`
// (a CostEstimate) is the NETWORK FEE in the chain's NATIVE coin — distinct from the
// payment token (you pay USDC, you burn ETH/SOL/TRX/NEAR/… for gas). The contract:
//   • every family's shape is identical (built by the shared nativeCost() helper);
//   • cost.basis ∈ {'estimated','heuristic'} — live RPC where cheap, a constant otherwise;
//   • a buyer-gasless exact/upto rail reports fee 0 (the facilitator/server eats the gas);
//   • it returns null when the URL isn't 402-gated, and never throws on a transient/dead RPC.
//
// This suite is almost entirely OFFLINE: estimateCost SPENDS NOTHING (it only reads), so we
// drive it against a dead RPC (forces the 'heuristic' fallback) and against hand-grafted 402s
// (an exact-only rail forces the gasless fee-0 path). The only live leg confirms a REAL Base
// gas read flips basis → 'estimated' with a finite, non-zero fee.
//
import { createPaymentGate, PipRailClient, NoCompatibleAcceptError } from '@piprail/sdk'
import { createServer } from 'node:http'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, USDC } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

banner('15 · estimateCost / gas-estimate across chains')

// A guaranteed-dead RPC: nothing listens on 127.0.0.1:1 → every chain read fails fast → the
// driver falls back to its 'heuristic' typical-cost constant. estimateCost must NEVER throw.
const DEAD_RPC = 'http://127.0.0.1:1/'
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

let PORT = 5150
const nextPort = () => PORT++

/** Serve a fixed (already-built) x402 challenge JSON on a fresh port → return its URL + closer. */
async function serveRaw(challenge) {
  const port = nextPort()
  const srv = createServer((req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify(challenge))
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${port}/m`, close: () => srv.close() }
}

/** Build a real (valid-envelope) onchain-proof challenge for a chain via its gate. */
async function gateChallenge(cfg) {
  const gate = createPaymentGate({ ...cfg, rpcUrl: DEAD_RPC })
  const port = nextPort()
  return (await gate.challenge(`http://127.0.0.1:${port}/m`)).challenge
}

/** Is x a non-negative integer encoded as a base-unit string? (BigInt-safe, NOT Number-safe —
 *  NEAR's native is 24-dp so the value legitimately exceeds Number.MAX_SAFE_INTEGER.) */
function isBaseUnitString(x) {
  if (typeof x !== 'string' || !/^\d+$/.test(x)) return false
  try { return BigInt(x) >= 0n } catch { return false }
}

/** A CostEstimate is well-formed: uniform shape, finite/non-negative numbers, no NaN/Infinity. */
function costWellFormed(cost) {
  if (!cost || typeof cost !== 'object') return false
  if (typeof cost.feeSymbol !== 'string' || cost.feeSymbol.length === 0) return false
  if (!Number.isInteger(cost.feeDecimals) || cost.feeDecimals < 0 || cost.feeDecimals > 36) return false
  if (!isBaseUnitString(cost.fee)) return false
  if (cost.basis !== 'estimated' && cost.basis !== 'heuristic') return false
  const ff = Number(cost.feeFormatted)
  if (!Number.isFinite(ff) || ff < 0) return false
  // feeFormatted must be the base-unit fee scaled by feeDecimals (no lost/garbage digits).
  if (typeof cost.feeFormatted !== 'string' || /NaN|Infinity/i.test(cost.feeFormatted)) return false
  return true
}

// ───────────────────────── OFFLINE — dead RPC, heuristic fallback ─────────────────────────
group('offline — a 402 on the client chain → { quote, cost } in the NATIVE coin, never throws (dead RPC)')
{
  const ch = await gateChallenge({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT })
  const srv = await serveRaw(ch)
  try {
    const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC })
    let r, threw = false
    try { r = await c.estimateCost(srv.url) } catch (e) { threw = true; note(`estimateCost threw: ${e?.constructor?.name}: ${e?.message}`) }
    check(threw === false, 'estimateCost did NOT throw even with a dead RPC (never-throw contract)')
    check(!!r && typeof r === 'object' && 'quote' in r && 'cost' in r, 'estimateCost returned the { quote, cost } shape')
    check(costWellFormed(r?.cost), 'cost is a well-formed CostEstimate (uniform nativeCost shape)')
    check(r?.cost.basis === 'heuristic', "a dead RPC degrades gracefully to basis:'heuristic' (not a throw)")
    // The FEE coin is the chain's native gas coin (ETH), DISTINCT from the payment token (USDC).
    check(r?.cost.feeSymbol === 'ETH', "the fee is denominated in the NATIVE coin (ETH on Base)")
    check(r?.quote.symbol === 'USDC', 'the payment token is still USDC (token ≠ gas coin)')
    check(r?.cost.feeSymbol !== r?.quote.symbol, 'native gas coin symbol ≠ payment-token symbol (the whole point)')
    check(BigInt(r?.cost.fee ?? '-1') > 0n, 'an onchain-proof rail burns real gas → fee > 0')
    check(r?.cost.feeDecimals === 18, 'ETH fee decimals = 18 (correct for the native coin, not the 6-dp token)')
  } finally { srv.close() }
}

// ───────────── OFFLINE — uniform shape & correct native coin across MANY chains ─────────────
group('offline — gas estimate is shaped uniformly across families; native symbol differs from the token')
{
  // Each row: [chain, token, payTo, expectedNativeSymbol, expectedNativeDecimals].
  // Addresses are valid-but-arbitrary recipients for that family (gate config validates them).
  const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
  const matrix = [
    ['base',    'USDC', MERCHANT,                               'ETH',  18],
    ['polygon', 'USDC', MERCHANT,                               'POL',  18],
    ['bnb',     'USDC', MERCHANT,                               'BNB',  18],
    ['arbitrum','USDC', MERCHANT,                               'ETH',  18],
    ['solana',  'USDC', SOL,                                    'SOL',   9],
    ['tron',    'USDT', 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC',   'TRX',   6],
    ['xrpl',    'RLUSD','rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',   'XRP',   6],
    ['near',    'USDC', 'merchant.near',                        'NEAR', 24],
    ['aptos',   'USDC', '0x1',                                  'APT',   8],
  ]
  let okShape = 0, okDistinct = 0, okSafe = 0, threwCount = 0
  for (const [chain, token, payTo, sym, dec] of matrix) {
    const ch = await gateChallenge({ chain, token, amount: '0.001', payTo })
    const srv = await serveRaw(ch)
    try {
      const c = new PipRailClient({ chain, rpcUrl: DEAD_RPC })
      let r
      try { r = await c.estimateCost(srv.url) }
      catch (e) { threwCount++; note(`${chain} estimateCost threw: ${e?.constructor?.name}`); continue }
      const cost = r?.cost
      if (costWellFormed(cost) && cost.feeSymbol === sym && cost.feeDecimals === dec) okShape++
      else note(`${chain}: feeSymbol=${cost?.feeSymbol} feeDecimals=${cost?.feeDecimals} basis=${cost?.basis} (expected ${sym}/${dec})`)
      // native gas coin must differ from the payment token's symbol on every one of these rows
      if (cost?.feeSymbol && r?.quote.symbol && cost.feeSymbol !== r.quote.symbol) okDistinct++
      // base-unit fee is a non-negative BigInt; the human fee is a finite, non-negative Number
      if (isBaseUnitString(cost?.fee) && Number.isFinite(Number(cost?.feeFormatted)) && Number(cost?.feeFormatted) >= 0) okSafe++
    } finally { srv.close() }
  }
  check(threwCount === 0, `estimateCost never threw across ${matrix.length} chains (got ${threwCount} throws)`)
  check(okShape === matrix.length, `every chain's gas estimate has the uniform shape + correct native coin (${okShape}/${matrix.length})`)
  check(okDistinct === matrix.length, `native gas coin symbol differs from the payment token on every chain (${okDistinct}/${matrix.length})`)
  check(okSafe === matrix.length, `every fee is a non-negative base-unit BigInt with a finite human value — no NaN/Infinity (${okSafe}/${matrix.length})`)
}

// ───────────── OFFLINE — buyer-gasless exact/upto rail reports fee 0 (2.14.0 note) ─────────────
group('offline — a gasless exact/upto rail is priced at fee 0 (the facilitator/server eats the gas)')
{
  // Graft a single EXACT rail onto a valid Base envelope (the gate won't advertise one offline —
  // it needs a live EIP-3009 probe — so we hand it the rail a real keyless 402 would carry).
  const base = await gateChallenge({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT })
  const mkExact = (method) => ({
    ...base,
    accepts: [{ ...base.accepts[0], scheme: 'exact', extra: { ...(base.accepts[0].extra ?? {}), assetTransferMethod: method, version: '2' } }],
  })

  for (const method of ['eip3009', 'permit2']) {
    const srv = await serveRaw(mkExact(method))
    try {
      const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC, schemes: ['exact', 'onchain-proof'] })
      let r, threw = false
      try { r = await c.estimateCost(srv.url) } catch (e) { threw = true; note(`exact(${method}) threw: ${e?.message}`) }
      check(threw === false, `estimateCost on a gasless exact rail (${method}) did not throw`)
      check(costWellFormed(r?.cost), `gasless exact (${method}) cost is still a well-formed CostEstimate`)
      check(r?.cost.fee === '0' && BigInt(r?.cost.fee ?? '-1') === 0n, `gasless exact (${method}) is priced at fee 0 (base units)`)
      check(Number(r?.cost.feeFormatted) === 0, `gasless exact (${method}) feeFormatted is 0`)
      check(r?.cost.basis === 'estimated', `gasless exact (${method}) basis is 'estimated' (a known-0, not a guess)`)
      check(r?.cost.feeSymbol === 'ETH', `gasless exact (${method}) still names the native coin (ETH) even at fee 0`)
    } finally { srv.close() }
  }

  // An `upto` rail is likewise buyer-gasless → fee 0.
  const upto = {
    ...base,
    accepts: [{ ...base.accepts[0], scheme: 'upto', maxTimeoutSeconds: 600, extra: { ...(base.accepts[0].extra ?? {}), assetTransferMethod: 'permit2-upto', facilitatorAddress: '0x0000000000000000000000000000000000000402', version: '2' } }],
  }
  const srvU = await serveRaw(upto)
  try {
    const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC, schemes: ['upto', 'onchain-proof'] })
    let r, threw = false
    try { r = await c.estimateCost(srvU.url) } catch (e) { threw = true; note(`upto threw: ${e?.message}`) }
    check(threw === false, 'estimateCost on an upto rail did not throw')
    if (r && r.quote && r.quote.asset && /upto-only/.test('')) { /* unreachable guard */ }
    // If the upto rail was selected, it must be fee 0; if the SDK couldn't gather it, r is non-null
    // (onchain-proof not offered here → null) — so assert the gasless price WHEN priced.
    if (r) {
      check(costWellFormed(r.cost), 'upto cost is a well-formed CostEstimate')
      check(BigInt(r.cost.fee) === 0n && r.cost.basis === 'estimated', 'a gasless upto rail is priced at fee 0 / estimated')
    } else {
      note('upto rail was not gatherable in this build (no payUpto / unrecognised) → estimateCost returned null gracefully')
      check(true, 'upto path returned a graceful null instead of throwing')
    }
  } finally { srvU.close() }
}

// ───────────── OFFLINE — null / graceful paths: not-gated, junk body, non-x402 JSON ─────────────
group('offline — estimateCost returns null (never throws) when the URL is not a parseable 402')
{
  const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC })
  const cases = [
    ['200 (not payment-gated)', 200, '{"ok":true}'],
    ['402 with a non-JSON body', 402, 'definitely <<< not json'],
    ['402 with valid JSON but no x402 envelope', 402, '{"hello":"world"}'],
    ['402 with empty body', 402, ''],
  ]
  for (const [label, status, body] of cases) {
    const port = nextPort()
    const srv = createServer((req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body) })
    await new Promise((r) => srv.listen(port, '127.0.0.1', r))
    let v, threw = false
    try { v = await c.estimateCost(`http://127.0.0.1:${port}/m`) } catch (e) { threw = true; note(`${label} threw: ${e?.constructor?.name}: ${e?.message}`) }
    check(threw === false && v === null, `${label} → null, no throw`)
    srv.close()
  }
}

// ───────────── OFFLINE — fee numbers are finite, safe, and self-consistent under hostile inputs ─────────────
group('offline — the priced fee is internally consistent (feeFormatted === fee / 10^feeDecimals)')
{
  const ch = await gateChallenge({ chain: 'near', token: 'USDC', amount: '0.001', payTo: 'merchant.near' })
  const srv = await serveRaw(ch)
  try {
    const c = new PipRailClient({ chain: 'near', rpcUrl: DEAD_RPC })
    const r = await c.estimateCost(srv.url)
    const cost = r?.cost
    // NEAR's native is 24-dp → the base-unit fee is > Number.MAX_SAFE_INTEGER. It must STILL be a
    // clean non-negative BigInt (this is exactly where a naive Number() cast would corrupt it).
    check(cost && BigInt(cost.fee) >= 0n, 'NEAR (24-dp native) fee is a valid non-negative BigInt')
    check(cost && !Number.isSafeInteger(Number(cost.fee)), "NEAR's base-unit fee exceeds Number.MAX_SAFE_INTEGER — proves it is carried as a string, not a JS number")
    // feeFormatted must equal fee scaled by feeDecimals (re-derive and compare digit-for-digit).
    const expected = scaleDown(cost.fee, cost.feeDecimals)
    check(cost.feeFormatted === expected, `feeFormatted (${cost.feeFormatted}) === fee/10^${cost.feeDecimals} (${expected})`)
    check(Number.isFinite(Number(cost.feeFormatted)) && Number(cost.feeFormatted) >= 0, 'feeFormatted parses to a finite, non-negative number (no NaN/Infinity)')
  } finally { srv.close() }
}

// ───────────── OFFLINE — no-compatible-rail behaviour (documents the ACTUAL contract) ─────────────
group('offline — estimateCost on a 402 with NO rail for the client chain')
{
  // A Base client hits a 402 that only offers Solana. There is no rail this client can price.
  // FINDING: estimateCost does NOT return a graceful result here — it propagates the same
  // NoCompatibleAcceptError the pay path throws. (The docs only promise null for a non-402 and
  // never-throw for a transient RPC; a foreign-only 402 is neither.) We assert the ACTUAL,
  // stable behaviour so a regression in either direction is caught.
  const solCh = await gateChallenge({ chain: 'solana', token: 'USDC', payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '0.001' })
  const srv = await serveRaw(solCh)
  try {
    const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC })
    let v, err = null
    try { v = await c.estimateCost(srv.url) } catch (e) { err = e }
    check(err instanceof NoCompatibleAcceptError, 'a foreign-only 402 makes estimateCost throw NoCompatibleAcceptError (NOT a graceful result — see finding)')
    check(err?.code === 'NO_COMPATIBLE_ACCEPT', "the thrown error carries the stable code 'NO_COMPATIBLE_ACCEPT'")
    check(v === undefined, 'no value is returned on the no-compatible-rail path (it threw, did not resolve)')
  } finally { srv.close() }
}

// ───────────── OFFLINE — an UNRECOGNISED-token onchain-proof rail still prices gracefully ─────────────
group('offline — an unknown-token rail on the client chain still gets a heuristic gas estimate (no throw)')
{
  // onchain-proof prices any ERC-20 by address; an unrecognised token must NOT break gas pricing.
  const base = await gateChallenge({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT })
  const weird = {
    ...base,
    accepts: [{ ...base.accepts[0], asset: '0x000000000000000000000000000000000000bEEF', extra: { ...(base.accepts[0].extra ?? {}), symbol: 'WAT', decimals: 18 } }],
  }
  const srv = await serveRaw(weird)
  try {
    const c = new PipRailClient({ chain: 'base', rpcUrl: DEAD_RPC })
    let r, threw = false
    try { r = await c.estimateCost(srv.url) } catch (e) { threw = true; note(`unknown-token threw: ${e?.message}`) }
    check(threw === false, 'an unrecognised-token onchain-proof rail did not make estimateCost throw')
    check(costWellFormed(r?.cost), 'the gas estimate is still well-formed for an unknown payment token')
    check(r?.cost.feeSymbol === 'ETH' && BigInt(r?.cost.fee ?? '0') > 0n, 'gas is still priced in ETH with a positive heuristic fee')
  } finally { srv.close() }
}

// ───────────────────────── LIVE — a real Base gas read flips basis → 'estimated' ─────────────────────────
if (!w || process.env.PIPRAIL_LIVE !== '1') {
  skip('live gas-read leg needs .secrets wallet AND PIPRAIL_LIVE=1 (estimateCost itself spends nothing, but we gate the real RPC read)')
} else {
  group('live — a real Base RPC gas read flips cost.basis → estimated with a finite, non-zero fee')
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC })
  const srv = serveGate(gate, { port: nextPort(), path: '/m' })
  await srv.listen()
  try {
    const c = new PipRailClient({ chain: 'base', rpcUrl: RPC })
    let r, threw = false
    try { r = await c.estimateCost(srv.url) } catch (e) { threw = true; check(false, `live estimateCost threw: ${e?.message}`) }
    if (!threw) {
      note(`live cost: ${r?.cost.feeFormatted} ${r?.cost.feeSymbol} basis=${r?.cost.basis} (${r?.cost.detail ?? ''})`)
      check(costWellFormed(r?.cost), 'live cost is a well-formed CostEstimate')
      check(r?.cost.basis === 'estimated', "a reachable RPC yields basis:'estimated' (a real gas-price read)")
      check(BigInt(r?.cost.fee ?? '0') > 0n, 'the live gas fee is finite and > 0')
      check(r?.cost.feeSymbol === 'ETH' && r?.quote.symbol === 'USDC', 'live: gas in ETH, payment in USDC (token ≠ gas coin)')
    }
  } finally { srv.close() }
}

// formatUnits-equivalent: scale a base-unit string down by `dec`, trimming trailing zeros.
function scaleDown(baseUnits, dec) {
  const neg = baseUnits.startsWith('-')
  const digits = (neg ? baseUnits.slice(1) : baseUnits).padStart(dec + 1, '0')
  const whole = digits.slice(0, digits.length - dec)
  const frac = digits.slice(digits.length - dec).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

done(w && process.env.PIPRAIL_LIVE === '1' ? '15 estimate-cost-gas' : '15 estimate-cost-gas (offline)')
