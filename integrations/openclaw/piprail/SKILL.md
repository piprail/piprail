---
name: piprail
description: A self-custodial crypto payment wallet for your OpenClaw agent, with a hard spend cap it can't exceed. It autonomously pays x402 paywalls ('402 Payment Required') on every major chain, settling funds straight to the recipient — no facilitator, no fee, no signup. Runs read-only with no key (discover/quote/plan before you add a wallet); add a key only to let the agent pay, optionally gaslessly via the standard x402 'exact' rail.
metadata:
  openclaw:
    emoji: "🛤️"
    homepage: https://piprail.com
    os:
      - darwin
      - linux
      - win32
    requires:
      bins:
        - npx
    install:
      - id: node
        kind: node
        package: "@piprail/mcp"
        bins:
          - piprail-mcp
        label: "Install @piprail/mcp (the PipRail MCP server)"
---

# PipRail — Agent Payment Wallet 🛤️

Give your OpenClaw agent a **self-custodial crypto payment wallet** with a **hard spend cap** it
can't exceed. It autonomously pays **x402** "402 Payment Required" paywalls across every major
chain — settling funds straight to the recipient's wallet, with **no facilitator, no fee, no signup**.

> **No API key. No account. No signup.** PipRail is self-custodial — you bring a wallet *you* control.
> It even runs **read-only with zero config**: `discover`, `quote`, `register`, `budget`, and `guide`
> work the moment it starts, no key at all. Add your own wallet key (`PIPRAIL_PRIVATE_KEY`) only when
> the agent should actually **pay** — it's a wallet signing key you hold, never an API credential, and
> it never leaves your machine.

PipRail plugs into OpenClaw as a **standard MCP server** — the published
**[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** (`npx -y @piprail/mcp`) over stdio —
so the agent gets all **8 tools** natively, capped by a budget it can't exceed.

## Why PipRail (vs every other crypto skill)

Every other OpenClaw payment skill routes through a **facilitator or custodian** that holds keys
and/or takes a cut. PipRail is different:

- **Backendless** — no facilitator, no hosted service. Payments verify locally against **your own RPC**.
- **No fee** — funds settle **straight to the service provider's wallet**. PipRail takes nothing.
- **Self-custodial** — your key, your machine. PipRail hosts and holds nothing.
- **Every major chain** — EVM (Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche, BNB…), Solana,
  TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL — one `PIPRAIL_CHAIN` param picks everything.
- **Gasless when you want it** — opt into the standard x402 `exact` rail (`PIPRAIL_SCHEMES=exact`) and the
  agent pays **zero gas**: it signs the transfer (EIP-3009/Permit2 on EVM, SVM on Solana) and the server settles.
- **A hard spend cap the model can't cross** — `PIPRAIL_MAX_TOTAL=5.00` and that's the ceiling, enforced
  in the SDK before any on-chain send. MIT open source.

## The 8 tools your agent gets

| Tool | What it does | Moves money? |
| --- | --- | --- |
| `piprail_discover` | Find payable x402 APIs on the open indexes — filter by category/asset/reliability, sort by price or uptime | no |
| `piprail_quote_payment` | Get a URL's price without paying | no |
| `piprail_plan_payment` | Check you can afford it (balance + gas + recipient-ready) | no |
| `piprail_pay_request` | Pay the 402 and return the resource | **yes** |
| `piprail_register` | List your own x402 API so other agents find it — add a category + tags for findability | no |
| `piprail_budget` | Read remaining spend + time leash | no |
| `piprail_guide` | Read the agent contract (how to quote → plan → pay) | no |
| `piprail_verify_receipt` | Re-verify a payment receipt against the chain, wallet-free | no |

Only `piprail_pay_request` moves funds. **Six tools — `discover`, `quote`, `register`, `budget`,
`guide`, `verify_receipt` — work with no key at all**; `pay` and `plan` (it reads *your* balance) need your wallet.

## Install

Discover + install on ClawHub (either command works):

```bash
clawhub install piprail            # the ClawHub CLI
openclaw skills install piprail     # …or OpenClaw's native command
```

Then wire the MCP server into `~/.openclaw/openclaw.json` — OpenClaw nests servers under `mcp.servers`.
**No key is needed** — this is the whole config, and it starts the server **read-only**
(discover / quote / register / budget / guide all work):

```json
{ "mcp": { "servers": { "piprail": {
  "command": "npx", "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_CHAIN": "base" }
} } } }
```

Want the agent to actually **pay**? Then — and only then — add your own self-custodial wallet key plus
a budget cap (`PIPRAIL_PRIVATE_KEY` is a wallet signing key you hold, never an API key):

```json
{ "mcp": { "servers": { "piprail": {
  "command": "npx", "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_CHAIN": "base", "PIPRAIL_MAX_TOTAL": "5.00", "PIPRAIL_PRIVATE_KEY": "0xYOUR_KEY" }
} } } }
```

Restart OpenClaw (or run `openclaw mcp set`) and the `piprail_*` tools appear. See **Configure** below.

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | — *(only to pay)* | — | Your **self-custodial** wallet key/seed. **Omit it for read-only** (discover/quote/register/budget/guide); set it only to let the agent pay. Not an API key; never sent anywhere. |
| `PIPRAIL_CHAIN` | — | `base` | Which chain to pay on |
| `PIPRAIL_CHAINS` | — | — | **Pay across several chains** (instead of `PIPRAIL_CHAIN`) — e.g. `base,polygon,solana`; give each its own `PIPRAIL_<CHAIN>_KEY`. The agent pays whichever chain a 402 asks for (the first you listed that can settle), under one shared budget. |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the **token's units** (≈ $ for USDC/USDT; native-coin units on a `native` rail) |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per (chain, token) |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers |
| `PIPRAIL_RPC_URL` | — | chain default | Custom RPC endpoint (recommended in production; fold any API key into the URL) |

> **Defaults are deliberately small and safe** (0.10 per payment, 10.00 lifetime, USDC on Base).
> Start there, raise as you trust it.

## The agent workflow

**discover → quote → plan → pay.** A typical session:

```
User:  Find me a crypto price API I can pay for.
Agent: [piprail_discover("crypto price")]  → cheapest is 0.001 USDC/call on Base.
User:  Can I afford it?
Agent: [piprail_plan_payment(url)]  → yes; 4.82 USDC left of 5.00, recipient ready, gas ~$0.05.
User:  Get me the ETH price.
Agent: [piprail_pay_request(url)]  → paid 0.001 USDC (tx 0x…). ETH: $3,247.18. 4.819 USDC left.
```

## Learn more

- **Docs:** [docs.piprail.com/integrations/openclaw](https://docs.piprail.com/integrations/openclaw/) ·
  [the 8 tools](https://docs.piprail.com/mcp/tools/) · [spend controls](https://docs.piprail.com/spend-controls/payment-policy/)
- **Source (MIT):** [github.com/piprail/piprail](https://github.com/piprail/piprail) — ⭐ a star helps others find it
- **Follow:** [@piprailhq on X](https://x.com/piprailhq) — new chains, ship logs, agent-payment tips
- **Live payable demo:** [piprail.com/x402/demo](https://piprail.com/x402/demo)
