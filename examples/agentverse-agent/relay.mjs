// PipRail Pay — the agent's paid service: an x402 "pay-for-me" relay.
//
// This is the agent that funds itself over x402. It has both PipRail sides:
//   EARN  — its /pay route is gated by `requirePayment`, DUAL-RAIL so ANY x402 client
//           can pay it: PipRail's `onchain-proof` AND the standard `exact` rail (self-
//           settled with the relay's own wallet). Verified locally, settled to YOUR wallet.
//   SPEND — once paid, a budget-bound `PipRailClient` pays the caller's target
//           x402 URL on their behalf and relays the unlocked result.
//
// Why it's useful: any agent that can't hold a wallet (or is on the wrong chain)
// can delegate payment to PipRail Pay — it pays the target and returns the result,
// capped by a spend policy the relay cannot exceed. Earn + spend, both x402, no
// backend, no custody.
//
//   npm install
//   PAY_TO=0xYourFeeWallet RELAY_PRIVATE_KEY=0xYourSpendKey npm run relay
//   curl "http://127.0.0.1:4031/agent"                         # free agent card
//   curl -i "http://127.0.0.1:4031/pay?url=https://piprail.com/x402/demo"  # 402 fee
//
// Register this server's PUBLIC url as your Agentverse webhook (see register.py).

import express from 'express'
import { requirePayment, PipRailClient } from '@piprail/sdk'

// ── EARN side: the fee gate (DUAL-RAIL — payable by ANY x402 client) ─────────
const PORT = Number(process.env.RELAY_PORT ?? 4031)
const GATE_CHAIN = process.env.RELAY_GATE_CHAIN ?? 'bnb'
const GATE_TOKEN = process.env.RELAY_GATE_TOKEN ?? 'USDC'
const FEE = process.env.RELAY_FEE ?? '0.02' // the service fee, > a typical target cost
const PAY_TO = process.env.PAY_TO ?? '0xYourFeeWallet'
const PUBLIC_URL = process.env.RELAY_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`

// ── SPEND side: the budget-bound payer ─────────────────────────────────────
const PAYER_CHAIN = process.env.RELAY_PAYER_CHAIN ?? 'base' // chain it pays targets on
// An allowlist keeps it from being an open relay to arbitrary URLs. Comma-separated
// hostnames; default = the live PipRail demo only. Widen deliberately.
const ALLOW_HOSTS = (process.env.RELAY_ALLOW_HOSTS ?? 'piprail.com')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

// Advertise the standard x402 `exact` rail BESIDE PipRail's `onchain-proof`, so EVERY
// x402 client can pay the relay — not just PipRail-equipped ones. It self-settles with
// the relay's own wallet (no facilitator needed); the transfer method (EIP-3009 vs
// Permit2) is auto-selected per token, so FDUSD/USD1 settle gaslessly for the buyer and
// Binance-Peg USDC/USDT settle via Permit2. ON by default on EVM gates (set RELAY_EXACT=0
// to disable, e.g. a non-EVM gate chain; or RELAY_GATE_FACILITATOR=<url> to settle via a
// facilitator instead of paying settle gas yourself).
const GATE_RELAYER_KEY = process.env.RELAY_RELAYER_KEY ?? process.env.RELAY_PRIVATE_KEY
const GATE_FACILITATOR = process.env.RELAY_GATE_FACILITATOR
const EXACT_ON = process.env.RELAY_EXACT !== '0' && Boolean(GATE_FACILITATOR || GATE_RELAYER_KEY)
const exactOpt = !EXACT_ON
  ? {}
  : GATE_FACILITATOR
    ? { exact: { settle: { facilitator: GATE_FACILITATOR } } }
    : { exact: { settle: 'self', relayer: { privateKey: GATE_RELAYER_KEY } } }

const fee = requirePayment({
  chain: GATE_CHAIN,
  token: GATE_TOKEN,
  amount: FEE,
  payTo: PAY_TO,
  rpcUrl: process.env.RELAY_GATE_RPC,
  ...exactOpt,
  onPaid: (r) =>
    console.log(`💰 earned ${r.amountFormatted} ${r.symbol} via ${r.scheme} — tx ${r.transaction.slice(0, 12)}…`),
})

// The relay's spending wallet, capped so the model/agent cannot overspend.
const payer = new PipRailClient({
  chain: PAYER_CHAIN,
  wallet: { privateKey: process.env.RELAY_PRIVATE_KEY },
  rpcUrl: process.env.RELAY_PAYER_RPC,
  policy: {
    maxAmount: process.env.RELAY_MAX_AMOUNT ?? '0.05', // per downstream call
    maxTotal: process.env.RELAY_MAX_TOTAL ?? '5.00', // lifetime, per token
    tokens: ['USDC', 'USDT'],
  },
  onEvent: (e) => {
    if (e.kind === 'payment-broadcast') console.log(`🛰️  spending on ${PAYER_CHAIN} — ${e.ref}`)
    if (e.kind === 'payment-settled') console.log(`🛰️  spend settled`)
  },
})

const app = express()
app.use(express.json())

function allowed(target) {
  try {
    return ALLOW_HOSTS.some((h) => new URL(target).hostname === h || new URL(target).hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

// Free — health.
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Free — the agent card (also what register.py advertises on Agentverse).
app.get('/agent', (_req, res) =>
  res.json({
    name: 'PipRail Pay',
    summary: 'Pay any x402 URL through me — a budget-bound, cross-chain x402 relay.',
    fee: { amount: FEE, token: GATE_TOKEN, chain: GATE_CHAIN, payTo: PAY_TO },
    rails: EXACT_ON ? ['onchain-proof', 'exact'] : ['onchain-proof'], // payable by any x402 client
    pays_on: PAYER_CHAIN,
    endpoint: `${PUBLIC_URL}/pay`,
    usage: `${PUBLIC_URL}/pay?url=<x402-url>  (pay the ${FEE} ${GATE_TOKEN} fee, then I pay the target and return the result)`,
    allow_hosts: ALLOW_HOSTS,
  })
)

// Paid — the relay. The caller pays the fee gate (EARN); then we pay their target
// x402 URL (SPEND) and return the unlocked result + both receipts.
app.all('/pay', fee, async (req, res) => {
  const target = String(req.query.url ?? req.body?.url ?? '')
  if (!target) return res.status(400).json({ error: 'missing ?url= (the x402 URL to pay)' })
  if (!allowed(target))
    return res.status(403).json({ error: `host not allowed: ${target} (allow: ${ALLOW_HOSTS.join(', ')})` })

  try {
    const downstream = await payer.fetch(target, {
      autoRoute: true,
      ...(req.method !== 'GET' && req.body?.body ? { method: req.method, body: JSON.stringify(req.body.body) } : {}),
    })
    const body = await downstream.text()
    res.json({
      relayed: true,
      target,
      downstream: {
        status: downstream.status,
        ok: downstream.ok,
        body: (() => {
          try {
            return JSON.parse(body)
          } catch {
            return body
          }
        })(),
      },
    })
  } catch (err) {
    // The caller already paid the fee, so report the downstream failure clearly
    // (a real deployment would refund or credit here).
    res.status(502).json({ relayed: false, target, error: String(err?.message ?? err) })
  }
})

app.listen(PORT, () => {
  console.log(`PipRail Pay relay → ${PUBLIC_URL}`)
  console.log(`  GET  /agent  → free agent card`)
  console.log(`  ANY  /pay    → ${FEE} ${GATE_TOKEN} on ${GATE_CHAIN} (earn) → pays target on ${PAYER_CHAIN} (spend)`)
  console.log(`  rails: onchain-proof${EXACT_ON ? ` + exact (${GATE_FACILITATOR ? 'facilitator' : 'self-settle'}) — any x402 client can pay` : ''}`)
  console.log(`  allow-hosts: ${ALLOW_HOSTS.join(', ')}`)
})
