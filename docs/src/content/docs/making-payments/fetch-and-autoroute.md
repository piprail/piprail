---
title: "fetch, autoRoute & retries"
description: The drop-in fetch that pays a 402 and retries with proof — plus opt-in balance-aware routing and the never-re-pay rule that keeps a flaky RPC from double-spending.
sidebar:
  order: 6
---

## Introduction

`client.fetch(url)` is a drop-in replacement for `fetch`. On any non-`402` response it just
returns it. On a `402` it reads the challenge, pays on-chain, waits for confirmation, and
re-sends the request with the proof attached — all in one call. Your code looks like a normal
request; the payment happens inside.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },  // 0x… hex, EVM
})

const res = await client.fetch('https://api.example.com/report')  // 402 → pay → 200
// → a standard Response — `await res.json()` / `res.text()` as usual
```

See [`PipRailClient`](/making-payments/piprail-client/) for every option and the per-family
wallet shapes.

## `get` and `post`

`get` and `post` are thin wrappers over `fetch`, both auto-handling the 402:

```ts
await client.get('https://api.example.com/report')                                // → Response
await client.post('https://api.example.com/jobs', { prompt: 'summarise this' })   // object → JSON
```

`post`'s `body` may be a string, `FormData`, `URLSearchParams`, `ArrayBuffer`, or `Blob` (sent
as-is), or a plain object (serialised as JSON, with a `content-type` header added if you didn't
set one).

:::caution
A request body must be **replayable** — the SDK may send the request twice (once to read the
402, once with the proof). A one-shot `ReadableStream` throws `NonReplayableBodyError`. Pass a
string, `FormData`, `URLSearchParams`, `ArrayBuffer`, or `Blob` instead.
:::

## How the 402 is paid

When `fetch` gets a `402`, it walks a fixed sequence before any funds move:

1. Parse the challenge and pick the rails this client can pay on its chain.
2. Run the [spend policy](/spend-controls/payment-policy/) and your `onBeforePay` hook — either
   refuses by throwing `PaymentDeclinedError`, before any send or signature.
3. Broadcast the payment and wait for confirmation.
4. Re-send the request with the proof header until the server returns the resource.

By default the client picks the **first** offered rail that the policy allows. To pick the
cheapest rail the wallet can actually settle instead, turn on auto-route.

## Auto-route — pay the cheapest settleable rail

`autoRoute` makes `fetch` run [`planPayment()`](/making-payments/plan-payment/) on the 402 and
pay `plan.best` — the cheapest rail the wallet can *actually* settle (enough token, enough
native-coin gas, recipient ready to receive) — rather than the first policy-passing accept. It's
opt-in and **off by default**: the zero-config path keeps its existing selection.

Set it on the client, or per call:

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  autoRoute: true,
})
// or override per call:
await client.fetch('https://api.example.com/report', { autoRoute: true })
```

If no rail is settleable, `fetch` throws `PaymentDeclinedError` carrying the plan's
`fundingHint` — **before any send**, so you learn what to top up instead of watching a broadcast
revert. Recommended for multi-rail 402s. Inspect the plan yourself first with
[`planPayment()`](/making-payments/plan-payment/) or
[`canAfford()`](/making-payments/plan-payment/) when you want to branch before calling `fetch`:

```ts
if (await client.canAfford('https://api.example.com/report')) {
  await client.fetch('https://api.example.com/report', { autoRoute: true })  // safe — we checked
}
```

## Retries — absorbing RPC propagation lag

After paying, the server's node may briefly trail the client's — it hasn't seen the confirmation
yet and answers `402` again. So the client re-sends the request with the proof a few times, with
a short backoff, before giving up.

| Option | Default | Purpose |
| --- | --- | --- |
| `maxPaymentRetries` | `3` | Re-sends with proof after paying, to absorb RPC propagation lag. |
| `retryTimeoutMs` | `30000` | Timeout (ms) for each retry leg after broadcast. |

```ts
new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  maxPaymentRetries: 5,
  retryTimeoutMs: 45_000,
})
```

If the server still returns `402` on the last attempt, `fetch` throws `MaxRetriesExceededError`
(it carries the rejection reason the server gave). If the server never responds within
`retryTimeoutMs`, it throws `PaymentTimeoutError`. Both carry `.ref` — the proof.

## The never-re-pay rule

A payment can be **broadcast but not yet confirmed** — a throttled RPC lands the transaction but
`429`s the status read. The client does **not** throw the proof away and it **never
re-broadcasts**. It emits a [`payment-unconfirmed`](/making-payments/events/) event, submits the
proof to the server (whose own on-chain verify is the authority), and switches to more patient
retries (a floor of 6 attempts, longer backoff), since the transaction may still be settling.

:::danger
On `MaxRetriesExceededError` or `PaymentTimeoutError`, read `err.ref` and **re-verify or
re-submit that proof — never re-pay.** A fresh payment double-spends. The proof stays redeemable
until the server's `maxTimeoutSeconds` window. The real fix for repeated lag is a dedicated
`rpcUrl` rather than a public default.
:::

## When a payment can't go through

`fetch` is the place where a payment actually throws. Catch a
[`PipRailError`](/errors/error-model/) and branch on its stable `.code` — and on these two codes
**recover via `err.ref`, never re-pay**:

```ts
import {
  PipRailError,
  PaymentTimeoutError,
  MaxRetriesExceededError,
} from '@piprail/sdk'

try {
  const res = await client.fetch('https://api.example.com/report')
  console.log(await res.text())
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // Broadcast already happened — re-verify or re-submit the proof, NEVER re-pay.
    console.log('recover with proof:', err.ref)
  } else if (err instanceof PipRailError) {
    switch (err.code) {
      case 'PAYMENT_DECLINED':       // policy / onBeforePay / no settleable rail (autoRoute)
      case 'INSUFFICIENT_FUNDS':     // top up the payer (token and/or native gas)
      case 'RECIPIENT_NOT_READY':    // the fix is on the recipient, not your balance
      case 'NO_COMPATIBLE_ACCEPT':   // no rail for this client's chain
        console.error(err.code, err.message)
        break
      default:
        throw err
    }
  } else {
    throw err  // not a PipRail error — re-throw
  }
}
```

Only `PaymentTimeoutError` and `MaxRetriesExceededError` carry `.ref`, so narrow on those two
classes before reading it. See [why payments fail](/errors/why-payments-fail/) for the full
error map.

## When the 402 offers no rail you can pay

If the challenge offers nothing payable on this client's chain, `fetch` throws
`NoCompatibleAcceptError` — its message names the chains the 402 *is* payable on. If the only
rails are standard `exact` rails (off by default), it tells you to enable them. See the
[exact buyer rail](/making-payments/exact-buyer/) for paying standard x402 servers, and
[why payments fail](/errors/why-payments-fail/) for the full error map.
