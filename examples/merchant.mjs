// A real merchant server. One paid route, gated by PipRail.
//
//   node merchant.mjs
//
// Then in another terminal:
//   curl -i http://127.0.0.1:4021/report     # → 402 with a price quote
//   node agent.mjs                            # pays, then gets the data
//
// Env overrides: PORT, RPC, PAY_TO, AMOUNT.

import express from 'express'
import { requirePayment } from '@piprail/sdk'

const PORT = Number(process.env.PORT ?? 4021)
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const PAY_TO = process.env.PAY_TO ?? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const AMOUNT = process.env.AMOUNT ?? '0.01'

// Anvil, defined inline so the demo needs no chain config files.
const ANVIL = {
  id: 31337,
  rpcUrl: RPC,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
}

const app = express()

// This is the whole integration: one middleware in front of your handler.
app.get(
  '/report',
  requirePayment({
    chain: ANVIL,        // on mainnet this is just 'base' or 'bnb'
    token: 'native',     // or 'USDC', or { address, decimals }
    amount: AMOUNT,
    payTo: PAY_TO,
    onPaid: (r) => console.log(`✅ paid: ${r.amount} from ${r.payer}  (tx ${r.transaction})`),
  }),
  // Your normal handler. It only runs AFTER payment is verified on-chain.
  (_req, res) => res.json({ report: 'TOP SECRET — quarterly numbers', at: new Date().toISOString() }),
)

app.listen(PORT, () => {
  console.log(`merchant listening on http://127.0.0.1:${PORT}`)
  console.log(`accepting ${AMOUNT} ETH (native) → ${PAY_TO}`)
  console.log()
  console.log(`  curl -i http://127.0.0.1:${PORT}/report   # see the 402 challenge`)
  console.log(`  node agent.mjs                            # pay + fetch the data`)
})
