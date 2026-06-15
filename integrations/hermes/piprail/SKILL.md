---
name: piprail
description: "Pay x402 paywalled URLs from a budget-bound, self-custodial crypto wallet across 10+ chains."
version: 1.1.2
author: PipRail (@piprail)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [x402, payments, crypto, web3, wallet, USDC, EVM, solana, stellar, xrpl, MCP]
    category: blockchain
    related_skills: [evm, solana]
    requires_toolsets: [terminal]
required_environment_variables:
  - name: PIPRAIL_PRIVATE_KEY
    prompt: "PipRail wallet private key (self-custodial; optional — omit for read-only)"
    help: "A wallet key you control, NOT an API key. Omit to run read-only (discover/quote only)."
    required_for: "paying x402 URLs (piprail_pay_request / piprail_plan_payment)"
---

# PipRail — autonomous x402 payments 🛤️

Pay HTTP "402 Payment Required" (x402) endpoints from a **self-custodial, budget-bound** wallet.
Funds go straight to the merchant — **no fee, no hosted facilitator** — verified locally against
**your own RPC**, and capped by a spend policy the model **cannot exceed**.

Chains: every major EVM chain plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and the
XRP Ledger. Tokens: USDC almost everywhere, USDT on most, plus each chain's native coin.

## When to use

- The agent hits an HTTP 402 / x402 paywall and must pay to proceed.
- The user asks to **discover**, **quote**, **plan**, or **pay** an x402 URL.
- The user wants a budget-bound agent wallet for paid APIs, data feeds, or AI services.

## Quick reference

PipRail ships as a published MCP server — Hermes runs it over stdio:

    npx -y @piprail/mcp

Add it to `~/.hermes/config.yaml` under `mcp_servers` (see this folder's `config.yaml`), or
`hermes mcp add piprail --command npx --args -y @piprail/mcp`. The seven tools surface as
`mcp_piprail_*` (e.g. `mcp_piprail_pay_request`):

`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · **`piprail_pay_request`** ·
`piprail_register` · `piprail_budget` · `piprail_guide`. Only `piprail_pay_request` moves money.
`piprail_discover` filters by category/asset/reliability and sorts by price or uptime; `piprail_register`
takes a category + tags so other agents find your endpoint.

Set `PIPRAIL_PRIVATE_KEY` to enable pay/plan; without it, the read-only tools still work.

**Pay across several chains** (optional): set `PIPRAIL_CHAINS=base,polygon,solana` (instead of
`PIPRAIL_CHAIN`) and give each its own `PIPRAIL_<CHAIN>_KEY`; the agent then pays whichever chain a
402 asks for — the first you listed that can settle — under one shared budget. `PIPRAIL_MAX_AMOUNT` /
`PIPRAIL_MAX_TOTAL` are in the **token's units** (≈ $ for USDC/USDT; native-coin units on a `native` rail).

## The workflow

**discover → quote → plan → pay.** Quote a URL's price, plan that you can afford it (balance + gas +
recipient-ready), then pay and return the resource — all bounded by `PIPRAIL_MAX_AMOUNT` /
`PIPRAIL_MAX_TOTAL`.

## Pitfalls

- `PIPRAIL_PRIVATE_KEY` is a **WALLET key, never an API key** — keep it in `~/.hermes/.env`, secret.
- Hermes does **not** inherit your shell env — the key must be in the server's `env:` block.
- `pay`/`plan` return `WALLET_REQUIRED` when no key is set (read-only mode).
- Budget the payment **plus gas** (the chain's native coin) — use `piprail_quote_payment` +
  `piprail_plan_payment` before `piprail_pay_request`.

## Verification

A successful run completes the **402 → pay → on-chain confirm → 200** round-trip;
`piprail_plan_payment` reports `payable`/`best` per rail before any spend. Quote the live demo at
`https://piprail.com/x402/demo` (0.01 USDC on Base) to prove it end-to-end.

## Learn more

- Integration guide: https://docs.piprail.com/integrations/hermes/
- The 7 tools: https://docs.piprail.com/mcp/tools/ · Spend controls: https://docs.piprail.com/spend-controls/payment-policy/
- Source (MIT): https://github.com/piprail/piprail · Follow: https://x.com/piprailhq
