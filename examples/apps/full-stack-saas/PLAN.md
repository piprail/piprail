# Plan — full-stack metered-API SaaS on PipRail

> **Status: planned, not built.** This is the blueprint for the example, kept here so it can be built
> in one focused pass when we're ready. It exists to prove PipRail end-to-end in a *real product*:
> a frontend, a backend, and a SQL database — the shape most people will actually ship.

## What it is

A tiny but complete **metered-API SaaS**. A developer wraps an API endpoint with PipRail so it
**charges per call** in x402; every successful payment is **persisted to a SQL database**; and a
**dashboard** shows revenue, usage, and the receipt log. Optionally, a second "agent" view pays the
API on its own with a budget-capped wallet.

The one-sentence pitch the example proves: **"Charge for an API, store every paid receipt in your own
database, and watch the revenue — with no payments backend, no facilitator, and no fee."**

## Why this example (what it teaches that the mini examples don't)

The mini examples prove the *primitives* in isolation. This proves the **product wiring** people ask
about the moment they go past "hello world":

1. **Durable receipts.** How to turn the fire-and-forget `onPaid` hook into a row in a real database —
   keyed on `idempotencyKey`, safe against the at-least-once delivery contract (upsert, never double-count).
2. **A SQL-backed replay store.** How to swap the in-memory used-proof set for the pluggable
   `isUsed` / `markUsed` so the gate survives restarts and runs across multiple instances.
3. **Reading payments back out.** A dashboard that queries the receipts table — revenue by token,
   calls over time, the live log — the "did I get paid?" view a merchant actually wants.
4. **Frontend + backend in one repo**, so the reader sees the whole loop, not just a route handler.

## Stack (chosen for portability + understandability)

- **Next.js (App Router)** — frontend pages **and** the gated API route in one repo, one `npm run dev`.
  (The gate pattern is `createPaymentGate`, identical to the [`next-app-router/`](../../next-app-router)
  mini example — this app is that route + persistence + a UI.)
- **Prisma + SQLite** — the SQL database. SQLite means zero setup (a file), and Prisma's schema reads
  as documentation. Swapping to Postgres/MySQL is a one-line datasource change (call that out in the README).
- **Tailwind** — for a clean dashboard without design overhead.
- **`@piprail/sdk`** from npm — `createPaymentGate` on the server, optionally `PipRailClient` for the
  agent view.

> **Why not AdonisJS/Laravel?** They're great and the pattern is identical (gate a controller, persist
> in `onPaid`), but a single Next.js repo is the most *copy-paste-able* full-stack TS example and keeps
> the reader's attention on PipRail, not framework setup. The README will note the 1:1 mapping to
> AdonisJS controllers / Laravel actions so those stacks aren't left out.

## Proposed structure

```
full-stack-saas/
├── README.md                 # what it is → PipRail integration points → run it
├── .env.example              # PIPRAIL_PAYTO, optional RPC + AGENT_KEY (placeholders, never real)
├── package.json              # next, prisma, @piprail/sdk, tailwind
├── prisma/
│   └── schema.prisma         # Receipt + (optional) UsedProof models — see below
├── lib/
│   ├── gate.ts               # the single createPaymentGate({ onPaid, isUsed, markUsed })
│   └── db.ts                 # Prisma client singleton
└── app/
    ├── api/report/route.ts   # the METERED endpoint — gate.verify() → 200 / 402, onPaid → SQL
    ├── page.tsx              # the dashboard (revenue, calls, live receipt log)
    └── agent/page.tsx        # (optional) "pay it yourself" view using PipRailClient + a budget
```

### The database (the SQL part)

```prisma
model Receipt {
  idempotencyKey String   @id            // the settled tx id — dedupe key (at-least-once safe)
  network        String                  // CAIP-2, e.g. eip155:8453
  asset          String
  amount         String                  // base units (string — amounts are bigints)
  amountFormatted String
  symbol         String?
  payer          String
  payTo          String
  resource       String
  verifiedAt     DateTime
  createdAt      DateTime @default(now())
  @@index([payTo, verifiedAt])
}

model UsedProof {                          // optional: SQL-backed replay store (multi-instance safe)
  ref       String   @id                  // the proof ref the gate marks used
  markedAt  DateTime @default(now())
}
```

## PipRail integration points (the whole point — keep these front-and-centre in the README)

1. **Gate the route** — `lib/gate.ts`:
   ```ts
   export const gate = createPaymentGate({
     chain: 'base', token: 'USDC', amount: '0.01', payTo: process.env.PIPRAIL_PAYTO!,
     // durable receipts: upsert on the idempotencyKey (onPaid is at-least-once — never double-count)
     awaitOnPaid: true,
     onPaid: (r) => db.receipt.upsert({ where: { idempotencyKey: r.idempotencyKey }, create: {...r}, update: {} }),
     // SQL-backed replay store (survives restarts + scales across instances)
     isUsed:   (ref) => db.usedProof.findUnique({ where: { ref } }).then(Boolean),
     markUsed: (ref) => db.usedProof.create({ data: { ref } }).then(() => {}),
   })
   ```
2. **Persist on success** — the `onPaid` upsert above is the "store receipts in SQL" headline. Use
   `awaitOnPaid` so the row is written before the 200 (durability over latency for this demo).
3. **Read it back** — the dashboard (`app/page.tsx`) is a server component that queries `db.receipt`
   for revenue totals + the recent log. This is the "did I get paid?" answer, straight from SQL.
4. **(optional) Pay it** — `app/agent/page.tsx` uses `PipRailClient` with a `policy` budget to call the
   metered route, showing both sides of the rail in one app.

## "Done" criteria

- [ ] `npm install && npx prisma migrate dev && npm run dev` boots with zero extra setup (SQLite file).
- [ ] `curl /api/report` → `402`; a real (or mocked-on-a-testnet/anvil) payment → `200` + a **Receipt row in SQLite**.
- [ ] The dashboard shows the receipt + running revenue.
- [ ] A replay of the same proof is rejected (the SQL `UsedProof` store works).
- [ ] README leads with the product, then the 4 integration points, then run steps; `.env.example` only.
- [ ] One paragraph mapping the pattern to AdonisJS (controller + action) and Laravel, so non-Next stacks aren't excluded.

## Explicitly out of scope (keep it an *example*, not a framework)

- No auth/billing/multi-tenant accounts — it's a payments demo, not a SaaS starter kit.
- No hosted infra — SQLite + `npm run dev`. (Note the Postgres one-liner for production.)
- Don't reintroduce a "payments backend": the DB stores the merchant's *own* receipts via `onPaid`;
  PipRail still verifies locally with no facilitator. The contrast with [`why-402/`](../../why-402)
  (the backend you'd need *without* x402) is worth a one-line callout.

---

*When building: start from the [`next-app-router/`](../../next-app-router) mini example (the gate +
route), add Prisma, wire `onPaid`/`isUsed`/`markUsed`, then the dashboard. Half a day, tops.*
