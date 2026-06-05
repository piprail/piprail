# Build your own MCP payment server

This folder builds a minimal MCP server from scratch with `paymentTools(client)` — to **learn the wiring** or **embed it in your own server**. ~50 lines, no framework.

> **Most people don't need this.** To just give an AI client a budget-capped wallet, run the published, `npx`-runnable [`@piprail/mcp`](../../mcp) — **no code**:
>
> ```json
> {
>   "mcpServers": {
>     "piprail": {
>       "command": "npx",
>       "args": ["-y", "@piprail/mcp"],
>       "env": { "PIPRAIL_PRIVATE_KEY": "0x…", "PIPRAIL_CHAIN": "base" }
>     }
>   }
> }
> ```
>
> Defaults are small + safe (0.10/payment, 10.00 lifetime, USDC on Base), the policy is enforced before any send, and it works on every PipRail chain. See [`@piprail/mcp`](../../mcp) for per-client config (Cursor, Claude Code, Windsurf, VS Code, Cline) + wallet formats.

---

## What this example exposes

The three tools from `paymentTools(client)`, served over MCP stdio:

- **`piprail_quote_payment(url)`** — price a gated URL *without* paying.
- **`piprail_plan_payment(url)`** — check you *can* pay (balance + gas + recipient-readiness) *without* paying.
- **`piprail_pay_request(url, method?, body?)`** — fetch it, paying the `402` automatically.

The client's `policy` caps spend (here: 0.10/call, 5.00 total, USDC on Base), checked **before any on-chain send** — so the model can't overspend.

## Run

```bash
npm install
AGENT_KEY=0x… npm start      # speaks MCP over stdio
```

## Add to Claude Desktop

This runs your **local file** with `node`, so use an **absolute** path and the example's `AGENT_KEY` env. (The published package uses `npx` + `PIPRAIL_PRIVATE_KEY` instead — see the box above.)

```json
{
  "mcpServers": {
    "piprail": {
      "command": "node",
      "args": ["/absolute/path/to/examples/mcp/server.mjs"],
      "env": { "AGENT_KEY": "0x…" }
    }
  }
}
```

Restart Claude Desktop — the three `piprail_*` tools appear.

## Why it's safe

The budget lives in the client's `policy`, enforced locally before any transfer — an over-budget request comes back as `{ declined: true, reason }` and nothing moves. Add an `onBeforePay` hook for human-in-the-loop approval.

## Note on the SDK

`paymentTools()` returns tools whose `parameters` are **JSON Schema**, so this server uses the low-level `Server` from `@modelcontextprotocol/sdk` (whose `inputSchema` is JSON Schema). The high-level `McpServer.registerTool` expects Zod shapes instead.

## Next

- [`@piprail/mcp`](../../mcp) — the published, zero-code server (what most people use)
- [`../agent`](../agent) — the same client without MCP
- [SDK docs](../../sdk/README.md) · [Model Context Protocol](https://modelcontextprotocol.io/)
