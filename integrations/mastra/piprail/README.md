# PipRail × Mastra

**Give a [Mastra](https://github.com/mastra-ai/mastra) agent a budget-bound payment wallet across
every major chain.** PipRail plugs into Mastra as a **standard MCP server** — the published
**[`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp)** (`npx -y @piprail/mcp`), wired in
through Mastra's first-class [`MCPClient`](https://mastra.ai/docs/mcp/overview). The agent gets all
**8 PipRail tools** (`piprail_*`), capped by a spend policy it cannot exceed.

> **The first x402 payment integration for Mastra.** Mastra ships no payment rail today — this is
> the drop-in answer: **backendless, no fee, self-custodial, every chain**. Funds settle straight to
> the provider's wallet, verified locally against *your* RPC, and the agent **cannot** exceed the cap
> you set.
>
> **No bespoke plugin code, and `viem` never enters Mastra's tree.** `@piprail/mcp` runs as a separate
> `npx` process, so neither the SDK nor its `viem` peer becomes a Mastra dependency — the cleanest
> possible footprint. The integration *is* the MCP server plus one `MCPClient` block.

## Setup

Point Mastra's `MCPClient` at `@piprail/mcp`, then hand its tools to an agent:

```ts
// src/mastra/mcp.ts
import { MCPClient } from '@mastra/mcp'

export const piprailMcp = new MCPClient({
  id: 'piprail',
  servers: {
    piprail: {
      command: 'npx',
      args: ['-y', '@piprail/mcp'],
      env: {
        PIPRAIL_PRIVATE_KEY: process.env.PIPRAIL_PRIVATE_KEY ?? '', // omit for read-only
        PIPRAIL_CHAIN: 'base',
        PIPRAIL_MAX_AMOUNT: '0.10', // max per payment (token units)
        PIPRAIL_MAX_TOTAL: '5.00', // lifetime budget per token
        PIPRAIL_TOKENS: 'USDC',
      },
    },
  },
})
```

```ts
// src/mastra/agents/payment-agent.ts
import { Agent } from '@mastra/core/agent'
import { openai } from '@ai-sdk/openai'
import { piprailMcp } from '../mcp'

export const paymentAgent = new Agent({
  id: 'payment-agent',
  name: 'PipRail Payment Agent',
  instructions: 'You can pay x402 URLs for the user, within a hard spend policy. Quote and plan before you pay.',
  model: openai('gpt-5'), // any Vercel AI SDK provider, or Mastra's 'openai/…' model router
  tools: await piprailMcp.listTools(), // all 8 PipRail tools, registered at agent level
})
```

That's it — the agent can now pay an x402 URL, but never above your cap. For per-request (dynamic)
tools instead of agent-level, pass `await piprailMcp.listToolsets()` to
`agent.generate(prompt, { toolsets })`.

> **Tool names are namespaced.** Mastra prefixes every MCP tool with its server key, so PipRail's
> `piprail_*` tools surface to the agent as **`piprail_piprail_*`** (server key + tool name) — standard
> Mastra behavior. The agent reads exact names from its tool schema, so this is invisible in practice;
> just don't hard-code the un-prefixed names in your own prompts.

**Read-only first run:** omit `PIPRAIL_PRIVATE_KEY` entirely and PipRail boots key-less —
discover / quote / plan / budget / guide all work; only `piprail_pay_request` needs the wallet.

## Configure

Copy [`.env.example`](./.env.example) to `.env` and fill in a **funded** wallet key. The full env
reference:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PIPRAIL_PRIVATE_KEY` | only to **pay** | — | Self-custodial wallet key/seed (EVM `0x…`, Solana base58, or a mnemonic). **Omit for read-only.** Not an API key — never commit it. |
| `PIPRAIL_CHAIN` | — | `base` | Chain to pay on (any EVM, or `solana`/`ton`/`tron`/`near`/`sui`/`aptos`/`algorand`/`stellar`/`xrpl`) |
| `PIPRAIL_CHAINS` | — | — | **Multi-chain** — comma-separated; each takes its own `PIPRAIL_<CHAIN>_KEY`. Pays whichever chain a 402 asks for. |
| `PIPRAIL_MAX_AMOUNT` | — | `0.10` | Max per payment, in the **token's units** (≈ $ for USDC/USDT; native units for a coin) |
| `PIPRAIL_MAX_TOTAL` | — | `10.00` | Lifetime budget per token (server default; this example sets `5.00`) |
| `PIPRAIL_TOKENS` | — | chain stables | Allowed tokens, comma-separated |
| `PIPRAIL_SCHEMES` | — | `onchain-proof` | Add `exact` to also pay standard x402 servers |
| `PIPRAIL_RPC_URL` | — | chain default | Custom RPC (recommended in production) |

> **Non-EVM chains** need their SDK peer library available alongside the server — see
> [docs.piprail.com/mcp/chains](https://docs.piprail.com/mcp/chains/). EVM chains need no extra peers.

## The 8 tools

`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · **`piprail_pay_request`** ·
`piprail_register` · `piprail_budget` · `piprail_guide` · `piprail_verify_receipt`. Only
`piprail_pay_request` moves money; the rest are read-only. Full reference:
[docs.piprail.com/mcp/tools](https://docs.piprail.com/mcp/tools/). (As above, Mastra surfaces these
to the agent prefixed with the server key — e.g. `piprail_piprail_pay_request`.)

## Run the example

This folder is a complete, runnable Mastra project.

```bash
npm install
cp .env.example .env     # add a funded PIPRAIL_PRIVATE_KEY (+ OPENAI_API_KEY for the LLM)
npm run dev              # opens the Mastra playground — chat with the PipRail Payment Agent
```

## Verify it works

A zero-dependency check spawns the server the way Mastra's `MCPClient` does and drives the tools:

```bash
node verify.mjs                 # offline: handshake + all 8 tools + read-only calls
node verify.mjs --mastra        # + drive the REAL @mastra/mcp MCPClient.listTools() (run `npm install` first)
node verify.mjs --live          # + quote the live demo + prove the budget cap refuses overspend
node verify.mjs --live --mastra # everything
PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live --mastra   # test a local MCP build
```

`--live` proves the real round-trip without spending: it quotes `piprail.com/x402/demo` (0.01 USDC on
Base) and confirms a below-price cap **refuses** the payment. For the checklist, see
[`integrations/TESTING.md`](../../TESTING.md).

## Publishing / upstream (maintainers)

Mastra's community **template contributions are currently paused** ("we're not accepting new template
contributions"), so this lives as a first-party PipRail example here. When templates reopen, this can
become `templates/template-x402-payments` in `mastra-ai/mastra` (the monorepo — its `templates/`
mirror ignores PRs). In the meantime the upstream path is a **docs recipe** under `docs/.../mcp/`,
which Mastra's `CONTRIBUTING.md` gates behind an **issue first** — propose it, then PR.

## Links

- **Integration docs:** [docs.piprail.com/integrations/mastra](https://docs.piprail.com/integrations/mastra/)
- **MCP server:** [`@piprail/mcp`](https://www.npmjs.com/package/@piprail/mcp) · [docs](https://docs.piprail.com/mcp/overview/)
- **PipRail:** [piprail.com](https://piprail.com) · [github.com/piprail/piprail](https://github.com/piprail/piprail) (MIT)
- **Follow along:** ⭐ [Star on GitHub](https://github.com/piprail/piprail) · 𝕏 [@piprailhq](https://x.com/piprailhq)
