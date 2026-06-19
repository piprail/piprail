// LIVE proof for the trusted-wallet layer (time envelope + budget surface + the
// structured decline funnel) against REAL non-EVM mainnet settlements. For each
// funded family it: (1) settles ONE real onchain-proof pay under a TIME policy and
// asserts budget()/remaining()/plan.session reflect it; (2) proves the refusal paths
// move NO funds — SESSION_EXPIRED (past deadline), OUTSIDE_WINDOW (tiny window), and a
// POLICY decline through the agent pay tool — each carrying the right typed reasonCode.
// MAINNET, TINY amounts. Reads keys from .secrets at runtime, NEVER prints them.
import { readFileSync } from 'node:fs'
import express from 'express'
// Imports the PUBLISHED @piprail/sdk (from node_modules) so it tests the released
// package exactly as a user would install it — set SDK_LOCAL=1 to test the working tree.
const { PipRailClient, requirePayment, paymentTools, PaymentDeclinedError } =
  await import(process.env.SDK_LOCAL ? '../../../../sdk/dist/index.js' : '@piprail/sdk')
import { group, check, note, summarize } from '../lib/report.mjs'

const AMOUNT = '0.001' // USDC settled on the success path

const FAMILIES = [
  { chain: 'solana', wallet: (w) => ({ key: w.secretKey }), payTo: (w) => w.merchant?.address ?? w.merchantAddress },
  { chain: 'aptos', wallet: (w) => ({ key: w.privateKey }), payTo: (w) => w.merchantAddress },
  { chain: 'algorand', wallet: (w) => ({ key: w.mnemonic }), payTo: (w) => w.merchantAddress },
]

const loadWallet = (family) => {
  try { return JSON.parse(readFileSync(new URL(`../../../../.secrets/wallets/${family}-wallet.json`, import.meta.url))) }
  catch { return null }
}

export async function run() {
  for (const fam of FAMILIES) {
    group(`LIVE trusted-wallet · ${fam.chain}`)
    const w = loadWallet(fam.chain)
    if (!w) { note(`SKIPPED — no .secrets/wallets/${fam.chain}-wallet.json`); continue }
    const payTo = fam.payTo(w)
    if (!payTo) { note('SKIPPED — could not resolve merchant payTo'); continue }
    const rpc = process.env[`RPC_${fam.chain.toUpperCase()}`] ? { rpcUrl: process.env[`RPC_${fam.chain.toUpperCase()}`] } : {}
    const mkWallet = () => fam.wallet(w)

    let server
    try {
      const app = express()
      app.get('/paid', requirePayment({ chain: fam.chain, token: 'USDC', amount: AMOUNT, payTo, ...rpc }), (_q, r) => r.json({ unlocked: true }))
      server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
      const url = `http://127.0.0.1:${server.address().port}/paid`

      // ── (1) Real settlement UNDER a time envelope ──────────────────────────
      const timed = new PipRailClient({
        chain: fam.chain, wallet: mkWallet(), schemes: ['onchain-proof'],
        // maxTotal = the per-asset LIFETIME cap remaining() reports; ttl + window add the time leash.
        policy: { maxAmount: '0.01', tokens: ['USDC'], maxTotal: '0.05', ttlSeconds: 3600, windowTotal: '0.01', windowSeconds: 3600 },
        ...rpc,
      })
      // The leash is visible BEFORE paying.
      const b0 = timed.budget()
      check(`${fam.chain}: budget() shows a live session clock before paying`, b0.session.secondsRemaining > 0 && b0.session.secondsRemaining <= 3600 && b0.byAsset.length === 0, `secondsRemaining=${b0.session.secondsRemaining}`)
      // planPayment surfaces the session block.
      const plan = await timed.planPayment(url).catch((e) => e)
      check(`${fam.chain}: plan.session is populated under a time policy`, !(plan instanceof Error) && plan?.session?.secondsRemaining > 0, plan instanceof Error ? plan.message : `secondsRemaining=${plan?.session?.secondsRemaining}`)

      const res = await timed.fetch(url).catch((e) => e)
      const ok = !(res instanceof Error) && res.status === 200
      check(`${fam.chain}: onchain-proof settles under a time policy`, ok, res instanceof Error ? `${res.constructor.name}: ${res.message}` : `status=${res.status}`)
      if (ok) {
        const bud = timed.budget()
        const row = bud.byAsset[0]
        // maxTotal 0.05, paid 0.001 → remaining ≈ 0.049 (a real, decreasing lifetime cap).
        const reflects = bud.byAsset.length === 1 && row?.remainingFormatted != null && Number(row.remainingFormatted) > 0 && Number(row.remainingFormatted) < 0.05
        check(`${fam.chain}: budget()/remaining() reflect the real spend (maxTotal cap)`, reflects, `spent=${row?.spentBase} remaining=${row?.remainingFormatted}`)
        note(`paid ${AMOUNT} USDC, ref=${timed.spent().records[0]?.ref?.slice(0, 22)}…, remaining≈${row?.remainingFormatted} USDC`)
      }

      // ── (2a) SESSION_EXPIRED — a past deadline refuses, NO funds move ───────
      const expired = new PipRailClient({ chain: fam.chain, wallet: mkWallet(), policy: { maxAmount: '0.01', tokens: ['USDC'], expiresAt: Date.now() - 1000 }, ...rpc })
      const exErr = await expired.fetch(url).catch((e) => e)
      check(`${fam.chain}: expired session refuses with reasonCode SESSION_EXPIRED`, exErr instanceof PaymentDeclinedError && exErr.reasonCode === 'SESSION_EXPIRED', `${exErr?.constructor?.name}/${exErr?.reasonCode}`)
      check(`${fam.chain}: expired session moved NO funds`, expired.spent().count === 0, `count=${expired.spent().count}`)

      // ── (2b) OUTSIDE_WINDOW — a tiny rolling window refuses even the first pay ─
      const windowed = new PipRailClient({ chain: fam.chain, wallet: mkWallet(), policy: { maxAmount: '0.01', tokens: ['USDC'], windowTotal: '0.0001', windowSeconds: 3600 }, ...rpc })
      const wErr = await windowed.fetch(url).catch((e) => e)
      check(`${fam.chain}: over-window refuses with reasonCode OUTSIDE_WINDOW`, wErr instanceof PaymentDeclinedError && wErr.reasonCode === 'OUTSIDE_WINDOW', `${wErr?.constructor?.name}/${wErr?.reasonCode}`)
      check(`${fam.chain}: over-window moved NO funds`, windowed.spent().count === 0, `count=${windowed.spent().count}`)

      // ── (2c) The agent pay tool FUNNELS a policy decline (structured, never a throw) ─
      const guarded = new PipRailClient({ chain: fam.chain, wallet: mkWallet(), policy: { maxAmount: '0.0001', tokens: ['USDC'] }, ...rpc })
      const payTool = paymentTools(guarded).find((t) => t.name === 'piprail_pay_request')
      const out = await payTool.invoke({ url })
      check(`${fam.chain}: pay tool returns a structured decline (declined + reasonCode:POLICY)`, out?.declined === true && out?.code === 'PAYMENT_DECLINED' && out?.reasonCode === 'POLICY' && typeof out?.explain === 'string', JSON.stringify({ declined: out?.declined, reasonCode: out?.reasonCode }))

      // The toolkit now ships 7 tools incl. the read-only budget + guide.
      const names = paymentTools(guarded).map((t) => t.name)
      check(`${fam.chain}: paymentTools() exposes piprail_budget + piprail_guide (7 tools)`, names.length === 7 && names.includes('piprail_budget') && names.includes('piprail_guide'), `${names.length} tools`)
    } catch (e) {
      check(`${fam.chain} trusted-wallet live`, false, e.stack ?? e.message)
    } finally {
      server?.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
