// Suite 14 — `exact: true` ZERO-CONFIG GASLESS, and the graceful fallback ladder.
//
// Shows EXACTLY how the one-line `exact: true` works: the gate auto-picks a known
// KEYLESS facilitator for each chain (from KNOWN_FACILITATORS) so neither buyer nor
// merchant pays gas — and how it degrades, step by step, when gasless isn't possible:
//
//     (a) gasless `exact` via an auto-picked keyless facilitator   ← preferred, buyer+merchant pay 0
//          ↓ no keyless facilitator for this chain (config time)
//     (b) graceful degrade → `onchain-proof` ONLY + a loud warning ← buyer pays gas
//          ↓ facilitator resolved but DOWN at settle time
//     (c) 502 settlement_failed + a CLEAR `fallback` hint          ← buyer retries onchain-proof (pays gas)
//     onchain-proof is ALWAYS advertised — the universal floor, the only option when nothing sponsors.
//
// Mostly OFFLINE: scenarios (3)-(6) need no network. (2) + (7) read Base mainnet
// read-only (the USDC EIP-712 domain) and SKIP cleanly if the RPC is unreachable.
// No funds move anywhere. Imports the LOCAL SDK build (../../../../sdk/dist).
// Run: node suites/14-exact-true-keyless.mjs   (after `npm run build` in sdk/).

import { randomBytes } from 'node:crypto'
import express from 'express'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createPaymentGate, requirePayment, buildExactAuthorization,
  firstKeylessFacilitator, knownFacilitatorsFor, KNOWN_FACILITATORS,
} from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const RPC = process.env.BASE_RPC ?? 'https://base-rpc.publicnode.com'
const PAY_TO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const BASE = 'eip155:8453'
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

const baseReachable = async () => {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
    const j = await r.json(); return j.result === '0x2105'
  } catch { return false }
}

export async function run() {
  group('exact: true — what it is')
  note('`exact: true` === `exact: { settle: \'keyless\' }`. The gate AUTO-PICKS a known KEYLESS')
  note('facilitator for each offered chain from KNOWN_FACILITATORS (firstKeylessFacilitator) — the')
  note('facilitator sponsors gas, so buyer AND merchant pay ZERO. No relayer key, no config.')
  note('It is OPT-IN and SOFT: omit it → onchain-proof only (byte-identical); a chain with no')
  note('keyless facilitator degrades gracefully to onchain-proof (the buyer pays gas).')

  // ── (1) The seed map the auto-pick reads ──────────────────────────────────
  group('1) the auto-pick source — KNOWN_FACILITATORS (seeded, live-settled only)')
  const baseFac = firstKeylessFacilitator(BASE)
  const solFac = firstKeylessFacilitator(SOLANA, 'svm')
  check('Base (eip155:8453) has a keyless facilitator to auto-pick', baseFac?.keyless === true && typeof baseFac.url === 'string', baseFac?.url)
  check('Solana has a keyless SVM fee-payer facilitator to auto-pick', solFac?.keyless === true, solFac?.url)
  check('firstKeylessFacilitator returns undefined for an unseeded chain (→ graceful degrade)', firstKeylessFacilitator('eip155:59144') === undefined)
  note(`Base keyless facilitators (in priority order): ${knownFacilitatorsFor(BASE).map((f) => f.url).join(' → ')}`)
  note(`seeded networks: ${Object.keys(KNOWN_FACILITATORS).join(', ')}`)

  // ── (2) exact:true → dual-rail (gasless exact + onchain-proof) on real Base ─
  group('2) exact: true on Base USDC → dual-rail (gasless exact FIRST + onchain-proof floor)')
  if (await baseReachable()) {
    // NOTE: NO relayer key. Self-settle would THROW without one — so a working exact rail
    // PROVES the keyless facilitator was auto-picked (it needs no relayer).
    const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO, rpcUrl: RPC, exact: true })
    const { challenge } = await gate.challenge('https://api.example/paid')
    check('advertises BOTH rails, gasless exact FIRST then onchain-proof', challenge.accepts.map((a) => a.scheme).join(',') === 'exact,onchain-proof', challenge.accepts.map((a) => a.scheme).join(','))
    const exact = challenge.accepts.find((a) => a.scheme === 'exact')
    check('exact rail is EIP-3009 with the REAL on-chain USDC domain', exact?.extra?.assetTransferMethod === 'eip3009' && exact?.extra?.name === 'USD Coin', JSON.stringify(exact?.extra))
    check('exact rail needs NO relayer (proves keyless facilitator auto-pick)', !!exact)
    note('A standard x402 client signs an EIP-3009 authorization (0 gas); the auto-picked keyless')
    note('facilitator broadcasts it + pays the gas. Buyer pays 0, merchant pays 0. Truly gasless.')
  } else {
    note(`SKIPPED Base RPC scenarios — ${RPC} unreachable.`)
  }

  // ── (3) graceful degrade: no keyless facilitator → onchain-proof only ──────
  group('3) graceful fallback — a chain with NO keyless facilitator → onchain-proof only (pay gas)')
  {
    const warnings = []
    const orig = console.warn
    console.warn = (...a) => warnings.push(a.join(' '))
    // Linea (eip155:59144) is NOT in KNOWN_FACILITATORS → soft `exact: true` degrades, never throws.
    const gate = createPaymentGate({ chain: 'linea', token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: true })
    let accepts
    try { accepts = (await gate.challenge('https://api.example/paid')).challenge.accepts } finally { console.warn = orig }
    check('does NOT brick the gate — serves onchain-proof only', accepts?.length === 1 && accepts[0].scheme === 'onchain-proof', accepts?.map((a) => a.scheme).join(','))
    check('warns LOUDLY (not silent): "ONCHAIN-PROOF ONLY"', warnings.some((w) => /ONCHAIN-PROOF ONLY/.test(w)))
    note(`warning shown to the developer:\n      ${(warnings.find((w) => /ONCHAIN-PROOF ONLY/.test(w)) || '').slice(0, 240)}…`)
  }

  // ── (4) EXPLICIT settle stays STRICT — a real config error throws ─────────
  group('4) an EXPLICIT settle that can\'t carry exact THROWS (config error, not soft)')
  {
    // settle:'self' on the native coin → capability gap on an explicitly-engaged rail → loud throw.
    const gate = createPaymentGate({ chain: 'base', token: 'native', amount: '0.01', payTo: PAY_TO, rpcUrl: RPC, exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } } })
    let threw = false
    try { await gate.challenge('https://api.example/paid') } catch (e) { threw = /none of the offered rails support it/.test(String(e.message)) }
    check('exact:{settle:\'self\'} on a native coin → throws a clear config error', threw)
    note('Soft `exact: true` would have degraded to onchain-proof; the explicit form surfaces the')
    note('mistake loudly so a typo\'d facilitator URL / wrong token is caught immediately.')
  }

  // ── (5) exact:false / omit → byte-identical onchain-proof-only default ─────
  group('5) exact: false (and omitting exact) → onchain-proof only, byte-identical default')
  {
    const off = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO, rpcUrl: RPC, exact: false })
    const omit = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO, rpcUrl: RPC })
    const a1 = (await off.challenge('https://api.example/p')).challenge.accepts
    const a2 = (await omit.challenge('https://api.example/p')).challenge.accepts
    check('exact: false → onchain-proof only', a1.length === 1 && a1[0].scheme === 'onchain-proof')
    check('omitting exact → identical (no exact rail)', a2.length === 1 && a2[0].scheme === 'onchain-proof')
  }

  // ── (6) settle-time fallback: facilitator DOWN → clear 502 + onchain-proof hint ─
  group('6) facilitator DOWN at settle time → 502 settlement_failed + a CLEAR onchain-proof fallback')
  if (await baseReachable()) {
    // Explicit UNREACHABLE facilitator. The gate still advertises exact + onchain-proof; a real
    // payment attempt fails at the facilitator HTTP call (no funds move — it never broadcasts).
    const app = express()
    app.get('/paid', requirePayment({
      chain: 'base', token: 'USDC', amount: '0.001', payTo: PAY_TO, rpcUrl: RPC,
      exact: { settle: { facilitator: 'http://127.0.0.1:9' } }, // port 9 = discard, always refused
    }), (_q, r) => r.json({ ok: true }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
    const url = `http://127.0.0.1:${srv.address().port}/paid`
    try {
      const ch = await (await fetch(url)).json()
      check('gate still advertises onchain-proof as the floor next to exact', ch.accepts.some((a) => a.scheme === 'onchain-proof') && ch.accepts.some((a) => a.scheme === 'exact'))
      // A throwaway-signed (no-funds) exact header — settlement dies at the dead facilitator, pre-broadcast.
      const rail = ch.accepts.find((a) => a.scheme === 'exact')
      const payer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`)
      const accept = { scheme: 'exact', network: rail.network, maxAmountRequired: rail.amount, asset: rail.asset, payTo: rail.payTo, maxTimeoutSeconds: rail.maxTimeoutSeconds, extra: { name: rail.extra.name, version: rail.extra.version } }
      const { authorization, signature } = await buildExactAuthorization({ account: payer, accept, chainId: 8453, now: Math.floor(Date.now() / 1000), nonce: `0x${randomBytes(32).toString('hex')}` })
      const header = b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })
      const r = await fetch(url, { headers: { 'payment-signature': header } })
      const body = await r.json().catch(() => ({}))
      check('settle failure → HTTP 502 settlement_failed (NOT a misleading 402)', r.status === 502 && body.error === 'settlement_failed', `status=${r.status} err=${body.error}`)
      check('the error CLEARLY names onchain-proof as the pay-gas fallback', /onchain-proof/.test(body.fallback || '') && /pay the gas/.test(body.fallback || ''), body.fallback)
      note(`fallback hint returned to the agent:\n      ${body.fallback}`)
    } finally { await new Promise((r) => srv.close(r)) }
  } else {
    note(`SKIPPED settle-failure scenario — Base RPC ${RPC} unreachable.`)
  }

  group('the ladder, recap')
  note('(a) exact:true → gasless via auto-picked keyless facilitator (buyer 0, merchant 0)')
  note('(b) no facilitator for the chain → graceful degrade to onchain-proof + loud warning (buyer pays gas)')
  note('(c) facilitator down at settle → 502 with a clear onchain-proof fallback hint (buyer pays gas)')
  note('onchain-proof is ALWAYS advertised — the only option when nothing can sponsor the gas.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
