---
title: OpenClaw
description: Give an OpenClaw agent a budget-bound PipRail wallet — pay x402 APIs across every chain, no facilitator, no fee. Install the ClawHub skill or add @piprail/mcp as a raw MCP server.
sidebar:
  order: 1
---

[OpenClaw](https://github.com/openclaw) agents get a **budget-bound payment wallet** with PipRail:
they can pay [x402](https://x402.org)-gated APIs, data feeds, and AI services **on their own**, across
[every supported chain](/chains/overview/) — and they **cannot** spend more than the cap you set.

## How it works

PipRail plugs into OpenClaw as a **standard MCP server** — the published
**[`@piprail/mcp`](/mcp/overview/)** (`npx -y @piprail/mcp`). OpenClaw spawns it over stdio, the agent
gets all **[7 tools](/mcp/tools/)** natively, and a spend policy the model **cannot exceed** is baked
in. There's no bespoke plugin to build or maintain — the integration is the MCP server plus one config
entry.

:::tip[Why PipRail over other OpenClaw crypto skills]
Every other OpenClaw payment skill routes through a **facilitator or custodian**. PipRail is
**backendless, no fee, self-custodial, every chain** — funds settle straight to the provider's wallet,
verified locally against **your own RPC**.
:::

## Setup

Add PipRail to `~/.openclaw/openclaw.json`. OpenClaw nests MCP servers under **`mcp.servers`** (not a
top-level `mcpServers`), and you can manage the block with `openclaw mcp set` / `openclaw mcp list`:

```json
{
  "mcp": {
    "servers": {
      "piprail": {
        "command": "npx",
        "args": ["-y", "@piprail/mcp"],
        "env": {
          "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
          "PIPRAIL_CHAIN": "base",
          "PIPRAIL_MAX_AMOUNT": "0.10",
          "PIPRAIL_MAX_TOTAL": "5.00",
          "PIPRAIL_TOKENS": "USDC"
        }
      }
    }
  }
}
```

Restart OpenClaw and the `piprail_*` tools appear. You can also **discover** PipRail on
[ClawHub](https://github.com/openclaw/clawhub) — `clawhub install piprail` — which carries this same
setup.

:::danger
Never commit your key. Keep it in the `env` block (or your shell) — treat that file as a secret.
OpenClaw passes ordinary credential env vars through to the server, but strips interpreter-startup vars
(`NODE_OPTIONS`, etc.).
:::

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | only to **pay** | — | Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). **Omit it for read-only** — discover/quote/register/budget/guide still work. Not an API key. |
| `PIPRAIL_CHAIN` | — | `base` | Which chain to pay on — any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl` |
| `PIPRAIL_CHAINS` | — | — | **Pay across several chains** (instead of `PIPRAIL_CHAIN`) — e.g. `base,polygon,solana`, each with its own `PIPRAIL_<CHAIN>_KEY`; pays whichever chain a 402 asks for. See [Configuration](/mcp/configuration/#pay-on-several-chains-from-one-server). |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the **token's units** (≈ $ for USDC/USDT; native-coin units on a `native` rail) |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per (chain, token) |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens, comma-separated |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers |
| `PIPRAIL_RPC_URL` | — | chain default | Custom RPC (recommended in production) |

Defaults are deliberately small and safe (0.10 per payment, 10.00 lifetime, USDC on Base). The full
env reference is on the [Configuration](/mcp/configuration/) page; the wallet key format your chain
expects is in [Wallets by family](/making-payments/wallets-by-family/).

## The 7 tools

| Tool | What it does | Moves money? |
| --- | --- | --- |
| `piprail_discover` | Find payable x402 APIs on the open indexes | no |
| `piprail_quote_payment` | Get a URL's price without paying | no |
| `piprail_plan_payment` | Check you can afford it (balance + gas + recipient-ready) | no |
| `piprail_pay_request` | Pay the 402 and return the resource | **yes** |
| `piprail_register` | List your own x402 API so other agents find it | no |
| `piprail_budget` | Read remaining spend + time leash | no |
| `piprail_guide` | Read the agent contract (quote → plan → pay) | no |

Only `piprail_pay_request` moves funds. Full reference: [the 7 tools](/mcp/tools/).

## The agent workflow

**discover → quote → plan → pay.**

```
User:  Find me a crypto price API I can pay for.
Agent: [piprail_discover("crypto price")]  → cheapest is 0.001 USDC/call on Base.
User:  Can I afford it?
Agent: [piprail_plan_payment(url)]  → yes; 4.82 USDC left of 5.00, recipient ready, gas ~$0.05.
User:  Get me the ETH price.
Agent: [piprail_pay_request(url)]  → paid 0.001 USDC (tx 0x…). ETH: $3,247.18. 4.819 USDC left.
```

## Verify

1. **Quote the live demo** — `piprail_quote_payment("https://piprail.com/x402/demo")` returns a real
   price (0.01 USDC on Base).
2. **Pay it** — `piprail_pay_request("https://piprail.com/x402/demo")` returns a `200` + a receipt.
3. **Budget holds** — set `PIPRAIL_MAX_TOTAL` below the price and confirm the agent is refused
   (`declined: true`), no funds moved.

The runnable skill folder lives at
[`integrations/openclaw/piprail/`](https://github.com/piprail/piprail/tree/main/integrations/openclaw/piprail) —
`SKILL.md`, an example `openclaw.json`, and `.env.example`.

## See also

- [MCP overview](/mcp/overview/) · [Client setup](/mcp/client-setup/) · [Tools](/mcp/tools/)
- [Spend controls](/spend-controls/payment-policy/) — how the cap is enforced
- [Chains](/chains/overview/) — every chain PipRail supports
