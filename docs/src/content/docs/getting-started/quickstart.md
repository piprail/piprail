---
title: Quickstart
description: Gate a server route behind a payment, then pay it from a client. A full x402 round-trip in five minutes.
sidebar:
  order: 3
---

## Introduction

This walks the whole loop: stand up a paid endpoint, then pay it from an agent. Both sides use
mainnet USDC on Base, but the only thing that changes for another chain is the `chain` value.

:::tip[Fastest start, no code]
Skip the manual wiring: [`@piprail/create`](/getting-started/scaffolder/) scaffolds a complete,
mainnet-ready merchant in one command: `npm create @piprail`. This page wires the **same
thing by hand** so you understand each piece.
:::

:::note
Before you start, you need a funded wallet on the chain you pick (a little of the payment token
plus a little native coin for gas) and an RPC endpoint. The built-in presets ship public RPC
defaults; pass your own `rpcUrl` for anything serious.
:::

## 1. Gate a route (the seller)

`requirePayment` returns Express/Connect middleware. The route answers `402 Payment Required`
until a payment for the right amount, asset, and recipient verifies on-chain. Then it runs.

```ts
import express from 'express'
import { requirePayment } from '@piprail/sdk'

const app = express()

app.get(
  '/report',
  requirePayment({
    chain: 'base',
    token: 'USDC',
    amount: '0.10',          // human units. 0.10 USDC ≈ 10 US cents (USDC is a $1 stablecoin)
    payTo: '0xYourWallet',   // paid straight to you; PipRail never touches it
  }),
  (req, res) => {
    res.json({ report: 'the goods behind the paywall' })
  },
)

app.listen(3000)
```

Not on Express? `createPaymentGate` gives you the same logic framework-free for Hono, Fastify,
Workers, Next, Bun, or Deno. See [Accepting Payments](/accepting-payments/require-payment-and-gate/).

## 2. Pay it (the buyer)

`PipRailClient.fetch` is a drop-in for `fetch`. When the server answers 402, it reads the
challenge, pays on-chain, and retries, all in one call.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY }, // a 0x-hex key, from the environment
})

const res = await client.fetch('http://localhost:3000/report')
const data = await res.json()
//    ^ { report: 'the goods behind the paywall' }, paid for and unlocked
```

That's the entire round-trip: `402 → pay on-chain → verify locally → 200`.

:::caution
`fetch` is the one call here that moves funds, so it's the one that can throw. Wrap it in a
`try/catch` for production. See [`PipRailClient`](/making-payments/piprail-client/) for the full
error surface (`.code` is a stable enum), and never re-pay on a timeout. Recover from the proof
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
[`planPayment()`](/making-payments/plan-payment/) for the full `PaymentPlan`, with per-rail
blockers, a `fundingHint`, and `best`.

## Try it against a live endpoint (no server needed)

Want to pay a real 402 before standing up your own server? PipRail runs a live one on **Base
mainnet**, a **$0.01 USDC** 402 you can hit right now:

```bash
curl -i https://piprail.com/x402/demo      # see a real 402 challenge + the accepts[]
```

```ts
// Pay it from a client (needs ~$0.01 USDC + a little ETH for gas on Base):
const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.AGENT_KEY } })
const res = await client.fetch('https://piprail.com/x402/demo')   // 402 → pay → 200
```

It's a real, backendless endpoint: dual-rail (PipRail's `onchain-proof` **and** a gasless standard
`exact` rail settled via the free PayAI facilitator), and it's listed on x402scan and 402 Index.
Prefer to watch the round-trip in your browser first? Try the interactive demo at
[piprail.com/demo](https://piprail.com/demo).

## One agent, every chain (multi-wallet)

A `PipRailClient` is bound to **one chain**. But a merchant might demand Base today and Solana
tomorrow, or list both in the same 402. Instead of wiring up routing yourself, give a
**`MultiChainPayer`** one wallet per chain and it pays whichever chain the 402 asks for,
under **one shared budget**:

```ts
import { MultiChainPayer } from '@piprail/sdk'

const agent = MultiChainPayer.fromWallets({
  wallets: {
    base:   { key: process.env.EVM_KEY },    // one EVM key works on every EVM chain
    solana: { key: process.env.SOLANA_KEY }, // every chain takes the same field: { key }
  },
  // ONE policy caps every chain. The agent can never exceed it, whatever chain it pays on.
  policy: { maxAmount: '1.00', maxTotal: '10.00', tokens: ['USDC'] },
})

// Same fetch/get/post/quote/planPayment as a single client, just across all your chains.
const res = await agent.get('https://api.example.com/report')
//    ^ settles on the first funded chain (in the order you listed) that can afford it
```

It surveys every funded chain when it hits the 402, then settles on the **first one you
listed** that can pay. No oracle, no backend, no manual routing. The
[agent toolkit](/agent-toolkit/payment-tools/) and the [MCP server](/mcp/overview/) wrap it
**unchanged**, so an LLM with a multi-chain bundle uses the exact same tools. Full reference:
[Multi-chain buying](/making-payments/multi-chain/).

## Next steps

- Add **spend caps** so an agent can't overspend: [Spend Controls](/spend-controls/payment-policy/).
- Pay a 402 on **whichever chain it asks for**: [Multi-chain buying](/making-payments/multi-chain/).
- Offer **several chains at once** in one challenge (seller side): [Defining Accepts](/accepting-payments/defining-accepts/).
- Hand the whole thing to an LLM with the [MCP server](/mcp/overview/).
