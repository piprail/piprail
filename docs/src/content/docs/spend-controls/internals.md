---
title: Internals & hardening
description: 'The engineering record for the spend-controls layer: the data model, the exact-precision math, every guard and why it exists.'
sidebar:
  order: 7
---

This page is the **engineering record** for the spend-controls layer, written for users and
agents who want the exact semantics, and for **us** (the maintainers) as the canonical account of
*why* each guard exists and *where* it's proven. If you're just setting a budget, start at
[Payment policy](/spend-controls/payment-policy/) and [Total budget](/spend-controls/total-budget/);
come here when you need the guarantees, the edge cases, or the threat model.

## The shape of it

Three pure, chain-agnostic modules, layered so the protocol never touches a chain SDK:

| Module | Responsibility |
|---|---|
| [`policy.ts`](https://github.com/piprail/piprail/blob/main/sdk/src/policy.ts) | `PaymentPolicy` + the pure `evaluatePolicy()` decision + `denomOf`/`scaleToDenom` |
| [`ledger.ts`](https://github.com/piprail/piprail/blob/main/sdk/src/ledger.ts) | `SpendLedger`, the tally (per-asset, per-denomination, count) + optional durable store |
| [`spendstore.ts`](https://github.com/piprail/piprail/blob/main/sdk/src/spendstore.ts) | the `SpendStore` seam + `memorySpendStore`; `fileSpendStore` lives in `@piprail/sdk/node` |

The **client** is the only stateful piece: it builds a `PaymentIntent` from the chosen 402
accept, asks `evaluatePolicy()` for a verdict **before any send**, and records a settled payment
into the ledger after. `evaluatePolicy()` itself is pure (no clock, no I/O), so the client injects a
context (`now`, the pre-sliced window totals, the running denom total, the counts) so the function
stays deterministic and unit-testable.

## The decision order (pinned, first-failure-wins)

```
session expiry → chains → hosts → unknown-token → tokens →
maxAmount → maxTotal → maxTotalPerDenom → maxPayments →
windowTotal → maxPaymentsPerWindow
```

Pinned so a refusal reports a **specific, stable** cause. Expiry is first because it's session-global
(an expired session must always report expiry, never some other gate that also happens to fail). The
grand-total and count caps come *after* the per-asset caps so the most-specific money cap is reported
first. Every guard maps to a typed [`PolicyDenyCode`](/errors/error-hierarchy/), which the client
collapses to the coarser `DeclineReasonCode` on the thrown `PaymentDeclinedError`.

## Exact-precision math (no floats, ever)

All amounts are `bigint` base units. Caps are decimal **strings** parsed with the token's TRUE
decimals (the SDK's own, never the server's `extra.decimals`) so a lying server can't understate a
price. The cross-token grand total sums in a **fixed-point accumulator** at `DENOM_PRECISION`
decimals: each payment contributes `amountBase × 10^(DENOM_PRECISION − decimals)`, so tokens with
*different* decimals (USDC 6dp + USD1 18dp) add up **exactly** with no floating-point drift.

`DENOM_PRECISION` is pinned to `MAX_DECIMALS` (100) **on purpose**; see the bypass below.

## Metered `upto` rails: MAX vs actual

The metered [`upto` rail](/accepting-payments/upto-rail-seller/) records two numbers per payment. The
buyer signs a **maximum**; the merchant self-settles the **actual** usage (≤ that max). The cap
accounting always charges the **authorized MAX** ([`SpendRecord.amountBase`](/spend-controls/spend-ledger/))
and never the merchant's self-reported actual, so an under-reporting merchant **cannot** loosen
`maxTotal` / `maxTotalPerDenom` / `windowTotal` / the count caps. The true actual is kept
**informationally** on [`settledBase`](/spend-controls/spend-ledger/) (clamped to ≤ the max) and never
feeds a cap. Counting the MAX is the security property: the leash binds to what the buyer
*authorized*, not what the merchant *claimed*.

## Security & robustness invariants

The spend policy is a security boundary; it was hardened against an adversarial review that
attacked it from eight angles (negatives, overflow, memory, denomination edge cases, persistence,
shared-ledger races, validation bypass, and the MCP env layer). The invariants it must hold:

### 1. A budget is measured against the TRUE token, never the server's claim
`maxAmount`/`maxTotal`/`maxTotalPerDenom` use the SDK's own decimals + symbol (via `describeAsset`).
A server that states `decimals: 9` for real-6dp USDC, or labels the amount `"0.005"` while the wire
says `5000000`, is priced at the **true** value and the cap bites. (Proven: `03-policy`, `17`.)

### 2. Amounts are non-negative integers, so negatives/decimals/junk are rejected
The wire amount must match `^\d+$`. A negative (`"-5"`), fractional (`"0.5"`), exponential (`"1e6"`),
or non-numeric amount is a [`InvalidEnvelopeError`](/errors/error-hierarchy/), so it can never reach the
ledger to "refund" a budget. A **zero** amount is legal: it settles, bumps the count, and adds nothing
to a denomination total. (Proven: `client-spend-controls`, `17`.)

### 3. Absurd `decimals` can't exhaust memory (OOM/DoS guard)
A hostile 402 for an unrecognised token (under `allowUnknownTokens`) could state `decimals: 1e9`;
pricing it would make `padStart`/`padEnd` allocate a multi-GB string. `MAX_DECIMALS` (100, generous
headroom over NEAR's 24dp, the deepest real token) bounds it at **two** layers: the envelope rejects a
quote stating more, and `assertValidDecimals` is the chokepoint backstop for all amount math. (Proven:
`units`, `17`.)

### 4. A denomination cap can't be ESCAPED with deep decimals, so it fails closed
*The subtle one.* The grand-total accumulator skips a token it can't scale (decimals >
`DENOM_PRECISION`). If `DENOM_PRECISION` were below `MAX_DECIMALS`, a token labelled `USDC` with
`decimals: 25` would be **silently excluded** from the USD total, slipping spend past the cap while
`budget()` showed `0`. Two defenses: `DENOM_PRECISION === MAX_DECIMALS` (so every priceable token is
summable), **and** `evaluatePolicy` **refuses** (never skips) a denomination-capped token it can't
scale. (Proven: `client-spend-controls` "GRAND-TOTAL BYPASS regression".)

### 5. Reads never throw; the ledger is crash-safe against a poisoned store
A `SpendStore` is **caller-owned**, so a tampered, corrupt, or future-version JSONL file can carry
anything. The ledger **validates every hydrated record** (`amountBase` a non-negative integer string,
`decimals` an integer in `[0, MAX_DECIMALS]`) and **skips** the corrupt ones; a non-string `denom` is
coerced to "no denomination" (the record still tallies per-asset). So a poisoned line can never throw
`BigInt(…)`/`formatUnits(…)`/`denom.toUpperCase(…)` out of construction, and `spent()`/`budget()`/
`summary()` **never throw** (ERRORS.md). `fileSpendStore` separately skips non-JSON lines. A bad
timestamp fails **closed**: an unparseable `at` is counted *toward* the rolling window, never silently
dropped from the cap. (Proven: `ledger-spend-controls` "crash-safe against a POISONED store", `node-spendstore`.)

### 6. Concurrency is best-effort by design (documented, not hidden)
`maxTotal`, `maxTotalPerDenom`, and the count caps are checked against spend recorded *so far*; many
payments in flight at once can race past a cap. Agents that need a hard concurrent ceiling should
serialise (the common case is sequential `await`ed calls). PipRail ships no reservation system; it
would cost more simplicity than it's worth (STANDARDS §7).

## Memory characteristics

The lifetime aggregates are **incremental and O(1) per payment**: the per-`(network,asset)` buckets,
the per-denomination totals, and the count are each updated on `record()` and never rescanned. Only
the rolling-**window** reads (`totalSince`/`countSince`) are an O(n) linear scan over the records
array, and they run **only** when a window cap is configured. The records array itself grows with the
number of settled payments (it's the in-memory audit log); a 100k-payment session tallies exact
totals in tens of milliseconds (proven in suite `17`). For a very-long-lived process, back the ledger
with a [`spendStore`](/spend-controls/persistence/) and treat the durable log as the system of record.

## Charter reconciliation: still no price oracle

The cross-token grand total is a **unit-of-account sum**, not a market read. PipRail never fetches a
price and never converts a volatile coin: a token's denomination is a static, ship-time label
(`BUILTIN_DENOMS`, extensible via `denomFor`), and the total simply adds up tokens you've declared as
one unit, each counted 1:1. Native coins and unrecognised tokens have **no** denomination and are
never in a bucket. No backend, no database, no fee: the same charter the rest of PipRail holds.

## Where every invariant is proven

| Surface | Proves |
|---|---|
| `sdk/test/policy-spend-controls.test.ts` | the pure decision: denom sum, count caps, pinned order, deny codes |
| `sdk/test/ledger-spend-controls.test.ts` | denom accumulation, counts, store hydrate/append, **poisoned-store crash-safety**, fail-closed `at` |
| `sdk/test/client-spend-controls.test.ts` | end-to-end enforcement, events, persistence, shared-ledger cross-chain, **the bypass + OOM regressions** |
| `sdk/test/node-spendstore.test.ts` | `fileSpendStore` round-trip + hostile-line hydration |
| `sdk/test/units.test.ts` | the `MAX_DECIMALS` OOM bound |
| `examples/basics/sdk-sandbox/suites/17-spend-controls.mjs` | the **living, runnable** gauntlet: every feature + the full adversarial matrix + a 100k-payment memory stress (`npm run spend-controls`) |

Run the whole thing: `cd examples/basics/sdk-sandbox && npm run spend-controls` (or `npm test` for
all 17 suites). It imports the working-tree build, so it always tests the code in this repo.
