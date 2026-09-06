---
title: PipRailClient
description: The agent-side client. A fetch that pays 402s automatically, plus quote, estimateCost, planPayment, a spend ledger, and discovery.
sidebar:
  order: 1
---

## Introduction

`PipRailClient` is the buyer side of PipRail. At its simplest it's a `fetch` that pays when it
hits a 402; underneath, it's a complete agent payment toolkit. Learn a price without paying,
check you can afford it, enforce a spend policy, and read back what you spent.

## Construct a client

One client is bound to one chain and one wallet:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY },
})
```

The `wallet` is `{ key }` on every chain (the chain's secret as a string); NEAR also needs
`{ accountId }`. You can also pass a viem
`{ walletClient }` to use an injected browser wallet. See [Wallets by
family](/making-payments/wallets-by-family/).

## Pay automatically with `fetch` / `get` / `post`

`fetch` is identical to the global `fetch`, except a `402` is handled transparently: it reads
the challenge, pays on-chain, retries with the proof, and returns the unlocked response. It
takes the same second argument as the global `fetch`, a `RequestInit` (plus the optional
`autoRoute` / `schemes` flags below):

```ts
const res = await client.fetch('https://api.example.com/report')
const data = await res.json()
// → the unlocked 200 response, the same shape the server returns once paid
```

`get` and `post` are thin conveniences over `fetch`. `get(url, init?)` takes the same optional
`RequestInit` second argument as `fetch`; `post(url, body?, init?)` takes the request body second
(a plain object is JSON-serialised with `content-type: application/json`; a string/`FormData`/
`URLSearchParams`/`ArrayBuffer`/`Blob` is sent as-is) and an optional `RequestInit` third:

```ts
const res = await client.post('https://api.example.com/jobs', { prompt: 'summarise Q3' })
```

:::caution
By default `fetch` will pay **whatever a server's challenge asks**, up to your
[spend policy](/spend-controls/payment-policy/). Always set a policy on an autonomous client
so a malicious or buggy server can't drain the wallet.
:::

## Look before you pay: the read-only trio

These move no funds; they're how an agent decides. `planPayment` and `estimateCost` never throw
for a *read* problem (a flaky RPC surfaces as a warning, not a false "broke"); `quote` raises
`InvalidEnvelopeError` if the challenge itself is unparseable. When the 402 is well-formed but
offers no rail this client can pay on its chain + enabled schemes, both `quote` *and*
`estimateCost` raise `NoCompatibleAcceptError` / `UnsupportedSchemeError`, a routing fact rather than a
read failure. Each returns `null` when the URL isn't payment-gated (no 402), so null-guard the
result:

```ts
const url = 'https://api.example.com/report'

const quote = await client.quote(url)        // price, with the token's TRUE decimals + symbol
const cost = await client.estimateCost(url)  // { quote, cost }: payment + estimated gas
const plan = await client.planPayment(url)   // can I actually settle? per-rail analysis

if (plan?.payable) {
  await client.fetch(url)   // safe, we checked
} else {
  console.log(plan?.fundingHint)   // one-line, human-readable: what's missing
}
```

- [`quote()`](/making-payments/quote/) learns the price without paying it.
- [`estimateCost()`](/making-payments/estimate-cost/) adds a best-effort native-coin gas
  estimate so you budget payment **+** gas.
- [`planPayment()`](/making-payments/plan-payment/) is the full readiness check across every rail
  the 402 offers: balance, gas, recipient-readiness, policy. Returns `payable`, `best`,
  per-rail `blockers`, and a one-line `fundingHint`.

`canAfford(url)` is the boolean shortcut over `planPayment`: `true` when at least one rail is
settleable (or when the URL isn't gated at all):

```ts
if (await client.canAfford(url)) {
  await client.fetch(url)
}
```

## Auto-routing and multiple chains

`fetch(url, { autoRoute: true })` (opt-in, default off) pays the **cheapest settleable rail** a
402 offers on your chain. If nothing is settleable it throws `PaymentDeclinedError` carrying the
funding hint, before any send. To choose across chains, give `planAcross` several single-chain
clients:

```ts
import { planAcross } from '@piprail/sdk'

const plan = await planAcross([baseClient, solanaClient, polygonClient], url)
// → merged, payable-first: which chain should I pay from?
```

## When a payment can't go through

Every read-only method returns a value you can branch on, but `fetch` (and `get`/`post`) **pays**,
so it throws a typed [`PipRailError`](/errors/error-model/) on failure. Branch on the stable
`.code`, and on the two broadcast-but-unconfirmed codes, recover via the proof on `.ref`, never
re-pay (a fresh payment would double-spend):

```ts
import {
  PipRailError,
  PaymentTimeoutError,
  MaxRetriesExceededError,
} from '@piprail/sdk'

try {
  const res = await client.fetch('https://api.example.com/report')
  return await res.json()
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // Broadcast succeeded; the server just hasn't accepted the proof yet.
    // Re-verify or re-submit err.ref. DON'T re-pay.
    console.warn('payment in flight, recover with ref', err.ref)
    return
  }
  if (err instanceof PipRailError) {
    switch (err.code) {
      case 'PAYMENT_DECLINED':     // your policy or onBeforePay refused it (no funds moved)
      case 'INSUFFICIENT_FUNDS':   // top up the payer (token and/or native gas)
      case 'RECIPIENT_NOT_READY':  // the fix is on the recipient, not your balance
        console.error(err.code, err.message)
        return
      default:
        throw err
    }
  }
  throw err
}
```

`.ref` lives on exactly two error classes, `PaymentTimeoutError` and `MaxRetriesExceededError`,
so narrow to those before reading it. See [the error model](/errors/error-model/) for the full
list of codes.

## What did I spend?

The client keeps an in-memory ledger, the basis for lifetime spend caps:

```ts
client.spent()      // { count, byAsset, byDenom, records }: everything settled this session
client.budget()     // { session, byAsset, byDenom, counts }: per-asset + cross-token (byDenom) + count leashes + the time envelope
client.remaining()  // SpendRemaining[]: remaining budget per (network, asset)
```

:::note
The ledger is in-memory and **process-scoped**, so it resets on restart. For crash-resistant
lifetime caps, wire a durable store (the `isUsed`/`markUsed` analogue).
:::

## Find and list resources: discovery

`discover()` reads the free open x402 indexes and returns resources payable on this client's
chain; `register()` lists a resource you run so other agents can find it. Both move no funds and
never throw for a read problem:

```ts
const resources = await client.discover({ query: 'weather' })
// → DiscoveredResource[]. Feed one straight into quote() → planPayment() → fetch()
```

`claimDomain(urlOrDomain, opts?)` and `verifyDomain(urlOrDomain)` prove you own a domain so your
402 Index listings go live; see [Domain verification](/discovery/domain-verification/).

### `discoverySigner()`

`client.discoverySigner()` returns the wallet's **discovery signer**, a `{ address, signMessage }`
used only to *sign in* to indexes that require a wallet signature (x402scan's SIWX), never to move
funds. It resolves to `null` on a family that has no discovery signer (today it's EVM-only), or on
a read-only client constructed without a `wallet` (no key to sign with, so it returns `null` rather
than throwing `WalletRequiredError`). You
rarely call it directly, because `register(url, { targets: ['x402scan'] })` uses it under the hood, but
it's there if you sign an index challenge by hand.

```ts
const signer = await client.discoverySigner()
// → { address, signMessage } on EVM, else null
```

## Observability

Pass `onEvent` to watch the lifecycle: `payment-required`, `payment-broadcast`,
`payment-confirmed`, `payment-settled`, `payment-failed` (plus `payment-unconfirmed` when the
broadcast lands but local confirmation times out), `payment-declined` (the rich pre-send refusal
with a budget snapshot), and `budget-threshold` (early warning when cumulative spend first crosses
`policy.warnAtFraction` of any cap), for logging or a UI. See [Events](/making-payments/events/)
for the full union and per-event fields.

## Constructor options

| Option | Purpose |
| --- | --- |
| `chain` | The chain this client pays on. |
| `wallet` | The per-family wallet (see above). **Optional**: omit it for a read-only client, where `quote`, `discover`, `estimateCost`, and `register` work with no key, while `fetch`/`get`/`post`, `planPayment`, and signing throw `WalletRequiredError`. |
| `rpcUrl` | Your RPC (fold any API key in here). |
| `policy` | The [spend policy](/spend-controls/payment-policy/): caps, allowlists, time window. |
| `onBeforePay` | Approval hook. Receives the `PipRailQuote`; returning `false` **or throwing** refuses the payment (`PaymentDeclinedError`, `reasonCode: 'APPROVAL'`), before any send. |
| `onEvent` | Lifecycle observability callback. |
| `onSpend` | Fire-and-forget `(record, budget) => void` after each settle; isolated like `onEvent` (a throw is swallowed). Same data rides the `payment-settled` event. See [Events](/making-payments/events/). |
| `spendStore` | Durable spend store so lifetime caps survive a restart. The ledger hydrates from it at construction and appends each settle (no backend; you own the store). See [Persistence](/spend-controls/persistence/). |
| `ledger` | Advanced: share one `SpendLedger` across single-chain clients for a cross-token / cross-chain grand total (`MultiChainPayer.fromWallets` wires this). **Mutually exclusive with `spendStore`**, and passing both throws. See [Total budget](/spend-controls/total-budget/). |
| `autoRoute` | Default for `fetch`'s cheapest-rail routing (default off). |
| `schemes` | Which schemes to settle: `['onchain-proof']` (default); add `'exact'` (the [gasless standard rail](/making-payments/exact-buyer/)) and/or `'upto'` (the [metered rail](/making-payments/upto-buyer/), EVM-Permit2 only). |
| `maxPaymentRetries` / `retryTimeoutMs` | Retry/timeout tuning (defaults: 3 attempts, 30_000 ms). |

Next: [`planPayment()`](/making-payments/plan-payment/), the readiness check every agent should
run first.
