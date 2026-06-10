---
title: Quickstart
description: Gate a server route behind a payment, then pay it from a client — a full x402 round-trip in five minutes.
sidebar:
  order: 3
---

## Introduction

This walks the whole loop: stand up a paid endpoint, then pay it from an agent. Both sides use
mainnet USDC on Base, but the only thing that changes for another chain is the `chain` value.

:::note
Before you start, you need a funded wallet on the chain you pick (a little of the payment token
plus a little native coin for gas) and an RPC endpoint. The built-in presets ship public RPC
defaults; pass your own `rpcUrl` for anything serious.
:::

## 1. Gate a route (the seller)

`requirePayment` returns Express/Connect middleware. The route answers `402 Payment Required`
until a payment for the right amount, asset, and recipient verifies on-chain — then it runs.

```ts
import express from 'express'
import { requirePayment } from '@piprail/sdk'

const app = express()

app.get(
  '/report',
  requirePayment({
    chain: 'base',
    token: 'USDC',
    amount: '0.10',          // human units — 0.10 USDC
    payTo: '0xYourWallet',   // paid straight to you; PipRail never touches it
  }),
  (req, res) => {
    res.json({ report: 'the goods behind the paywall' })
  },
)

app.listen(3000)
```

Not on Express? `createPaymentGate` gives you the same logic framework-free for Hono, Fastify,
Workers, Next, Bun, or Deno — see [Accepting Payments](/accepting-payments/require-payment-and-gate/).

## 2. Pay it (the buyer)

`PipRailClient.fetch` is a drop-in for `fetch`. When the server answers 402, it reads the
challenge, pays on-chain, and retries — all in one call.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY }, // a 0x-hex key, from the environment
})

const res = await client.fetch('http://localhost:3000/report')
const data = await res.json()
//    ^ { report: 'the goods behind the paywall' } — paid for and unlocked
```

That's the entire round-trip: `402 → pay on-chain → verify locally → 200`.

:::caution
`fetch` is the one call here that moves funds, so it's the one that can throw — wrap it in a
`try/catch` for production. See [`PipRailClient`](/making-payments/piprail-client/) for the full
error surface (`.code` is a stable enum), and never re-pay on a timeout — recover from the proof
ref instead.
:::

## 3. Look before you pay (recommended for agents)

An autonomous agent should learn the price and check it can actually settle **before** spending.
The read-only trio never moves funds; each returns `null` when the URL isn't payment-gated (no
402), so null-guard the result before using it.

```ts
const url = 'https://api.example.com/report'

const quote = await client.quote(url)        // the price, with the token's TRUE decimals
// → { amountFormatted: '0.10', symbol: 'USDC', chain: 'base', withinPolicy: true, … }

const plan = await client.planPayment(url)   // can I pay? balance + gas + recipient readiness
// → { payable: true, best: { … }, options: [ … ], fundingHint: null, … }

if (plan?.payable) {
  await client.fetch(url)
} else if (plan) {
  console.log(plan.fundingHint)   // one-line, human-readable: what's missing
}
```

See [`quote()`](/making-payments/quote/) for the priced requirement,
[`estimateCost()`](/making-payments/estimate-cost/) for the gas, and
[`planPayment()`](/making-payments/plan-payment/) for the full `PaymentPlan` — per-rail
blockers, a `fundingHint`, and `best`.

## Next steps

- Add **spend caps** so an agent can't overspend — [Spend Controls](/spend-controls/payment-policy/).
- Offer **several chains at once** in one challenge — [Defining Accepts](/accepting-payments/defining-accepts/).
- Hand the whole thing to an LLM — the [MCP server](/mcp/overview/).
