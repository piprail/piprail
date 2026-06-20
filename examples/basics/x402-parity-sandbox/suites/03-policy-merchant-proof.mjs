// Suite 03 — MERCHANT-PROOF SPEND LEASH  (POL-1)
//
// The whole point of the spend policy is that a malicious or buggy merchant cannot trick the
// buyer into spending more than it authorized. For the metered `upto` rail this is subtle: the
// buyer's cumulative budget must debit the AUTHORIZED MAX of each payment, NOT the merchant's
// self-reported "actual" — otherwise a merchant that under-reports each settle could loosen the
// cumulative caps and bleed the buyer past maxTotal.
//
//   The discriminating live test (Base mainnet, tiny USDC):
//     per-payment MAX = 0.001, merchant METERS only 0.0005 (half), buyer policy maxTotal = 0.002.
//     • MAX-based (correct): each debits 0.001 → exactly 2 fit, the 3rd is BLOCKED (0.003 > 0.002).
//     • actual-based (the leak): each debits 0.0005 → 4 would fit.
//   So: 3rd blocked + only 2 on-chain settles (merchant Δ = 0.001 total) ⇒ the leash is merchant-proof.
//   `spent().records[].settledBase` still surfaces the true 0.0005 actual for display.
//
import { createPaymentGate, PipRailClient, evaluatePolicy } from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, usdcBalance, formatUnits } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

banner('03 · MERCHANT-PROOF SPEND LEASH (POL-1)')
const w = loadWallet()

// ───────────────────────── OFFLINE ─────────────────────────
group('offline — the policy primitive + a buyer start with an empty, well-formed ledger')
{
  check(typeof evaluatePolicy === 'function', 'evaluatePolicy is exported (the pure policy decision fn)')
  const buyer = new PipRailClient({ chain: 'base', wallet: { key: w?.key ?? ('0x' + '11'.repeat(32)) }, rpcUrl: RPC, policy: { maxTotal: '0.002', tokens: ['USDC'] } })
  const spent = buyer.spent()
  check(Array.isArray(spent.records) && spent.records.length === 0, 'a fresh buyer has spent 0 (empty records)')
}

// ───────────────────────── LIVE ─────────────────────────
if (!w) {
  skip('no .secrets wallet → skipping the live merchant-proof leash test')
} else {
const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC,
  upto: { relayer: { key: w.key }, settleAmount: () => 500n }, // meter HALF the max
  onPaid: (r) => console.log(`  💰 settled actual ${r.amountFormatted} ${r.symbol} — tx ${r.transaction?.slice(0, 14)}…`),
})
const srv = serveGate(gate, { port: 4831, path: '/m', body: { ok: true } })
await srv.listen()

group('live — per-MAX 0.001 · meter 0.0005 · policy maxTotal 0.002 → 2 settle, 3rd BLOCKED')
try {
  const mBefore = await usdcBalance(w.merchant)
  let declines = 0
  const declineCodes = []
  const buyer = new PipRailClient({
    chain: 'base', wallet: { key: w.key }, rpcUrl: RPC, schemes: ['upto'],
    policy: { maxTotal: '0.002', tokens: ['USDC'] },
    onEvent: (e) => { if (e.kind === 'payment-declined') { declines++; const code = e.code ?? e.reasonCode ?? e.reason; declineCodes.push(code); note(`payment declined: ${code}`) } },
  })

  let thrown3 = null
  for (let i = 1; i <= 3; i++) {
    let status = 0, threw = null
    try { status = (await buyer.fetch(srv.url)).status } catch (e) { threw = e; if (i === 3) thrown3 = e }
    const total = buyer.spent().byAsset?.[0]?.totalFormatted ?? '0'
    note(`payment ${i}: HTTP ${status}${threw ? ` (threw ${threw.name ?? threw})` : ''} · budget total ${total} USDC (MAX-based)`)
    if (i <= 2) check(status === 200, `payment ${i} settled (within budget)`)
  }
  // Payment 3 must be blocked SPECIFICALLY by the budget cap — not by any incidental non-200
  // (a gate error, an RPC blip, a signing failure). Pin the typed decline + the exact reason,
  // so this stays red if the 3rd were blocked for the WRONG reason.
  check(thrown3?.name === 'PaymentDeclinedError', `payment 3 threw a typed PaymentDeclinedError (got ${thrown3?.name ?? 'no throw'})`)
  check(declineCodes.includes('MAX_TOTAL'), `payment 3 was declined SPECIFICALLY by the maxTotal cap (decline codes seen: ${JSON.stringify(declineCodes)})`)

  const spent = buyer.spent()
  check(spent.byAsset?.[0]?.totalBase === '2000', `budget recorded 2×MAX = 2000 base units = 0.002 USDC (got ${spent.byAsset?.[0]?.totalBase})`)
  const settled = spent.records.map((r) => r.settledBase)
  note(`per-payment settledBase (true actual): ${JSON.stringify(settled)}`)
  check(settled.filter((s) => s === '500').length === 2, 'each settled record surfaces the TRUE actual 500 (half the MAX) for display')

  await wait(4500)
  const delta = (await usdcBalance(w.merchant)) - mBefore
  note(`merchant Δ +${formatUnits(delta, 6)} USDC (the 2 actuals)`)
  check(delta === 1000n, `merchant received exactly 2×0.0005 = 0.001 on-chain (Δ ${delta}); the budget counted the MAX 0.002`)
} catch (err) {
  check(false, `live policy leash threw: ${err?.message ?? err}`)
} finally {
  srv.close()
}
}

done(w ? '03 policy' : '03 policy (offline)')
