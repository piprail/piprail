// A real agent. It calls a paid URL and pays automatically on a 402.
//
//   node agent.mjs                       # pays http://127.0.0.1:4021/report
//   URL=https://api.example.com/x node agent.mjs
//
// Env overrides: URL, RPC, AGENT_KEY.

import { PipRailClient } from '@piprail/sdk'

const URL = process.env.URL ?? 'http://127.0.0.1:4021/report'
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
// Anvil's account 0 — funded with 10000 ETH. NEVER use a real key like this.
const AGENT_KEY = process.env.AGENT_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const client = new PipRailClient({
  wallet: { privateKey: AGENT_KEY },
  chain: { id: 31337, rpcUrl: RPC, name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  onEvent: (e) => {
    if (e.kind === 'payment-required') console.log(`• 402 received — price is ${e.accept.extra.amountFormatted} ${e.accept.extra.symbol ?? 'native'}`)
    if (e.kind === 'payment-broadcast') console.log(`• paying on-chain — ref ${e.ref}`)
    if (e.kind === 'payment-confirmed') console.log(`• confirmed in block ${e.blockNumber}`)
    if (e.kind === 'payment-settled') console.log(`• server accepted the proof`)
  },
})

console.log(`GET ${URL}  (auto-pays if it returns 402)`)
const res = await client.fetch(URL) // one call — the 402 dance happens inside
console.log(`\n→ ${res.status} ${res.statusText}`)
console.log('→ data:', await res.json())
