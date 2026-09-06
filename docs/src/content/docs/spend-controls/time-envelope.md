---
title: "The time envelope (Mode A)"
description: 'A spend policy that also bounds time: a session deadline plus a rolling rate-limit window.'
sidebar:
  order: 3
---

## Introduction

The [spend policy](/spend-controls/payment-policy/) caps *amount* and *total*. It can also bound
*time*, and that is what makes **Mode A** work: a headless agent runs free **inside** a budget
and a time envelope, and the policy *is* the consent, with no per-payment approval prompt. It's a
budget that is also a clock.

Two independent leashes, both opt-in. Omit them and behaviour is byte-identical to a time-free
policy.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: {
    maxAmount: '0.10', maxTotal: '5.00', tokens: ['USDC'],
    ttlSeconds: 3600,                          // the whole session expires in 1h
    windowTotal: '1.00', windowSeconds: 600,   // …and ≤ 1.00 USDC per rolling 10 minutes
  },
})
```

## The session deadline: `ttlSeconds` / `expiresAt`

A session deadline is a hard stop. Past it, **every** payment is refused, even a zero-amount or
under-cap one, because expiry is amount-blind and checked first. It's a headless agent's time
leash: spend dies when the clock runs out.

```ts
policy: { ttlSeconds: 3600 }   // dies 1 hour after client construction
```

The deadline is relative to **session start**, which is when you construct the client. State is
in-memory and **resets on restart**, because the session *is* the process. For crash-loop-resistant
limits, supply a pluggable durable store (the `isUsed` / `markUsed` analogue).

`expiresAt` sets the same deadline absolutely, as epoch **milliseconds** (matching `Date.now()`):

```ts
policy: { expiresAt: Date.now() + 3_600_000 }   // SDK-only; pass milliseconds
```

| Field | Units | Notes |
| --- | --- | --- |
| `ttlSeconds` | seconds, relative to session start | Positive safe integer; also the MCP's `PIPRAIL_TTL` knob. |
| `expiresAt` | epoch milliseconds (absolute) | SDK-only, with no MCP env knob. Not auto-corrected from seconds. |

When both are set, the **earlier** deadline wins.

:::caution
`expiresAt` is milliseconds, not seconds, and is **not** auto-corrected. A small value expires
immediately by design: `expiresAt: 3600` is the year 1970, not "an hour from now". Use
`ttlSeconds` for a relative leash, or `Date.now() + ms` for an absolute one.
:::

A payment past the deadline throws [`PaymentDeclinedError`](/errors/error-hierarchy/) with
**`reasonCode: 'SESSION_EXPIRED'`**, before any funds move. This is **terminal, so don't retry**:
the session is over, and the next payment will be refused too.

```ts
import { PipRailClient, PaymentDeclinedError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { ttlSeconds: 3600 },
})
const url = 'https://api.example.com/report'

try {
  await client.fetch(url)
} catch (e) {
  if (e instanceof PaymentDeclinedError && e.reasonCode === 'SESSION_EXPIRED') {
    // terminal: the session's time leash has elapsed; start a fresh client
  } else {
    throw e
  }
}
```

## The rolling window: `windowTotal` / `windowSeconds`

The window is a rate limit layered on top of the lifetime `maxTotal`: at most `windowTotal` of a
given asset may be spent within any trailing `windowSeconds`. It's enforced **per (network,
asset)**, the same per-distinct-asset scoping as `maxTotal`, because summing across tokens is
unit-meaningless without a price oracle (which the SDK deliberately omits).

```ts
policy: { windowTotal: '1.00', windowSeconds: 600 }   // ≤ 1.00 USDC per rolling 10 min
```

A payment that would push spend within the last `windowSeconds` past the cap throws
[`PaymentDeclinedError`](/errors/error-hierarchy/) with **`reasonCode: 'OUTSIDE_WINDOW'`**. Unlike
a session expiry, this is **recoverable**: wait for the window to free up (older spend ages out),
or raise `windowTotal`.

:::caution
The window needs **both** `windowTotal` and `windowSeconds`, or neither. Setting one without the
other is a config error and throws a `TypeError` at construction, because a security leash can't be
silently half-armed. `windowSeconds` must be a positive integer.
:::

## Read the leash before paying with `client.budget()`

`budget()` returns a read-only [`SessionBudget`](/spend-controls/spend-ledger/): the time envelope
plus the per-asset money leash. A Mode A agent reads this to *see* its remaining runway rather than
discovering the limit by hitting a decline.

```ts
const b = client.budget()
// → {
//     session: { start, expiresAt, secondsRemaining },  // ISO strings; null fields when no deadline
//     byAsset: [ /* one SpendRemaining row per (network, asset) the ledger has seen */ ],
//   }
```

`client.remaining()` returns just the `byAsset` half: the per-(network, asset) remaining cap, as
a `SpendRemaining[]`. A pair only appears once it's been spent on (the SDK learns the token's
decimals from the first payment), so a never-spent asset simply isn't a row, and a fresh client
with a `maxTotal` returns `[]` until its first payment.

The time envelope also surfaces on every [`PaymentPlan`](/making-payments/plan-payment/) as
`plan.session`, present only when a deadline is configured, so the same plan you check for funds
also shows the clock:

```ts
const plan = await client.planPayment(url)
if (plan?.session) {
  console.log(plan.session.secondsRemaining)   // number | null: seconds left on the session
}
```

## How the guards interleave

Every payment is evaluated against the whole policy in a pinned, first-failure-wins order, so the
refusal is specific. Session expiry runs **first** because it's session-global, not asset-scoped.
An expired session always reports expiry, never some other gate that happens to also fail.

```text
session expiry → chains → hosts → unknown-token → tokens → maxAmount → maxTotal → maxTotalPerDenom → maxPayments → windowTotal → maxPaymentsPerWindow
```

Both time guards collapse to a single decline `reasonCode` on the client, distinct from the
amount-based codes:

| Configured by | Decline `reasonCode` | Retry? |
| --- | --- | --- |
| `ttlSeconds` / `expiresAt` | `SESSION_EXPIRED` | No, terminal. |
| `windowTotal` + `windowSeconds` | `OUTSIDE_WINDOW` | Yes, once the window frees, or raise the cap. |

:::note
That `reasonCode` is the *coarse* code a `catch` sees on `PaymentDeclinedError` (a
[`DeclineReasonCode`](/errors/error-hierarchy/)). The read-only `quote.policyCode` (a finer
[`PolicyDenyCode`](/spend-controls/evaluate-policy/)) names the exact guard: `SESSION_EXPIRED`
passes through unchanged, while the rolling window's `WINDOW_TOTAL` maps to `OUTSIDE_WINDOW`.
:::

See [Evaluate policy](/spend-controls/evaluate-policy/) for the pure decision function behind
these checks, and [Why payments fail](/errors/why-payments-fail/) for branching on every
`reasonCode`. The MCP exposes the relative `PIPRAIL_TTL` knob, the rolling window via
`PIPRAIL_WINDOW_TOTAL` + `PIPRAIL_WINDOW_SECONDS` (set both together or neither), and a
`piprail_budget` tool; see [MCP modes](/mcp/modes/). Only `expiresAt` is genuinely SDK-only
(no MCP env knob).
