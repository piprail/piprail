---
title: FAQ
description: 'Short answers to the common questions about running the @piprail/mcp wallet: clients, budgeting, custody, chains, and how it differs from the SDK.'
sidebar:
  order: 10
---

## Can I use PipRail with Claude Desktop?

Yes. `@piprail/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so it
runs in any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline, and more;
see [Client setup](/mcp/client-setup/)). Add one entry to your client's config with your wallet
key and spend limits, restart, and the tools appear in the agent's tool list. No code, no backend.

```bash
npx -y @piprail/mcp        # speaks MCP over stdio
```

See [Client setup](/mcp/client-setup/) for the exact config block per client.

## How do I set it up?

Add it to your MCP client's config with two things: your **wallet private key** and (optionally)
a **budget**. For Claude Desktop, open Settings → Developer → Edit Config and add an `mcpServers`
entry that runs `npx -y @piprail/mcp` with your env, then restart the client.

```jsonc
"piprail": {
  "command": "npx",
  "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY", "PIPRAIL_CHAIN": "base" }
}
```

Cursor, Claude Code, Windsurf, VS Code, and Cline support `${env:PIPRAIL_PRIVATE_KEY}`
interpolation, so the key never sits in the config file. Claude Desktop has no interpolation, so
treat that config file as a secret. Full walkthrough: [Getting started](/mcp/getting-started/).

:::caution
Never commit your key. Put it in your client's `env` block (or use `${env:…}` where supported),
and keep the config file out of version control.
:::

## How does spend budgeting work, and can the agent overspend?

No. `PIPRAIL_MAX_AMOUNT` caps each individual payment and `PIPRAIL_MAX_TOTAL` caps lifetime spend
per token. Both are enforced by the SDK **before any on-chain send**, and checked against the
token's true on-chain decimals, so a malicious server can't slip past a limit by misstating the
price. An over-budget request comes back as `{ declined: true, reason }` and nothing moves.

```jsonc
"env": {
  "PIPRAIL_MAX_AMOUNT": "0.10",   // per payment
  "PIPRAIL_MAX_TOTAL": "10.00"    // lifetime, per token
}
```

:::note
With nothing set, the defaults are deliberately small and safe: **0.10 per payment, 10.00
lifetime per token, USDC on Base.** Raise them deliberately.
:::

You can also restrict tokens (`PIPRAIL_TOKENS`) and destination hosts (`PIPRAIL_HOSTS`). See
[Configuration](/mcp/configuration/) for every variable.

## What happens if an agent tries to pay something out of policy?

The call is declined before any on-chain send and returns `{ declined: true, reason }`. The model
never signs and never broadcasts. The decline also carries a typed `reasonCode` the model can
branch on (`POLICY` / `BUDGET` / `OUTSIDE_WINDOW` / `SESSION_EXPIRED` / `APPROVAL`); see
[Modes](/mcp/modes/) for the full shape. Because `piprail_plan_payment` is read-only, the agent
can also check affordability and policy compliance up front and skip the failed attempt entirely.

:::tip
Point the agent at [`piprail_plan_payment`](/mcp/tools/) first. It reports per-rail blockers
(insufficient token, insufficient gas, recipient not ready, outside policy) without spending.
:::

## Which AI clients and chains does it support?

Any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline, and more; see
[Client setup](/mcp/client-setup/)). For chains, all
of the ones PipRail supports: every EVM mainnet plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand,
Stellar, and the XRP Ledger. EVM works out of the box (the server ships with `viem`); non-EVM
chains pull their SDK peer library on demand. See [Chains](/mcp/chains/).

A server instance can be a single wallet on one chain, OR fund several chains in one process with
`PIPRAIL_CHAINS`, which then pays whichever chain a 402 asks for, under one shared budget. For an
independent budget per chain, register it once per chain. See Configuration → Pay on several chains.

## Does it take custody of my funds or run a backend?

No. The server runs locally on your machine with your key, your RPC, and your limits. Payments
settle wallet-to-wallet straight to the recipient. PipRail runs no service and holds nothing.
There's no PipRail backend to compromise and no facilitator in the path. The code is MIT and open;
you can audit or run it yourself. More in [Security](/mcp/security/).

## What's the difference between @piprail/sdk and @piprail/mcp?

The SDK is for developers who write code: you call
[`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) to charge,
or [`PipRailClient`](/making-payments/piprail-client/) to pay, in TypeScript. The MCP flips that:
you write no code, you add an env block, and agents in your MCP client pay x402 URLs autonomously,
capped by a spend policy. Same engine, same chains, same backendless self-custody. The MCP is the
zero-integration path for AI/agent operators.

| | `@piprail/sdk` | `@piprail/mcp` |
| --- | --- | --- |
| You provide | TypeScript code | an env block |
| Charge | [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) | not applicable |
| Pay | [`PipRailClient`](/making-payments/piprail-client/) | the agent's tools |
| For | developers | AI/agent operators |

To embed the server in your own host instead of running it as a subprocess, see
[Use as a library](/mcp/use-as-a-library/).
