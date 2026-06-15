---
title: Hermes
description: Give a Hermes agent a budget-bound PipRail wallet — pay x402 APIs across every chain, no facilitator, no fee. Add @piprail/mcp under mcp_servers, or install the Hermes MCP catalog entry.
sidebar:
  order: 2
---

[Hermes](https://github.com/NousResearch/hermes-agent) (NousResearch) agents get a **budget-bound
payment wallet** with PipRail: they can pay [x402](https://x402.org)-gated APIs, data feeds, and AI
services **on their own**, across [every supported chain](/chains/overview/) — and they **cannot**
spend more than the cap you set.

## How it works

PipRail plugs into Hermes as a **standard MCP server** — the published
**[`@piprail/mcp`](/mcp/overview/)** (`npx -y @piprail/mcp`). Hermes spawns it over stdio, the agent
gets all **[7 tools](/mcp/tools/)** (namespaced `mcp_piprail_*`, e.g. `mcp_piprail_piprail_pay_request`), and a spend policy the model
**cannot exceed** is baked in. There's no bespoke plugin to build — Hermes is Python and
`@piprail/sdk` is TypeScript, so the MCP server *is* the integration, plus one config entry.

:::tip[Hermes has no native payment rail]
Nous Portal is fiat-subscription only — there's even an open RFC for an agent wallet
([Issue #38280](https://github.com/NousResearch/hermes-agent/issues/38280)). PipRail is the drop-in
answer: **backendless, no fee, self-custodial, every chain** — funds settle straight to the
provider's wallet, verified locally against **your own RPC**.
:::

## Setup

**Quickest — one command.** Adds the server and (after a quick "enable all 7 tools?" prompt) saves it to
`~/.hermes/config.yaml`:

```bash
hermes mcp add piprail --command npx --args -y @piprail/mcp
```

Once the [catalog entry](#discover--publish) lands it gets shorter still — `hermes mcp install piprail`.
Or wire it by hand — Hermes nests MCP servers under the top-level **`mcp_servers`** key in
`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  piprail:
    command: "npx"
    args: ["-y", "@piprail/mcp"]
    enabled: true
    env:
      PIPRAIL_PRIVATE_KEY: "${PIPRAIL_PRIVATE_KEY}"   # from ~/.hermes/.env
      PIPRAIL_CHAIN: "base"
      PIPRAIL_MAX_AMOUNT: "0.10"
      PIPRAIL_MAX_TOTAL: "5.00"
      PIPRAIL_TOKENS: "USDC"
    tools:
      prompts: false
      resources: false
      include:
        - piprail_discover
        - piprail_quote_payment
        - piprail_plan_payment
        - piprail_pay_request
        - piprail_register
        - piprail_budget
        - piprail_guide
```

Run **`/reload-mcp`** in a session (or start a new one) and the `mcp_piprail_*` tools appear.

:::danger
**Two secret gotchas.** Hermes does **not** inherit your shell environment into the subprocess, so
`PIPRAIL_PRIVATE_KEY` **must** be in the server's `env:` block — otherwise pay stays `WALLET_REQUIRED`.
Keep the literal key in `~/.hermes/.env` (chmod 600) and reference it as `${PIPRAIL_PRIVATE_KEY}` —
Hermes expands `${VAR}` but **not** bare `$VAR`. Never commit the key.
:::

**Read-only first run:** omit the key and PipRail boots key-less — discover/quote/register/budget/guide
all work; only pay/plan need the wallet.

:::note[There's also a skill]
Beyond the MCP server (which is what actually pays), PipRail ships a small Hermes **skill** — usage
guidance for the agent. It's discoverable with `hermes skills search piprail`, or add the tap directly:
`hermes skills tap add piprail/skills`. The skill only teaches the quote → plan → pay workflow —
**install the MCP server above to get the tools.**
:::

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | only to **pay** | — | Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). **Omit it for read-only** — discover/quote/register/budget/guide still work. Not an API key. |
| `PIPRAIL_CHAIN` | — | `base` | Which chain to pay on — any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl`. NEAR also requires `PIPRAIL_NEAR_ACCOUNT_ID` to pay (e.g. you.near). |
| `PIPRAIL_CHAINS` | — | — | **Pay across several chains** (instead of `PIPRAIL_CHAIN`) — e.g. `base,polygon,solana`, each with its own `PIPRAIL_<CHAIN>_KEY`; pays whichever chain a 402 asks for. See [Configuration](/mcp/configuration/#pay-on-several-chains-from-one-server). |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the **token's units** (≈ $ for USDC/USDT; native-coin units on a `native` rail) |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per token; in multi-chain mode, per chain+token |
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

Only `piprail_pay_request` moves funds; in Hermes they surface as `mcp_piprail_*`. To let the agent
read and plan but never auto-spend, drop `piprail_pay_request` from the server's `tools.include`. Full
reference: [the 7 tools](/mcp/tools/).

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

## Discover & publish

PipRail is added to Hermes two ways — both PRs into
[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent):

1. **MCP catalog (primary)** — a `optional-mcps/piprail/manifest.yaml` entry makes
   `hermes mcp install piprail` work natively, carrying the "Nous-approved" label.
2. **Skills Hub** — a `SKILL.md` published via `hermes skills publish`, or contributed to
   `optional-skills/`.

Both ship in the runnable folder below.

## Verify

1. **Quote the live demo** — `piprail_quote_payment("https://piprail.com/x402/demo")` returns a real
   price (0.01 USDC on Base).
2. **Pay it** — `piprail_pay_request("https://piprail.com/x402/demo")` returns a `200` + a receipt.
3. **Budget holds** — set `PIPRAIL_MAX_TOTAL` below the price and confirm the agent is refused
   (`declined: true`), no funds moved.

The runnable folder lives at
[`integrations/hermes/piprail/`](https://github.com/piprail/piprail/tree/main/integrations/hermes/piprail) —
`manifest.yaml` (the catalog entry), `config.yaml`, `SKILL.md`, `.env.example`, and a zero-dep
`verify.mjs` (`node verify.mjs --live`).

## See also

- [MCP overview](/mcp/overview/) · [Client setup](/mcp/client-setup/) · [Tools](/mcp/tools/)
- [Spend controls](/spend-controls/payment-policy/) — how the cap is enforced
- [Chains](/chains/overview/) — every chain PipRail supports
