---
title: evaluatePolicy()
description: The pure, dependency-free heart of the spend leash. Evaluate one payment intent against a policy and get a typed allow/deny decision back.
sidebar:
  order: 4
---

## Introduction

`evaluatePolicy()` is the testable core of the [spend policy](/spend-controls/payment-policy/).
It takes a `PaymentIntent` (the facts about one payment the client is about to make) and a
`PaymentPolicy`, and returns a `PolicyDecision`: `allowed` plus a typed `code` and a
human-readable `reason` when it refuses. It is **pure and chain-agnostic**: it imports nothing
from any driver, never touches the network, and never throws.

The client calls it for you on every payment and throws
[`PaymentDeclinedError`](/errors/error-hierarchy/) on a refusal, so you rarely call it directly.
You call it to **unit-test your own policy** without a wallet, an RPC, or a live 402.

```ts
import { evaluatePolicy, type PaymentIntent, type PaymentPolicy } from '@piprail/sdk'

// The facts about one payment, as the client would build them from a 402's accept.
const intent: PaymentIntent = {
  host: 'api.example.com',
  chain: 'base',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
  amountBase: 100_000n,                                 // 0.10 USDC (6 decimals)
  decimals: 6,
  symbol: 'USDC',
  recognized: true,
}

const policy: PaymentPolicy = { maxAmount: '0.10', tokens: ['USDC'], chains: ['base'] }

const decision = evaluatePolicy(intent, policy, 0n)
// → { allowed: true }

if (!decision.allowed) console.log(decision.code, decision.reason)
```

## The PaymentIntent

The intent is the value object the policy reasons over, meaning what the client builds from the chosen
accept after it has resolved the asset against the driver. The cardinal rule lives here: amounts
are checked against the token's **true** decimals (the SDK's own, via the driver), never the
server-stated `extra.decimals`, so a server can't slip past a cap by claiming a cheap-looking
amount.

```ts
interface PaymentIntent {
  host: string          // host of the gated URL (for the hosts allowlist)
  chain: ChainSelector  // the selector the client is configured with
  network: Caip2         // e.g. 'eip155:8453'
  asset: string          // token address, or 'native'
  amountBase: bigint     // server-stated base units: what actually transfers
  decimals: number       // TRUE decimals if recognised, else server-stated
  symbol?: string        // TRUE symbol if recognised, else server-stated
  recognized: boolean    // did the driver's describeAsset recognise this asset?
}
```

## The PolicyDecision

```ts
interface PolicyDecision {
  allowed: boolean
  reason?: string        // why it was refused (only when allowed === false)
  code?: PolicyDenyCode  // which guard fired, as a typed enum
}
```

Branch on `code`, never on the prose. The `reason` is for humans and logs; the `code` is the
stable contract, so it won't break when the wording is tweaked.

## Deny codes

Each guard refuses with one typed `PolicyDenyCode`, matching the field it enforces.

| Code | Fired when |
| --- | --- |
| `SESSION_EXPIRED` | The session's TTL or deadline has elapsed. Refuses every payment, amount-blind. |
| `CHAIN` | `intent.chain` / `network` is not in `policy.chains`. |
| `HOST` | `intent.host` is not in `policy.hosts` (exact or `*.suffix` wildcard). |
| `UNKNOWN_TOKEN` | The asset isn't one the SDK can price and `allowUnknownTokens` is off. |
| `TOKEN` | The true symbol (or `'native'`) is not in `policy.tokens`. |
| `MAX_AMOUNT` | The payment exceeds `policy.maxAmount` (per-payment ceiling). |
| `MAX_TOTAL` | This payment would push per-asset lifetime spend past `policy.maxTotal`. |
| `MAX_TOTAL_DENOM` | This payment would push the cross-token grand total for its denomination past `policy.maxTotalPerDenom` (e.g. all USD-unit tokens summed). |
| `MAX_PAYMENTS` | The lifetime count of settled payments would exceed `policy.maxPayments`. |
| `WINDOW_TOTAL` | This payment would exceed `policy.windowTotal` within the rolling window. |
| `WINDOW_COUNT` | The number of payments in the rolling window would exceed `policy.maxPaymentsPerWindow`. |

## Evaluation order

Checks run in a pinned, deterministic order, **first-failure-wins**, so the reported reason is
the most specific one:

```
session expiry → chains → hosts → unknown-token → tokens → maxAmount
              → maxTotal → maxTotalPerDenom → maxPayments → windowTotal → maxPaymentsPerWindow
```

Expiry is first because it's session-global, not asset-scoped, and an expired session must always
report expiry, not whichever other gate also happens to fail. The budget caps run cheapest-first:
the per-asset `maxTotal`, then the cross-token `maxTotalPerDenom` (`MAX_TOTAL_DENOM`) and the
lifetime `maxPayments` count (`MAX_PAYMENTS`), and the two rolling-window checks, `windowTotal`
and the window count `maxPaymentsPerWindow` (`WINDOW_COUNT`), last, because they're the heaviest.

:::note
The expiry check is **inclusive** (`now >= deadline` is expired), while the amount caps are
**strict** (`amount > cap` fails). This asymmetry is intentional and tested: an amount exactly at
the cap is allowed.
:::

## The spentForAssetBase argument

The third argument is the running total already spent on **this** `(network, asset)` pair, in
base units, which the client supplies from its [spend ledger](/spend-controls/spend-ledger/). It
powers the `maxTotal` cap. With no policy `maxTotal`, pass `0n`.

```ts
// already spent 0.07 USDC (6 decimals) on this network+asset; a further 0.10 → 0.17 > 0.10
evaluatePolicy({ ...intent, amountBase: 100_000n }, { maxTotal: '0.10' }, 70_000n)
// → { allowed: false, code: 'MAX_TOTAL', reason: 'this payment would push spend on USDC past …' }
```

`maxTotal` is **per distinct asset**, not a grand total across tokens, because summing different tokens
is meaningless without a price oracle (which the SDK deliberately omits). Pair it with
`tokens: ['USDC']` for a true single-currency budget.

## Unknown tokens

An asset the SDK can't recognise can't have its decimals verified, so it can't be priced safely
and an unpriceable asset is **declined by default**. Set `allowUnknownTokens: true` to opt in
to trusting the server-stated decimals (the explicit risk).

```ts
evaluatePolicy({ ...intent, recognized: false }, {}, 0n)
// → { allowed: false, code: 'UNKNOWN_TOKEN', reason: "asset … isn't a token the SDK can price …" }

evaluatePolicy({ ...intent, recognized: false }, { allowUnknownTokens: true }, 0n)
// → { allowed: true }
```

## No policy is allow-all

Omit the policy (or pass `undefined`) and every payment is allowed. The leash is opt-in.

```ts
evaluatePolicy(intent, undefined, 0n)
// → { allowed: true }
```

## Checks that need the injected context

The third argument carries only the per-asset spend (`spentForAssetBase`). Several caps need
more than that (a clock, the cross-token grand totals, or the settled-payment counts) and the
client supplies all of it through the **same private context** it uses for the clock. There is
**no public way to pass it**, so calling `evaluatePolicy` directly (as in a unit test) skips
these checks entirely; behaviour is byte-identical to a policy without those fields. The
context-dependent guards are:

- **Session expiry** (`ttlSeconds` / `expiresAt`) and the **rolling window** (`windowTotal` +
  `windowSeconds`) need a clock; they surface as `SESSION_EXPIRED` and `WINDOW_TOTAL`.
- **Cross-token grand total** (`maxTotalPerDenom`) needs the per-denomination sums the client
  rolls up from its [spend ledger](/spend-controls/spend-ledger/); surfaces as `MAX_TOTAL_DENOM`.
- **Payment counts** (`maxPayments`, `maxPaymentsPerWindow`) need the settled-payment count
  (lifetime and per-window); surface as `MAX_PAYMENTS` and `WINDOW_COUNT`.

So `SESSION_EXPIRED`, `WINDOW_TOTAL`, `MAX_TOTAL_DENOM`, `MAX_PAYMENTS`, and `WINDOW_COUNT` all
fire **only through the live client**, never from a bare `evaluatePolicy` call.

To test these leashes, drive them through the client's session surfaces; see the
[time envelope](/spend-controls/time-envelope/) page.

## Two enums, not one

`evaluatePolicy` returns the fine-grained `PolicyDenyCode` (every code in the table above), which
the client surfaces unchanged on a read-only [`quote()`](/making-payments/quote/) as `quote.policyCode`.
But when a live payment is actually refused, the thrown `PaymentDeclinedError` carries a **coarser**
[`DeclineReasonCode`](/errors/error-hierarchy/) on `.reasonCode`. The client maps the
policy codes down to five:

| `PolicyDenyCode` (read-only) | `DeclineReasonCode` (`catch`) |
| --- | --- |
| `SESSION_EXPIRED` | `SESSION_EXPIRED` (terminal: restart/extend the TTL, don't retry) |
| `WINDOW_TOTAL` / `WINDOW_COUNT` | `OUTSIDE_WINDOW` |
| `MAX_TOTAL` / `MAX_TOTAL_DENOM` / `MAX_PAYMENTS` | `BUDGET` |
| `CHAIN` / `HOST` / `UNKNOWN_TOKEN` / `TOKEN` / `MAX_AMOUNT` | `POLICY` |

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PaymentDeclinedError) {
    console.log(err.reasonCode) // 'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' | 'SESSION_EXPIRED' | 'APPROVAL'
    if (err.reasonCode === 'SESSION_EXPIRED' || err.reasonCode === 'APPROVAL') return // terminal, don't retry
  } else {
    throw err
  }
}
```

The fine-grained `policyCode` is for read-only inspection; the coarse `reasonCode` is what a
`catch` sees. See [Payment policy](/spend-controls/payment-policy/) for the full field-by-field
reference.

:::tip
For the field-by-field meaning of every policy option, see
[Payment policy](/spend-controls/payment-policy/). To see a denial surfaced as a `PayBlocker`
without spending, [`planPayment()`](/making-payments/plan-payment/) maps `OUTSIDE_POLICY` /
`OUTSIDE_WINDOW` straight from these codes.
:::
