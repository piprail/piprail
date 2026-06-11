---
title: The error model
description: Two channels and only two — a thrown typed PipRailError on the imperative path, a returned VerifyErrorCode on the verify path — so every failure reaches you typed, never as an opaque chain-library blob.
sidebar:
  order: 1
---

## Introduction

PipRail reports every failure through exactly **two chain-agnostic channels**, and only two. An
EVM, Solana, TON, or Stellar failure looks identical to you — you always get a typed reason, never
a raw `viem` / `@solana` / `@ton` / `@stellar` error for a condition the SDK recognises.

| | Channel | Shape | For |
| --- | --- | --- | --- |
| 1 | **THROWN** | a typed [`PipRailError`](/errors/error-hierarchy/) subclass with a stable `.code` | config / flow / wallet / registry / affordability — things you act on |
| 2 | **RETURNED** | a [`VerifyErrorCode`](/errors/verify-error-code/) on `{ ok: false, error, detail }` | the outcome of verifying an on-chain proof, server side |

The rule of thumb: **config / flow / wallet / registry / affordability → throw; proof-verification
outcome → return.** This page is the map; the dedicated pages drill into each channel.

## Channel 1 — a thrown `PipRailError`

The imperative path — paying, binding a wallet, resolving a token, talking to the registry —
throws a typed error. Every one extends the abstract [`PipRailError`](/errors/error-hierarchy/)
base class, so you filter SDK-originated failures from arbitrary ones in one check:

```ts
import { PipRailClient, PipRailError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
})

try {
  const res = await client.fetch('https://api.example.com/report')
  const data = await res.json()
} catch (err) {
  if (err instanceof PipRailError) console.log(err.code, err.message)
  else throw err
}
```

Or branch directly on `.code` — a stable `SCREAMING_SNAKE` string that never changes:

```ts
try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PipRailError && err.code === 'PAYMENT_DECLINED') {
    // over policy / refused before any send — nothing moved
  } else throw err
}
```

Every `PipRailError` supports the standard `{ cause }` option, so the untouched chain error stays
attached on `.cause` for deeper debugging while the message reads in plain language. All concrete
classes are exported from `@piprail/sdk`. The full set of classes and their `.code` values is the
[error hierarchy](/errors/error-hierarchy/).

## Channel 2 — a returned `VerifyErrorCode`

A driver's `verify()` reports *why a proof was rejected* without throwing — it **returns** a
`VerifyResult`. This is the one place verification fails closed instead of throwing.

```ts
type VerifyResult =
  | { ok: true; receipt: X402Receipt }
  | { ok: false; error: VerifyErrorCode; detail: string }
```

`error` is a closed `snake_case` union the compiler enforces — `tx_not_found`, `amount_too_low`,
`tx_reverted`, and so on — so a driver can't invent a code, and the same condition uses the same
code everywhere. The gate turns a rejection into a conformant 402 re-challenge (carrying
`accepts[]` so a standard client can retry, the reason in `error`, the machine code in
`extensions.piprail.{code,detail}`). See the [verify error code](/errors/verify-error-code/) page
for the full union and which driver emits each.

:::note
Verification **fails closed**. If the gate's RPC read hiccups, `verify()` returns `tx_not_found`
and the gate replies 402 — never `paid`. An RPC outage can't trick a merchant into unlocking
without a real, on-chain-confirmed payment, and the proof is not burned: you can re-submit it once
the RPC recovers. See [replay protection](/accepting-payments/replay-protection/).
:::

## Affordability always converges on one error

"Wallet can't pay" always surfaces as a single thrown
[`InsufficientFundsError`](/errors/error-hierarchy/) (`.code === 'INSUFFICIENT_FUNDS'`), no matter
which chain detected it. The *detection* differs per family, the *result* never does:

```ts
try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PipRailError && err.code === 'INSUFFICIENT_FUNDS') {
    // fund the payer — more token, native gas, or reserve
  } else throw err
}
```

Message-regex drivers (Solana, TON) match the chain library's "can't afford it" message via the
exported `toInsufficientFundsError(err)` helper; structured-error drivers (EVM, Stellar) detect it
from typed data (viem's `BaseError` chain, Horizon `result_codes`) and *also* fall through to the
same helper as a backstop, so the two paths can't drift in vocabulary.

:::tip
Don't confuse it with [`RecipientNotReadyError`](/errors/error-hierarchy/) (`RECIPIENT_NOT_READY`).
That's a chain-*state* problem on the receiving side — XRPL not activated, a missing Stellar
trustline, an unregistered NEAR account — and the fix is the opposite: set up the *recipient*, not
fund the *payer*. PipRail keeps the two distinct on purpose.
:::

## Recovering a broadcast proof — never re-pay

Once a payment broadcasts, funds may have moved. If the broadcast succeeds but the server then
times out or keeps returning 402, the client throws `PaymentTimeoutError` or
`MaxRetriesExceededError` — and **only these two** carry the already-broadcast proof on **`.ref`**.
Narrow on the concrete class before reading it (the `PipRailError` base has no `.ref`):

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (
    (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) &&
    err.ref
  ) {
    // re-verify or RE-SUBMIT err.ref — never start a fresh payment
  } else throw err
}
```

The proof stays redeemable until the server's `maxTimeoutSeconds` recency window elapses (default
600s). A fresh payment would double-spend, so the recovery rule for these two codes is: read
`.ref`, re-submit it, never re-pay. A `ConfirmationTimeoutError` from your own `confirm()` poll
behaves the same way — the tx may still land — but it carries **no** `.ref`; re-check the proof
ref you already hold from `send()`, don't expect one on the error.

For the full picture of what happens to a payment when a request doesn't finish — on both the
client and the gate side — see [Replay protection &
recovery](/accepting-payments/replay-protection/#paid-but-didnt-receive--the-recovery-model).

## Branching on a decline reason

A `PaymentDeclinedError` is thrown *before* any send — the quote exceeded your
[spend policy](/spend-controls/payment-policy/), or an `onBeforePay` hook said no. Its `.code`
stays `'PAYMENT_DECLINED'`, but it carries an optional typed `.reasonCode` so an agent can branch
on *why* without parsing prose:

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PaymentDeclinedError) {
    // err.reasonCode: 'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' | 'SESSION_EXPIRED' | 'APPROVAL'
  } else throw err
}
```

`'SESSION_EXPIRED'` and `'APPROVAL'` are **terminal** — every payment this process makes is now
refused, so don't auto-retry; restart or extend the [time envelope](/spend-controls/time-envelope/)
first. This adds no new `.code` and no new class — it's a hint layered on the always-reliable
two-channel model.

## What an AI agent receives

The two channels are designed so a model never sees a raw exception. The
[agent toolkit](/agent-toolkit/the-7-tools/) funnels everything: its `piprail_pay_request` tool
catches **every** `PipRailError` and returns a structured `{ ok: false, code, reason, explain,
ref?, reasonCode?, declined? }` instead of letting it crash the loop — so a broadcast-but-unconfirmed
`PAYMENT_TIMEOUT` reaches the model with its `.ref` and the never-re-pay rule attached. Only a
genuine non-`PipRailError` bug rethrows.

## Where read-only methods sit

The read-only completion of the trio — `balanceOf`, `recipientReady`,
[`estimateCost()`](/making-payments/estimate-cost/), and the composed
[`planPayment()`](/making-payments/plan-payment/) — deliberately **never throw**. Like `verify()`,
they *return* their outcome: a transient read becomes a rail in `state: 'unknown'` with a warning,
an unsettleable rail carries typed `blockers`, and a missing field comes back `null` (never a false
`0`). The only throw on that path is `InvalidEnvelopeError` on an unparseable challenge — and
[`fetch(url, { autoRoute: true })`](/making-payments/fetch-and-autoroute/), the one place a plan
turns into a thrown `PaymentDeclinedError` when nothing is settleable.

[Discovery](/discovery/discover-and-register/) is read-style too: `client.discover()` reports `[]`
for a dead index rather than throwing, and `client.register()` returns one `{ ok, detail }` outcome
per target — surfaced, never swallowed.

This whole model is the SDK's single standard; it is specified in `sdk/ERRORS.md`, and every module
and chain driver conforms to it by construction.
