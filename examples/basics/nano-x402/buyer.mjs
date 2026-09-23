// Buyer that pays a resource on the Nano (XNO) x402 exact rail — feeless,
// sub-second settlement, no stablecoin approve, no gas auction.
//
//   NANO_CLIENT_KEY=… node buyer.mjs http://127.0.0.1:3000/api/report-nano
//
// The client builds a Nano send block for the exact-scheme price and sends the
// payment payload to the merchant (which hands it to a facilitator to verify).
// For the offline self-check in test.mjs we exercise the same create-flow
// against a stubbed verifier so no real XNO moves — see README (Keyless note).
//
// Env: NANO_CLIENT_KEY (the payer's raw-format Nano private key),
//      NANO_RPC_URL (default public rpc.nano.to), NANO_WORK_GENERATION_URL.

import { x402Client, x402HTTPClient } from '@x402/core/client'
import { ExactNanoScheme } from '@x402nano/exact/client'
import { Helper } from '@x402nano/helper'

const url = process.argv[2] ?? process.env.URL ?? 'http://127.0.0.1:3000/api/report-nano'

const client = new x402Client()
const helper = new Helper({
  NANO_ACCOUNT_PRIVATE_KEY: process.env.NANO_CLIENT_KEY,
  NANO_RPC_URL: process.env.NANO_RPC_URL ?? 'https://rpc.nano.to',
  NANO_WORK_GENERATION_URL: process.env.NANO_WORK_GENERATION_URL,
})
const exact = new ExactNanoScheme(helper)
client.register('nano:mainnet', exact)
client.setSpendControls({ allowedAssets: [{ network: 'nano:mainnet', asset: 'XNO' }] })

const http = new x402HTTPClient(client)

async function main() {
  console.log(`Target: ${url}\n`)
  const initial = await fetch(url)
  if (initial.status !== 402) {
    console.warn(`Expected a 402 challenge but got ${initial.status}. Is the merchant Nano rail up?`)
    return
  }
  const header = (name) => initial.headers.get(name)
  const req = await http.getPaymentRequiredResponse(header)
  console.log('402 challenge offers (accepts):')
  for (const a of req.paymentRequired?.paymentRequirements ?? []) {
    console.log(`  - ${a.payment.network} · ${a.payment.asset} · ${a.payment.amount}`)
  }
  const payload = await http.createPaymentPayload(req)
  const sigHeader = http.encodePaymentSignatureHeader(payload)
  console.log('\nPayment payload created (Nano send block). Retrying with PAYMENT-SIGNATURE…\n')

  const retry = await fetch(url, { headers: sigHeader })
  if (retry.status === 200) {
    const settle = http.getPaymentSettleResponse((n) => retry.headers.get(n))
    console.log(`Unlocked! Settled on ${settle.success ? 'nano:mainnet' : '?'}`)
    console.log(JSON.stringify(await retry.json(), null, 2))
  } else {
    console.error(`Retry failed with ${retry.status}`)
  }
}

main().catch((e) => { console.error('Error:', e?.message ?? e); process.exit(1) })
