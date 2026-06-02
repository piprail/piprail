# PipRail examples

Dead-simple, copy-paste examples — for humans **and** agents. Each folder is a standalone app that installs `@piprail/sdk` from npm.

## Accept payments

| Framework | Folder | Primitive |
|---|---|---|
| Express | [`express/`](./express) | `requirePayment` (middleware) |
| Next.js (App Router) | [`next-app-router/`](./next-app-router) | `createPaymentGate` |

> `requirePayment` is **Express-only**. Every other framework — Next.js, Hono, Fastify, Cloudflare Workers, Bun, Deno — uses `createPaymentGate` exactly like the Next.js example: build a gate, switch on `verify()`.

## Make payments (agents)

| What | Folder |
|---|---|
| An agent that auto-pays a `402` (+ a spend policy) | [`agent/`](./agent) |
| Expose payment as tools to a model (MCP) | [`mcp/`](./mcp) |

## Start here

- **New to PipRail?** Read [`CONCEPTS.md`](./CONCEPTS.md) — the 402 loop, who owns what, and which primitive to use when.
- **Full API:** [`../sdk/README.md`](../sdk/README.md) — all 24 chains, custom tokens, policy controls, gas estimation.

Each example targets **Base + USDC** with a placeholder `payTo` — set your own wallet, then `npm install && npm start` in the folder.
