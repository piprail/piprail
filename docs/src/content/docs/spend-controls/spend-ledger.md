---
title: The spend ledger
description: The in-memory tally of everything a client has paid — spent() for the record, budget() for the leash, remaining() for what's left.
sidebar:
  order: 4
---

## Introduction

An autonomous agent that can't account for its spend can't be trusted to spend. So every
[`PipRailClient`](/making-payments/piprail-client/) keeps an in-memory ledger of every settled
payment, and exposes three read-only views over it: [`spent()`](#spent--the-full-record) for the
full record, [`budget()`](#budget--the-session-leash) for the session leash, and
[`remaining()`](#remaining--per-asset-headroom) for the headroom per token. The same ledger powers
the lifetime cap — your [`policy.maxTotal`](/spend-controls/payment-policy/) is checked against it
before any on-chain send.

:::note
The ledger is **process-scoped and in-memory** — every figure resets on restart, because the
session *is* the process. There is no database. For crash-loop-resistant limits, supply a
pluggable durable store (the [`isUsed`/`markUsed`](/accepting-payments/replay-protection/) analogue).
:::

## `spent()` — the full record

`client.spent()` returns a `SpendSummary`: the total count, the cumulative spend per distinct
token, and the individual records, in order. It never throws and moves no funds.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

// …after three payments of 0.10 USDC each…
const summary = client.spent()
console.log(summary.count)                      // 3
console.log(summary.byAsset[0].totalFormatted)  // '0.30'
console.log(summary.records[0].url)             // 'https://api.example.com/report'
// → { count: 3, byAsset: [ { symbol: 'USDC', totalFormatted: '0.30', … } ], records: [ … ] }
```

```ts
interface SpendSummary {
  count: number              // total settled payments
  byAsset: SpendAssetTotal[] // cumulative spend per (network, asset)
  records: SpendRecord[]     // every settled payment, in order
}
```

### SpendRecord — one settled payment

| Field | Meaning |
| --- | --- |
| `url` / `host` | The resource paid for, and its hostname. |
| `network` | The chain, as a [CAIP-2](/reference/wire-codecs/) id (e.g. `eip155:8453`). |
| `asset` | The token paid (address or native marker). |
| `amountBase` | Base units paid, already scaled by decimals. |
| `amountFormatted` | Human-readable amount, e.g. `'0.10'`. |
| `symbol` | Token symbol, when known. |
| `ref` | Proof ref — EVM tx hash, Solana signature, TON locator, Stellar tx hash. |
| `at` | ISO timestamp of settlement. |

### SpendAssetTotal — the per-token tally

Aggregation is keyed by `(network, asset)` because summing across different tokens is
unit-meaningless without a price oracle, which the SDK deliberately doesn't add.

```ts
interface SpendAssetTotal {
  network: Caip2
  asset: string
  symbol?: string
  decimals: number
  totalBase: string       // cumulative base units
  totalFormatted: string  // human units, e.g. '0.30'
  count: number           // payments on this pair
}
```

## `budget()` — the session leash

`client.budget()` composes the ledger with your configured policy into a `SessionBudget`: the
time envelope plus the per-asset money leash. This is how a headless (Mode A) agent *sees*
what's left of its consent before paying, rather than discovering it by hitting a decline. It
never throws and moves no funds.

```ts
const b = client.budget()
console.log(b.session.secondsRemaining)        // 540 (or null — no time limit)
console.log(b.byAsset[0].remainingFormatted)   // '0.70' (or undefined — unbounded)
// → { session: { start, expiresAt, secondsRemaining }, byAsset: [ SpendRemaining, … ] }
```

```ts
interface SessionBudget {
  session: {
    start: string                  // session start, ISO
    expiresAt: string | null       // deadline ISO, or null if no time limit
    secondsRemaining: number | null // clamped ≥ 0, or null
  }
  byAsset: SpendRemaining[]        // the money half, per (network, asset)
}
```

The `session` fields carry a real deadline only when the policy configures a [time
envelope](/spend-controls/time-envelope/) (`ttlSeconds` or `expiresAt`); otherwise `expiresAt` and
`secondsRemaining` are `null`. The `byAsset` rows are exactly what `remaining()` returns.

## `remaining()` — per-asset headroom

`client.remaining()` returns one `SpendRemaining` row per `(network, asset)` the ledger has
already seen — the money half of the leash. It's pure and in-memory, never throws, and never
sums across tokens.

```ts
for (const r of client.remaining()) {
  console.log(r.symbol, r.spentBase, r.remainingFormatted)
  // 'USDC' '300000' '0.70'
}
```

```ts
interface SpendRemaining {
  network: Caip2
  asset: string
  symbol?: string
  decimals: number
  spentBase: string          // base units spent so far on this pair
  capBase?: string           // the maxTotal cap, base units (undefined = unbounded)
  remainingBase?: string     // max(0, cap − spent), base units
  remainingFormatted?: string // remainingBase in human units
}
```

The cap fields (`capBase`, `remainingBase`, `remainingFormatted`) are present only when
`policy.maxTotal` is set; with no cap configured the pair is unbounded and they are `undefined`.

:::caution
Decimals are known only after the first spend, so a fresh client with a `maxTotal` set returns
`[]` from `remaining()` (and an empty `byAsset` from `budget()`) **until its first payment** on a
pair. A never-spent token simply isn't a row yet.
:::

## How it feeds the lifetime cap

The ledger isn't only a report — it's the running total the policy checks against. Before any
on-chain send, the client reads the per-asset total from the ledger (`ledger.totalFor`) and passes
it to [`evaluatePolicy()`](/spend-controls/evaluate-policy/) as `spentForAssetBase`; if the new
payment would push it past `policy.maxTotal`, the client refuses with
[`PaymentDeclinedError`](/errors/error-hierarchy/) and no funds move. The same totals back the
rolling-window check ([`windowSeconds` + `windowTotal`](/spend-controls/time-envelope/)), which
scans only records inside the window.

:::note
The thrown error carries a coarse [`reasonCode`](/spend-controls/payment-policy/): a `maxTotal`
breach surfaces as `'BUDGET'`, a `windowTotal` breach as `'OUTSIDE_WINDOW'`. To see the full
breakdown *before* it throws, read [`client.quote(url)`](/making-payments/quote/) — its
`policyCode` carries the finer verdict (`MAX_TOTAL` / `WINDOW_TOTAL`).
:::
