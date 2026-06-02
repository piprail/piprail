# PipRail MCP server

Hand a model (Claude, GPT, any MCP client) a **budget-bound payment wallet**. It exposes the two tools from `paymentTools(client)`:

- **`piprail_quote_payment(url)`** — price a gated URL *without* paying.
- **`piprail_pay_request(url, method?, body?)`** — fetch it, paying the `402` automatically.

The client's `policy` caps spend (here: $0.10/call, $5 total, USDC on Base), checked **before any on-chain send** — so the model can't overspend.

## Run

```bash
npm install
AGENT_KEY=0x… npm start      # speaks MCP over stdio
```

## Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop — the two `piprail_*` tools appear. (Use an **absolute** path.)

## Why it's safe

The budget lives in the client's `policy`, enforced locally before any transfer — an over-budget request comes back as `{ declined: true, reason }` and nothing moves. Add an `onBeforePay` hook for human-in-the-loop approval.

## Note on the SDK

`paymentTools()` returns tools whose `parameters` are **JSON Schema**, so this server uses the low-level `Server` from `@modelcontextprotocol/sdk` (whose `inputSchema` is JSON Schema). The high-level `McpServer.registerTool` expects Zod shapes instead.

## Next

- [`../agent`](../agent) — the same client without MCP
- [SDK docs](../../sdk/README.md) · [Model Context Protocol](https://modelcontextprotocol.io/)
