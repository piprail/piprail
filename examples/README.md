# PipRail examples

Copy-paste examples for humans **and** agents. Every folder is a standalone app that installs from npm — `npm install && npm start`, set one wallet, done.

PipRail has **two sides**, plus a **zero-code** path for AI clients:

- **Accept** — your server returns `402` and gets paid straight to your wallet.
- **Pay** — your agent auto-pays a `402` on-chain, inside a budget it cannot exceed.
- **Zero code** — `npx -y @piprail/mcp` hands Claude / Cursor / any MCP client a budget-capped wallet.

No backend, no database, no fee. Verification is local, against your own RPC.

## 🌐 No build — run it in the browser

| What | Folder | How |
|---|---|---|
| One HTML page that loads the SDK from a CDN and runs a **live 402 demo** in-browser | [`browser/`](./browser) | open `index.html` — no npm, no bundler, no backend |

> `@piprail/sdk` runs in the browser **and** on the server. The merchant gate needs only your wallet **address** (no key); the payer client pays from Node or a browser (with the visitor's injected wallet). See [`browser/README.md`](./browser).

## Accept payments (merchant)

| Framework | Folder | Primitive |
|---|---|---|
| Express | [`express/`](./express) | `requirePayment` (middleware) |
| Next.js (App Router) | [`next-app-router/`](./next-app-router) | `createPaymentGate` |

> `requirePayment` is **Express-only**. Every other framework — Next.js, Hono, Fastify, Cloudflare Workers, Bun, Deno — uses `createPaymentGate` the same way: build a gate, switch on `verify()`.

## Make payments (agent)

| What | Folder |
|---|---|
| An agent that auto-pays a `402` (+ a spend policy) | [`agent/`](./agent) |
| Expose payment as MCP tools — **build your own** server | [`mcp/`](./mcp) |

> **Most agents write no code.** The published [`@piprail/mcp`](../mcp) server gives any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) the three payment tools, budget-capped — just `npx -y @piprail/mcp` with your key + chain in `env`. The [`mcp/`](./mcp) folder is the minimal from-scratch version, for when you want to embed or customize it.

## Start here

- **New to PipRail?** Read [`CONCEPTS.md`](./CONCEPTS.md) — the 402 loop, who owns what, and which primitive to use when.
- **Full SDK API:** [`../sdk/README.md`](../sdk/README.md) — every chain, custom tokens, policy controls, gas estimation.
- **MCP setup:** [`../mcp/README.md`](../mcp/README.md) — per-client config, all chains, wallet formats.

Each example targets **Base + USDC** with a placeholder `payTo` — set your own wallet, then `npm install && npm start` in the folder.
