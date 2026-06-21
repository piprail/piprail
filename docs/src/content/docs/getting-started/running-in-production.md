---
title: Running in production
description: The checklist for shipping PipRail beyond a single process — share the replay store across instances, understand what is process-scoped (and resets on restart), make receipts durable, bring your own RPC, advertise an exact rail for discovery, and keep keys safe.
sidebar:
  order: 5
---

The quickstart runs in one process with sensible in-memory defaults. Going to production — a
fleet of agents, a load-balanced gate, a long-lived service — means knowing exactly **what is
in-memory and single-process by default**, and opting into the durable version. Nothing here
changes the defaults; each item is a seam you wire up when you need it. This is the one page to
read before you ship.

## 1. Share the replay store across instances

A gate's [replay protection](/accepting-payments/replay-protection/) is an **in-memory used-proof
set, scoped to one process**. On a single instance it's airtight (each proof redeems exactly
once). Behind a load balancer, each instance has its own set — so the *same* proof could be
redeemed once **per instance**. Pass a shared store via `isUsed` / `markUsed`; a Redis `SET NX`
is the canonical, atomic choice:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  isUsed:   (ref) => redis.exists(`piprail:proof:${ref}`).then(Boolean),
  markUsed: (ref) => { redis.set(`piprail:proof:${ref}`, '1', { EX: 900 }) },  // >= the gate's maxTimeoutSeconds (default 600s)
})
```

Make the check + set **atomic** (`SET NX`) if you need the exact single-redeem guarantee under
concurrency. Without a shared store, run a single gate instance.

## 2. Know what's process-scoped (and resets on restart)

These are deliberately in-memory — a leash within one run, not a persistent ledger. **Every figure
resets when the process restarts.**

| What | Scope | If you need durability |
|---|---|---|
| Client [spend ledger / budget](/spend-controls/spend-ledger/) (`spent()`, `budget()`) | per process, per `(network, asset)` | persist `spent()` yourself, or run one long-lived client |
| [Time envelope](/spend-controls/time-envelope/) (TTL, rolling window) | per process — the session *is* the process | a restart begins a fresh window |
| Gate replay set (without a custom store) | per process | §1 — a shared store |

A `maxTotal` of `20 USDC` means **20 per process lifetime**; restart the agent and spent resets to
zero. For a CI runner or a fleet, treat the policy as a per-run guardrail and track cumulative
spend in your own system if you need a hard cross-restart cap.

## 3. Make receipts durable

[`onPaid`](/accepting-payments/receipts-and-onpaid/) is **fire-and-forget by default** and
**at-least-once** across instances. For production:

- **Dedupe on `receipt.idempotencyKey`** (a unique index / upsert) — across instances the same
  settlement can fire twice.
- Set **`awaitOnPaid: true`** to record the receipt *before* the resource is served, or push to a
  durable queue inside the hook and process it in a worker.
- For a webhook, use **[`deliverReceipt`](/accepting-payments/receipts-and-onpaid/#reliable-delivery)** —
  signed (HMAC), retried, idempotent, never throws.

A bare `onPaid: (r) => db.insert(r)` on a single instance is fine for low stakes; the above is what
makes it survive crashes and horizontal scaling.

## 4. Bring your own RPC

Verification reads the chain against **your** RPC (`rpcUrl`). The SDK has no separate API-key
field — **fold any key into the URL**. Public RPCs are rate-limited and will throttle a busy gate
or a fleet; use a dedicated endpoint in production. Per-chain notes: TON needs a keyed toncenter
URL; Tron's public node is heavily rate-limited (keep TRX for gas); NEAR has no account-history
RPC. See [Chains](/chains/overview/) for the per-family RPC + gas notes.

## 5. Confirm the recipient can receive (per-chain prerequisites)

Some chains require a **one-time** receive setup on the `payTo` address before it can accept a
token — miss it and payments fail at settle, not at quote:

- **Stellar / XRPL** — a trustline for the asset + an activated, reserve-funded account.
- **NEAR** — `storage_deposit` for a NEP-141 token (native NEAR is zero-setup).
- **Algorand** — an ASA opt-in for the token (native ALGO is zero-setup).
- **Solana / Aptos / Sui** — the recipient's token account exists once it has held the token.

The client surfaces this read-only via `planPayment()` — each rail's `options[].recipient` reports
`ready` plus a `fix` hint; the
[chains catalog](/chains/overview/) lists every caveat. Native coin is payable on every family with
no prerequisite.

## 6. Be discoverable AND payable

If you [register](/discovery/discover-and-register/) a gate on the open indexes (402 Index,
x402scan), note that index payers are **overwhelmingly standard `exact` clients**. A default
`onchain-proof`-only gate gets *listed* but those clients **can't pay it** — a discoverable dead
end. Advertise a standard [`exact` rail](/accepting-payments/exact-rail-seller/) so it's payable by
the whole index audience:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  exact: { settle: { facilitator: 'https://your-facilitator' } }, // or settle: 'self' with a relayer
  discovery: true,                                                 // x402scan requires an input schema
})
```

On BNB the exact rail covers Binance-Peg USDC/USDT (Permit2) and FDUSD/USD1/U (gasless EIP-3009) —
see [Gasless payments](/making-payments/gasless-payments/).

## 7. Keep keys safe

The wallet key lives in the process env (or a secrets manager) and is **never committed**. The SDK
takes a raw key/seed; a payer client signs with it, a gate needs only the receive **address** (no
key). Scope what each process holds: a gate that only verifies needs no private key at all. The
[MCP server](/mcp/security/) enforces the spend policy before any send, so an agent can hold a
budget-bound key it cannot drain.

## The short list

- [ ] Shared `isUsed`/`markUsed` store if more than one gate instance.
- [ ] Accept that `spent()` / the time window reset on restart; track cumulative spend yourself if needed.
- [ ] `awaitOnPaid` and/or a durable queue; dedupe receipts on `idempotencyKey`.
- [ ] A dedicated RPC (key folded into the URL).
- [ ] Recipient receive-prerequisites done for non-EVM chains.
- [ ] An `exact` rail advertised if you list on the open indexes.
- [ ] Keys in env/secrets-manager only; gates hold no key.
