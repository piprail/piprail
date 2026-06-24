# PipRail examples

Copy-paste examples for humans **and** agents. Every folder is a standalone app that installs from npm — `npm install && npm start`, set one wallet, done.

PipRail has **two sides**, a **zero-code** path for AI clients, and **discovery**:

- **Accept** — your server returns `402` and gets paid straight to your wallet.
- **Pay** — your agent auto-pays a `402` on-chain, inside a budget it cannot exceed.
- **Zero code** — `npx -y @piprail/mcp` hands Claude / Cursor / any MCP client a budget-capped wallet.
- **Discover** — emit a manifest, register your endpoint on the open x402 indexes, and find payable APIs.

No backend, no database, no fee. Verification is local, against your own RPC.

> **Fastest start — scaffold a whole merchant:** `npm create piprail` generates a complete, deployable app (node / Cloudflare / Vercel) with your wallet baked in — see [`create-piprail`](../create-piprail). The folders below are the hand-wired building blocks it assembles.

## 🔬 Why 402, not a raw transfer? (with vs without)

If a payer just sends a raw transfer to your wallet, you can't discover the price, can't tell **which request** it paid for, can't stop replays, and you have to run a **payments backend** (a chain listener + correlation + async notify) just to notice it. [`why-402/`](./basics/why-402) proves this with code you can run:

| What | Folder | Run |
|---|---|---|
| The three **verification** holes a raw transfer leaves (discovery, replay, collision) | [`why-402/`](./basics/why-402) | `node basics/why-402/without-402.mjs` |
| The **backend** you'd have to run without 402 (listener, accounts, async grant) | [`why-402/`](./basics/why-402) | `node basics/why-402/without-402-server.mjs` |
| The same payment with the SDK, commented at each point a hole closes | [`why-402/`](./basics/why-402) | see `basics/why-402/with-402.mjs` |

> The honest verdict (incl. where a raw build **can** match us, and our own limitations) + the side-by-side slides are in [`why-402/README.md`](./basics/why-402/README.md). **This is the thesis: you can't get x402's full behaviour the old way without rebuilding x402.**

## 🌐 No build — run it in the browser

| What | Folder | How |
|---|---|---|
| One HTML page that loads the SDK from a CDN and runs a **live 402 demo** in-browser | [`browser/`](./basics/browser) | open `index.html` — no npm, no bundler, no backend |

> `@piprail/sdk` runs in the browser **and** on the server. The merchant gate needs only your wallet **address** (no key); the payer client pays from Node or a browser (with the visitor's injected wallet). See [`browser/README.md`](./basics/browser).

## Accept payments (merchant)

| Framework | Folder | Primitive |
|---|---|---|
| Express | [`express/`](./basics/express) | `requirePayment` (middleware) |
| Next.js (App Router) | [`next-app-router/`](./basics/next-app-router) | `createPaymentGate` |

> `requirePayment` is **Express-only**. Every other framework — Next.js, Hono, Fastify, Cloudflare Workers, Bun, Deno — uses `createPaymentGate` the same way: build a gate, switch on `verify()`.

## A complete payment system — both sides notified, success **and** failure

| What | Folder |
|---|---|
| A merchant + a buyer where **both** are told the outcome of every payment — each settlement (`onPaid`) **and** each rejected attempt (`onFailed`) persisted to SQLite, the buyer's `onEvent` seeing `payment-settled` / `payment-failed` with the **same `code`** | [`payment-system/`](./basics/payment-system) |

> The merchant's gate records every success (`onPaid` → `payments`) and every rejected attempt (`onFailed` → `failed_attempts`, with a `transient` flag so RPC-lag retries aren't false alarms) to its **own** SQLite ledger; a free `GET /ledger` shows both. The buyer is notified of the same outcome (event + thrown error). This is the "just like a payment system" reference — `npm start` the merchant, then `npm run buyer`.

## Make payments (agent)

| What | Folder |
|---|---|
| An agent that auto-pays a `402` (+ a spend policy) | [`agent/`](./basics/agent) |
| **Pay across chains** — one buyer, a wallet per chain, auto-route to whichever the 402 asks for (`MultiChainPayer`) | [`multi-chain/`](./basics/multi-chain) |
| Expose payment as MCP tools — **build your own** server | [`mcp/`](./basics/mcp) |

> **Most agents write no code.** The published [`@piprail/mcp`](../mcp) server gives any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) all **eight** tools (discover · quote · plan · pay · register · budget · guide · verify_receipt), budget-capped — just `npx -y @piprail/mcp` with your key + chain in `env`. The [`mcp/`](./basics/mcp) folder is the minimal from-scratch version, for when you want to embed or customize it.

## Integrations

First-party framework integrations live in their own top-level [`integrations/`](../integrations) folder, one per framework — e.g. the **OpenClaw** ClawHub skill at [`integrations/openclaw/piprail/`](../integrations/openclaw/piprail) (`clawhub install piprail`) and the **Hermes** MCP catalog entry at [`integrations/hermes/piprail/`](../integrations/hermes/piprail). Each wraps the published `@piprail/mcp` — nothing new to build. Full guides: [docs.piprail.com/integrations](https://docs.piprail.com/integrations/).

## Find & be found (discovery)

| What | Folder |
|---|---|
| Emit a discovery manifest, register on the open indexes, and find payable APIs — `emit` / `register` / `discover`, live | [`discovery/`](./basics/discovery) |

> Discovery is **$0 and backendless** — built on the open x402 indexes (402 Index, CDP Bazaar); PipRail hosts none of its own. `register()` lists your endpoint (no auth, any chain), `discover()` finds resources to pay, and the pure emitters turn your gate's config into the OpenAPI / `.well-known` / DNS artifacts crawlers read. See [docs.piprail.com/discovery](https://docs.piprail.com/discovery/discover-and-register/).

## Full applications

The folders above are **mini examples** — each proves one thing. [`apps/`](./apps) is the next tier up:
**complete, runnable applications** (a frontend + backend + persistence) that show PipRail inside a
real product. First up (📋 planned): a **metered-API SaaS** that gates an endpoint and **stores every
paid receipt in a SQL database**, with a revenue dashboard — blueprint in
[`apps/full-stack-saas/PLAN.md`](./apps/full-stack-saas/PLAN.md).

> The database belongs to the *merchant's app*, never to PipRail — these show how to wire `onPaid` and a
> SQL-backed replay store into **your** stack. PipRail itself stays backendless.

## Prove it works — the adversarial test harnesses

These aren't payment apps — they're **runnable proofs**. Each exercises a real,
published package end-to-end (no mocks) and tries hard to break it. Most use no real
money or keys — the live settlement tests use a local Anvil fork of Base with fake funds.
(The one exception, [`x402-parity-sandbox/`](./basics/x402-parity-sandbox), settles **tiny
real** amounts on Base mainnet against the **published** npm packages, and self-skips its
live legs when no funded test wallet is present.)

| What | Folder | Proves |
|---|---|---|
| The **SDK**, both ends — `requirePayment`/`createPaymentGate` (merchant) **and** `PipRailClient` (payer) | [`sdk-sandbox/`](./basics/sdk-sandbox) | the gate, the client, the spend policy, the wire codecs, the typed errors, a real on-chain round-trip (USDC + native), **and live discovery** (emit + register + discover vs. the real indexes) — **284 checks** |
| The **MCP server** — spawned over real stdio, attacked as a greedy AI + a lying merchant | [`mcp-sandbox/`](./basics/mcp-sandbox) | an AI **cannot break the spend policy**: caps can't be tricked or drained, proven on a real on-chain settlement; plus the discovery tools over MCP — **169 checks** |
| The **x402-parity** features against the **published** `@piprail/sdk` + `@piprail/mcp` | [`x402-parity-sandbox/`](./basics/x402-parity-sandbox) | verifiable receipts (R1+R2), the `upto` metered rail, the merchant-proof spend leash, the **A2A (Google Agent2Agent)** transport, and the MCP's 8th tool `piprail_verify_receipt` — each proven **live on Base mainnet** on what `npm i` actually ships |

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
- **Full SDK API:** [docs.piprail.com](https://docs.piprail.com) — every chain, custom tokens, policy controls, gas estimation.
- **MCP setup:** [docs.piprail.com/mcp](https://docs.piprail.com/mcp/overview/) — per-client config, all chains, wallet formats.

Each example targets **Base + USDC** with a placeholder `payTo` — set your own wallet, then `npm install && npm start` in the folder.

> **A note on `*.local.mjs`.** Any loose `*.local.mjs` files in this folder are **gitignored local
> live-test harnesses** (real-money smoke tests against mainnet, run from a maintainer's machine with
> `.secrets/` wallets). They're never committed and aren't part of the shipped examples — ignore them.

## Spread the word

PipRail is free, open-source, and backendless. If an example here saved you a payments backend, help others find it:

⭐ **[Star on GitHub](https://github.com/piprail/piprail)** &nbsp;·&nbsp; 𝕏 **[Follow @piprailhq](https://x.com/piprailhq)** &nbsp;·&nbsp; 🌐 **[piprail.com](https://piprail.com)** &nbsp;·&nbsp; 📖 **[docs.piprail.com](https://docs.piprail.com)**
