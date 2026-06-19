# Full applications

The examples one level up are **mini examples** — focused, single-purpose snippets that prove one
thing (gate a route, pay a 402, discover an endpoint) — and the **sandboxes**
([`sdk-sandbox/`](../basics/sdk-sandbox), [`mcp-sandbox/`](../basics/mcp-sandbox)) are end-to-end test suites.

This folder is for the next tier up: **complete, runnable applications** that show PipRail inside a
real product — a frontend, a backend, persistence, the whole shape. Each app here is self-contained
(`npm install && npm run dev`), installs `@piprail/sdk` (and/or `@piprail/mcp`) from npm, and carries
its own README.

| App | Stack | What it demonstrates | Status |
|---|---|---|---|
| [`full-stack-saas/`](./full-stack-saas) | Next.js + Prisma + SQLite + Tailwind | A metered-API SaaS: gate an endpoint, **persist every paid receipt to SQL** via `onPaid`, show revenue/usage on a dashboard | 📋 **Planned** — see [`PLAN.md`](./full-stack-saas/PLAN.md) (not built yet) |

> **Charter note.** PipRail itself stays backendless — no database, no fee, verification is local. A
> *merchant's* app, of course, can have its own SQL database; these app examples show how to wire
> PipRail's `onPaid` / `deliverReceipt` hooks into one (and how to back the replay store with it).
> The database belongs to the app, never to PipRail.

## Adding an app here

1. One folder, one self-contained app, one README. It must run with `npm install && npm run dev`.
2. Depend on the **published** `@piprail/sdk` / `@piprail/mcp` (npm), not a relative path — these are
   what a real user copies.
3. Lead the README with *what product it is*, then the **PipRail integration points** (where it gates,
   where it persists receipts, where it pays), then how to run it.
4. Keep secrets in `.env` (a `.env.example` with placeholders, never a real key).
