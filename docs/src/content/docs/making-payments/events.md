---
title: Events & observability
description: A single onEvent hook that emits one PipRailEvent per stage of a payment, for logging, metrics, or a live UI.
sidebar:
  order: 7
---

## Introduction

Every payment moves through stages (challenge, broadcast, confirmation, settlement)
and you'll want to see them, whether for a log line, a metric, or a progress bar in a UI.
Pass an `onEvent` hook when you build the client and PipRail calls it once per stage with a
typed `PipRailEvent`.

The hook is fire-and-forget: it returns nothing, and a throwing handler can never abort a
payment (the call is isolated, mirroring the server gate's [`onPaid`](/accepting-payments/receipts-and-onpaid/)).

A companion constructor option, [`onSpend`](#logging-spend-with-onspend), fires once after each
settle with the [`SpendRecord`](/spend-controls/spend-ledger/) plus the current budget, and the
ergonomic "log my spend locally" hook, when all you want is a running spend line rather than the
full per-stage stream.

## Basic use

`onEvent` is a constructor option. Switch on `event.kind` and handle the stages you care about:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
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
in order, never all of them.

| `kind` | When it fires | Payload |
| --- | --- | --- |
| `payment-required` | A 402 was received and a rail chosen, before any funds move. | `challenge`, `accept` |
| `payment-broadcast` | The transaction was sent, so funds may already have moved. | `ref` |
| `payment-confirmed` | The proof confirmed locally against your RPC. | `ref`, `blockNumber` |
| `payment-unconfirmed` | Broadcast succeeded but local confirmation timed out. | `ref`, `reason` |
| `payment-settled` | The server served the resource, so the payment is done. | `receipt`, `settle?` |
| `payment-failed` | The flow gave up: a server rejection, **or** a pre-send decline (policy / `onBeforePay` / no settleable rail). | `reason`, `code?`, `detail?` |
| `payment-declined` | A pre-send decline. The **rich** companion to `payment-failed`, with a budget snapshot. | `reason`, `reasonCode?`, `code?`, `quote?`, `budget` |
| `budget-threshold` | Spend first crossed `policy.warnAtFraction` of any cap. An early warning, **not** a failure. | `scope`, `label`, `spentFormatted`, `capFormatted`, `fraction` |

```ts
export type PipRailEvent =
  | { kind: 'payment-required'; challenge: X402Challenge; accept: X402AnyAccept }
  | { kind: 'payment-broadcast'; ref: string }
  | { kind: 'payment-confirmed'; ref: string; blockNumber: bigint }
  | { kind: 'payment-unconfirmed'; ref: string; reason: string }
  | { kind: 'payment-settled'; receipt: X402Receipt | null; settle?: SettleOutcome }
  | {
      kind: 'payment-failed'
      reason: string
      // A machine-readable failure code, when one is known. On a SERVER rejection it's the
      // SAME code the merchant's `onFailed` hook receives: a canonical VerifyErrorCode from a
      // PipRail gate ('amount_too_low', 'payment_expired', 'tx_already_used', …), or a foreign
      // facilitator's reason string. On a pre-send DECLINE it's the SAME DeclineReasonCode the
      // thrown PaymentDeclinedError carries ('POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' |
      // 'SESSION_EXPIRED' | 'APPROVAL'): one consistent value across the event and the error.
      // Absent when no structured code was given.
      code?: string
      // Human-readable detail, when present, e.g. "Paid 40000, required 500000."
      detail?: string
    }
  // The rich pre-send decline. Fires alongside `payment-failed`, carrying a budget snapshot.
  | {
      kind: 'payment-declined'
      reason: string
      reasonCode?: DeclineReasonCode // the coarse 'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' | …
      code?: PolicyDenyCode          // the fine guard, e.g. 'MAX_TOTAL_DENOM' | 'MAX_PAYMENTS'
      quote?: PipRailQuote           // the read-only quote that was refused, when there was one
      budget: SessionBudget          // remaining headroom at the moment of the decline
    }
  // An early warning: spend first crossed `policy.warnAtFraction` of some cap.
  | {
      kind: 'budget-threshold'
      scope: 'asset' | 'denom' | 'count' | 'window' | 'window-count'
      label: string                 // the asset, denomination, or window the cap belongs to
      spentFormatted: string
      capFormatted: string
      fraction: number               // how far into the cap, e.g. 0.8
    }
```

`ref` is the proof: a chain-specific id (an EVM tx hash, a Solana signature, a TON locator,
a Stellar tx hash). See [Proof binding](/concepts/proof-binding/) for what a `ref` is per family.

## The happy path

A successful `onchain-proof` payment emits four events in order: required, broadcast,
confirmed, settled. That's the spine of a progress indicator:

```ts
onEvent: (e) => {
  // `accept.amount` is base units. On `onchain-proof`, `extra.amountFormatted`/`symbol` are the
  // human form; on an `exact` rail both are optional, so fall back to `accept.amount`.
  if (e.kind === 'payment-required') {
    ui.show(`Paying ${e.accept.extra.amountFormatted ?? e.accept.amount} ${e.accept.extra.symbol ?? ''}…`)
  }
  if (e.kind === 'payment-broadcast') ui.show(`Sent ${e.ref.slice(0, 10)}…`)
  if (e.kind === 'payment-confirmed') ui.show(`Confirmed in block ${e.blockNumber}`)
  if (e.kind === 'payment-settled') ui.done(e.receipt?.transaction)
}
```

:::note
The standard [`exact`](/making-payments/exact-buyer/) rail emits a **shorter** sequence,
the buyer signs an authorization and the server/facilitator broadcasts it, so there's no
buyer broadcast or local confirm: you'll see `payment-required` then `payment-settled` (or
`payment-failed`), never `payment-broadcast` / `payment-confirmed`.
:::

## Reading the settled receipt

`payment-settled` carries `receipt`, a rich [`X402Receipt`](/accepting-payments/receipts-and-onpaid/)
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
facilitator may return a lean x402 `SettleResponse` instead of a rich receipt, and then `receipt`
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

`payment-unconfirmed` means the broadcast succeeded (you hold the `ref`) but the client's
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
`payment-unconfirmed` is informational, not a failure. A `payment-settled` usually follows it
once the server's node catches up. The client uses more patient retries after this event.
:::

## When a payment fails

`payment-failed` fires whenever the flow gives up, and it now covers **every** failure type, not
just a server rejection. It carries `reason` (always), plus optional `code` and `detail` that tell
you *what kind* of failure it was and let you branch without parsing the prose. There are two
distinct cases.

### Case 1: the server rejected a submitted proof

This is the post-send case. On the **onchain-proof** rail it happens after the transaction was
broadcast and the server kept returning 402; the matching `MaxRetriesExceededError` carries `.ref`,
so re-verify or re-submit, **never re-pay**. On the **exact** rail it can fire with *no* broadcast
at all, because the buyer only signs an authorization, so a facilitator rejection or a server-side settle
failure ends the flow before anything settles.

When the server gave a structured reason, the event carries it: `code` is the same machine
[`VerifyErrorCode`](/accepting-payments/verifying-payments/) the merchant's
[`onFailed` hook](/accepting-payments/receipts-and-onpaid/) receives (`'amount_too_low'`,
`'payment_expired'`, `'tx_already_used'`, `'wrong_recipient'`, `'signature_invalid'`, …) and
`detail` is the human one-liner (e.g. `"Paid 40000, required 500000."`). **Both sides see one
consistent reason**: the buyer's `code` here equals the merchant's `failure.code` there, by design.
A foreign (non-PipRail) facilitator may instead supply its own reason string, and an `exact`
facilitator/relayer rejection that returns no structured reason fires with `reason` only (no `code`).

### Case 2: the client declined *before* sending

`payment-failed` now **also** fires on a pre-send decline: the same three refusals that throw a
typed [`PaymentDeclinedError`](/spend-controls/payment-policy/): the quote fell outside the
configured [spend policy](/spend-controls/payment-policy/), an
[`onBeforePay`](/spend-controls/payment-policy/) hook returned `false` (or threw), or
`autoRoute` found no rail the wallet can actually settle. **Zero funds move** in any of these, and
the typed throw is unchanged, so the event is *additive* and a consumer watching `onEvent` alone now
learns of every failure, not only server rejections.

On a policy or approval decline the event's `code` is the **same**
[`DeclineReasonCode`](/errors/error-hierarchy/) the thrown
[`PaymentDeclinedError`](/errors/why-payments-fail/) carries: `'POLICY'` (a per-payment cap, or a
chain/host/token outside the allowlist), `'BUDGET'` (the lifetime cap), `'OUTSIDE_WINDOW'` (the
rolling window), `'SESSION_EXPIRED'`, or `'APPROVAL'` (`onBeforePay` refused). The `autoRoute`
"nothing settleable" decline carries the funding hint as `reason` with no `code`.

:::note
The event's `code` and the thrown `PaymentDeclinedError.reasonCode` are **one consistent value** for
a decline, so branch on whichever you're already reading. (For the *finer* cause, the read-only
[`quote.policyCode`](/making-payments/quote/), a `PolicyDenyCode` like `'MAX_AMOUNT'` vs `'MAX_TOTAL'`,
is available before you ever spend.)
:::

### Branching on the failure

Switch on `e.code` to route each failure to the right place: alert on a real rejection, ask the
human on an approval decline, top up on a budget block, ignore the rest:

```ts
onEvent: (e) => {
  if (e.kind !== 'payment-failed') return
  switch (e.code) {
    case 'APPROVAL':                       // onBeforePay said no: a deliberate human/agent choice
      log.info('payment declined by approval hook'); break
    case 'POLICY':                         // a per-payment cap or a chain/host/token outside the allowlist
    case 'BUDGET':                         // the lifetime cap
    case 'OUTSIDE_WINDOW':                 // the rolling spend window
    case 'SESSION_EXPIRED':                // a spend-policy ceiling: refill / extend the leash
      alerts.budget(e.reason); break
    case 'amount_too_low':
    case 'wrong_recipient':
    case 'signature_invalid':              // a definitive SERVER rejection: the proof is bad
      alerts.page(`gate rejected payment: ${e.code}: ${e.detail ?? e.reason}`); break
    default:                               // no code (foreign facilitator / autoRoute), so log the prose
      log.error(e.reason)
  }
}
```

:::caution
A `payment-failed` after a `payment-broadcast` does not mean nothing left your wallet. The
broadcast may have settled on-chain even though the server didn't accept the proof in time.
Treat the `ref` as a thing to verify, not a payment to retry. (A pre-send decline never reaches
broadcast, so there's nothing to recover, and it's safe to retry from scratch once you've fixed the cause.)
:::

## payment-declined: the rich decline

`payment-declined` is the **richer companion** to a pre-send decline. Every pre-send refusal still
emits `payment-failed` exactly as before (that's unchanged, for back-compat) but `payment-declined`
fires **as well**, and carries the full picture: the coarse `reasonCode`, the fine `code`, the
refused `quote`, and a `budget` snapshot of remaining headroom at the moment of refusal. If you only
care about the coarse value, stay on `payment-failed`; reach for `payment-declined` when you want to
know *how close to the limit you were* without a second `client.budget()` read.

- `reasonCode` is the coarse [`DeclineReasonCode`](/errors/error-hierarchy/), the same value the
  thrown [`PaymentDeclinedError`](/errors/why-payments-fail/) carries: `'POLICY'`, `'BUDGET'`,
  `'OUTSIDE_WINDOW'`, `'SESSION_EXPIRED'`, or `'APPROVAL'`.
- `code` is the fine [`PolicyDenyCode`](/spend-controls/evaluate-policy/): *which* guard fired
  (`'MAX_AMOUNT'`, `'MAX_TOTAL'`, `'MAX_TOTAL_DENOM'`, `'MAX_PAYMENTS'`, `'WINDOW_COUNT'`, …). The
  newer cross-token and count guards map down to the coarse codes you already branch on:
  `MAX_TOTAL_DENOM` and `MAX_PAYMENTS` → `'BUDGET'`, `WINDOW_COUNT` → `'OUTSIDE_WINDOW'`.
- `budget` is the [`SessionBudget`](/spend-controls/total-budget/). Read `budget.byDenom` for the
  cross-token grand total and `budget.counts` for the payment-count caps.

```ts
onEvent: (e) => {
  if (e.kind !== 'payment-declined') return
  // The fine guard tells you exactly which ceiling stopped it…
  log.warn(`declined: ${e.code ?? e.reasonCode}: ${e.reason}`)
  // …and the snapshot shows how close you were, no extra read needed.
  for (const d of e.budget.byDenom) {
    log.info(`${d.denom}: ${d.spentFormatted} / ${d.capFormatted} (${Math.round(d.fraction * 100)}%)`)
  }
}
```

:::note
`payment-declined` fires only on a **pre-send** refusal, so there is no `payment-declined` for a server
rejection of a submitted proof (that's `payment-failed` with a `VerifyErrorCode`). It's emitted in
addition to `payment-failed`, never instead of it, so existing `payment-failed` handlers keep working.
:::

## budget-threshold: an early warning

Set [`policy.warnAtFraction`](/spend-controls/payment-policy/) (a number in `(0, 1]`) and the client
emits a `budget-threshold` event the **first time** spend crosses that fraction of *any* cap: a
per-asset `maxTotal`, a cross-token `maxTotalPerDenom`, a lifetime `maxPayments`, or either rolling
window. It fires **once per crossing**, and it is **not** a failure. The payment that crossed the
line still settled. Use it to top up funds or widen the leash before a hard decline ever happens.

`scope` names what was crossed and `label` identifies the specific cap; `spentFormatted` /
`capFormatted` / `fraction` describe how far in:

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxTotalPerDenom: { USD: '20.00' }, warnAtFraction: 0.8 },
  onEvent: (e) => {
    if (e.kind !== 'budget-threshold') return
    // e.g. scope: 'denom', label: 'USD', spent: '16', cap: '20', fraction: 0.8
    alerts.budget(`approaching ${e.scope} cap on ${e.label}: ${e.spentFormatted} / ${e.capFormatted}`)
  },
})
```

| `scope` | The cap it warns about |
| --- | --- |
| `asset` | A per-asset [`maxTotal`](/spend-controls/total-budget/), where `label` is the token symbol. |
| `denom` | A cross-token [`maxTotalPerDenom`](/spend-controls/total-budget/), where `label` is the denomination (`'USD'`, `'EUR'`). |
| `count` | The lifetime `maxPayments` count, where `label` names the cap. |
| `window` | The rolling `windowTotal` value cap. |
| `window-count` | The rolling `maxPaymentsPerWindow` count cap. |

## Logging spend with onSpend

When you don't need the full per-stage stream and only want a tidy spend line after each successful
payment, pass the `onSpend` constructor option instead. It fires once **after each settle** with the
[`SpendRecord`](/spend-controls/spend-ledger/) just appended and the current
[`SessionBudget`](/spend-controls/total-budget/), with the same fire-and-forget, isolated contract as
`onEvent` (a throwing handler is swallowed):

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxTotalPerDenom: { USD: '20.00' } },
  onSpend: (record, budget) => {
    // record.denom / record.decimals are present when the token has a known denomination
    log.info(`paid ${record.amountFormatted} ${record.symbol} on ${record.network}`)
    const usd = budget.byDenom.find((d) => d.denom === 'USD')
    if (usd) log.info(`USD spent so far: ${usd.spentFormatted} / ${usd.capFormatted}`)
  },
})
```

:::tip
`onSpend` is the live, per-settle counterpart to the after-the-fact
[`client.spent()`](/spend-controls/spend-ledger/). Use the hook to stream spend as it happens, and
`spent()` for a one-shot total (including its `byDenom` grand totals). Neither needs a backend.
:::

## What the hook can't do

The hook is for observability only. It can't approve, deny, or alter a payment, so use
[`onBeforePay`](/spend-controls/payment-policy/) for the approval gate and a
[spend policy](/spend-controls/payment-policy/) for hard ceilings. A handler that throws is
swallowed silently so it can never abort the payment, so don't rely on it for control flow.

:::tip
For a one-shot, after-the-fact view of everything a client has paid, call
[`client.spent()`](/spend-controls/spend-ledger/) instead of accumulating events yourself,
it returns the running ledger.
:::
