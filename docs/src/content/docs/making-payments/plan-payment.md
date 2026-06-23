---
title: planPayment()
description: The read-only readiness check — for every rail a 402 offers, can this wallet actually settle it? Balance, gas, recipient readiness, and policy, with a funding hint.
sidebar:
  order: 2
---

## Introduction

`planPayment(url)` answers the question an autonomous agent must ask before spending: *can I
actually pay this, and which rail is best?* It reads on-chain (balances, gas, recipient
prerequisites) but **never pays** — it returns a structured `PaymentPlan` you can branch on.

It completes the read-only trio: [`quote()`](/making-payments/quote/) learns the price,
[`estimateCost()`](/making-payments/estimate-cost/) adds the gas, and `planPayment()` decides
whether the whole thing is settleable.

It returns `null` when the URL isn't payment-gated (no 402), so null-guard the result before
reading it.

## Basic use

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)

if (!plan) {
  // not payment-gated — fetch it for free
  await client.fetch(url)
} else if (plan.payable) {
  await client.fetch(url) // safe — we checked
} else {
  console.log(plan.fundingHint) // one-line, human-readable: what's missing
}
```

## The PaymentPlan

```ts
interface PaymentPlan {
  url: string
  network: Caip2                  // the network this client is bound to, e.g. 'eip155:8453'
  status: 'ready' | 'blocked' | 'unknown' // top-level verdict for instant branching
  payable: boolean                // is at least one rail settleable right now? (best !== null)
  best: PayOption | null          // the recommended rail (cheapest settleable), or null
  options: PayOption[]            // every offered+supported rail, ranked: payable → unknown → blocked
  fundingHint: string | null      // when NOT payable: one human sentence on what to top up (null when payable)
  session?: {                     // present ONLY when the policy configures a time envelope
    expiresAt: number | null      // deadline as epoch ms, or null when no time limit
    secondsRemaining: number | null // best-effort, clamped ≥ 0, or null when no time limit
  }
}
```

`status` is the quick verdict: `'ready'` (a rail is payable now), `'blocked'` (every rail has a
hard blocker), or `'unknown'` (a read failed, so payability can't be confirmed — retry).

Each `PayOption` analyses one offered rail against your wallet:

```ts
interface PayOption {
  accept: X402AnyAccept    // the rail this analyses (one entry from the 402's accepts[])
  quote: PipRailQuote      // the priced requirement — TRUE decimals/symbol + the policy verdict
  cost: CostEstimate       // estimated native-coin gas to send it (cost.basis surfaced)
  state: 'payable' | 'blocked' | 'unknown' // the verdict for THIS rail
  blockers: PayBlocker[]   // hard reasons it can't settle (empty when payable)
  warnings: PayWarning[]   // soft flags worth surfacing (may be present even when payable)
  balance: { token: string | null; native: string | null } // live holdings, human units (null = unread, NOT zero)
  need: { token: string; native: string }                  // the payment amount + the estimated gas
  shortfall?: { token?: string; native?: string }          // how far short, if blocked on funds
  recipient: { ready: boolean | 'n/a' | 'unknown'; reason?: RecipientReason; fix?: string }
}
```

## Blockers — the hard reasons a rail can't settle

| Blocker | Meaning |
| --- | --- |
| `INSUFFICIENT_TOKEN` | Not enough of the payment token. |
| `INSUFFICIENT_GAS` | Not enough native coin to cover the network fee. |
| `RECIPIENT_NOT_READY` | `payTo` can't receive yet (no trustline / not registered / not opted-in / inactive). |
| `OUTSIDE_POLICY` | The payment breaches your [spend policy](/spend-controls/payment-policy/). |
| `OUTSIDE_WINDOW` | The rolling time window or session deadline has passed. |

:::note[Solana `exact` to a brand-new recipient]
On the opt-in Solana `exact` rail, `planPayment` can't detect a recipient whose **associated token
account** doesn't exist yet (the buyer can't create it on that rail). Such a payment may read
`payable`, then `autoRoute` refuses it **pre-broadcast** (recoverable, no funds move). The default
`onchain-proof` rail is unaffected — the payer's tx creates the recipient ATA — so it's always a
safe fallback.
:::

## Warnings — soft flags

`SYMBOL_MISMATCH`, `BALANCE_UNREADABLE`, `RECIPIENT_READINESS_UNKNOWN`, `GAS_HEURISTIC`,
`THIN_GAS_MARGIN`. A warning doesn't block a payment, but an agent should surface it (for
example, a symbol mismatch means the token's on-chain symbol differs from the challenge).

:::note
When a balance or readiness probe can't be read, the field is `null` and you get a
`*_UNREADABLE` / `*_UNKNOWN` warning — **never a false `0`**. PipRail won't tell you you're
broke because an RPC hiccuped.
:::

## When it throws (and when it doesn't)

`planPayment()` is fundability-as-data: an unaffordable, recipient-not-ready, or out-of-policy
rail is reported as a `blocker` on a `PayOption`, **never** thrown. A transient RPC failure
surfaces as `state: 'unknown'` plus a warning, never a false "unaffordable".

The one exception is a malformed challenge: a 402 whose body isn't a parseable x402 envelope
throws `InvalidEnvelopeError`.

```ts
import { InvalidEnvelopeError } from '@piprail/sdk'

try {
  const plan = await client.planPayment(url)
  // …branch on plan…
} catch (err) {
  if (err instanceof InvalidEnvelopeError) {
    console.error('Server returned a 402 with a malformed payment challenge:', err.message)
  } else {
    throw err
  }
}
```

:::caution
`planPayment()` never moves funds, but [`fetch(url, { autoRoute: true })`](/making-payments/fetch-and-autoroute/)
**does** — and when it runs the same plan and finds no settleable rail, it throws
`PaymentDeclinedError` carrying the funding hint, before any send. Plan first if you want to
branch instead of catch.
:::

## canAfford() — the boolean shortcut

When you only need a yes/no, `canAfford(url)` runs the same plan and returns `plan.payable`
(or `true` when the URL isn't gated — a free resource is trivially affordable):

```ts
if (await client.canAfford(url)) {
  await client.fetch(url)
}
// → true | false
```

## Across chains — `planAcross`

To decide which of several chains to pay from, plan across single-chain clients. It returns a
merged `PaymentPlan | null` — `null` only when the URL isn't gated for any client:

```ts
import { planAcross } from '@piprail/sdk'

const plan = await planAcross([baseClient, solanaClient, polygonClient], url)
// merged, payable-first — `best` points at the chain to use
if (plan?.best) {
  console.log(`Pay on ${plan.best.accept.network}`)
}
```

## Make it legible to an LLM

`summarizePlan(plan)` renders the plan as one English line for a model to read or relay:

```ts
import { summarizePlan } from '@piprail/sdk'

console.log(summarizePlan(plan))
// → "Payable: 0.10 USDC on eip155:8453 (gas ~0.00002 ETH). 1 other rail(s) not settleable."
```

Gas is shown in the chain's native coin (ETH/SOL/TRX/…), never in fiat — PipRail has no price
oracle. A `null` plan renders `"No payment required — the URL is not payment-gated."`; an
unpayable plan renders `"NOT payable: <fundingHint>"`.

See the [agent toolkit](/agent-toolkit/the-agent-tools/) for how the MCP server wires this into a tool.
