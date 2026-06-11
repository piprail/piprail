// The payee's PipRail gate — the actual x402 resource an APP payer settles.
//
// In the Fetch Agent Payment Protocol (APP) mapping, the *payee agent* fronts
// this gate: its `RequestPayment.reference` is this server's /service URL. When
// the payer settles (via @piprail/mcp → piprail_pay_request), THIS gate verifies
// the proof LOCALLY against its own RPC and serves the result — no backend, no
// facilitator, funds straight to PAY_TO. The uAgents `CompletePayment` that
// follows is just the receipt for the negotiation log.
//
//   npm install && PAY_TO=0xYourWallet… npm run merchant
//   curl http://127.0.0.1:4021/offer      # → what to put in RequestPayment
//   curl http://127.0.0.1:4021/service    # → 402 + payment challenge
//
// On BNB (PIPRAIL_CHAIN=bnb) pick FDUSD or USD1 as TOKEN for the *gasless* path:
// the payer signs an EIP-3009 authorization (no gas, no Permit2 approve) and a
// facilitator can broadcast it — neither agent pays gas. USDC/USDT on BNB settle
// via Permit2; every chain also supports plain `onchain-proof`.

import express from 'express'
import { requirePayment } from '@piprail/sdk'

const PORT = Number(process.env.MERCHANT_PORT ?? 4021)
const CHAIN = process.env.PIPRAIL_CHAIN ?? 'base'
const TOKEN = process.env.MERCHANT_TOKEN ?? (CHAIN === 'bnb' ? 'FDUSD' : 'USDC')
const AMOUNT = process.env.MERCHANT_AMOUNT ?? '0.05'
const PAY_TO = process.env.PAY_TO ?? '0xYourWallet…'
const PUBLIC_URL = process.env.MERCHANT_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`

// Optionally ALSO advertise a standard `exact` rail. `onchain-proof` (the default,
// always on) lets the payer broadcast + prove — works on every chain with zero
// merchant setup. To make the payment GASLESS FOR BOTH SIDES, set a facilitator
// URL (e.g. Binance x402 on BNB): the payer signs an EIP-3009/Permit2 auth and the
// facilitator broadcasts it — neither agent pays gas. On BNB FDUSD/USD1 that's a
// no-approve EIP-3009 signature; USDC/USDT use Permit2 (a one-time approve).
const FACILITATOR = process.env.MERCHANT_FACILITATOR // optional facilitator URL
const exact = FACILITATOR ? { exact: { settle: { facilitator: FACILITATOR } } } : {}

// One gate config, reusable across routes. Verification is local (your own RPC).
const paid = requirePayment({
  chain: CHAIN,
  token: TOKEN,
  amount: AMOUNT,
  payTo: PAY_TO,
  rpcUrl: process.env.PIPRAIL_RPC_URL, // optional; omit for a public RPC
  ...exact,
  onPaid: (r) =>
    console.log(`✅ paid ${r.amount} ${TOKEN} by ${r.payer.slice(0, 10)}… — tx ${r.transaction.slice(0, 12)}…`),
})

const app = express()

// Free — a health check.
app.get('/health', (_req, res) => res.json({ status: 'ok', chain: CHAIN, token: TOKEN }))

// Free — the "offer": exactly what the payee agent puts in RequestPayment.
// (amount, currency, reference). Lets the demo run without hardcoding the price.
app.get('/offer', (_req, res) =>
  res.json({
    payment_method: 'x402',
    amount: AMOUNT,
    currency: TOKEN,
    chain: CHAIN,
    reference: `${PUBLIC_URL}/service`,
    pay_to: PAY_TO,
  })
)

// Paid — the service. 402 until settled; the result rides the 200 body.
app.get('/service', paid, (_req, res) => {
  res.json({
    service: 'fetch-app-demo',
    result: 'PAID UNLOCK — your agent-to-agent x402 settlement worked.',
    deliveredAt: new Date().toISOString(),
  })
})

app.listen(PORT, () => {
  console.log(`PipRail payee gate → ${PUBLIC_URL}`)
  console.log(`  GET /health   → free`)
  console.log(`  GET /offer    → free (the RequestPayment fields)`)
  console.log(`  GET /service  → ${AMOUNT} ${TOKEN} on ${CHAIN} → ${PAY_TO}`)
  if (CHAIN === 'bnb' && (TOKEN === 'FDUSD' || TOKEN === 'USD1'))
    console.log(`  (BNB ${TOKEN} is EIP-3009 → buyer signs gaslessly, no Permit2 approve)`)
})
