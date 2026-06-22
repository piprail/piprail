---
title: Mastra
description: Give a Mastra agent a budget-bound x402 payment wallet across every major chain, via the @piprail/mcp MCP server. The first x402 integration for Mastra — self-custody, no facilitator, no fee.
sidebar:
  order: 5
---

[Mastra](https://mastra.ai) agents can **pay for [x402](https://x402.org)-gated APIs and resources** with
PipRail — the **first x402 payment integration for Mastra**, which ships no payment rail of its own. The
agent gets a [budget-bound](/spend-controls/payment-policy/) wallet that settles straight from your own
wallet, verified on your own RPC: no facilitator, no fee.

## How it works

Like [OpenClaw](/integrations/openclaw/) and [Hermes](/integrations/hermes/) (and unlike the native
[elizaOS](/integrations/elizaos/) / [n8n](/integrations/n8n/) packages), Mastra wires in the published
[`@piprail/mcp`](/mcp/overview/) server through Mastra's first-class
[`MCPClient`](https://mastra.ai/docs/mcp/overview). The agent gets all **8 PipRail tools** (`piprail_*`),
capped by a spend policy it cannot exceed.

:::note[`viem` never enters Mastra's tree]
`@piprail/mcp` runs as a separate `npx` process, so neither [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk)
nor its `viem` peer becomes a Mastra dependency — the cleanest possible footprint. The integration *is* the
MCP server plus one `MCPClient` block. Every chain PipRail supports works, EVM and non-EVM.
:::

## Setup

Point Mastra's `MCPClient` at `@piprail/mcp`, then hand its tools to an agent:

```ts
// src/mastra/mcp.ts
import { MCPClient } from '@mastra/mcp'

export const piprailMcp = new MCPClient({
  id: 'piprail',
  servers: {
    piprail: {
      command: 'npx',
      args: ['-y', '@piprail/mcp'],
      env: {
        PIPRAIL_PRIVATE_KEY: process.env.PIPRAIL_PRIVATE_KEY ?? '', // omit for read-only
        PIPRAIL_CHAIN: 'base',
        PIPRAIL_MAX_AMOUNT: '0.10', // max per payment (token units)
        PIPRAIL_MAX_TOTAL: '5.00', // lifetime budget per token
        PIPRAIL_TOKENS: 'USDC',
      },
    },
  },
})
```

```ts
// src/mastra/agents/payment-agent.ts
import { Agent } from '@mastra/core/agent'
import { openai } from '@ai-sdk/openai'
import { piprailMcp } from '../mcp'

export const paymentAgent = new Agent({
  id: 'payment-agent',
  name: 'PipRail Payment Agent',
  instructions: 'You can pay x402 URLs for the user, within a hard spend policy. Quote and plan before you pay.',
  model: openai('gpt-5'), // any Vercel AI SDK provider, or Mastra's 'openai/…' model router
  tools: await piprailMcp.listTools(), // all 8 PipRail tools, registered at agent level
})
```

For per-request (dynamic) tools instead of agent-level, pass `await piprailMcp.listToolsets()` to
`agent.generate(prompt, { toolsets })`.

:::note[Tool names are namespaced]
Mastra prefixes every MCP tool with its server key, so PipRail's `piprail_*` tools surface to the agent
as **`piprail_piprail_*`** (server key + tool name) — standard Mastra behavior. The agent reads exact
names from its tool schema, so it's invisible in practice; just don't hard-code the un-prefixed names in
your own prompts.
:::

**Read-only first run:** omit `PIPRAIL_PRIVATE_KEY` and PipRail boots key-less — discover / quote / plan /
budget / guide all work; only `piprail_pay_request` needs the wallet.

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | only to **pay** | — | Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). **Omit for read-only.** Not an API key — never commit it. |
| `PIPRAIL_CHAIN` | — | `base` | Chain to pay on (any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl`). |
| `PIPRAIL_CHAINS` | — | — | **Multi-chain** — comma-separated; each takes its own `PIPRAIL_<CHAIN>_KEY`. Pays whichever chain a 402 asks for. |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the token's units (≈ $ for USDC/USDT). |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per token (server default; this example sets `5.00`). |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens, comma-separated. |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers. |
| `PIPRAIL_RPC_URL` | — | chain default | Custom RPC (recommended in production). |

:::danger[The pay tool spends autonomously]
`piprail_pay_request` moves money without a per-payment confirmation — bounded only by the spend caps. Keep
the caps conservative, fund the wallet with only what the agent may spend, and treat the key as hot.
:::

## The 8 tools

`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · **`piprail_pay_request`** ·
`piprail_register` · `piprail_budget` · `piprail_guide` · `piprail_verify_receipt`. Only
`piprail_pay_request` moves money; the rest are read-only. Full reference: [MCP tools](/mcp/tools/).
(As noted above, Mastra surfaces these prefixed with the server key — e.g. `piprail_piprail_pay_request`.)

## Verify

The runnable example lives at
[`integrations/mastra/piprail/`](https://github.com/piprail/piprail/tree/main/integrations/mastra/piprail) —
`npm install`, then:

```bash
node verify.mjs --live --mastra   # drives the REAL @mastra/mcp MCPClient + the live demo
```

It proves `MCPClient.listTools()` surfaces all 8 PipRail tools (each callable, ready for `new Agent({ tools })`),
quotes the live demo (0.01 USDC on Base), and confirms a below-price cap **refuses** the payment — no funds
move. For the checklist, see [`integrations/TESTING.md`](https://github.com/piprail/piprail/blob/main/integrations/TESTING.md).

## See also

- [MCP overview](/mcp/overview/) · [MCP tools](/mcp/tools/) · [Client setup](/mcp/client-setup/)
- [Spend controls](/spend-controls/payment-policy/) · [Chains](/chains/overview/)
