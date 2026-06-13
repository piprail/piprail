# PipRail integrations

**Drop PipRail into the frameworks where agents already live — no payment code.** Each integration
wraps the same thing we already ship: [`@piprail/sdk`](../sdk)'s `paymentTools()` and the published
[`@piprail/mcp`](../mcp) server (7 tools, budget-bound). Nothing new to build.

Each framework gets its own folder under `integrations/<framework>/`, with PipRail's artifact inside
(`integrations/<framework>/piprail/`) — so the structure scales as we add frameworks.

| Integration | Folder | What it gives you | Status |
|---|---|---|---|
| **OpenClaw** 🦞 | [`openclaw/piprail/`](./openclaw/piprail) | A [ClawHub](https://github.com/openclaw/clawhub) skill (published under **@piprail**) that hands an OpenClaw agent the 7 PipRail tools, budget-bound — via `@piprail/mcp` as an MCP server. `clawhub install piprail`. | ✅ built + tested |
| _Vercel AI SDK · Mastra_ | _`vercel/piprail/` (soon)_ | `paymentTools()` as Vercel AI SDK / Mastra tools. | planned |
| _ElizaOS_ | _`elizaos/piprail/` (soon)_ | A PipRail plugin + an MCP-monetization guide. | planned |

> **Any MCP client can use PipRail today** without a dedicated integration — point it at
> `npx -y @piprail/mcp`. See [docs.piprail.com/mcp/client-setup](https://docs.piprail.com/mcp/client-setup/).

## Is it working?

**[TESTING.md](./TESTING.md)** — how to verify each integration. Every folder ships a zero-dependency
`verify.mjs` that spawns the MCP server the way the framework does and drives the tools (run
`node verify.mjs --live`), plus a manual real-app run for the final sign-off.

Full guides live on the docs: **[docs.piprail.com/integrations](https://docs.piprail.com/integrations/)**.

---

*These are standalone packages — not part of the npm workspace. Each folder is publishable on its own
(e.g. a ClawHub skill). The integration is always "wrap what exists + get discovered," never a fork of
the SDK.*
