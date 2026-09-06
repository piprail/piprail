---
title: Overview
description: 'What @piprail/mcp is: a Model Context Protocol server that hands any AI agent a budget-bound wallet to pay x402 URLs autonomously.'
sidebar:
  order: 1
---

## Introduction

`@piprail/mcp` is a Model Context Protocol server that wraps the SDK and hands any MCP client
(Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline, and more; see
[Client setup](/mcp/client-setup/)) a **budget-bound wallet**. The
agent can discover, quote, plan, and pay x402 URLs on its own, but only within a spend policy you
set in environment variables. It is a cap the model cannot exceed.

It runs locally, with your wallet and your RPC. There is no backend and no custody: the same
"settle straight to your wallet, verify locally" model as the SDK, exposed as agent tools.

## SDK vs MCP: which do I want?

| | You're writing code | You're configuring an agent |
| --- | --- | --- |
| Use | [`@piprail/sdk`](/getting-started/introduction/) | `@piprail/mcp` |
| You provide | TypeScript | a small `env` block |
| Result | full programmatic control | an agent that can pay, within caps |

If you control the program, use the SDK. If you want Claude (or any MCP agent) to pay for things
itself, use the MCP server.

## Quick start

Add one entry to your client's MCP config. Invocation is identical everywhere: `npx -y
@piprail/mcp` over stdio, configured entirely through `env`:

```jsonc
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY", // your wallet key/seed for the chain
        "PIPRAIL_CHAIN": "base",
        "PIPRAIL_MAX_AMOUNT": "0.10",  // max per payment, human units
        "PIPRAIL_MAX_TOTAL": "10.00",  // lifetime cap, per token
        "PIPRAIL_TOKENS": "USDC"
      }
    }
  }
}
```

Those five lines *are* the defaults (`chain: 'base'`, `0.10` per payment, `10.00` lifetime per
token, `USDC`), so the only field you add to **pay** is `PIPRAIL_PRIVATE_KEY` (alias `AGENT_KEY`);
omit it entirely and the server boots **read-only** (discover/quote/register/budget/guide still work).
Restart the client and the PipRail tools appear. Per-client config-file locations and gotchas
(VS Code uses `servers`, not `mcpServers`) are on the [Client setup](/mcp/client-setup/) page.

:::caution
Treat the config file as a secret, because it holds a private key. Use `${env:…}` interpolation where
your client supports it; on clients without it (Claude Desktop), the key is stored in plaintext
there. Never pass it as a CLI argument, and never commit it.
:::

## The tools

| Tool | What it does |
| --- | --- |
| `piprail_discover` | Find x402-payable resources on the open indexes, without paying. |
| `piprail_quote_payment` | Price a gated URL (no payment). |
| `piprail_plan_payment` | Check it *can* pay: balance, gas, recipient readiness, across every rail. |
| `piprail_pay_request` | **The one value-moving tool.** Fetch the URL and pay the `402`, within policy. Returns a structured outcome (success *or* failure), never an exception. |
| `piprail_register` | List a resource you run on the open indexes (moves no funds). |
| `piprail_budget` | Read remaining budget + time leash + spend-so-far. |
| `piprail_guide` | Read the agent contract: the quote → plan → pay loop and the never-re-pay rule. |
| `piprail_verify_receipt` | Re-verify a verifiable receipt against the chain, wallet-free and never throwing. |

Only `piprail_pay_request` ever moves money; `piprail_register` writes a listing to an external
index (so it isn't flagged read-only) but moves none, and the other six are read-only. Each tool
carries MCP annotations so your client can show the right consent. The spend policy, not the
annotations, is the real boundary. See the [Tools reference](/mcp/tools/) for inputs, outputs, and errors.

## Two modes

- **Mode A, headless (default).** The agent runs free *inside* the budget and time envelope.
  The policy **is** the consent, so there is no per-payment prompt. Over-budget requests are refused before
  any on-chain send.
- **Mode B, supervised (`PIPRAIL_CONFIRM=1`).** Each payment asks the human for approval at the
  moment of spend (on clients that support elicitation). Fail-safe: any decline, cancel, timeout,
  or error means **not** paying. Mode B sits *on top of* the policy and never replaces it.

Full details, including the elicitation timeout and how a non-eliciting client degrades cleanly
to Mode A, are on the [Modes](/mcp/modes/) page.

## Why it's safe

- The spend policy (`PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL` / `PIPRAIL_TOKENS` /
  `PIPRAIL_HOSTS`) is enforced **before any on-chain send**, against the token's *true* decimals
  (the SDK's, never a server's), so a server can't slip past a cap by understating a price.
- No custody, no backend. Your key stays local, payments settle straight from your wallet
  against your own RPC.
- Open source, MIT, auditable.

See [Security](/mcp/security/) for the full threat model.

## Next steps

Continue to [Client setup](/mcp/client-setup/), the full
[Configuration reference](/mcp/configuration/), and the [Tools reference](/mcp/tools/).

Building an agent in another language or framework? The MCP doubles as a language-agnostic
**settlement engine**: any runtime that can speak MCP JSON-RPC over stdio can pay through it.
