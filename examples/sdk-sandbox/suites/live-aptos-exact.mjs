// LIVE mainnet smoke — the Aptos `exact` rail, SELF-SETTLE, on real USDC, TINY amounts.
// Proves the new gasless Aptos rail end-to-end with real money: the gate advertises an `exact`
// rail (fee-payer / sponsored tx), a PipRailClient pays it by signing ONLY the sender slot of a
// `primary_fungible_store::transfer`, and the gate's relayer adds the fee-payer signature + submits.
// The BUYER spends ZERO APT (gasless); the merchant's relayer pays the sub-cent gas to receive.
// USDC moves on Aptos mainnet, sub-second final.
//
// Role note: the FEE PAYER must hold APT. So here the APT-rich key is the feePayer (= payTo,
// self-settle), and the other funded key is the gasless buyer. feePayer === payTo is allowed on
// Aptos (the fee-payer signature is separate from the transfer, unlike Solana's MUST-rules).
//
// LOCAL ONLY. Reads keys from ../../../.secrets — never prints or commits them. Imports the LOCAL
// SDK build. Run: node suites/live-aptos-exact.mjs   (after `npm run build` in sdk/).
// Skips cleanly (never fails) if the wallets are underfunded.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import express from 'express'
import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk'
import { requirePayment, PipRailClient } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.APTOS_RPC ?? 'https://fullnode.mainnet.aptoslabs.com/v1'
const USDC = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const AMOUNT = '0.001' // 1000 base units (6dp) — tiny
const AMOUNT_BASE = 1000n
const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET, fullnode: RPC }))

async function bal(addr) {
  const apt = await aptos.getAccountAPTAmount({ accountAddress: addr }).then((n) => BigInt(n)).catch(() => 0n)
  let usdc = 0n
  try {
    const [b] = await aptos.view({
      payload: {
        function: '0x1::primary_fungible_store::balance',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [addr, USDC],
      },
    })
    usdc = BigInt(String(b))
  } catch {
    usdc = 0n
  }
  return { apt, usdc }
}

export async function run() {
  group('LIVE · Aptos exact (self-settle) — mainnet USDC, real money, tiny')

  let w
  try {
    w = JSON.parse(readFileSync(resolve(HERE, '../../../.secrets/wallets/aptos-wallet.json'), 'utf8'))
  } catch {
    note('SKIPPED — no .secrets/wallets/aptos-wallet.json (local-only test).')
    return
  }

  // The fee payer must hold APT → pick the APT-rich key as feePayer (= payTo, self-settle); the
  // other key is the gasless buyer. Keys are read here and NEVER printed.
  const a0 = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(w.privateKey) })
  const a1 = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(w.merchantPrivateKey) })
  const A0 = a0.accountAddress.toString()
  const A1 = a1.accountAddress.toString()
  const [b0, b1] = [await bal(A0), await bal(A1)]
  // feePayer/payTo = the APT-rich key; buyer = the other (must hold ≥ AMOUNT USDC).
  let relayerKey, buyerKey, payToAddr, buyerAddr
  if (b0.apt >= b1.apt) {
    relayerKey = w.privateKey; payToAddr = A0; buyerKey = w.merchantPrivateKey; buyerAddr = A1
  } else {
    relayerKey = w.merchantPrivateKey; payToAddr = A1; buyerKey = w.privateKey; buyerAddr = A0
  }
  const bp = await bal(buyerAddr)
  const bm = await bal(payToAddr)
  note(`buyer           ${buyerAddr.slice(0, 10)}…  USDC ${Number(bp.usdc) / 1e6}  APT ${Number(bp.apt) / 1e8}  (pays USDC, ZERO APT)`)
  note(`payTo=feePayer  ${payToAddr.slice(0, 10)}…  USDC ${Number(bm.usdc) / 1e6}  APT ${Number(bm.apt) / 1e8}  (receives + pays gas)`)

  if (bp.usdc < AMOUNT_BASE) {
    note(`SKIPPED — buyer needs ≥ ${AMOUNT} USDC (fund ${buyerAddr}). It pays ZERO APT.`)
    return
  }
  if (bm.apt < 600_000n) {
    note(`SKIPPED — feePayer must hold ≥ ~0.006 APT (it pays gas). Fund ${payToAddr}.`)
    return
  }

  // The gate: a standard `exact` rail, SELF-SETTLE with the merchant as its own relayer (feePayer
  // === payTo). No facilitator. One block of config.
  const app = express()
  app.get('/paid', requirePayment({
    chain: 'aptos', token: 'USDC', amount: AMOUNT, payTo: payToAddr, rpcUrl: RPC,
    exact: { settle: 'self', relayer: { key: relayerKey } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    // Confirm the gate dual-advertises the exact rail.
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts?.find((a) => a.scheme === 'exact')
    check('gate advertises an Aptos `exact` rail (method=aptos, feePayer set)',
      rail?.extra?.assetTransferMethod === 'aptos' && typeof rail?.extra?.feePayer === 'string',
      JSON.stringify(rail?.extra))
    check('onchain-proof floor is also advertised', ch.accepts?.some((a) => a.scheme === 'onchain-proof'))

    group('LIVE · gasless round-trip (buyer signs the sponsored transfer; relayer pays gas)')
    const client = new PipRailClient({ chain: 'aptos', wallet: { key: buyerKey }, schemes: ['exact'], rpcUrl: RPC })
    const r = await client.fetch(url)
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — resource unlocked by a real gasless Aptos exact payment',
      r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`)

    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      check('receipt scheme is exact + has a real settle tx hash',
        receipt.scheme === 'exact' && /^0x[0-9a-f]{64}$/i.test(receipt.transaction || ''), receipt.transaction)
      note(`settled tx: https://explorer.aptoslabs.com/txn/${receipt.transaction}?network=mainnet`)
      await new Promise((res) => setTimeout(res, 3000))

      const ap = await bal(buyerAddr)
      const am = await bal(payToAddr)
      check(`payTo received exactly ${AMOUNT} USDC`, am.usdc - bm.usdc === AMOUNT_BASE, `delta=${am.usdc - bm.usdc}`)
      check(`buyer USDC dropped by exactly ${AMOUNT}`, bp.usdc - ap.usdc === AMOUNT_BASE, `delta=${bp.usdc - ap.usdc}`)
      check('buyer spent ZERO APT (gasless — balance unchanged)', ap.apt === bp.apt, `before=${bp.apt} after=${ap.apt}`)
      check('feePayer paid the gas (APT dropped)', bm.apt - am.apt > 0n, `gas paid=${bm.apt - am.apt} octas`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
