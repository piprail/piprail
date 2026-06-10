---
title: Use as a library
description: Embed the PipRail MCP server in your own host — build the config from env, wire the server to a transport, and hold the client for budget reads.
sidebar:
  order: 9
---

## Introduction

The MCP server ships as a runnable binary (`npx -y @piprail/mcp`), but it's also a plain
library with no side effects. If you're building your own MCP host, an agent runtime, or a
custom transport, you can construct the server yourself and own the connection.

The library entry exports two functions that do the work — `parseConfig` (env →
[`Config`](/mcp/configuration/)) and `createMcpServer` (client options → `{ server, client }`)
— plus `configToClientOptions` to bridge them. None of them touch the network or a chain.

```ts
import { createMcpServer, parseConfig, configToClientOptions } from '@piprail/mcp'
```

## The standard wiring

The same three steps the binary runs: parse the env into a validated config, turn that into SDK
client options, then build the server. You own the transport.

```ts
import { createMcpServer, parseConfig, configToClientOptions } from '@piprail/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const config = parseConfig(process.env)               // → Config (throws ConfigError on bad env)
const { server } = createMcpServer(configToClientOptions(config))

await server.connect(new StdioServerTransport())
```

`createMcpServer` returns a low-level `Server` from `@modelcontextprotocol/sdk` with all seven
[payment tools](/mcp/tools/) already registered. It connects no transport and reads no chain, so
it's testable without a wallet or RPC.

## Parsing config yourself

`parseConfig(env)` takes the env object — it never reads `process.env` on its own — so you can
feed it a fake env, defaults overridden in code, or values from your own config system. It
returns a normalized [`Config`](/mcp/configuration/) and throws `ConfigError` (with a
human-readable message) on anything missing or malformed.

```ts
import { parseConfig, ConfigError } from '@piprail/mcp'

try {
  const config = parseConfig({
    PIPRAIL_PRIVATE_KEY: process.env.AGENT_KEY,
    PIPRAIL_CHAIN: 'base',
    PIPRAIL_MAX_AMOUNT: '0.10',
  })
  // → Config { chain: 'base', maxAmount: '0.10', maxTotal: '10.00',
  //            tokens: ['USDC'], confirm: false, guide: true, … }
} catch (e) {
  if (e instanceof ConfigError) process.stderr.write(e.message + '\n')
}
```

The wallet key has one hard requirement and a few aliases: `parseConfig` reads
`PIPRAIL_PRIVATE_KEY`, then `PIPRAIL_WALLET_KEY`, then `AGENT_KEY` — the first non-empty one
wins. Everything else falls back to the safe defaults above (`base` / `0.10` / `10.00` / `USDC`).

`configToClientOptions(config)` then maps the config to `PipRailClientOptions`: the budget knobs
become the [spend policy](/spend-controls/payment-policy/), and the wallet secret is shaped to
the chosen family's `WalletInput`. The `confirm` and `guide` flags are MCP-server concerns and
deliberately do **not** appear here — pass them as the second argument to `createMcpServer`.

```ts
const clientOptions = configToClientOptions(config)
// → PipRailClientOptions { chain: 'base', wallet: { privateKey: '…' },
//     policy: { maxAmount: '0.10', maxTotal: '10.00', tokens: ['USDC'], … } }
```

## Server options

The second argument layers the opt-in features on top of the base tool wiring. All three are
additive — omit them and the tools path is byte-identical.

| Option | Default | Effect |
| --- | --- | --- |
| `confirm` | `false` | [Mode B](/mcp/modes/): ask the human to approve each payment via MCP elicitation. |
| `confirmTimeoutMs` | `55000` | The elicitation approval window, in milliseconds. |
| `guide` | `true` | Expose the agent-guide prompt and the `piprail://guide` + `piprail://budget` resources. |

```ts
const { server } = createMcpServer(configToClientOptions(config), {
  confirm: config.confirm,
  guide: config.guide,
})
```

:::note
Enabling `confirm` (Mode B) wires the SDK's `onBeforePay` seam to the server's
`elicitInput()`. Elicitation is a **client** capability — the MCP client you connect to must
support it (specifically `elicitation.form`), or PipRail silently degrades to Mode A and the
policy alone is the consent. See [Modes](/mcp/modes/).
:::

## Holding the client

`createMcpServer` also returns the underlying `PipRailClient`. You don't need it to serve tools
(the binary discards it), but an embedder can read the live spend leash from it.

```ts
const { server, client } = createMcpServer(configToClientOptions(config))

client.spent()
// → SpendSummary { count: 0, byAsset: [], records: [] }   (before any payment)

client.budget()
// → SessionBudget {
//     session: { start: '2026-06-10T…Z', expiresAt: null, secondsRemaining: null },
//     byAsset: []   // one row per (network, asset) once a payment lands
//   }
```

`spent()` is the per-`(network, asset)` tally of everything paid so far (never a cross-token
sum — there's no price oracle); `budget()` adds the remaining-per-token leash and the session's
time envelope (`expiresAt` / `secondsRemaining` are `null` until you set a TTL). Both are
read-only and move no funds — use them to surface "spent so far / remaining" in your own UI.

These are the same reads the `piprail://budget` resource exposes.

:::caution
The budget is process-scoped: every figure resets when the process restarts. The spend policy
is a leash within one run, not a persistent ledger.
:::
