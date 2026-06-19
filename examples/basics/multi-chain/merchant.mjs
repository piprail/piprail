// A merchant that accepts payment on SEVERAL chains in ONE 402.
//
//   npm install && npm run merchant
//
// The gate returns a single 402 that advertises the SAME price on Base, Polygon,
// and Arbitrum (USDC). A buyer pays on whichever chain it holds funds for — the
// merchant gets paid straight to its wallet on that chain, verified locally.
//
// Env (all optional — sensible placeholders otherwise):
//   PORT          default 3000
//   PAY_TO_EVM    your EVM address (one address works on every EVM chain)
//   RPC_BASE / RPC_POLYGON / RPC_ARBITRUM   optional custom RPCs
//
// This is the BUYER-side companion to ./buyer.mjs. Run this, then run the buyer.

import express from 'express'
import { requirePayment } from '@piprail/sdk'

const PORT = Number(process.env.PORT ?? 3000)
// One EVM address receives on every EVM chain (same private key, same address).
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? '0x000000000000000000000000000000000000dEaD'

// ONE 402, THREE rails — same 0.05 USDC price on Base, Polygon, and Arbitrum.
// The buyer picks whichever chain it can settle, preferring the first it listed.
// Add a 'solana' / 'xrpl' / … rail here and a buyer funded on that chain can pay it too.
const paid = requirePayment({
  description: 'Quarterly numbers — pay 0.05 USDC on Base, Polygon, or Arbitrum',
  accept: [
    { chain: 'base', token: 'USDC', amount: '0.05', payTo: PAY_TO_EVM, rpcUrl: process.env.RPC_BASE },
    { chain: 'polygon', token: 'USDC', amount: '0.05', payTo: PAY_TO_EVM, rpcUrl: process.env.RPC_POLYGON },
    { chain: 'arbitrum', token: 'USDC', amount: '0.05', payTo: PAY_TO_EVM, rpcUrl: process.env.RPC_ARBITRUM },
  ],
  onPaid: (r) => console.log(`✅ paid ${r.amount} USDC on ${r.network} — tx ${r.transaction.slice(0, 12)}…`),
})

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok' })) // free
app.get('/api/report', paid, (_req, res) => res.json({ report: 'TOP SECRET — quarterly numbers' }))

app.listen(PORT, () => {
  console.log(`Merchant on http://127.0.0.1:${PORT}`)
  console.log(`  GET /health      → free`)
  console.log(`  GET /api/report  → 0.05 USDC on Base | Polygon | Arbitrum → ${PAY_TO_EVM}`)
  console.log(`\nNow run the buyer:  node buyer.mjs http://127.0.0.1:${PORT}/api/report`)
})
