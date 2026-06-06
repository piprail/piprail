# PipRail examples

Copy-paste examples for humans **and** agents. Every folder is a standalone app that installs from npm — `npm install && npm start`, set one wallet, done.

PipRail has **two sides**, a **zero-code** path for AI clients, and **discovery**:

- **Accept** — your server returns `402` and gets paid straight to your wallet.
- **Pay** — your agent auto-pays a `402` on-chain, inside a budget it cannot exceed.
- **Zero code** — `npx -y @piprail/mcp` hands Claude / Cursor / any MCP client a budget-capped wallet.
- **Discover** — emit a manifest, register your endpoint on the open x402 indexes, and find payable APIs.

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

> **Most agents write no code.** The published [`@piprail/mcp`](../mcp) server gives any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) all **five** tools (three for paying, two for discovery), budget-capped — just `npx -y @piprail/mcp` with your key + chain in `env`. The [`mcp/`](./mcp) folder is the minimal from-scratch version, for when you want to embed or customize it.

## Find & be found (discovery)

| What | Folder |
|---|---|
| Emit a discovery manifest, register on the open indexes, and find payable APIs — `emit` / `register` / `discover`, live | [`discovery/`](./discovery) |

> Discovery is **$0 and backendless** — built on the open x402 indexes (402 Index, CDP Bazaar); PipRail hosts none of its own. `register()` lists your endpoint (no auth, any chain), `discover()` finds resources to pay, and the pure emitters turn your gate's config into the OpenAPI / `.well-known` / DNS artifacts crawlers read. See [`../sdk/DISCOVERY.md`](../sdk/DISCOVERY.md).

## Prove it works — the adversarial test harnesses

These aren't payment apps — they're **runnable proofs**. Each exercises a real,
published package end-to-end (no mocks) and tries hard to break it. No real money,
no real keys; the live settlement tests use a local Anvil fork of Base with fake funds.

| What | Folder | Proves |
|---|---|---|
| The **SDK**, both ends — `requirePayment`/`createPaymentGate` (merchant) **and** `PipRailClient` (payer) | [`sdk-sandbox/`](./sdk-sandbox) | the gate, the client, the spend policy, the wire codecs, the typed errors, a real on-chain round-trip (USDC + native), **and live discovery** (emit + register + discover vs. the real indexes) — **117 checks** |
| The **MCP server** — spawned over real stdio, attacked as a greedy AI + a lying merchant | [`mcp-sandbox/`](./mcp-sandbox) | an AI **cannot break the spend policy**: caps can't be tricked or drained, proven on a real on-chain settlement; plus the discovery tools over MCP — **167 checks** |

> **The headline both prove:** the spend policy is the boundary, and it holds.
> A merchant that lies about decimals / display amount / symbol can't push a
> payment over its cap (the cap binds to the token's *true* value); you can't
> drain a wallet across many small calls (the lifetime cap is enforced on real
> on-chain settlements — total spend held to the base unit, declined calls move
> **zero**); and every refusal happens **before any on-chain send**.
>
> Run them: `npm run build:sdk && npm run build:mcp` (repo root), then
> `node run-all.mjs` in either folder. Both are regression gates *and* living
> documentation of why PipRail is safe to hand an autonomous agent.

## Start here

- **New to PipRail?** Read [`CONCEPTS.md`](./CONCEPTS.md) — the 402 loop, who owns what, and which primitive to use when.
- **Full SDK API:** [`../sdk/README.md`](../sdk/README.md) — every chain, custom tokens, policy controls, gas estimation.
- **MCP setup:** [`../mcp/README.md`](../mcp/README.md) — per-client config, all chains, wallet formats.

Each example targets **Base + USDC** with a placeholder `payTo` — set your own wallet, then `npm install && npm start` in the folder.
