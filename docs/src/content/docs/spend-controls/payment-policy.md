---
title: Payment policy
description: The budget guard that makes autonomous payment safe — per-payment and lifetime ceilings plus chain, token, and host allowlists, enforced by the SDK before any on-chain send.
sidebar:
  order: 1
---

## Introduction

A `PaymentPolicy` is the spend leash on an autonomous client. You set it once at construction,
and from then on every 402 the client meets is checked against it **before any on-chain send**.
A payment that breaches the policy is refused with [`PaymentDeclinedError`](/errors/error-hierarchy/)
and no funds move — so a server you don't control cannot drain the wallet.

The enforcement is local and the SDK is the judge. A cap is measured against the token's **true
decimals** (the SDK's own, via the driver) — never the server-stated `extra.decimals` — so a
malicious server can't slip past a `maxAmount` by claiming a cheap-looking amount.

## Setting a policy

Pass `policy` to the [`PipRailClient`](/making-payments/piprail-client/). With one set, the client
only spends inside the lines you draw:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
  policy: {
    maxAmount: '0.50',          // per payment
    maxTotal: '10.00',          // lifetime, per asset
    tokens: ['USDC'],           // single-currency budget
    hosts: ['*.example.com'],   // only this domain
  },
})
```

Omit `policy` entirely for the unguarded default. A policy is opt-in, but recommended for any
headless agent — it is the difference between "the model can spend the wallet" and "the model
can spend up to here."

## Fields

Every field is optional. An unset field places no limit; the checks you do set run in a pinned
order, first-failure-wins, so the refusal reason is specific.

| Field | Type | Limits |
| --- | --- | --- |
| `maxAmount` | `string` | Per-payment ceiling (human units, e.g. `'0.10'`). |
| `maxTotal` | `string` | Lifetime ceiling for this client, **per distinct asset**. |
| `chains` | `ChainSelector[]` | Allowlist of chains the agent may pay on. |
| `tokens` | `string[]` | Allowlist of token symbols, or the alias `'native'`. |
| `hosts` | `string[]` | Allowlist of hosts — exact or `*.` wildcard. |
| `allowUnknownTokens` | `boolean` | Pay a token the SDK can't price? Default `false`. |
| `ttlSeconds` | `number` | Session time-to-live (see [Time envelope](/spend-controls/time-envelope/)). |
| `expiresAt` | `number` | Absolute session deadline, epoch ms. |
| `windowTotal` | `string` | Rolling-window spend cap, per asset. |
| `windowSeconds` | `number` | Width of that rolling window, in seconds. |

## The money caps — `maxAmount` and `maxTotal`

`maxAmount` bounds a single payment; `maxTotal` bounds the running total over the life of the
client. Both are human-readable strings, floored to the token's true decimals.

```ts
policy: { maxAmount: '0.25', maxTotal: '5.00' }
```

`maxTotal` is tracked **per distinct asset** (network + asset), not summed across tokens —
adding 1 USDC to 1 SOL is unit-meaningless without a price oracle, which the SDK deliberately
doesn't ship. Each token gets its own running cap. For a single-currency budget, pair `maxTotal`
with a one-token allowlist:

```ts
policy: { maxTotal: '20.00', tokens: ['USDC'] }   // 20 USDC, full stop
```

The running totals live in the [spend ledger](/spend-controls/spend-ledger/), which is
process-scoped: every figure resets on restart. Shipping a fleet or a long-lived service? See
[Running in production](/getting-started/running-in-production/) for what's in-memory and how to
make it durable.

## The allowlists — `chains`, `tokens`, `hosts`

Three allowlists narrow *where* and *what* the agent may pay. A 402 outside any of them is
refused.

```ts
policy: {
  chains: ['base', 'polygon'],
  tokens: ['USDC', 'USDT'],
  hosts: ['api.example.com', '*.trusted.dev'],
}
```

- **`chains`** — string entries match the configured selector (an EVM preset like `'base'` or a
  family name like `'solana'`); object selectors (a viem `Chain` or `{ id, rpcUrl }`) match by
  resolved network id.
- **`tokens`** — matched against the token's **true symbol**. The special value `'native'` is a
  chain-agnostic alias for the chain's native coin — it matches ETH, BNB, TRX, XLM, and so on
  without naming the ticker, mirroring the merchant-side `token: 'native'`.
- **`hosts`** — exact (`api.example.com`) or wildcard (`*.example.com`, which also matches the
  bare apex `example.com`).

## Unknown tokens

A token the SDK can't recognise has no verifiable decimals, so PipRail can't safely measure it
against a cap. By default such a payment is **refused** — even with no other limit set — with the
typed code `UNKNOWN_TOKEN`.

```ts
policy: { allowUnknownTokens: true }   // explicit, opt-in risk
```

Set `allowUnknownTokens: true` to trust the server-stated decimals and pay anyway. This is the
one knob that loosens the guard rather than tightening it; leave it off unless you mean it.

:::caution
With `allowUnknownTokens` on, the server's claimed decimals are taken on trust — which is exactly
the lever a `maxAmount` cap defends against. Combine it with a tight `tokens` allowlist so the
relaxation applies only to assets you actually expect.
:::

## The time envelope

Four more fields put the policy on a clock. `ttlSeconds` and `expiresAt` set a session deadline
after which **every** payment is refused regardless of amount; `windowTotal` + `windowSeconds`
add a rolling rate limit on top of `maxTotal`. They have their own page:

```ts
policy: { ttlSeconds: 3600, windowTotal: '1.00', windowSeconds: 60 }
```

The rolling window requires **both** fields together — setting one without the other is a config
error the client rejects at construction. See [Time envelope](/spend-controls/time-envelope/) for
the full treatment.

## Seeing the verdict without paying

You don't have to attempt a payment to learn whether the policy would allow it. Both the
read-only check and the live [quote](/making-payments/quote/) carry the verdict, so an agent can
branch on it. `quote()` returns `null` when the URL isn't payment-gated, so null-guard it:

```ts
const url = 'https://api.example.com/report'
const quote = await client.quote(url)

if (!quote) {
  // not payment-gated — nothing to check
} else if (!quote.withinPolicy) {
  console.log(quote.policyReason)   // human-readable
  console.log(quote.policyCode)     // typed: 'MAX_AMOUNT' | 'CHAIN' | …
}
// → quote.policyCode is a PolicyDenyCode (see the table below) | undefined when within policy
```

[`planPayment()`](/making-payments/plan-payment/) folds the same verdict into its per-rail
analysis — a policy breach shows as the `OUTSIDE_POLICY` blocker (or `OUTSIDE_WINDOW` for the
time envelope). And [`client.budget()`](/spend-controls/spend-ledger/) reports the remaining
allowance per asset plus any time leash, so a Mode-A agent can see how much room it has left.

## Refusal codes

When the policy refuses, the typed `policyCode` says exactly which guard fired — no prose-parsing
required. This is the `PolicyDenyCode` enum, carried on `quote.policyCode` (and re-exposed via the
[testable `evaluatePolicy()` core](/spend-controls/evaluate-policy/)).

| Code | Guard |
| --- | --- |
| `CHAIN` | Chain not in `chains`. |
| `HOST` | Host not in `hosts`. |
| `UNKNOWN_TOKEN` | Unrecognised token and `allowUnknownTokens` is off. |
| `TOKEN` | Symbol not in `tokens`. |
| `MAX_AMOUNT` | Payment exceeds `maxAmount`. |
| `MAX_TOTAL` | Payment would push the per-asset total past `maxTotal`. |
| `SESSION_EXPIRED` | The session deadline has passed. |
| `WINDOW_TOTAL` | Payment would exceed `windowTotal` within the window. |

Checks run in this order — session expiry → chains → hosts → unknown-token → tokens → maxAmount
→ maxTotal → windowTotal — with the first failure winning. Expiry is checked first because it's
session-global: an expired session always reports expiry, not whichever cap also happens to fail.

## Catching a refusal

When a payment actually breaches the policy, the client throws
[`PaymentDeclinedError`](/errors/error-hierarchy/) **before any on-chain send** — `.code` is
always `'PAYMENT_DECLINED'`, and `.reasonCode` is a typed [`DeclineReasonCode`](/errors/error-model/)
an agent can branch on without parsing the message.

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  const res = await client.fetch(url)
  // → paid (within policy) and the gated response is returned
  console.log(res.status)
} catch (err) {
  if (err instanceof PaymentDeclinedError) {
    // No funds moved. Branch on the typed reason — never re-pay on a terminal code.
    switch (err.reasonCode) {
      case 'SESSION_EXPIRED': // TERMINAL — restart/extend the session, don't retry
      case 'APPROVAL':        // TERMINAL — an onBeforePay hook said no
        console.error('refused, do not retry:', err.message)
        break
      case 'BUDGET':          // lifetime maxTotal hit for this asset
      case 'OUTSIDE_WINDOW':  // rolling windowTotal exhausted — may clear later
      case 'POLICY':          // a chain/host/token/per-payment cap
      default:
        console.error('declined by policy:', err.message)
    }
  } else {
    throw err
  }
}
```

:::note
`quote.policyCode` (the read-only `PolicyDenyCode`) is finer-grained than the
`PaymentDeclinedError.reasonCode` (`DeclineReasonCode`) you catch — the client maps the eight
policy codes down to five decline reasons:

| `quote.policyCode` | `err.reasonCode` |
| --- | --- |
| `MAX_TOTAL` | `BUDGET` |
| `WINDOW_TOTAL` | `OUTSIDE_WINDOW` |
| `SESSION_EXPIRED` | `SESSION_EXPIRED` |
| `CHAIN` · `HOST` · `UNKNOWN_TOKEN` · `TOKEN` · `MAX_AMOUNT` | `POLICY` |

(An `onBeforePay` decline — see below — has no `policyCode` and reports `reasonCode: 'APPROVAL'`.)
Use `quote.policyCode` when you want to know *exactly* which guard would fire ahead of time, and
`err.reasonCode` when you only need the coarse "retry vs. give up" verdict.
:::

## A final human gate

The policy is mechanical; for human-in-the-loop or custom per-payment logic, add `onBeforePay`.
It runs **after** the policy passes but **before** any send, receiving the priced
[quote](/making-payments/quote/); return `false` to refuse (the client throws
`PaymentDeclinedError` with `reasonCode: 'APPROVAL'` and no funds move). It may be sync or async.

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
  policy: { maxAmount: '0.50' },
  // amountFormatted is a string — compare it as a number, not lexicographically.
  onBeforePay: (quote) => Number(quote.amountFormatted) <= 0.1,
})
```
