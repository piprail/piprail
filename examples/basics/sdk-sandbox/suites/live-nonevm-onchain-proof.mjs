// LIVE non-EVM proof — confirms the exact-buyer change did NOT regress the `onchain-proof`
// path on real non-EVM chains, and that `exact` is correctly IGNORED there (EVM-only).
// For each funded non-EVM family it: (1) pays a real onchain-proof gate with
// schemes:['onchain-proof','exact'] → proves onchain-proof still settles AND that adding
// 'exact' on a non-EVM chain harmlessly falls back; (2) read-only asserts schemes:['exact']
// alone → NoCompatibleAcceptError (a non-EVM family can't pay exact). MAINNET, TINY amounts.
// Reads keys from .secrets at runtime, NEVER prints them. Run from examples/sdk-sandbox.
import { readFileSync } from 'node:fs'
import express from 'express'
import { PipRailClient, requirePayment, NoCompatibleAcceptError } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const AMOUNT = '0.001' // USDC

const FAMILIES = [
  { chain: 'solana', wallet: (w) => ({ key: w.secretKey }), payTo: (w) => w.merchant?.address ?? w.merchantAddress, template: 'B (digest)' },
  { chain: 'aptos', wallet: (w) => ({ key: w.privateKey }), payTo: (w) => w.merchantAddress, template: 'B (digest)' },
  { chain: 'algorand', wallet: (w) => ({ key: w.mnemonic }), payTo: (w) => w.merchantAddress, template: 'A (memo/nonce)' },
]

function loadWallet(family) {
  try { return JSON.parse(readFileSync(new URL(`../../../../.secrets/wallets/${family}-wallet.json`, import.meta.url))) }
  catch { return null }
}

export async function run() {
  for (const fam of FAMILIES) {
    group(`LIVE non-EVM · ${fam.chain} — onchain-proof unaffected by the exact change (Template ${fam.template})`)
    const w = loadWallet(fam.chain)
    if (!w) { note(`SKIPPED — no .secrets/wallets/${fam.chain}-wallet.json`); continue }
    const payTo = fam.payTo(w)
    if (!payTo) { note('SKIPPED — could not resolve merchant payTo'); continue }
    const rpcUrl = process.env[`RPC_${fam.chain.toUpperCase()}`]
    const rpc = rpcUrl ? { rpcUrl } : {}

    // A real onchain-proof gate served over a throwaway localhost HTTP server.
    let server
    try {
      const app = express()
      app.get('/paid', requirePayment({ chain: fam.chain, token: 'USDC', amount: AMOUNT, payTo, ...rpc }), (_q, r) => r.json({ unlocked: true }))
      server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
      const url = `http://127.0.0.1:${server.address().port}/paid`

      // (1) Pay with schemes including 'exact' — must settle via onchain-proof (exact ignored on non-EVM).
      const client = new PipRailClient({ chain: fam.chain, wallet: fam.wallet(w), schemes: ['onchain-proof', 'exact'], policy: { maxAmount: '0.01', tokens: ['USDC'] }, ...rpc })
      const res = await client.fetch(url).catch((e) => e)
      const ok = !(res instanceof Error) && res.status === 200
      check(`onchain-proof round-trip settles on ${fam.chain} (schemes include 'exact')`, ok, res instanceof Error ? `${res.constructor.name}: ${res.message}` : `status=${res.status}`)
      if (ok) {
        check(`spend recorded once on ${fam.chain}`, client.spent().count === 1, `count=${client.spent().count}`)
        note(`paid ${AMOUNT} USDC, ref=${client.spent().records[0]?.ref?.slice(0, 24)}…`)
      }

      // (2) Read-only: schemes:['exact'] alone cannot pay an onchain-proof gate on a non-EVM family.
      const exactOnly = new PipRailClient({ chain: fam.chain, wallet: fam.wallet(w), schemes: ['exact'], ...rpc })
      const err = await exactOnly.fetch(url).catch((e) => e)
      check(`schemes:['exact'] alone is refused on ${fam.chain} (EVM-only) — no funds moved`, err instanceof NoCompatibleAcceptError, err?.constructor?.name)
    } catch (e) {
      check(`${fam.chain} live round-trip`, false, e.message)
    } finally {
      server?.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
