// Express: gate a route with PipRail in one middleware.
//
//   npm install && PAY_TO=0xYourWallet… npm start
//
//   curl http://127.0.0.1:3000/health      # → free
//   curl http://127.0.0.1:3000/api/report  # → 402 + payment challenge
//
// Point any agent at /api/report — see ../agent for one that auto-pays.
// Env: PORT (default 3000), PAY_TO (your wallet), RPC (optional custom Base RPC).

import express from 'express'
import { requirePayment } from '@piprail/sdk'

const PORT = Number(process.env.PORT ?? 3000)
const PAY_TO = process.env.PAY_TO ?? '0xYourWallet…'

// One gate config, reusable across as many routes as you like.
const paid = requirePayment({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo: PAY_TO,
  rpcUrl: process.env.RPC, // optional; omit to use a public Base RPC
  // Notified the instant a payment SUCCEEDS…
  onPaid: (r) => console.log(`✅ paid ${r.amountFormatted} ${r.symbol} by ${r.payer.slice(0, 8)}… — tx ${r.transaction.slice(0, 10)}…`),
  // …AND the instant one is REJECTED (the buyer's client is told the same `code`). `transient`
  // means the proof may still be settling (RPC lag) and the buyer auto-retries — alert on !transient.
  onFailed: (f) => console.log(`⚠️  rejected: ${f.code}${f.transient ? ' (transient — buyer retrying)' : ''} — ${f.detail}`),
})

const app = express()

// Free route — no payment.
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Paid route — 0.05 USDC on Base, straight to your wallet.
app.get('/api/report', paid, (_req, res) => {
  res.json({ report: 'TOP SECRET — quarterly numbers' })
})

app.listen(PORT, () => {
  console.log(`http://127.0.0.1:${PORT}`)
  console.log(`  GET /health      → free`)
  console.log(`  GET /api/report  → 0.05 USDC on Base → ${PAY_TO}`)
})
