---
name: piprail-openclaw
description: Give your OpenClaw agent a budget-bound payment wallet. Pay x402-gated APIs, data feeds, and AI services across every major chain — no facilitator, no fee, funds settle straight to the provider's wallet. The agent literally cannot exceed the spend cap you set.
metadata:
  openclaw:
    emoji: "🛤️"
    homepage: https://piprail.com
    os:
      - darwin
      - linux
      - win32
    primaryEnv: PIPRAIL_PRIVATE_KEY
    requires:
      env:
        - PIPRAIL_PRIVATE_KEY
      bins:
        - npx
    install:
      - kind: node
        package: "@piprail/mcp"
        bins:
          - piprail-mcp
    envVars:
      - name: PIPRAIL_PRIVATE_KEY
        required: true
        description: "Funded wallet key/seed for the chosen chain (EVM 0x… hex, Solana base58 secret, or a mnemonic). NEVER commit it. Also accepted as PIPRAIL_WALLET_KEY."
      - name: PIPRAIL_CHAIN
        required: false
        description: "Chain to pay on. EVM ('base' default, 'ethereum', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'bnb', …) or 'solana' | 'ton' | 'tron' | 'near' | 'sui' | 'aptos' | 'algorand' | 'stellar' | 'xrpl'."
      - name: PIPRAIL_MAX_AMOUNT
        required: false
        description: "Hard cap per payment, in human units (default 0.10). A 402 above this is refused before any funds move."
      - name: PIPRAIL_MAX_TOTAL
        required: false
        description: "Lifetime spend cap per token, in human units (default 10.00). The agent cannot exceed it."
      - name: PIPRAIL_TOKENS
        required: false
        description: "Comma-separated allow-list of tokens the agent may spend (e.g. USDC,USDT). Defaults to the chain's stablecoins."
      - name: PIPRAIL_SCHEMES
        required: false
        description: "Payment schemes to settle: 'onchain-proof' (default, backendless) and/or 'exact' (the standard x402 EIP-3009 rail, lets the agent pay any standard x402 server). Comma-separated."
      - name: PIPRAIL_RPC_URL
        required: false
        description: "Override the chain's default RPC endpoint (recommended in production; fold any API key into the URL)."
---

# PipRail — Agent Payment Wallet 🛤️

Give your OpenClaw agent a **budget-bound payment wallet** across every major chain. It can pay
**x402** "402 Payment Required" APIs, data feeds, and AI services **on its own** — and it
**cannot** spend more than the cap you set.

PipRail plugs into OpenClaw as a **standard MCP server** — the published
**[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** (`npx -y @piprail/mcp`) over stdio —
so the agent gets all **7 tools** natively, capped by a budget it can't exceed.

## Why PipRail (vs every other crypto skill)

Every other OpenClaw payment skill routes through a **facilitator or custodian** that holds keys
and/or takes a cut. PipRail is different:

- **Backendless** — no facilitator, no hosted service. Payments verify locally against **your own RPC**.
- **No fee** — funds settle **straight to the service provider's wallet**. PipRail takes nothing.
- **Self-custodial** — your key, your machine. PipRail hosts and holds nothing.
- **Every major chain** — EVM (Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche, BNB…), Solana,
  TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL — one `PIPRAIL_CHAIN` param picks everything.
- **A hard spend cap the model can't cross** — `PIPRAIL_MAX_TOTAL=5.00` and that's the ceiling, enforced
  in the SDK before any on-chain send. MIT open source.

## The 7 tools your agent gets

| Tool | What it does | Moves money? |
| --- | --- | --- |
| `piprail_discover` | Find payable x402 APIs on the open indexes | no |
| `piprail_quote_payment` | Get a URL's price without paying | no |
| `piprail_plan_payment` | Check you can afford it (balance + gas + recipient-ready) | no |
| `piprail_pay_request` | Pay the 402 and return the resource | **yes** |
| `piprail_register` | List your own x402 API so other agents find it | no |
| `piprail_budget` | Read remaining spend + time leash | no |
| `piprail_guide` | Read the agent contract (how to quote → plan → pay) | no |

Only `piprail_pay_request` moves funds — the other six are read-only.

## Install

Discover it on ClawHub:

```bash
clawhub install piprail-openclaw
```

Then wire the MCP server into `~/.openclaw/openclaw.json` (this is the step that hands the agent the
tools) — OpenClaw nests servers under `mcp.servers`:

```json
{ "mcp": { "servers": { "piprail": {
  "command": "npx", "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_KEY", "PIPRAIL_CHAIN": "base", "PIPRAIL_MAX_TOTAL": "5.00" }
} } } }
```

Restart OpenClaw (or run `openclaw mcp set`) and the `piprail_*` tools appear. See **Configure** below
for the full env.

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | ✅ | — | Funded wallet key/seed for the chain (keep it secret) |
| `PIPRAIL_CHAIN` | — | `base` | Which chain to pay on |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per token |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers |

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
  [the 7 tools](https://docs.piprail.com/mcp/tools/) · [spend controls](https://docs.piprail.com/spend-controls/payment-policy/)
- **Source (MIT):** [github.com/piprail/piprail](https://github.com/piprail/piprail)
- **Live payable demo:** [piprail.com/x402/demo](https://piprail.com/x402/demo)
