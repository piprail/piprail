---
title: A2A transport (seller)
description: Accept x402 payments over Google's Agent2Agent (A2A) JSON-RPC, not just HTTP — map a PipRail gate onto A2A Task/Message metadata with one handler, sharing the same replay set as your HTTP gate. Backendless, additive.
sidebar:
  order: 9
---

## Introduction

x402 is transport-agnostic: the same payment envelope rides over plain HTTP **or** over
[Google's Agent2Agent (A2A)](https://google.github.io/A2A/) JSON-RPC, where a payment is a
**Task** that moves through `input-required → completed`. PipRail gives you the A2A **seller**
side as a thin adapter over the exact same [`PaymentGate`](/accepting-payments/require-payment-and-gate/)
you already use for HTTP — no second verifier, no backend.

```ts
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const pay = createA2APaymentHandler({
  gate, // ← pass the SAME gate your HTTP path uses (shared replay set — see below)
  fulfill: async ({ receipt }) => [{ name: 'result', parts: [{ kind: 'text', text: `Paid ${receipt.amount} — here's your result.` }] }],
})

// Wire it into your A2A server's message/send handler:
a2aAgent.on('message/send', ({ message, taskId }) => pay.handleMessage(message, taskId))

// And advertise x402 support on your AgentCard:
agentCard.capabilities.extensions.push(pay.agentCardExtension())
```

`handleMessage(message, taskId?)` returns an A2A **Task**; the payment state rides in the message
metadata under the `x402.payment.*` keys.

:::note[Offline core]
This is the seller-side handler, proven offline against the A2A spec. The A2A **buyer**
(`A2APayer`) and live cross-agent interop are a later ship-gate — the wire it emits is strict
`x402Version: 2`. The HTTP path is the fully live one; A2A reuses its exact verification.
:::

## How a payment Task flows

| Step | Inbound | PipRail returns | Task `state` · `x402.payment.status` |
|---|---|---|---|
| 1. Service request (no payment) | `message/send` with no payload | a challenge | `input-required` · `payment-required` |
| 2. Buyer submits a proof | `message/send` carrying `x402.payment.payload` | verify + (for exact/upto) settle | — |
| 3a. Valid | — | the served result + a receipt | `completed` · `payment-completed` |
| 3b. Rejected (expired/wrong-amount/replayed) | — | a fresh challenge + a failure receipt, **retryable** | `input-required` · `payment-rejected` |
| 3c. Settlement error (money never moved) | — | a terminal failure | `failed` · `payment-failed` |

The status values follow the A2A spec's lifecycle table exactly: the retryable `input-required`
state is only ever paired with `payment-required` (a fresh challenge) or `payment-rejected` (a
submitted proof that didn't verify); `payment-failed` is reserved for the terminal `failed` state.
Every failure carries a conformant receipt in the append-only `x402.payment.receipts` array
(`{ success: false, transaction: "", errorReason }`, plus `network` when the gate resolves a
single chain — best-effort, omitted only for a multi-chain gate).

## `gate.verifyObject(payload)` — the raw-JSON verify seam

The HTTP path verifies a **base64** `PAYMENT-SIGNATURE` header; A2A carries the payment as a raw
JSON object in metadata. `gate.verifyObject(rawObject)` is the object-level twin of `gate.verify`:
it runs the identical dispatch and re-derives every trusted field from your own config — it just
skips the base64 decode.

```ts
const result = await gate.verifyObject(message.metadata['x402.payment.payload'])
// result.kind: 'paid' | 'invalid' | 'challenge' — same VerifyPaymentResult as gate.verify()
```

Both seams **share the gate's one replay set**, so a proof settled over HTTP can't be replayed
over A2A (or vice-versa) — as long as you pass the *same* gate instance to
`createA2APaymentHandler`. Like every read path it never throws on malformed input; a garbage
object simply yields a fresh challenge.

## Options

```ts
createA2APaymentHandler({
  gate,                      // the shared PaymentGate (RECOMMENDED — one replay set across transports)
  fulfill: async (ctx) => [],// ({ taskId, receipt, message }) → A2A artifacts to attach on success
  taskStore,                 // optional bounded store correlating a follow-up to its in-flight Task
  taskTtlMs,                 // TTL for the default in-memory task store (default = the replay window)
  // …or, instead of `gate`, any inline RequirePaymentOptions to build a fresh gate (then a
  //   co-resident HTTP gate MUST share isUsed/markUsed, or a proof could be replayed cross-transport).
})
```

The returned handler is `{ handleMessage, agentCardExtension, gate }`. `agentCardExtension({ required?, version? })`
produces the x402 capability declaration to push into your AgentCard.

## See also

- [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) — the gate this wraps.
- [Verifying payments (HTTP)](/accepting-payments/verifying-payments/) — the base64 sibling of `verifyObject`.
- [Replay protection](/accepting-payments/replay-protection/) — the shared used-proof set both transports key off.
