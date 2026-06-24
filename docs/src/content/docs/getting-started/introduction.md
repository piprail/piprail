---
title: Introduction
description: What PipRail is — backendless x402 crypto payments for AI agents across every major chain — and the one idea that makes it work.
sidebar:
  order: 1
---

## What is PipRail?

PipRail is **three things, no server.** It lets any HTTP request demand a crypto payment — the
HTTP `402 Payment Required` status, finally put to use — and lets any agent pay one
automatically. There is no middleman: payments settle **straight into your wallet**, verified
locally against your own RPC.

- **[`@piprail/sdk`](/reference/api/)** — a TypeScript SDK for x402 payments across any EVM
  chain, Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and the XRP Ledger. `npm
  install`, name a chain, add a wallet, done.
- **[`@piprail/mcp`](/mcp/overview/)** — a Model Context Protocol server that wraps the SDK,
  handing any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) a
  budget-bound wallet to pay x402 URLs autonomously, capped by a spend policy the model cannot
  exceed.
- **The marketing site** — [piprail.com](https://piprail.com), the pitch and the live demo.

There is no backend, no database, no auth, no dashboard, and **no fee**. It's a tool you `npm
install`, not a platform you sign up for.

:::tip[Just want to get paid?]
The fastest path is [`create-piprail`](/getting-started/scaffolder/) — `npm create piprail@latest`
scaffolds a complete, deployable merchant (no code, no key, no account). Or follow the
[Quickstart](/getting-started/quickstart/) to wire it yourself.
:::

## The one idea

Most payment SDKs ship an **allowlist** — a fixed set of chains they bless, and a facilitator
in the middle that settles on your behalf. PipRail inverts both:

> **Chain details are data the caller passes, not an allowlist the SDK ships.** Built-in presets
> (each with canonical USDC pre-filled) are a convenience; any other EVM chain works by passing a
> viem `Chain` or `{ id, rpcUrl }`. No gatekeeping. And there's no facilitator — your server
> verifies the payment itself, on-chain, against its own RPC.

One parameter picks everything:

```ts
const opts = { chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' }
//             ^^^^^^^^^^^^^ — 'base' | 'bnb' | 'solana' | 'ton' | 'xrpl' | … picks the whole rail
```

x402 v2 §7 explicitly blesses this merchant-local shape ("resource servers MAY… host the
endpoints themselves"), so being backendless is **spec-supported, not a workaround**.

## The two sides

PipRail has exactly two entry points — the seller and the buyer.

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

// ACCEPT (server side) — turn a route paid-only.
// requirePayment(...) returns an Express-style middleware: drop it in front of a handler.
const middleware = requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })

// PAY (agent side) — a fetch that pays 402s itself.
const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.AGENT_KEY } })

const res = await client.fetch('https://api.example.com/report') // pays the 402, then returns the page
const report = await res.json()
```

The same app can both **take** payments (`middleware`) and **make** them (`client`). From here,
[`PipRailClient`](/making-payments/piprail-client/) is the buyer's core surface — `quote`,
`estimateCost`, `planPayment`, and `fetch` (plus `discover`/`register`/`canAfford`/`spent`/`budget`).

:::note
The protocol layer is **chain-agnostic**. Naming a non-EVM chain lazily imports only that
family's libraries on first use — so pure-EVM installs never download Solana, TON, or any
other family's dependencies. See [How it works](/getting-started/how-it-works/).
:::

## Where to go next

- New here? [Installation](/getting-started/installation/) → [Quickstart](/getting-started/quickstart/).
- Want the mental model first? [How it works](/getting-started/how-it-works/) and
  [The x402 flow](/concepts/the-x402-flow/).
- Building an agent? [Making Payments](/making-payments/piprail-client/) and the
  [MCP server](/mcp/overview/).
