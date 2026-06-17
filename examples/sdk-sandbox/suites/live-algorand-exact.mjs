// LIVE mainnet smoke — the Algorand `exact` rail, SELF-SETTLE, on real USDCa, TINY amounts.
// Proves the new gasless Algorand rail end-to-end with real money: the gate advertises an
// `exact` rail (atomic-group fee pooling), a PipRailClient pays it by signing ONLY the asset
// transfer at fee 0, and the gate's relayer co-signs the pooled-fee txn + submits the group.
// The BUYER spends ZERO ALGO (gasless); the merchant's relayer pays the ~0.002-ALGO group fee
// to receive. USDCa moves on Algorand mainnet, single-step final (~3s).
//
// Here feePayer === payTo (the merchant pays its own receive fee) — allowed on Algorand because
// the fee txn is SEPARATE from the transfer (unlike Solana's fee-payer MUST-rules).
//
// LOCAL ONLY. Reads keys from ../../../.secrets — never prints or commits them. Imports the
// LOCAL SDK build. Run: node suites/live-algorand-exact.mjs   (after `npm run build` in sdk/).
// Skips cleanly (never fails) if the wallet is underfunded / not opted in.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import express from 'express'
import algosdk from 'algosdk'
import { requirePayment, PipRailClient } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ALGOD = process.env.ALGOD ?? 'https://mainnet-api.algonode.cloud'
const USDC_ASA = 31566704
const AMOUNT = '0.001' // 1000 base units (6dp) — tiny
const AMOUNT_BASE = 1000n
const algod = new algosdk.Algodv2('', ALGOD, '')

async function bal(addr) {
  const info = await algod.accountInformation(addr).do()
  const algo = BigInt(info.amount ?? 0)
  const holding = (info.assets ?? []).find((a) => Number(a.assetId) === USDC_ASA)
  return { algo, usdc: holding ? BigInt(holding.amount) : 0n, optedIn: Boolean(holding) }
}

export async function run() {
  group('LIVE · Algorand exact (self-settle) — mainnet USDCa, real money, tiny')

  let w
  try {
    w = JSON.parse(readFileSync(resolve(HERE, '../../../.secrets/wallets/algorand-wallet.json'), 'utf8'))
  } catch {
    note('SKIPPED — no .secrets/wallets/algorand-wallet.json (local-only test).')
    return
  }

  // payer = buyer (pays USDCa, ZERO ALGO). merchant = payTo AND the relayer/feePayer (pays the
  // group fee to receive). Mnemonics are read here and NEVER printed.
  const payer = algosdk.mnemonicToSecretKey(w.mnemonic)
  const payerAddr = payer.addr.toString()
  const merchantMnemonic = w.merchantMnemonic
  const merchantAddr = w.merchantAddress

  const p0 = await bal(payerAddr)
  const m0 = await bal(merchantAddr)
  note(`payer    ${payerAddr.slice(0, 10)}…  USDCa ${Number(p0.usdc) / 1e6}  ALGO ${Number(p0.algo) / 1e6}  optedIn=${p0.optedIn}`)
  note(`merchant ${merchantAddr.slice(0, 10)}…  USDCa ${Number(m0.usdc) / 1e6}  ALGO ${Number(m0.algo) / 1e6}  optedIn=${m0.optedIn}  (= payTo AND relayer)`)

  if (!p0.optedIn || p0.usdc < AMOUNT_BASE) {
    note(`SKIPPED — payer needs ≥ ${AMOUNT} USDCa and an opt-in (fund/opt-in ${payerAddr}). It can hold spare ALGO but pays ZERO fee.`)
    return
  }
  if (!m0.optedIn || m0.algo < 10_000n) {
    note(`SKIPPED — merchant must be opted into USDCa and hold ≥ 0.01 ALGO (it pays the group fee). Fund/opt-in ${merchantAddr}.`)
    return
  }

  // The gate: a standard `exact` rail, SELF-SETTLE with the merchant as its own relayer (feePayer
  // === payTo). No facilitator. One block of config.
  const app = express()
  app.get('/paid', requirePayment({
    chain: 'algorand', token: 'USDC', amount: AMOUNT, payTo: merchantAddr, rpcUrl: ALGOD,
    exact: { settle: 'self', relayer: { key: merchantMnemonic } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    // Confirm the gate dual-advertises the exact rail.
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts?.find((a) => a.scheme === 'exact')
    check('gate advertises an Algorand `exact` rail (method=algorand, feePayer set)',
      rail?.extra?.assetTransferMethod === 'algorand' && typeof rail?.extra?.feePayer === 'string',
      JSON.stringify(rail?.extra))
    check('onchain-proof floor is also advertised', ch.accepts?.some((a) => a.scheme === 'onchain-proof'))

    group('LIVE · gasless round-trip (buyer signs fee-0 axfer; merchant pools the group fee)')
    // The buyer pays via the SDK client, forcing the exact rail (schemes:['exact']).
    const client = new PipRailClient({ chain: 'algorand', wallet: { key: w.mnemonic }, schemes: ['exact'], rpcUrl: ALGOD })
    const r = await client.fetch(url)
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — resource unlocked by a real gasless Algorand exact payment',
      r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`)

    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      check('receipt scheme is exact + has a real settle txid',
        receipt.scheme === 'exact' && /^[A-Z2-7]{52}$/.test(receipt.transaction || ''), receipt.transaction)
      note(`settled tx: https://allo.info/tx/${receipt.transaction}`)
      await new Promise((res) => setTimeout(res, 4000))

      const p1 = await bal(payerAddr)
      const m1 = await bal(merchantAddr)
      check(`merchant received exactly ${AMOUNT} USDCa`, m1.usdc - m0.usdc === AMOUNT_BASE, `delta=${m1.usdc - m0.usdc}`)
      check(`payer USDCa dropped by exactly ${AMOUNT}`, p0.usdc - p1.usdc === AMOUNT_BASE, `delta=${p0.usdc - p1.usdc}`)
      check('payer spent ZERO ALGO (gasless — fee 0, balance unchanged)', p1.algo === p0.algo, `before=${p0.algo} after=${p1.algo}`)
      check('merchant paid the group fee (ALGO dropped by the pooled fee)', m0.algo - m1.algo > 0n && m0.algo - m1.algo <= 3000n, `fee paid=${m0.algo - m1.algo} µALGO`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
