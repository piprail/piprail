---
title: Events & observability
description: A single onEvent hook that emits one PipRailEvent per stage of a payment — for logging, metrics, or a live UI.
sidebar:
  order: 7
---

## Introduction

Every payment moves through stages — challenge, broadcast, confirmation, settlement —
and you'll want to see them, whether for a log line, a metric, or a progress bar in a UI.
Pass an `onEvent` hook when you build the client and PipRail calls it once per stage with a
typed `PipRailEvent`.

The hook is fire-and-forget: it returns nothing, and a throwing handler can never abort a
payment (the call is isolated, mirroring the server gate's [`onPaid`](/accepting-payments/receipts-and-onpaid/)).

## Basic use

`onEvent` is a constructor option. Switch on `event.kind` and handle the stages you care about:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
  onEvent: (e) => console.log(e.kind, 'ref' in e ? e.ref : ''),
})

// One onchain-proof payment logs, in order:
// → payment-required
// → payment-broadcast  0xabc123…
// → payment-confirmed  0xabc123…
// → payment-settled
```

## The PipRailEvent union

`PipRailEvent` is a discriminated union keyed on `kind`. One payment emits a subset of these,
in order — never all of them.

| `kind` | When it fires | Payload |
| --- | --- | --- |
| `payment-required` | A 402 was received and a rail chosen, before any funds move. | `challenge`, `accept` |
| `payment-broadcast` | The transaction was sent — funds may already have moved. | `ref` |
| `payment-confirmed` | The proof confirmed locally against your RPC. | `ref`, `blockNumber` |
| `payment-unconfirmed` | Broadcast succeeded but local confirmation timed out. | `ref`, `reason` |
| `payment-settled` | The server served the resource — the payment is done. | `receipt`, `settle?` |
| `payment-failed` | The flow gave up after broadcasting. | `reason` |

```ts
export type PipRailEvent =
  | { kind: 'payment-required'; challenge: X402Challenge; accept: X402AnyAccept }
  | { kind: 'payment-broadcast'; ref: string }
  | { kind: 'payment-confirmed'; ref: string; blockNumber: bigint }
  | { kind: 'payment-unconfirmed'; ref: string; reason: string }
  | { kind: 'payment-settled'; receipt: X402Receipt | null; settle?: SettleOutcome }
  | { kind: 'payment-failed'; reason: string }
```

`ref` is the proof — a chain-specific id (an EVM tx hash, a Solana signature, a TON locator,
a Stellar tx hash). See [Proof binding](/concepts/proof-binding/) for what a `ref` is per family.

## The happy path

A successful `onchain-proof` payment emits four events in order — required, broadcast,
confirmed, settled. That's the spine of a progress indicator:

```ts
onEvent: (e) => {
  // `accept.amount` is base units. On `onchain-proof`, `extra.amountFormatted`/`symbol` are the
  // human form; on an `exact` rail both are optional — fall back to `accept.amount`.
  if (e.kind === 'payment-required') {
    ui.show(`Paying ${e.accept.extra.amountFormatted ?? e.accept.amount} ${e.accept.extra.symbol ?? ''}…`)
  }
  if (e.kind === 'payment-broadcast') ui.show(`Sent ${e.ref.slice(0, 10)}…`)
  if (e.kind === 'payment-confirmed') ui.show(`Confirmed in block ${e.blockNumber}`)
  if (e.kind === 'payment-settled') ui.done(e.receipt?.transaction)
}
```

:::note
The standard [`exact`](/making-payments/exact-buyer/) rail emits a **shorter** sequence —
the buyer signs an authorization and the server/facilitator broadcasts it, so there's no
buyer broadcast or local confirm: you'll see `payment-required` then `payment-settled` (or
`payment-failed`), never `payment-broadcast` / `payment-confirmed`.
:::

## Reading the settled receipt

`payment-settled` carries `receipt` — a rich [`X402Receipt`](/accepting-payments/receipts-and-onpaid/)
when the server returns one (its own gate, or a facilitator that echoes the full shape), or
`null` when it doesn't. Read `receipt.transaction` for the verified on-chain settle tx:

```ts
onEvent: (e) => {
  if (e.kind === 'payment-settled') {
    console.log('settled', e.receipt?.transaction ?? '(no receipt)')
  }
}
```

On standard [`exact`](/making-payments/exact-buyer/) interop, a conformant third-party
facilitator may return a lean x402 `SettleResponse` instead of a rich receipt — then `receipt`
is `null` and the settle tx is on `event.settle.transaction`:

```ts
onEvent: (e) => {
  if (e.kind === 'payment-settled') {
    const tx = e.receipt?.transaction ?? e.settle?.transaction
    console.log('settled', tx)
  }
}
```

## When confirmation times out

`payment-unconfirmed` means the broadcast succeeded — you hold the `ref` — but the client's
own confirmation read timed out (typically a throttled or lagging RPC). The proof is **not**
discarded: the client submits it to the server (whose own on-chain verify is the authority)
rather than throwing, so a real payment is never orphaned into a double-pay. `reason` is the
confirm error's message.

```ts
onEvent: (e) => {
  if (e.kind === 'payment-unconfirmed') {
    log.warn(`broadcast ${e.ref} but confirm timed out: ${e.reason}`)
  }
}
```

:::note
`payment-unconfirmed` is informational, not a failure — a `payment-settled` usually follows it
once the server's node catches up. The client uses more patient retries after this event.
:::

## When a payment fails

`payment-failed` fires only after the transaction was broadcast and the flow then gave up
(the server kept returning 402, or a facilitator rejected the `exact` authorization). The
matching `MaxRetriesExceededError` thrown to the caller carries `.ref` — re-verify or
re-submit, **never re-pay**.

```ts
onEvent: (e) => {
  if (e.kind === 'payment-failed') log.error(e.reason)
}
```

:::caution
A `payment-failed` after a `payment-broadcast` does not mean nothing left your wallet — the
broadcast may have settled on-chain even though the server didn't accept the proof in time.
Treat the `ref` as a thing to verify, not a payment to retry.
:::

## What the hook can't do

The hook is for observability only. It can't approve, deny, or alter a payment — use
[`onBeforePay`](/spend-controls/payment-policy/) for the approval gate and a
[spend policy](/spend-controls/payment-policy/) for hard ceilings. A handler that throws is
swallowed silently so it can never abort the payment, so don't rely on it for control flow.

:::tip
For a one-shot, after-the-fact view of everything a client has paid, call
[`client.spent()`](/spend-controls/spend-ledger/) instead of accumulating events yourself —
it returns the running ledger.
:::
