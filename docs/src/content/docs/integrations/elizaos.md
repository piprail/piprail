---
title: elizaOS
description: Give an elizaOS agent a budget-bound PipRail wallet — pay x402 APIs across every chain, no facilitator, no fee. A native elizaOS plugin wrapping @piprail/sdk's payment tools.
sidebar:
  order: 3
---

[elizaOS](https://github.com/elizaOS/eliza) agents get a **budget-bound payment wallet** with PipRail:
they can pay [x402](https://x402.org)-gated APIs, data feeds, and AI services **on their own**, across
[every supported chain](/chains/overview/) — and they **cannot** spend more than the cap you set.

## How it works

Unlike the [OpenClaw](/integrations/openclaw/) and [Hermes](/integrations/hermes/) integrations (which
wire the [`@piprail/mcp`](/mcp/overview/) server over stdio), elizaOS gets a **native plugin** —
[`@piprail/elizaos-plugin`](https://github.com/piprail/piprail/tree/main/integrations/elizaos/piprail).
It wraps the SDK's [`paymentTools`](/agent-toolkit/payment-tools/) directly into **six elizaOS actions**.
It has no payment logic of its own — it delegates to the published
[`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk), so the agent's own key signs against your
own RPC: **self-custody, no facilitator, no fee**, and a spend policy the model **cannot exceed**.

:::tip[elizaOS has a sell-side x402 plugin — this is the buy side]
`@elizaos/plugin-x402` lets an agent *charge* for its services. `@piprail/elizaos-plugin` is the
counterpart: it lets an agent *pay* — autonomously, across [every chain](/chains/overview/), budget-bound.
:::

## Setup

```bash
npm install @piprail/elizaos-plugin
```

List the plugin in your character and give it a funded wallet key + caps:

```jsonc
{
  "name": "PayBot",
  "plugins": ["@piprail/elizaos-plugin"],
  "settings": {
    "PIPRAIL_CHAIN": "base",
    "PIPRAIL_MAX_AMOUNT": "0.10",   // per-payment cap
    "PIPRAIL_MAX_TOTAL": "5.00",    // lifetime cap
    "secrets": { "PIPRAIL_PRIVATE_KEY": "0x-your-funded-key" }
  }
}
```

In a TypeScript character you can instead `import { piprailPlugin } from '@piprail/elizaos-plugin'` and
put the object in `plugins: [piprailPlugin]`. See
[`character.example.json`](https://github.com/piprail/piprail/tree/main/integrations/elizaos/piprail/character.example.json).

:::danger[`PIPRAIL_PAY` spends autonomously]
`PIPRAIL_PAY` is the only action that moves money, and it pays **without a per-payment human
confirmation** — bounded only by the spend policy. Keep `PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL`
conservative, fund the wallet with only what the agent may spend, and treat the key as hot.
:::

**Wallet required.** The plugin needs `PIPRAIL_PRIVATE_KEY` (a self-custodial key) — *every* action
validates against the wallet, so set it before the agent will offer any PipRail action. (For a
key-less read-only mode — discover / quote / budget / guide with no wallet — use the
[MCP server](/mcp/overview/) instead, which boots read-only.)

## Configure

The plugin reads these from the character's `settings` / `settings.secrets` (via `runtime.getSetting`):

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | **yes** | — | Self-custodial wallet key (EVM `0x…`, Solana base58, …). Put it in `settings.secrets`. Every action requires it. Not an API key. |
| `PIPRAIL_CHAIN` | — | `base` | Which chain to pay on — any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl`. |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment → `policy.maxAmount` |
| `PIPRAIL_MAX_TOTAL` | — | `5.00` | Lifetime budget → `policy.maxTotal` |

The plugin pays with `schemes: ['onchain-proof', 'exact']`, so it also settles standard x402 servers
(gasless for the buyer on the `exact` rail). Full policy surface:
[Payment policy](/spend-controls/payment-policy/).

## The actions

| Action | Similes | What it does | Moves money? |
| --- | --- | --- | --- |
| `PIPRAIL_PAY` | PAY · BUY · PURCHASE | Pay a gated x402 URL and return the unlocked resource | **yes** |
| `PIPRAIL_QUOTE` | PRICE · HOW_MUCH · COST | Price a 402 URL without paying | no |
| `PIPRAIL_PLAN` | CAN_I_AFFORD · AFFORD | Check affordability + the cheapest rail | no |
| `PIPRAIL_DISCOVER` | FIND_API · SEARCH_X402 | Find x402-payable APIs matching a query | no |
| `PIPRAIL_BUDGET` | SPENT · REMAINING | What's been spent / what remains under the policy | no |
| `PIPRAIL_GUIDE` | HOW_TO_PAY · PAYMENT_HELP | Explain the payment tools + the spend policy | no |

Only `PIPRAIL_PAY` moves funds — and it's offered only when the message contains a URL. These wrap six
of [the eight PipRail tools](/mcp/tools/); the programmatic `piprail_register` + `piprail_verify_receipt`
stay available via [`@piprail/sdk`](/agent-toolkit/payment-tools/) or [`@piprail/mcp`](/mcp/overview/).

## The agent workflow

**discover → quote → plan → pay.**

```
User:  Find me a crypto price API I can pay for.
Agent: [PIPRAIL_DISCOVER]  → 3 x402 resources found.
User:  Can I afford the first one?
Agent: [PIPRAIL_PLAN(url)]  → Payable — best rail: eip155:8453.
User:  Pay it.
Agent: [PIPRAIL_PAY(url)]  → Paid (tx 0x…). <resource>
```

## Verify

Point the plugin at the live demo (0.01 USDC on Base):

1. **Quote** — `PIPRAIL_QUOTE` on `https://piprail.com/x402/demo` → `Price: 0.01 USDC on eip155:8453.`
2. **Pay** — `PIPRAIL_PAY` → `Paid (tx 0x…).` and the unlocked body.
3. **Budget holds** — set `PIPRAIL_MAX_TOTAL` below the price and confirm the agent is declined, no funds moved.

The runnable plugin lives at
[`integrations/elizaos/piprail/`](https://github.com/piprail/piprail/tree/main/integrations/elizaos/piprail) —
`npm run build`, `npm run typecheck`, `npm run smoke`. It's proven on Base mainnet by driving the
plugin's own action handlers (a real on-chain settle, the budget cap enforced).

## See also

- [Agent toolkit — `paymentTools`](/agent-toolkit/payment-tools/) — the descriptors this plugin wraps
- [MCP overview](/mcp/overview/) · [Spend controls](/spend-controls/payment-policy/) · [Chains](/chains/overview/)
