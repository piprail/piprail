---
title: Persistence (durable budget)
description: Make a client's budget survive a restart — a pluggable SpendStore, a one-line local file store, and an MCP env knob. No backend, no database; you own the store.
sidebar:
  order: 6
---

## Why

By default the [spend ledger](/spend-controls/spend-ledger/) is **in-memory and process-scoped** —
the session *is* the process. That's the right default for a one-shot agent, but it means a restart
zeroes `maxTotal`, [`maxTotalPerDenom`](/spend-controls/total-budget/), and the payment-count caps.
A crash-loop could re-spend the whole budget on every boot.

Pass a **`SpendStore`** and the ledger hydrates from it at construction and persists every settled
payment — so the caps **resume where they left off**. There is no PipRail backend: you own the
store, exactly like the gate's [replay-protection](/accepting-payments/replay-protection/)
`isUsed`/`markUsed` hook.

## The one-liner: a local file

`fileSpendStore` is a durable JSONL log (one settled payment per line). It lives in the Node-only
entry `@piprail/sdk/node`, so the browser bundle never imports `node:fs`.

```ts
import { PipRailClient } from '@piprail/sdk'
import { fileSpendStore } from '@piprail/sdk/node'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxTotalPerDenom: { USD: '20.00' }, maxPayments: 100 },
  spendStore: fileSpendStore('./.piprail-spend.jsonl'),
})
```

Restart the process and the `$20` USD cap + the 100-payment count pick up exactly where they were —
the file is replayed on construction.

## Bring your own store

The interface is two methods. `load()` is read once (synchronously) at construction; `append()`
persists one settled payment and **must never throw** (a disk hiccup can't be allowed to abort a
confirmed payment).

```ts
import type { SpendStore, SpendRecord } from '@piprail/sdk'

const redisStore: SpendStore = {
  load: () => JSON.parse(readSync()) as SpendRecord[], // hydrate from your store
  append: (r) => fireAndForget(() => redis.rpush('piprail:spend', JSON.stringify(r))),
}

new PipRailClient({ chain: 'base', wallet, policy, spendStore: redisStore })
```

Round-trip the **whole** `SpendRecord` (it carries `decimals` + `denom`) so the per-asset totals and
the cross-token grand total rebuild exactly on reload — the built-in stores do.

`memorySpendStore(seed?)` is the in-memory implementation (handy for tests and seeding).

## Across chains

A [`MultiChainPayer`](/making-payments/multi-chain/) shares ONE ledger; back it with a store and the
**whole cross-chain budget** is durable from a single file:

```ts
const payer = MultiChainPayer.fromWallets({
  wallets: { base: { key }, solana: { key } },
  policy: { maxTotalPerDenom: { USD: '20.00' } },
  spendStore: fileSpendStore('./spend.jsonl'),
})
```

## In the MCP server

One env knob wires the file store for you:

```bash
PIPRAIL_SPEND_LOG=/data/piprail-spend.jsonl
```

The budget then survives the MCP server restarting (and, in multi-chain mode, the file backs the one
shared ledger). See [MCP configuration](/mcp/configuration/).

## What persists, what doesn't

| Survives a restart (with a store) | Always process-scoped |
|---|---|
| `maxTotal` (per-asset lifetime) | The session time envelope (`ttlSeconds` / `expiresAt`) |
| `maxTotalPerDenom` (grand total) | The rolling-window *slice* is recomputed from record timestamps on reload |
| `maxPayments` (lifetime count) | |

The store never throws: a failed `load()` falls back to an empty ledger, and a failed `append()` is
swallowed — neither can break construction or a confirmed payment.
