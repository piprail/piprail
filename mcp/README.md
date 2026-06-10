# @piprail/mcp

**Hand any AI agent a budget-bound payment wallet.** An [MCP](https://modelcontextprotocol.io) server that wraps [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) so any MCP client — Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline — can pay [x402](https://x402.org) payment-gated URLs **on its own**, capped by a spend policy the model **cannot exceed**.

Runs on **your** machine with **your** wallet and **your** limits. No backend, no custody, no facilitator — PipRail never touches your funds.

```bash
npx -y @piprail/mcp        # speaks MCP over stdio
```

Listed in the official **MCP registry** as [`io.github.piprail/mcp`](https://registry.modelcontextprotocol.io).

> ### 📖 Full documentation → **[docs.piprail.com/mcp](https://docs.piprail.com/mcp/overview/)**
> This README is the quick start. Every client's config, the complete env-var reference, the modes, the per-chain setup, and the tools reference live in the docs. **The docs are the source of truth.**

---

## Quick start

Add it to your MCP client with two things: your **wallet private key** and (optionally) a **budget**. The defaults are deliberately small and safe: **0.10 per payment, 10.00 lifetime per token, USDC on Base.**

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "PIPRAIL_CHAIN": "base",
        "PIPRAIL_MAX_AMOUNT": "0.10",
        "PIPRAIL_MAX_TOTAL": "10.00",
        "PIPRAIL_TOKENS": "USDC"
      }
    }
  }
}
```

Restart the client and the PipRail tools appear. Invocation is identical in every client — only the config-file path and the top-level key differ (VS Code uses `servers`, not `mcpServers`).

> **Never commit your key.** Put it in your client's `env` block, or use `${env:…}` interpolation where supported. Claude Desktop has no interpolation — treat that config file as a secret.

→ [Client setup, per client](https://docs.piprail.com/mcp/client-setup/) ·
[Full configuration reference](https://docs.piprail.com/mcp/configuration/)

## The 7 tools

| Tool | What it does |
| --- | --- |
| `piprail_discover` | Find payable resources on the **open** x402 indexes — without paying. |
| `piprail_quote_payment` | Price a gated URL **without** paying. |
| `piprail_plan_payment` | Check it *can* pay — balance, gas, recipient-readiness — across every rail. |
| `piprail_pay_request` | Fetch a URL and pay the `402` automatically, within the budget. **The one value-moving tool.** |
| `piprail_register` | List a resource you run on the open indexes so other agents find it. |
| `piprail_budget` | Read remaining budget + time leash + spend-so-far. |
| `piprail_guide` | Read the agent contract — the quote → plan → pay loop and the never-re-pay rule. |

Only `piprail_pay_request` ever moves money; every other tool is read-only, and each is advertised with MCP annotations so your client can show the right consent. The spend policy — not the annotations — is the real boundary.

→ [Tools reference](https://docs.piprail.com/mcp/tools/)

## Two modes

- **Mode A — headless (default).** The agent runs free *inside* the budget and time envelope. The policy **is** the consent — no per-payment prompt; over-budget requests are refused before any on-chain send.
- **Mode B — supervised (`PIPRAIL_CONFIRM=1`).** The human approves each payment at the moment of spend (on clients that support elicitation). Any decline/cancel/timeout fail-safes to **not** paying. Mode B sits on top of the policy — it never replaces it.

→ [Modes](https://docs.piprail.com/mcp/modes/)

## Why it's safe

- The spend policy (`PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL` / `PIPRAIL_TOKENS` / `PIPRAIL_HOSTS`) is enforced **before any on-chain send**, against the token's **true** decimals — a server can't slip past a cap by understating a price.
- No custody, no backend — your key stays local; funds settle wallet-to-wallet against your own RPC.

→ [Security](https://docs.piprail.com/mcp/security/) · [Chains & per-chain setup](https://docs.piprail.com/mcp/chains/)

## Use it as a library

```ts
import { createMcpServer, parseConfig, configToClientOptions } from '@piprail/mcp'

const config = parseConfig(process.env)
const { server } = createMcpServer(configToClientOptions(config))
// connect your own transport…
```

→ [Use as a library](https://docs.piprail.com/mcp/use-as-a-library/)

## Links

[Docs](https://docs.piprail.com/mcp/overview/) · [PipRail](https://piprail.com) · [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) · [x402](https://x402.org) · [Model Context Protocol](https://modelcontextprotocol.io)

MIT · no backend, no fee, ever.
