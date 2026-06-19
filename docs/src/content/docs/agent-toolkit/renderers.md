---
title: Natural-language renderers
description: Three pure one-line English renderers that turn a plan, a decline, or a spend report into a sentence an LLM can read and act on.
sidebar:
  order: 3
---

## Introduction

An autonomous LLM reasons over text, not JSON. The renderers turn the SDK's three structured
value objects — a [`PaymentPlan`](/making-payments/plan-payment/), a thrown
[`PipRailError`](/errors/error-model/), and a [`SpendSummary`](/spend-controls/spend-ledger/) —
into **one model-readable English line each**, so a model gets a sentence it can act on instead
of a blob it has to interpret.

All three are **pure**: zero I/O, zero chain libraries. They compose only fields the SDK already
shipped — they invent no data and never call the network — so the line you print is always
exactly what the structured object already said.

```ts
import { summarizePlan, explainDecline, formatSpendReport } from '@piprail/sdk'
```

## summarizePlan(plan)

Render a `PaymentPlan` (or `null`) as one line: what's payable, on which chain, the gas, and how
many other rails aren't settleable. It accepts `null` directly, so you can hand it the result of
[`planPayment()`](/making-payments/plan-payment/) (which returns `PaymentPlan | null`) without a
guard:

```ts
import { PipRailClient, summarizePlan } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'
const plan = await client.planPayment(url) // PaymentPlan | null
console.log(summarizePlan(plan))
// → "Payable: 0.10 USDC on eip155:8453 (gas ~0.00002 ETH). 2 other rail(s) not settleable."
```

The three branches it renders:

| Plan | Line |
| --- | --- |
| `null` (URL not gated) | `No payment required — the URL is not payment-gated.` |
| `payable` with a `best` rail | `Payable: <amount> <symbol> on <network> (gas ~<fee> <feeSymbol>).` plus a count of other rails. |
| not payable | `NOT payable: <fundingHint>` (or `no settleable rail on <network>`). |

The amount, symbol, network, and gas come straight off `plan.best.quote` and `plan.best.cost`;
the trailing `N other rail(s) not settleable` is `plan.options.length - 1`. Gas is shown in the
chain's native coin (ETH/SOL/TRX/…), never in fiat — PipRail has no price oracle. This is the
sentence you hand a model after [`planPayment()`](/making-payments/plan-payment/) so it can
decide whether to call [`fetch()`](/making-payments/fetch-and-autoroute/).

## explainDecline(err)

Render any caught failure as one line a model can act on. For a `PipRailError` it switches on the
stable [`.code`](/errors/error-model/); for anything else (including any code not listed below) it
falls back to `Payment failed: <message>`.

```ts
try {
  await client.fetch(url)
} catch (err) {
  console.log(explainDecline(err))
  // → "The wallet cannot cover the payment + gas — top up the payer (token and/or native gas) and retry."
}
```

What each code renders:

| `.code` | Rendered guidance |
| --- | --- |
| `PAYMENT_DECLINED` | The error's own message (a policy reason, approval decline, or session-expiry text — already human). |
| `INSUFFICIENT_FUNDS` | Top up the payer (token and/or native gas) and retry. |
| `RECIPIENT_NOT_READY` | The message **plus** that the fix is on the **recipient** (trustline / registration / opt-in / activation), not your balance. |
| `NO_COMPATIBLE_ACCEPT` / `UNSUPPORTED_SCHEME` | The thrown message verbatim — it already says whether you're on the wrong chain or need to enable the `exact` scheme. |
| `PAYMENT_TIMEOUT` / `MAX_RETRIES_EXCEEDED` / `CONFIRMATION_TIMEOUT` | The message **plus the never-re-pay rule** (below). |

Any other code (e.g. `INVALID_ENVELOPE`, `SETTLEMENT_FAILED`) falls through to
`Payment failed: <message>`, so the model still gets the original message rather than nothing.

### The never-re-pay rule

The three broadcast-but-unconfirmed codes — `PAYMENT_TIMEOUT`, `MAX_RETRIES_EXCEEDED`,
`CONFIRMATION_TIMEOUT` — mean the payment may already be on-chain; the SDK just didn't see it
confirm in time. For all three, the rendered line carries the load-bearing recovery instruction:

```text
… Recover using the proof on .ref (re-verify or re-submit it); never re-pay — a fresh payment would double-spend.
```

:::danger
On these three codes, **do not retry by paying again** — a fresh payment would double-spend.

When you handle the error in code, the proof ref is on `.ref` for `PaymentTimeoutError` and
`MaxRetriesExceededError` only (re-verify or re-submit it). `ConfirmationTimeoutError` carries
**no `.ref`** — re-check the proof ref you already broadcast. The rendered line states the rule in
English so a model that reads only the sentence still does the safe thing.
:::

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    console.log('Recover this proof — never re-pay:', err.ref) // .ref lives on these two classes
  }
  console.log(explainDecline(err)) // always safe: one English line for the model
}
```

## formatSpendReport(summary)

Render `client.spent()` — the spend ledger — as one line, broken out per `(network, asset)`,
then **appends a cross-token grand total per denomination** when one is present. There is still
**no price oracle**: a denomination total is a *unit-of-account sum* — it adds up every token the
caller has grouped as one unit (e.g. USDC + USDT + PYUSD as `USD`) 1:1, never a price-converted
figure, and never folds in a native coin or an unknown token (those have no denomination).

```ts
import { formatSpendReport } from '@piprail/sdk'

console.log(formatSpendReport(client.spent()))
// → "0.30 USDC on eip155:8453 (3 payments); 0.05 USDT on solana:5eykt4Us… (1 payment) — grand total: 0.35 USD total"
```

A ledger with `count === 0` renders `No payments yet.`; otherwise each `byAsset` row becomes
`<total> <symbol> on <network> (<n> payment(s))`, joined with `; `. Then, for each row in
`summary.byDenom` (a `SpendDenomTotal[]` of `{ denom, totalScaled, totalFormatted, count }`), it
appends ` — grand total: <totalFormatted> <denom> total`. With no denominated spend, `byDenom`
is empty and the line ends after the per-asset breakdown, exactly as before.

The denomination grouping is driven by the policy's built-in units — `USDC`, `USDT`, `USD1`,
`FDUSD`, `RLUSD` fold into `USD`, `EURC` into `EUR` — extensible per client via
[`denomFor`](/spend-controls/total-budget/). When several clients share a ledger
(`MultiChainPayer.fromWallets` or a shared `spendStore`), the grand total spans every chain. It
is the read-side mirror of the
[`maxTotalPerDenom`](/spend-controls/total-budget/) cap.

:::note
By default spend totals are **in-memory for this process** and reset on restart — a convenience
for an agent to account for its own session. Pass a
[`spendStore`](/spend-controls/spend-ledger/) (e.g. `fileSpendStore(path)`) to make them survive
a restart; the store is caller-owned, never a backend. See
[the spend ledger](/spend-controls/spend-ledger/) for the underlying `SpendSummary`.
:::

## Wiring them into a tool

These three lines are what make a budget-bound client legible across a tool boundary. The
[MCP server](/mcp/tools/) returns `summarizePlan` and `formatSpendReport` output in its tool
responses, and `explainDecline` on a thrown failure, so the model on the other end reads a
sentence rather than parsing the structured object itself. See the
[payment tools](/agent-toolkit/payment-tools/) for how a self-hosted toolkit does the same.
