# @piprail/mcp

**Hand any AI agent a budget-bound payment wallet.** An [MCP](https://modelcontextprotocol.io) server wrapping [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) so any MCP client — Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline, OpenClaw, Hermes — can pay [x402](https://x402.org) URLs **on its own**, capped by a spend policy the model **cannot exceed**. Runs locally with **your** wallet and **your** limits — no backend, no custody, no facilitator.

```bash
npx -y @piprail/mcp        # speaks MCP over stdio
```

> ### 📖 Full documentation → **[docs.piprail.com/mcp](https://docs.piprail.com/mcp/overview/)**
> The docs are the single **source of truth** — every client's config, the complete env-var reference, the modes, per-chain setup, and the tools reference. This README is just the front door.

---

## Add it to your client

Two things: your **wallet private key** and (optionally) a **budget**. The defaults are deliberately small and safe (0.10 per payment, 10.00 lifetime per token, USDC on Base).

```jsonc
{ "mcpServers": { "piprail": {
  "command": "npx", "args": ["-y", "@piprail/mcp"],
  "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_KEY", "PIPRAIL_CHAIN": "base", "PIPRAIL_MAX_AMOUNT": "0.10" }
} } }
```

Restart the client and the PipRail tools appear (VS Code uses `servers`, not `mcpServers`). **Never commit your key** — keep it in the client's `env` block. → [Per-client setup](https://docs.piprail.com/mcp/client-setup/) · [Configuration](https://docs.piprail.com/mcp/configuration/)

**7 tools** — `piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · `piprail_pay_request` · `piprail_register` · `piprail_budget` · `piprail_guide`. Only `piprail_pay_request` moves money; the rest are read-only. → [Tools reference](https://docs.piprail.com/mcp/tools/)

**No key? It still runs.** Without `PIPRAIL_PRIVATE_KEY` the server boots in **read-only mode** — discover, quote, register, budget, and guide all work; only `piprail_pay_request` (and `piprail_plan_payment`) ask for a wallet. Add a key when you're ready to actually pay.

**Pay across chains?** List several chains and give each its own key — the tools then pay whichever chain a 402 asks for (one server, one budget):

```jsonc
"env": {
  "PIPRAIL_CHAINS": "base,polygon,solana",
  "PIPRAIL_BASE_KEY": "0x…", "PIPRAIL_POLYGON_KEY": "0x…", "PIPRAIL_SOLANA_KEY": "<base58-secret>",
  "PIPRAIL_MAX_AMOUNT": "1.00"
}
```

One EVM key works on every EVM chain; non-EVM families each need their own key (and that family's peer libs). A chain with no key is read-only. → [Configuration](https://docs.piprail.com/mcp/configuration/)

Listed in the official **MCP registry** as [`io.github.piprail/mcp`](https://registry.modelcontextprotocol.io).

---

## Documentation

| | |
|---|---|
| **[Overview](https://docs.piprail.com/mcp/overview/)** · **[Getting started](https://docs.piprail.com/mcp/getting-started/)** | What it is · first run |
| **[Client setup](https://docs.piprail.com/mcp/client-setup/)** · **[Configuration](https://docs.piprail.com/mcp/configuration/)** | Per-client config · every env var |
| **[Tools](https://docs.piprail.com/mcp/tools/)** · **[Modes](https://docs.piprail.com/mcp/modes/)** | The 7 tools · headless vs supervised |
| **[Security](https://docs.piprail.com/mcp/security/)** · **[Chains](https://docs.piprail.com/mcp/chains/)** | Why it's safe · per-chain setup |
| **[Use as a library](https://docs.piprail.com/mcp/use-as-a-library/)** · **[FAQ](https://docs.piprail.com/mcp/faq/)** | Embed it · common questions |

## Spread the word

Free, open-source, self-custodial — no backend to sell you. If PipRail gave your agent a wallet it can trust, help others find it:

⭐ **[Star on GitHub](https://github.com/piprail/piprail)** &nbsp;·&nbsp; 𝕏 **[Follow @piprailhq](https://x.com/piprailhq)** &nbsp;·&nbsp; 🌐 **[piprail.com](https://piprail.com)** &nbsp;·&nbsp; 📖 **[docs.piprail.com](https://docs.piprail.com)**

---

[Docs](https://docs.piprail.com/mcp/overview/) · [PipRail](https://piprail.com) · [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk) · [x402](https://x402.org) · [Model Context Protocol](https://modelcontextprotocol.io)

MIT · no backend, no fee, ever.
