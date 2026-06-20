// Suite 02 — the `upto` METERED RAIL  (pay-for-what-you-use)
//
// The buyer authorizes a MAX up front with an OFF-CHAIN Permit2 signature; the merchant's relayer
// broadcasts the settlement for only the ACTUAL metered amount (≤ MAX) and pays that gas. Because
// the buyer only signs (never broadcasts), the rail is buyer-gasless in a real deployment with a
// distinct relayer — but this sandbox uses the payer key AS the relayer for funding convenience,
// so what it proves is the METERING (the on-chain merchant Δ === the actual), not the gas split.
//
//   OFFLINE (reads the chain for the EIP-712 domain, but SPENDS NOTHING): the 402 offers an `upto`
//     rail advertising the MAX + the permit2-upto method + the facilitator (relayer) address
//     (DISC-3); self-describe mirrors it.
//   LIVE (Base mainnet, tiny USDC — only with the .secrets wallet):
//     • PARTIAL : meter 0.0005 of a 0.001 MAX → merchant receives ONLY the metered actual (≤ MAX)
//     • OVER-METER guard : meter 0.003 > MAX 0.002 → rejected, NOTHING broadcast, merchant Δ0
//     • ZERO-CHARGE : meter 0 → 200 + synthetic receipt (transaction:''), NOTHING broadcast
//
import { createPaymentGate, PipRailClient, buildSelfDescription } from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, usdcBalance, getAddress, formatUnits, DUMMY_KEY } from '../lib/env.mjs'
import { serveGate } from '../lib/http-gate.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

banner('02 · UPTO METERED RAIL')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

// ───────────────────────── OFFLINE ─────────────────────────
group('offline — the 402 advertises an `upto` rail at the MAX + the facilitator (DISC-3)')
{
  const RELAY_KEY = w?.key ?? DUMMY_KEY
  const relayAddr = privateKeyToAccount(RELAY_KEY).address
  const gate = createPaymentGate({
    chain: 'base', token: 'USDC', amount: '0.002', payTo: MERCHANT, rpcUrl: RPC,
    upto: { relayer: { key: RELAY_KEY }, settleAmount: () => 1000n }, receipts: true,
  })
  const c = await gate.challenge('http://127.0.0.1:1/m')
  const rail = c.challenge.accepts.find((a) => a.scheme === 'upto')
  check(!!rail, 'the 402 offers an `upto` rail')
  check(rail?.amount === '2000', 'the upto rail advertises the authorized MAX (0.002 USDC = 2000 base units), not a smaller actual')
  check(rail?.extra?.assetTransferMethod === 'permit2-upto', 'the rail method is permit2-upto')
  check(!!rail?.extra?.facilitatorAddress && getAddress(rail.extra.facilitatorAddress) === getAddress(relayAddr),
    'the rail carries the facilitatorAddress (= the relayer) so a buyer can budget gas (DISC-3)')

  const sd = buildSelfDescription({ accepts: c.challenge.accepts })
  const sdUpto = sd.pay.find((r) => r.scheme === 'upto')
  check(sdUpto?.amount === '2000' && !!sdUpto?.how, 'self-describe shows the upto rail at the MAX with a how-text')
}

// ───────────────────────── LIVE ─────────────────────────
if (!w) {
  skip('no .secrets wallet → skipping the live Base-mainnet metered settles')
} else {
// One upto gate factory with a configurable meter. relayer = the payer key (it pays the gas).
// Returns the http server harness PLUS the gate (so a rejection's verdict can be re-read).
function uptoServer(port, settleAmount, amount = '0.002') {
  const gate = createPaymentGate({
    chain: 'base', token: 'USDC', amount, payTo: w.merchant, rpcUrl: RPC,
    upto: { relayer: { key: w.key }, settleAmount }, receipts: true,
    onPaid: (r) => console.log(`  💰 self-settled actual ${r.amountFormatted} ${r.symbol} — tx ${r.transaction?.slice(0, 14)}…`),
  })
  const s = serveGate(gate, { port, path: '/m', body: (r) => ({ ok: true, charged: r.receipt.amount }) })
  return { ...s, gate }
}
// A real settle needs the patient default retry window; the always-rejecting over-meter gate uses a short cap.
const newBuyer = (opts = {}) => new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC, schemes: ['upto'], ...opts })

try {
  // ── PARTIAL — meter 0.0005 of a 0.001 MAX → merchant receives exactly the actual ──
  group('live — PARTIAL: meter 0.0005 of a 0.001 MAX → merchant receives ONLY the metered actual')
  {
    const mBefore = await usdcBalance(w.merchant)
    const s = uptoServer(4811, () => 500n, '0.001')
    await s.listen()
    const buyer = newBuyer()
    const res = await buyer.fetch(s.url)
    check(res.status === 200, 'metered payment settled (HTTP 200)')
    check(buyer.lastReceipt()?.receipt.scheme === 'upto', 'the receipt scheme is `upto`')
    await wait(4500)
    const delta = (await usdcBalance(w.merchant)) - mBefore
    note(`merchant Δ +${formatUnits(delta, 6)} USDC`)
    check(delta === 500n, `merchant received EXACTLY the metered 0.0005 USDC (Δ ${delta}), not the 0.001 MAX`)
    s.close()
  }

  // ── OVER-METER guard — meter 0.003 > MAX 0.002 → reject, NOTHING broadcast ──
  group('live — OVER-METER guard: meter 0.003 > MAX 0.002 → rejected, no broadcast, merchant Δ0')
  {
    const mBefore = await usdcBalance(w.merchant)
    const s = uptoServer(4812, () => 3000n, '0.002')
    await s.listen()
    let status = 0
    try { status = (await newBuyer({ maxPaymentRetries: 1, retryTimeoutMs: 4000 }).fetch(s.url)).status }
    catch (e) { status = -1; note(`buyer gave up: ${e?.name ?? e}`) }
    check(status !== 200, 'over-meter did NOT settle (no 200)')
    const verdict = await s.gate.verify(s.lastSig()) // re-read the same auth to read the verdict
    check(verdict.error === 'upto_settle_exceeds_max',
      `rejected SPECIFICALLY by the ceiling guard (upto_settle_exceeds_max, got ${verdict.error})`)
    await wait(2500)
    check((await usdcBalance(w.merchant)) - mBefore === 0n, 'merchant received NOTHING on an over-meter (Δ0)')
    s.close()
  }

  // ── ZERO-CHARGE — meter 0 → 200 + synthetic receipt, NOTHING broadcast ──
  group('live — ZERO-CHARGE: meter 0 → 200 + receipt transaction:"" , no broadcast, merchant Δ0')
  {
    const mBefore = await usdcBalance(w.merchant)
    const s = uptoServer(4813, () => 0n, '0.001')
    await s.listen()
    const buyer = newBuyer()
    const res = await buyer.fetch(s.url)
    check(res.status === 200, 'zero-charge settled (HTTP 200)')
    const rcpt = buyer.lastReceipt()
    check(rcpt?.receipt.amount === '0', `receipt amount === 0 (got ${rcpt?.receipt.amount})`)
    check(rcpt?.receipt.transaction === '', "zero-charge receipt transaction === '' (synthetic, no broadcast)")
    await wait(2500)
    check((await usdcBalance(w.merchant)) - mBefore === 0n, 'merchant Δ0 on a zero-charge')
    s.close()
  }
} catch (err) {
  check(false, `live upto threw: ${err?.message ?? err}`)
}
}

done(w ? '02 upto' : '02 upto (offline)')
