---
title: A2A transport (seller)
description: Accept x402 payments over Google's Agent2Agent (A2A) JSON-RPC, not just HTTP — map a PipRail gate onto A2A Task/Message metadata with one handler, sharing the same replay set as your HTTP gate. Backendless, additive.
sidebar:
  order: 9
---

## Introduction

x402 is **transport-agnostic**: the same payment envelope rides over plain HTTP **or** over
[Google's Agent2Agent (A2A)](https://google.github.io/A2A/) JSON-RPC. Over HTTP a 402 is a
status code and a header; over A2A a payment is a **Task** that moves through
`input-required → completed`, with the x402 envelope carried in the Task/Message `metadata`
under five namespaced `x402.payment.*` keys instead of base64 headers.

PipRail gives you the A2A **seller** side as a thin adapter over the exact same
[`PaymentGate`](/accepting-payments/require-payment-and-gate/) you already use for HTTP — no
second verifier, no backend, no chain-specific code. It's a codec **above** the
[`PaymentDriver`](/concepts/payment-driver/) boundary, so every chain family works over A2A for
free, exactly as it works over HTTP.

```ts
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const pay = createA2APaymentHandler({
  gate, // ← pass the SAME gate your HTTP path uses (shared replay set — see below)
  fulfill: async ({ receipt }) => [
    { name: 'result', parts: [{ kind: 'text', text: `Paid ${receipt.amount} — here's your result.` }] },
  ],
})

// Wire it into your A2A server's message/send handler:
a2aAgent.on('message/send', ({ message, taskId }) => pay.handleMessage(message, taskId))

// And advertise x402 support on your AgentCard:
agentCard.capabilities.extensions.push(pay.agentCardExtension())
```

`handleMessage(message, taskId?)` returns an A2A **Task**; the payment state rides in the
message metadata under the `x402.payment.*` keys, keyed off a coarse A2A Task `state`.

:::note[Offline-tested core]
This is the seller-side handler, proven **offline** against the A2A spec. The A2A **buyer**
(`A2APayer`) and live cross-agent interop are a later ship-gate — so the wire it emits is strict
`x402Version: 2`. The HTTP path is the fully live one; A2A reuses its exact verification with
zero driver, scheme, or chain changes.
:::

## Quick start

Three moves: build a gate, wrap it, and wire the wrapper into your A2A server.

```ts
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

// 1. One gate — the same object you'd pass to requirePayment.
const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

// 2. Wrap it. `fulfill` returns the artifacts to attach once a payment settles.
const pay = createA2APaymentHandler({
  gate,
  fulfill: async ({ receipt }) => [
    {
      name: 'result',
      parts: [{ kind: 'text', text: `Here is your generated report (paid ${receipt.amount}).` }],
    },
  ],
})

// 3. Route every inbound message through the handler.
a2aAgent.on('message/send', async ({ message, taskId }) => {
  return pay.handleMessage(message, taskId)
})

// 4. Declare the extension on your AgentCard so clients know you take x402.
agentCard.capabilities.extensions.push(pay.agentCardExtension())
```

:::caution[The fulfill artifact shape]
A fulfill artifact is `{ name, parts: [{ kind: 'text', text }] }` — the content lives under
`parts`, **not** flat on the artifact. Returning `[{ name: 'result', text: '…' }]` puts the text
where no A2A reader looks. Each part is an [`A2APart`](#metadata-keys) (`kind: 'text' | 'data' |
'file'`).
:::

`fulfill` is optional. Omit it for a metadata-only "payment accepted" completion (the Task still
reaches `completed` with the receipt, just with no artifacts attached).

## The Task lifecycle

`handleMessage` mirrors `gate.verify()`'s [`VerifyPaymentResult`](/accepting-payments/verifying-payments/)
exactly, then dresses the verdict in an A2A Task. Each step pairs a Task `state` with an
`x402.payment.status` — and PipRail emits **only** the spec-correct pairings:

| Step | Inbound | What PipRail returns | Task `state` · `x402.payment.status` |
|---|---|---|---|
| 1. Service request | `message/send` with **no** `x402.payment.payload` | a fresh challenge in `x402.payment.required` | `input-required` · `payment-required` |
| 2. Buyer submits a proof | `message/send` carrying `x402.payment.payload` | dispatched through `gate.verifyObject` | — |
| 3a. **Valid** (`kind: 'paid'`) | — | the served artifacts + a success receipt | `completed` · `payment-completed` |
| 3b. **Rejected** (`kind: 'invalid'`) | — | a fresh challenge + a failure receipt — **retryable** | `input-required` · `payment-rejected` |
| 3c. No usable proof (`kind: 'challenge'`) | — | a fresh challenge | `input-required` · `payment-required` |
| 3d. **Settlement error** (`SettlementError` thrown) | — | a **terminal** failure | `failed` · `payment-failed` |
| 3e. Settle OK but `fulfill` threw | — | the success receipt + an error-annotation artifact | `completed` · `payment-completed` |

Read the pairings carefully — they're the part most adapters get wrong:

- **`input-required` + `payment-required`** — the first challenge, or a re-issued one when the
  payload carried no usable proof. No receipt; identical to the very first 402.
- **`input-required` + `payment-rejected`** — a *submitted* proof that didn't verify (expired,
  wrong amount, replayed). This is **retryable**: the Task stays open, carries the error code,
  appends a failure receipt, and re-issues a fresh challenge so the buyer can try again on the
  **same** `taskId`. It is **`payment-rejected`, NOT `payment-failed`** — the spec reserves the
  terminal `payment-failed` for the `failed` state, and a rejected-but-retryable proof is not
  terminal.
- **`completed` + `payment-completed`** — the money moved. The success receipt is in
  `x402.payment.receipts[]` and the served work is in the Task's `artifacts[]`.
- **`failed` + `payment-failed`** — a settlement-side error: the relayer/facilitator never moved
  funds (only on the [`exact` rail](/accepting-payments/exact-rail-seller/)). **Terminal** —
  re-submitting the same authorization won't help until the merchant fixes their relayer.

Every failure carries a conformant receipt in the append-only `x402.payment.receipts` array:
`{ success: false, transaction: "", errorReason }`, plus `network` when it can be attributed (the
buyer's submitted rail for a settlement failure, the challenge's single rail for a rejection;
best-effort, omitted only when genuinely ambiguous). The `transaction: ""` is deliberate — the
x402 v2 SettlementResponse marks `transaction` as Required ("empty string if settlement failed"),
so it's an explicit empty string, never a missing key.

## `gate.verifyObject(payload)` — the raw-JSON verify seam

The HTTP path verifies a **base64** `payment-signature` header; A2A carries the payment as a raw
JSON object in `metadata['x402.payment.payload']`. `gate.verifyObject(rawObject)` is the
object-level twin of `gate.verify` — it runs the **identical dispatch** (upto → exact →
onchain-proof), reads `sig.payload.nonce` off the object exactly as HTTP does, and re-derives
every trusted field (`payTo` / `amount` / `asset` / `network`) from your own config. It just
skips the base64 decode.

```ts
const result = await gate.verifyObject(message.metadata['x402.payment.payload'])
// result.kind: 'paid' | 'invalid' | 'challenge' — the SAME VerifyPaymentResult as gate.verify()
```

Two properties matter for A2A, and `createA2APaymentHandler` relies on both:

- **Shared replay set.** Pass the *same* gate instance to `createA2APaymentHandler`, and HTTP and
  A2A share **one** used-proof set. A proof settled over HTTP can't be replayed over A2A, or
  vice-versa — the nonce is claimed once, in one set, regardless of transport.
- **Never throws on malformed input.** A garbage, empty, or `null` payload object doesn't crash —
  it simply yields `kind: 'challenge'`, a fresh 402. (The *only* throw is a `SettlementError` on
  the `exact` rail, which the handler catches and maps to a `failed` Task; see the lifecycle
  table above.)

You normally never call `verifyObject` yourself — `handleMessage` does, on the payload it reads
out of the inbound message. It's documented here because it's the seam that makes A2A and HTTP one
gate, not two.

## Metadata keys

The payment state rides in five namespaced metadata keys, exported as constants so you never
hard-code a typo. A standard A2A reader ignores them, and they coexist with any other metadata.

| Constant | String value | Carries |
|---|---|---|
| `A2A_STATUS_KEY` | `x402.payment.status` | the `A2APaymentStatus` (`payment-required` / `payment-completed` / `payment-rejected` / `payment-failed`) |
| `A2A_REQUIRED_KEY` | `x402.payment.required` | the raw `X402Challenge` (NOT base64) on a challenge |
| `A2A_PAYLOAD_KEY` | `x402.payment.payload` | the raw payment payload object the buyer submits (fed to `verifyObject`) |
| `A2A_RECEIPTS_KEY` | `x402.payment.receipts` | the append-only `(X402Receipt \| SettleOutcome)[]` history |
| `A2A_ERROR_KEY` | `x402.payment.error` | the spec error enum (e.g. `EXPIRED_PAYMENT`) on a rejection/failure |

Extension activation rides in an HTTP header on the A2A request:

| Constant | Value | Purpose |
|---|---|---|
| `A2A_EXTENSIONS_HEADER` | `X-A2A-Extensions` | the header a client sends to opt into the x402 extension |
| `A2A_X402_EXTENSION_URI_V01` | `https://github.com/google-a2a/a2a-x402/v0.1` | the default extension URI (the seller's `agentCardExtension()` advertises this) |
| `A2A_X402_EXTENSION_URI_V02` | `https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2` | the newer v0.2 URI (AP2 Embedded-Flow targets) |

```ts
import {
  A2A_STATUS_KEY,       // 'x402.payment.status'
  A2A_REQUIRED_KEY,     // 'x402.payment.required'
  A2A_PAYLOAD_KEY,      // 'x402.payment.payload'
  A2A_RECEIPTS_KEY,     // 'x402.payment.receipts'
  A2A_ERROR_KEY,        // 'x402.payment.error'
  A2A_EXTENSIONS_HEADER, // 'X-A2A-Extensions'
} from '@piprail/sdk'

// e.g. read the inbound payload by constant rather than a string literal:
const rawPayload = message.metadata?.[A2A_PAYLOAD_KEY]
```

PipRail also maps its lowercase verify codes to the spec's screaming-snake error enum for
`x402.payment.error` (`payment_expired → EXPIRED_PAYMENT`, `tx_already_used → DUPLICATE_NONCE`,
`amount_too_low → INVALID_AMOUNT`, …) via the exported `toA2AErrorCode(code)`. The raw PipRail
code is still preserved in the re-challenge's `extensions.piprail`, so a buyer agent branches
identically across transports.

## Options

```ts
createA2APaymentHandler({
  gate,                       // the shared PaymentGate (RECOMMENDED — one replay set across transports)
  fulfill: async (ctx) => [], // ({ taskId, receipt, message }) → A2AArtifact[] to attach on success
  taskStore,                  // optional bounded store correlating a follow-up to its in-flight Task
  taskTtlMs,                  // TTL for the default in-memory task store (default = the replay window)
  // …or, instead of `gate`, any inline RequirePaymentOptions to build a fresh gate (see the caveat).
})
```

| Option | Type | Purpose |
|---|---|---|
| `gate` | `PaymentGate` | **The primary form.** Pass the SAME gate your HTTP path uses → one shared replay set. |
| `fulfill` | `(ctx: { taskId, receipt, message }) => A2AArtifact[] \| Promise<A2AArtifact[]>` | Produce the served artifacts for a settled task. Omit for a metadata-only completion. |
| `taskStore` | `A2ATaskStore` | A bounded, pluggable TRANSPORT-lifecycle store — correlates a follow-up `message/send` to its in-flight Task and accumulates `receipts[]`. Default = an in-memory TTL Map. NOT on the verification path. |
| `taskTtlMs` | `number` | TTL (ms) for the default task store. Default = `maxTimeoutSeconds * 1000` (the replay window). |

The handler also accepts any inline [`RequirePaymentOptions`](/accepting-payments/require-payment-and-gate/)
(`chain` / `token` / `amount` / `payTo` / `exact` / …) **instead of** `gate`, and builds a fresh
gate from them.

:::caution[Build a fresh gate only if you must]
If you pass inline options instead of a `gate`, `createA2APaymentHandler` builds its **own** gate
with its **own** replay set. A co-resident HTTP gate must then share `isUsed` / `markUsed` (see
[Replay protection](/accepting-payments/replay-protection/)), or a proof settled over one
transport could be replayed over the other. Passing the single shared `gate` avoids the trap
entirely — prefer it.
:::

The `taskStore` holds only the per-task receipt history (`A2ATaskRecord = { receipts? }`) — no
nonce, no security state. That history is **bounded** to the most recent `MAX_TASK_RECEIPTS` (64)
entries: a real task holds one or two, but a hostile caller pinning one `taskId` and streaming
throw-producing payloads could otherwise grow it without limit, so only the tail is kept.

The returned handler is `{ handleMessage, agentCardExtension, gate }`.
`agentCardExtension({ required?, version? })` produces the
[`A2AExtensionDeclaration`](#worked-end-to-end-example) to push into your AgentCard — set
`required: true` to reject callers that didn't activate the extension, and `version: 'v0.2'` to
advertise the newer URI. The `gate` is re-exposed as an escape hatch for advanced flows
(`gate.describe()`, `gate.landingPage()`).

## Worked end-to-end example

A full seller round-trip: challenge → buyer submits → completed Task with a receipt and a
fulfilled artifact.

```ts
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const pay = createA2APaymentHandler({
  gate,
  fulfill: async ({ taskId, receipt }) => {
    // The money has moved; serve the merchant's actual work here.
    return [
      {
        name: 'forecast',
        parts: [{ kind: 'text', text: `Forecast for task ${taskId}: clear skies (paid ${receipt.amount}).` }],
      },
    ]
  },
})

// Advertise x402 on the AgentCard (clients opt in with the X-A2A-Extensions header):
agentCard.capabilities.extensions.push(pay.agentCardExtension({ required: false }))
// → { uri: 'https://github.com/google-a2a/a2a-x402/v0.1',
//     description: 'Supports payments using the x402 protocol for on-chain settlement.' }

// 1. First contact — no payload. handleMessage returns an input-required Task:
const challengeTask = await pay.handleMessage({ kind: 'message', role: 'user', parts: [] })
// challengeTask.status.state                                  === 'input-required'
// challengeTask.status.message.metadata['x402.payment.status'] === 'payment-required'
// challengeTask.status.message.metadata['x402.payment.required'] is the X402Challenge (raw JSON)
const taskId = challengeTask.id

// 2. The buyer signs/pays and re-sends on the SAME taskId, carrying the payload:
const submission = {
  kind: 'message' as const,
  role: 'user',
  taskId,
  metadata: { 'x402.payment.payload': /* the raw PaymentPayload object the buyer built */ buyerPayload },
}
const done = await pay.handleMessage(submission, taskId)
// done.status.state                                  === 'completed'
// done.status.message.metadata['x402.payment.status'] === 'payment-completed'
// done.status.message.metadata['x402.payment.receipts'][0] is the success X402Receipt:
//   { scheme, success: true, network, transaction, asset, amount, payer, payTo, verifiedAt }
// done.artifacts[0] === { name: 'forecast', parts: [{ kind: 'text', text: 'Forecast … clear skies …' }] }
```

If step 2's proof were expired or replayed, `done.status.state` would instead be `input-required`
with `x402.payment.status: 'payment-rejected'`, a failure receipt
(`{ success: false, transaction: '', network, errorReason }`) appended to `receipts[]`, and a
fresh `x402.payment.required` challenge — so the buyer can retry on the same `taskId`.

## See also

- [Verifying payments (HTTP)](/accepting-payments/verifying-payments/) — `gate.verify`, the
  base64 sibling of `verifyObject`, and the shared `VerifyPaymentResult`.
- [Replay protection](/accepting-payments/replay-protection/) — the shared used-proof set both
  transports key off, and the `isUsed` / `markUsed` hooks for multi-instance deploys.
- [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) — the
  gate this handler wraps.
- [The exact rail (seller)](/accepting-payments/exact-rail-seller/) — the only rail that settles
  on the server, and so the only one that can produce a `failed` · `payment-failed` Task.
