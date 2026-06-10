---
title: Getting started
description: Hand any MCP client a budget-bound payment wallet with one npx command and a small env block — restart, and the piprail_* tools appear.
sidebar:
  order: 2
---

## Introduction

The MCP server is `@piprail/sdk` wrapped as a [Model Context Protocol](https://modelcontextprotocol.io)
server, so any MCP client — Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline — can
pay [x402](https://x402.org)-gated URLs **on its own**, capped by a spend policy the model
**cannot exceed**. You don't write code: you add an `npx` command and an env block, restart your
client, and the `piprail_*` tools appear.

It runs on **your** machine with **your** wallet and **your** limits. No backend, no custody, no
facilitator — PipRail never touches your funds.

## Quick start

The server speaks MCP over stdio. The only hard requirement is a wallet key; everything else has
a deliberately small, safe default — **0.10 per payment, 10.00 lifetime per token, USDC on Base.**

```bash
npx -y @piprail/mcp        # speaks MCP over stdio
```

You don't run that by hand — your MCP client runs it for you. Point the client at the command and
hand it the env block below.

### The minimal env block

Every client uses the same two pieces: a `command` (`npx -y @piprail/mcp`) and an `env` block.
The smallest working block is a private key plus a chain:

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "${env:PIPRAIL_PRIVATE_KEY}",  // your wallet key for the chain
  "PIPRAIL_CHAIN": "base"                               // optional — defaults to base
}
```

A fuller block pins the budget explicitly — these are the safe defaults written out, so you can
see and tighten them:

```jsonc
"env": {
  "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
  "PIPRAIL_CHAIN": "base",
  "PIPRAIL_MAX_AMOUNT": "0.10",   // max per payment
  "PIPRAIL_MAX_TOTAL": "10.00",   // lifetime cap per token
  "PIPRAIL_TOKENS": "USDC"        // allowed token symbols
}
```

:::danger
Never commit your key. Put it in your client's `env` block, or export it and use `${env:…}`
interpolation where the client supports it (Cursor, Claude Code, Windsurf, VS Code do; Claude
Desktop does **not** — treat that config file as a secret). The server **never** accepts the key
as a CLI argument — `argv` leaks in process listings and shell history.
:::

### Restart, and the tools appear

Drop the server into your client's config, then restart the client. The full set of
[seven `piprail_*` tools](/mcp/tools/) registers over stdio — `piprail_pay_request` to pay (the
only value-moving tool), `piprail_plan_payment` / `piprail_quote_payment` / `piprail_discover` to
look without spending, `piprail_register` to list a resource you run, `piprail_budget` to read the
remaining leash, and `piprail_guide` to read the agent contract. See
[Client setup](/mcp/client-setup/) for the exact config-file path and shape for each client.

:::tip
EVM chains work out of the box — the package ships with `viem`, so `base`, `ethereum`,
`arbitrum`, `polygon`, `bnb`, and every other EVM preset just run. Non-EVM chains
(Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL) need their peer library installed
alongside the server — see [MCP chains](/mcp/chains/).
:::

## SDK or MCP — which one?

PipRail ships the same engine two ways. The deciding question is *who is doing the integrating.*

| | `@piprail/sdk` | `@piprail/mcp` |
| --- | --- | --- |
| You... | **write code** | **add an env block** |
| Surface | TypeScript imports (`requirePayment`, `PipRailClient`, …) | MCP tools your client calls |
| Who pays / gets paid | your app, the way you wire it | the model in your MCP client |
| Spend policy | you pass it in code | you set it in env vars |
| Lives in | your application | your MCP client config |

Reach for the **SDK** when you're building software — a server that needs to
[get paid](/accepting-payments/require-payment-and-gate/), or an agent of your own that needs to
[pay programmatically](/making-payments/fetch-and-autoroute/). You import functions and control
every call.

Reach for the **MCP server** when you want an existing AI client to pay for things autonomously
without you writing a payment loop. The model gets a wallet that's bounded by the budget you set
in env vars, and it pays within that leash on its own.

:::note
It's not either/or. The MCP server *is* the SDK with a config layer — the env block becomes the
SDK's [spend policy](/spend-controls/payment-policy/) before the server boots. If you outgrow the
env block you can drop down to the SDK directly; see [Use as a library](/mcp/use-as-a-library/).
:::

## What you set, and where it goes

The env block isn't ad-hoc — each variable maps to an SDK concept. The four you'll touch first:

| Variable | Required | Default | Maps to |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | **yes** | — | The wallet, in the chain's native key format. |
| `PIPRAIL_CHAIN` | no | `base` | The chain to pay on (any PipRail chain). |
| `PIPRAIL_MAX_AMOUNT` | no | `0.10` | Per-payment ceiling in token units. |
| `PIPRAIL_MAX_TOTAL` | no | `10.00` | Lifetime cap per token in token units. |

These are the common ones — the full set (token allowlist, host allowlist, RPC override, time
envelope, supervised mode) lives on the [Configuration](/mcp/configuration/) page.

:::caution
The key's format depends on the chain — `0x…` hex for EVM and Tron, base58 for Solana, a 24-word
mnemonic for TON, an `S…` seed for Stellar, and so on. The server maps it to the right shape
automatically, but you must supply the *right kind* of secret for the chosen chain. The full table
is on the [Configuration](/mcp/configuration/) page; NEAR additionally needs
`PIPRAIL_NEAR_ACCOUNT_ID`.
:::

## Verify it's running

The server validates the env block at startup and **fails loudly** rather than silently: a
mistyped `PIPRAIL_*` variable, a missing key, an unknown chain, or a malformed budget all abort
with an actionable message on stderr. On a clean boot it prints a startup banner (and a
`⚠ notes:` block for any per-chain caveats); a missing key reads:

```text
PIPRAIL_PRIVATE_KEY (alias: AGENT_KEY) is required — set it to your wallet key/seed for the chosen chain.
```

If the tools don't appear after a restart, check your client's MCP log for that line — see the
[FAQ](/mcp/faq/) for the common causes.
