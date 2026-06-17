// LIVE mainnet — Algorand `exact` settled by the KEYLESS GoPlausible facilitator. TRULY gasless:
// neither the buyer NOR the merchant pays ALGO — GoPlausible's sponsor (its published feePayer)
// pools the group fee and submits. This is the both-sides-gasless win (vs self-settle, where the
// MERCHANT pays the group fee). The gate discovers GoPlausible's feePayer from its GET /supported,
// advertises it, the buyer signs ONLY the fee-0 axfer, and the gate forwards verify+settle to
// GoPlausible. USDCa moves on Algorand mainnet, single-step final (~3s).
//
// LOCAL ONLY. Reads keys from ../../../.secrets — never prints/commits them. Imports the LOCAL SDK
// build. Run: node suites/live-algorand-goplausible.mjs  (after `npm run build` in sdk/).
// Skips cleanly if the buyer is underfunded / not opted in.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import express from 'express'
import algosdk from 'algosdk'
import { requirePayment, PipRailClient } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALGOD = process.env.ALGOD ?? 'https://mainnet-api.algonode.cloud'
const FACILITATOR = 'https://facilitator.goplausible.xyz'
const USDC_ASA = 31566704
const AMOUNT = process.env.GP_AMOUNT ?? '0.001'
const AMOUNT_BASE = BigInt(Math.round(Number(AMOUNT) * 1e6))
const algod = new algosdk.Algodv2('', ALGOD, '')

async function bal(addr) {
  const info = await algod.accountInformation(addr).do()
  const algo = BigInt(info.amount ?? 0)
  const holding = (info.assets ?? []).find((a) => Number(a.assetId) === USDC_ASA)
  return { algo, usdc: holding ? BigInt(holding.amount) : 0n, optedIn: Boolean(holding) }
}

export async function run() {
  group('LIVE · Algorand exact via KEYLESS GoPlausible facilitator — both sides gasless, real USDCa')

  let w
  try { w = JSON.parse(readFileSync(resolve(HERE, '../../../.secrets/wallets/algorand-wallet.json'), 'utf8')) }
  catch { note('SKIPPED — no .secrets/wallets/algorand-wallet.json (local-only test).'); return }

  const payerAddr = algosdk.mnemonicToSecretKey(w.mnemonic).addr.toString()
  const merchantAddr = w.merchantAddress

  const p0 = await bal(payerAddr)
  const m0 = await bal(merchantAddr)
  note(`payer    ${payerAddr.slice(0, 10)}…  USDCa ${Number(p0.usdc) / 1e6}  ALGO ${Number(p0.algo) / 1e6}  optedIn=${p0.optedIn}`)
  note(`merchant ${merchantAddr.slice(0, 10)}…  USDCa ${Number(m0.usdc) / 1e6}  ALGO ${Number(m0.algo) / 1e6}  optedIn=${m0.optedIn}  (GoPlausible pays the fee — merchant needs NO ALGO)`)

  if (!p0.optedIn || p0.usdc < AMOUNT_BASE) {
    note(`SKIPPED — payer needs ≥ ${AMOUNT} USDCa and an opt-in (fund/opt-in ${payerAddr}). It pays ZERO ALGO.`)
    return
  }
  if (!m0.optedIn) { note(`SKIPPED — merchant must be opted into USDCa to receive (opt-in ${merchantAddr}).`); return }

  // The gate: a standard `exact` rail settled by the KEYLESS GoPlausible facilitator. No relayer key.
  const app = express()
  app.get('/paid', requirePayment({
    chain: 'algorand', token: 'USDC', amount: AMOUNT, payTo: merchantAddr, rpcUrl: ALGOD,
    exact: { settle: { facilitator: FACILITATOR } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts?.find((a) => a.scheme === 'exact')
    check('gate advertises an Algorand exact rail with GoPlausible’s feePayer (discovered from /supported)',
      rail?.extra?.assetTransferMethod === 'algorand' && typeof rail?.extra?.feePayer === 'string', JSON.stringify(rail?.extra))
    note(`facilitator feePayer (sponsor): ${rail?.extra?.feePayer}`)
    check('onchain-proof floor is also advertised', ch.accepts?.some((a) => a.scheme === 'onchain-proof'))

    group('LIVE · keyless gasless round-trip (GoPlausible sponsors the group fee — both sides 0 ALGO)')
    const client = new PipRailClient({ chain: 'algorand', wallet: { key: w.mnemonic }, schemes: ['exact'], rpcUrl: ALGOD })
    const r = await client.fetch(url)
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — resource unlocked by a KEYLESS GoPlausible-settled Algorand exact payment',
      r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 240)}`)

    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      check('receipt scheme is exact + has a real settle txid', receipt.scheme === 'exact' && /^[A-Z2-7]{52}$/.test(receipt.transaction || ''), receipt.transaction)
      note(`settled tx: https://allo.info/tx/${receipt.transaction}`)
      await new Promise((res) => setTimeout(res, 5000))

      const p1 = await bal(payerAddr)
      const m1 = await bal(merchantAddr)
      check(`merchant received exactly ${AMOUNT} USDCa`, m1.usdc - m0.usdc === AMOUNT_BASE, `delta=${m1.usdc - m0.usdc}`)
      check(`payer USDCa dropped by exactly ${AMOUNT}`, p0.usdc - p1.usdc === AMOUNT_BASE, `delta=${p0.usdc - p1.usdc}`)
      check('buyer spent ZERO ALGO (gasless)', p1.algo === p0.algo, `before=${p0.algo} after=${p1.algo}`)
      check('MERCHANT spent ZERO ALGO (GoPlausible sponsored — keyless both-sides-gasless)', m1.algo === m0.algo, `before=${m0.algo} after=${m1.algo}`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
