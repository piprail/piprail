// An agent that pays a 402 automatically — zero ceremony.
//
//   AGENT_KEY=0x… URL=https://api.example.com/report npm run pay
//
// Create a client with a chain + wallet, then call fetch(url). If the server
// answers 402, the client pays on-chain and retries with proof — automatically.

import { PipRailClient } from '@piprail/sdk'

const URL = process.env.URL ?? 'https://api.example.com/report'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY }, // a funded Base key: USDC + a little ETH for gas
  onEvent: (e) => {
    if (e.kind === 'payment-required') console.log(`• 402 — price ${e.accept.extra.amountFormatted} ${e.accept.extra.symbol ?? ''}`)
    if (e.kind === 'payment-broadcast') console.log(`• paying — ${e.ref}`)
    if (e.kind === 'payment-confirmed') console.log(`• confirmed in block ${e.blockNumber}`)
    if (e.kind === 'payment-settled') console.log(`• server accepted the proof`)
  },
})

console.log(`GET ${URL}  (auto-pays if it returns 402)\n`)
const res = await client.fetch(URL)
console.log(`→ ${res.status} ${res.statusText}`)
console.log('→', await res.json())
