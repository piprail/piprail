---
title: The spend ledger
description: The in-memory tally of everything a client has paid — spent() for the record, budget() for the leash, remaining() for what's left.
sidebar:
  order: 5
---

## Introduction

An autonomous agent that can't account for its spend can't be trusted to spend. So every
[`PipRailClient`](/making-payments/piprail-client/) keeps an in-memory ledger of every settled
payment, and exposes three read-only views over it: [`spent()`](#spent--the-full-record) for the
full record, [`budget()`](#budget--the-session-leash) for the session leash, and
[`remaining()`](#remaining--per-asset-headroom) for the headroom per token. The same ledger powers
the lifetime cap — your [`policy.maxTotal`](/spend-controls/payment-policy/) is checked against it
before any on-chain send.

When you cap by [cross-token grand total or payment count](/spend-controls/total-budget/)
(`maxTotalPerDenom`, `maxPayments`, …), the same ledger surfaces those leashes too:
[`budget().byDenom`](#budgetbydenom--the-grand-total-leash) and
[`budget().counts`](#budgetcounts--the-payment-count-leash) (with the standalone
[`denomRemaining()`](#denomremaining--and-countstatus) / [`countStatus()`](#denomremaining--and-countstatus)
readers), plus [`spent().byDenom`](#spentbydenom--the-grand-total-tally) and
[`client.policy()`](#policy--read-the-policy-back).

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
  byDenom: SpendDenomTotal[] // cumulative spend per denomination (USD, EUR, …)
  records: SpendRecord[]     // every settled payment, in order
}
```

### SpendRecord — one settled payment

| Field | Meaning |
| --- | --- |
| `url` / `host` | The resource paid for, and its hostname. |
| `network` | The chain, as a [CAIP-2](/reference/wire-codecs/) id (e.g. `eip155:8453`). |
| `asset` | The token paid (address or native marker). |
| `amountBase` | Base units that count against the caps — for the [metered `upto` rail](/accepting-payments/upto-rail-seller/) this is the **authorized MAX**, not the merchant's claimed actual. |
| `amountFormatted` | Human-readable `amountBase`, e.g. `'0.10'`. |
| `settledBase` | Merchant-claimed settled **actual** (upto rail only), clamped to ≤ `amountBase`. **Informational** — it does **not** feed the caps. Absent for `onchain-proof` / `exact` rails (where actual = amount). |
| `settledFormatted` | Human-readable `settledBase`, when present. |
| `symbol` | Token symbol, when known. |
| `decimals` | Token decimals, when known — so a [durable store](/spend-controls/persistence/) rebuilds totals on reload without a second spend. |
| `denom` | The token's [denomination](/spend-controls/total-budget/) (`'USD'`, `'EUR'`, …), when it has one — `undefined` for native + unrecognised tokens. |
| `ref` | Proof ref — EVM tx hash, Solana signature, TON locator, Stellar tx hash. |
| `at` | ISO timestamp of settlement. |

The new `decimals` + `denom` fields are what let a [`SpendStore`](/spend-controls/persistence/)
replay the ledger and rebuild both the per-asset totals **and** the cross-token grand total exactly,
without waiting for the first live spend on a pair.

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

### `spent().byDenom` — the grand-total tally

When tokens share a [denomination](/spend-controls/total-budget/), `byDenom` rolls them into one
unit-of-account line — USDC + USDT + FDUSD + U all land in `USD`. It's the **sum the
[`maxTotalPerDenom`](/spend-controls/total-budget/) cap is checked against**, not a priced figure:
each token is counted 1:1 as the unit you labelled it. Native coins and unrecognised tokens have no
denomination, so they're never in a row here.

```ts
const summary = client.spent()
summary.byDenom[0] // → { denom: 'USD', totalFormatted: '0.30', count: 3, … }
```

```ts
interface SpendDenomTotal {
  denom: string           // the unit of account, e.g. 'USD'
  totalScaled: string     // cumulative value at the DENOM_PRECISION fixed point, as a string
  totalFormatted: string  // human units, e.g. '0.30'
  count: number           // payments rolled into this denomination
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
// → { session: {…}, byAsset: [ SpendRemaining, … ], byDenom: [ DenomRemaining, … ], counts: { … } }
```

```ts
interface SessionBudget {
  session: {
    start: string                  // session start, ISO
    expiresAt: string | null       // deadline ISO, or null if no time limit
    secondsRemaining: number | null // clamped ≥ 0, or null
  }
  byAsset: SpendRemaining[]        // the money half, per (network, asset)
  byDenom: DenomRemaining[]        // the cross-token grand-total leash, per denomination
  counts: CountStatus              // the payment-count leash
}
```

The `session` fields carry a real deadline only when the policy configures a [time
envelope](/spend-controls/time-envelope/) (`ttlSeconds` or `expiresAt`); otherwise `expiresAt` and
`secondsRemaining` are `null`. The `byAsset` rows are exactly what `remaining()` returns.

### `budget().byDenom` — the grand-total leash

One row per [denomination](/spend-controls/total-budget/) you've capped with `maxTotalPerDenom`.
Unlike `byAsset`, these rows are present **from the start, before any spend** — the cap is a single
declared number, not a per-token total that has to be discovered — so a headless agent can preview
its full headroom up front.

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxTotalPerDenom: { USD: '20.00' } },
})

client.budget().byDenom
// [{ denom: 'USD', spentFormatted: '0', capFormatted: '20', remainingFormatted: '20', fraction: 0 }]
```

```ts
interface DenomRemaining {
  denom: string              // the unit of account, e.g. 'USD'
  spentFormatted: string     // human units spent so far across every token of this unit
  capFormatted: string       // the maxTotalPerDenom cap, human units
  remainingFormatted: string // max(0, cap − spent), human units
  fraction: number           // spent / cap, in [0, 1]
}
```

### `budget().counts` — the payment-count leash

The [payment-count caps](/spend-controls/total-budget/#cap-the-number-of-payments)
(`maxPayments`, `maxPaymentsPerWindow`) need no oracle, so `counts` always reflects every settled
payment across every chain and token — including native coins. The cap and remaining fields appear
only for the caps you configured.

```ts
client.budget().counts
// { settled: 3, lifetimeCap: 100, lifetimeRemaining: 97, windowCap: 10, windowSettled: 3, windowRemaining: 7 }
```

```ts
interface CountStatus {
  settled: number            // total settled payments, all chains + tokens
  lifetimeCap?: number       // maxPayments, when set
  lifetimeRemaining?: number // max(0, lifetimeCap − settled)
  windowCap?: number         // maxPaymentsPerWindow, when set
  windowSettled?: number     // settled payments inside the current rolling window
  windowRemaining?: number   // max(0, windowCap − windowSettled)
}
```

### `denomRemaining()` and `countStatus()`

Both leashes are also reachable directly, without the rest of the budget — handy when you only need
one half:

```ts
client.denomRemaining() // → DenomRemaining[], same rows as budget().byDenom
client.countStatus()    // → CountStatus, same as budget().counts
```

Both are pure, in-memory, and never throw.

## `policy()` — read the policy back

`client.policy()` returns the configured [`PaymentPolicy`](/spend-controls/payment-policy/) (or
`undefined` if none was set), so an agent can introspect its own consent — what it's *allowed* to do
— alongside `budget()`'s view of what's *left*. It's also on
[`MultiChainPayer`](/making-payments/multi-chain/) and is part of the shared `PayingClient`
interface.

```ts
const p = client.policy()
console.log(p?.maxTotalPerDenom) // { USD: '20.00' }
console.log(p?.maxPayments)      // 100
```

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
pair. A never-spent token simply isn't a row yet. (The cross-token
[`byDenom`](#budgetbydenom--the-grand-total-leash) leash is different: its cap is a declared number,
so those rows are present **from the start**.)
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
