// LIVE MCP on real NON-EVM mainnet — spawns the PUBLISHED @piprail/mcp bin with a
// .secrets wallet and settles a real onchain-proof payment through piprail_pay_request
// UNDER A TIME ENVELOPE, reads piprail_budget, and proves an over-cap pay is declined
// (structured, no funds move). MAINNET, TINY amounts. Reads keys from .secrets at
// runtime, NEVER prints them. Run from examples/mcp-sandbox.
import { readFileSync } from 'node:fs'
import express from 'express'
import { requirePayment } from '@piprail/sdk'
import { connectServer, callTool } from '../lib/harness.mjs'
import { group, check, note, summarize } from '../lib/report.mjs'

const AMOUNT = '0.001' // USDC

// PIPRAIL_PRIVATE_KEY is mapped per family by the MCP (aptos → privateKey, algorand → mnemonic).
const FAMILIES = [
  { chain: 'aptos', secret: (w) => w.privateKey, payTo: (w) => w.merchantAddress },
  { chain: 'algorand', secret: (w) => w.mnemonic, payTo: (w) => w.merchantAddress },
]

const loadWallet = (fam) => {
  try { return JSON.parse(readFileSync(new URL(`../../../.secrets/wallets/${fam}-wallet.json`, import.meta.url))) }
  catch { return null }
}

export async function run() {
  for (const fam of FAMILIES) {
    group(`LIVE MCP · ${fam.chain} — real settlement through the published bin`)
    const w = loadWallet(fam.chain)
    if (!w) { note(`SKIPPED — no .secrets/wallets/${fam.chain}-wallet.json`); continue }
    const secret = fam.secret(w)
    const payTo = fam.payTo(w)
    if (!secret || !payTo) { note('SKIPPED — wallet missing key/merchant'); continue }
    const rpcUrl = process.env[`RPC_${fam.chain.toUpperCase()}`]
    const rpc = rpcUrl ? { rpcUrl } : {}

    let server
    try {
      const app = express()
      app.get('/paid', requirePayment({ chain: fam.chain, token: 'USDC', amount: AMOUNT, payTo, ...rpc }), (_q, r) => r.json({ unlocked: true }))
      server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
      const url = `http://127.0.0.1:${server.address().port}/paid`

      // (1) Pay through the MCP under a TIME envelope (Mode A) — a real on-chain settlement.
      const s = await connectServer({
        PIPRAIL_PRIVATE_KEY: secret, PIPRAIL_CHAIN: fam.chain,
        PIPRAIL_MAX_AMOUNT: '0.01', PIPRAIL_TOKENS: 'USDC', PIPRAIL_TTL: '3600',
        ...(rpcUrl ? { PIPRAIL_RPC_URL: rpcUrl } : {}),
      })
      try {
        const pay = await callTool(s.client, 'piprail_pay_request', { url })
        const ok = !pay.isError && pay.json?.status === 200
        check(`${fam.chain}: piprail_pay_request settles on real mainnet (status 200)`, ok, pay.isError ? pay.text : `status=${pay.json?.status}`)
        const bud = await callTool(s.client, 'piprail_budget', {})
        const reflects = !bud.isError && bud.json?.spent?.count === 1 && bud.json?.session?.secondsRemaining > 0
        check(`${fam.chain}: piprail_budget reflects the spend + a live time leash`, reflects, JSON.stringify({ count: bud.json?.spent?.count, secs: bud.json?.session?.secondsRemaining }))
        if (ok) note(`paid ${AMOUNT} USDC via the MCP, ref=${bud.json?.spent?.records?.[0]?.ref?.slice(0, 22)}…`)
      } finally { await s.close() }

      // (2) An over-cap pay is DECLINED structured through the tool — no funds move.
      const s2 = await connectServer({
        PIPRAIL_PRIVATE_KEY: secret, PIPRAIL_CHAIN: fam.chain,
        PIPRAIL_MAX_AMOUNT: '0.0001', PIPRAIL_TOKENS: 'USDC',
        ...(rpcUrl ? { PIPRAIL_RPC_URL: rpcUrl } : {}),
      })
      try {
        const d = await callTool(s2.client, 'piprail_pay_request', { url })
        check(`${fam.chain}: an over-cap pay is declined (structured: declined + reasonCode:POLICY)`,
          !d.isError && d.json?.declined === true && d.json?.code === 'PAYMENT_DECLINED' && d.json?.reasonCode === 'POLICY',
          JSON.stringify({ declined: d.json?.declined, reasonCode: d.json?.reasonCode }))
      } finally { await s2.close() }
    } catch (e) {
      check(`${fam.chain} live MCP`, false, e.stack ?? e.message)
    } finally {
      server?.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
