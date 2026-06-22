# PipRail integrations

**Drop PipRail into the frameworks where agents already live — no payment code.** Each integration
wraps the same thing we already ship: [`@piprail/sdk`](../sdk)'s `paymentTools()` and the published
[`@piprail/mcp`](../mcp) server (8 tools, budget-bound). Nothing new to build.

Each framework gets its own folder under `integrations/<framework>/`, with PipRail's artifact inside
(`integrations/<framework>/piprail/`) — so the structure scales as we add frameworks.

| Integration | Folder | What it gives you | Status |
|---|---|---|---|
| **OpenClaw** 🦞 | [`openclaw/piprail/`](./openclaw/piprail) | A [ClawHub](https://github.com/openclaw/clawhub) skill (published under **@piprail**) that hands an OpenClaw agent the 8 PipRail tools, budget-bound — via `@piprail/mcp` as an MCP server. `clawhub install piprail`. | ✅ built + tested |
| **Hermes** 🛤️ | [`hermes/piprail/`](./hermes/piprail) | A [Hermes](https://github.com/NousResearch/hermes-agent) MCP catalog entry (`manifest.yaml`) + Skills Hub skill — add one `mcp_servers` block to `~/.hermes/config.yaml` and the agent gets the 8 PipRail tools, budget-bound. | ✅ built + tested |
| **elizaOS** 🤖 | [`elizaos/piprail/`](./elizaos/piprail) | A **native** elizaOS plugin (`@piprail/elizaos-plugin`) that wraps `paymentTools()` as 6 budget-bound agent actions (pay / quote / plan / discover / budget / guide). | ✅ built + live-tested |
| **n8n** ⚙️ | [`n8n/piprail/`](./n8n/piprail) | A **native** n8n community node (`@piprail/n8n-nodes-piprail`) — pay / plan / quote / estimate an x402 URL from any workflow, `usableAsTool` so AI Agent nodes can call it. EVM (v1), zero runtime deps. Install via Community Nodes. | ✅ built + e2e-tested |
| **Mastra** ⭐ | [`mastra/piprail/`](./mastra/piprail) | The **first x402 integration for Mastra** — a runnable example wiring [`@piprail/mcp`](../mcp) in via Mastra's `MCPClient`; an agent gets all 8 PipRail tools, budget-bound. `viem` never enters Mastra's tree. | ✅ built + tested |
| _Vercel AI SDK_ | _`vercel/piprail/` (soon)_ | `paymentTools()` as Vercel AI SDK tools. | planned |

> **Any MCP client can use PipRail today** without a dedicated integration — point it at
> `npx -y @piprail/mcp`. See [docs.piprail.com/mcp/client-setup](https://docs.piprail.com/mcp/client-setup/).

## Is it working?

**[TESTING.md](./TESTING.md)** — how to verify each integration. Every folder ships a zero-dependency
`verify.mjs` that spawns the MCP server the way the framework does and drives the tools (run
`node verify.mjs --live`), plus a manual real-app run for the final sign-off.

Full guides live on the docs: **[docs.piprail.com/integrations](https://docs.piprail.com/integrations/)**.

## Spread the word

Building an integration for a framework we haven't covered yet? Open a PR. And to help others find PipRail:

⭐ **[Star on GitHub](https://github.com/piprail/piprail)** &nbsp;·&nbsp; 𝕏 **[Follow @piprailhq](https://x.com/piprailhq)** &nbsp;·&nbsp; 🌐 **[piprail.com](https://piprail.com)** &nbsp;·&nbsp; 📖 **[docs.piprail.com](https://docs.piprail.com)**

---

*These are standalone packages — not part of the npm workspace. Each folder is publishable on its own
(e.g. a ClawHub skill). The integration is always "wrap what exists + get discovered," never a fork of
the SDK.*
