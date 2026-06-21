---
title: A2A transport (seller)
description: Accept x402 payments over the Agent2Agent (A2A) protocol's JSON-RPC, not just HTTP — map a PipRail gate onto A2A Task/Message metadata with one handler, sharing the same replay set as your HTTP gate. Backendless, additive, x402-V2-conformant.
sidebar:
  order: 9
---

## Introduction

x402 is **transport-agnostic**: the same payment envelope rides over plain HTTP **or** over
[the Agent2Agent (A2A) protocol](https://a2a-protocol.org/)'s JSON-RPC. Over HTTP a 402 is a status
code and a header; over A2A a payment is a **Task** that moves `input-required → completed`, with
the x402 envelope carried in the Task/Message `metadata` under five namespaced `x402.payment.*`
keys instead of base64 headers.

:::note[Which A2A package?]
A2A is an **open protocol** — created by Google, now stewarded by the **Linux Foundation**
([a2a-protocol.org](https://a2a-protocol.org/), protocol v1.0). The official JavaScript runtime is
**[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)** (the `a2aproject` org; Apache-2.0;
Google-maintained), which is exactly what the [mount below](#mount-it-in-a2a-js-sdk) uses. PipRail's
A2A types are **duck-typed** (zero `@a2a` dependency), so any conformant A2A runtime works — `@a2a-js/sdk`
is just the one we prove against. The x402 **extension** keys + URI come from Google's
[`a2a-x402`](https://github.com/google-agentic-commerce/a2a-x402) reference (`x402_a2a`).
:::

PipRail gives you the A2A **seller** side as a thin adapter over the exact same
[`PaymentGate`](/accepting-payments/require-payment-and-gate/) you already use for HTTP — no second
verifier, no backend, no chain-specific code. It's a codec **above** the
[`PaymentDriver`](/concepts/payment-driver-architecture/) boundary, so every chain family works
over A2A for free, exactly as it works over HTTP.

```ts
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const pay = createA2APaymentHandler({
  gate, // ← the SAME gate your HTTP path uses (one shared replay set — see "Co-resident with HTTP")
  fulfill: async ({ receipt }) => [
    // `receipt` is the X402Receipt: `receipt.amount` is BASE units (e.g. "10000"), `receipt.asset`,
    // `receipt.transaction`, … — format with the token's decimals if you want a human amount.
    { name: 'result', parts: [{ kind: 'text', text: `Settled (tx ${receipt.transaction}) — here's your result.` }] },
  ],
})

const task = await pay.handleMessage(message, taskId) // → a transport-metadata A2A Task
```

`handleMessage(message, taskId?)` takes an inbound A2A message and returns a **transport-metadata** A2A
**Task**; the payment state rides in `task.status.message.metadata` under the `x402.payment.*` keys, keyed
off a coarse A2A Task `state`. You wire that into your A2A server's executor — see
[Mount it in `@a2a-js/sdk`](#mount-it-in-a2a-js-sdk) for a full, runnable server.

:::note[Transport metadata, not host ids]
The returned Task carries the x402 **payment** state, not the host-owned identifiers the `@a2a-js/sdk`
runtime requires — `Task.contextId`, `status.message.messageId`/`parts`, and `artifacts[].artifactId` are
all REQUIRED in the SDK's own types, and the **host adapter** (your `AgentExecutor`) stamps them before
`bus.publish` (the mount below does exactly this). That's deliberate: PipRail's A2A types are duck-typed
with **zero `@a2a` dependency**, so the same handler works against any A2A runtime. If you publish PipRail's
Task to a **non-`@a2a-js/sdk`** runtime, assign those ids yourself.
:::

:::note[Interop status — verified at the wire level]
The seller handler is **conformant with the current x402 standard (V2)**: the canonical
[`x402`](https://pypi.org/project/x402/) library parses PipRail's `PaymentRequired` and
`PaymentPayload` envelopes byte-identically (CAIP-2 networks, `amount`, `x402Version: 2`, nested
`accepted`), and the five `x402.payment.*` metadata keys + the extension URI match Google's official
`x402_a2a` constants verbatim. Proven by a live cross-check against Google's actual libraries (the reproducible harness +
verdict are in [`examples/a2a-interop/`](https://github.com/piprail/piprail/tree/main/examples/a2a-interop)),
the offline contract + the always-on wire-conformance guard (`a2a-seller.test.ts` +
`a2a-wire-conformance.test.ts`), and a live Base-mainnet settle through the handler
(`x402-parity-sandbox/suites/04-a2a-google.mjs`).

**Honest scope:** this is the **seller** side. The A2A **buyer** (`A2APayer`) and AP2 mandate
carriage are not built — today your HTTP buyer mints the payload that rides A2A (see
[Where the payload comes from](#where-the-buyers-payload-comes-from)). The legacy standalone
`x402-a2a` 0.1.0 Python package targets the older x402 **V1** schema (chain slugs, `maxAmountRequired`,
`x402Version: 1`) and is currently un-runnable on the live stack — PipRail deliberately tracks the
current **V2** standard, not that frozen snapshot. The `@a2a-js/sdk` mount below is **proven to run**
end-to-end against `@a2a-js/sdk` 0.3 — see the runnable
[`examples/a2a-server`](https://github.com/piprail/piprail/tree/main/examples/a2a-server) (it round-trips
a request through the SDK's own `ResultManager`).
:::

## Mount it in `@a2a-js/sdk`

A2A servers are **event-driven**: an `AgentExecutor.execute(requestContext, eventBus)` publishes
events. PipRail's `handleMessage` returns a *complete* Task, so the bridge is two lines —
`bus.publish(task); bus.finished()`.

```bash
npm i @piprail/sdk @a2a-js/sdk express
```

```ts
import express from 'express'
import { randomUUID } from 'node:crypto'
import type { AgentCard, Task } from '@a2a-js/sdk'
import {
  type AgentExecutor, type RequestContext, type ExecutionEventBus,
  DefaultRequestHandler, InMemoryTaskStore,
} from '@a2a-js/sdk/server'
import { A2AExpressApp } from '@a2a-js/sdk/server/express'
import { createPaymentGate, createA2APaymentHandler } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const pay = createA2APaymentHandler({
  gate,
  fulfill: async ({ taskId }) => [
    { name: 'result', parts: [{ kind: 'text', text: `Forecast for ${taskId}: clear skies.` }] },
  ],
})

// Bridge PipRail's complete-Task handler to the SDK's event-driven executor.
class X402Executor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const task = await pay.handleMessage(ctx.userMessage, ctx.taskId)
    // Stamp the SDK-required, host-owned identifiers the runtime correlates events by (messageId /
    // artifactId / contextId). PipRail's A2A types are transport metadata only (zero @a2a dep, by
    // design), so the adapter supplies these.
    const msg = task.status.message
    if (msg) { msg.messageId ??= randomUUID(); msg.parts ??= [] }
    for (const a of task.artifacts ?? []) a.artifactId ??= randomUUID()
    task.contextId = ctx.contextId
    bus.publish(task as unknown as Task)
    bus.finished()
  }
  async cancelTask(): Promise<void> {} // PipRail holds no long-running work to cancel
}

const agentCard: AgentCard = {
  name: 'My x402 Merchant',
  description: 'A paid skill, payable over A2A with x402.',
  url: 'https://my-agent.example.com/',
  version: '1.0.0',
  protocolVersion: '0.3.0',
  // Advertise the x402 extension so clients opt in (with the X-A2A-Extensions header):
  capabilities: { extensions: [pay.agentCardExtension({ required: false })] },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'forecast', name: 'Forecast', description: 'Pay-gated forecast.', tags: ['paid'] }],
}

const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new X402Executor())
const app = express()
new A2AExpressApp(handler).setupRoutes(app) // serves /.well-known/agent-card.json + message/send
app.listen(3000)
```

That's the whole seller: the AgentCard (with the x402 extension declaration) is served at
`/.well-known/agent-card.json`, and every `message/send` flows through `handleMessage`.
`pay.agentCardExtension({ required: false })` returns the
[`A2AExtensionDeclaration`](#metadata-keys) — `{ uri, description }`, plus `required: true` when you
set it. On a hand-built card, make sure `capabilities.extensions` is initialised to an array before
you push onto it.

:::tip[Runnable proof]
[`examples/a2a-server`](https://github.com/piprail/piprail/tree/main/examples/a2a-server) mounts
exactly this and round-trips a request **through the real `@a2a-js/sdk` `ResultManager`** — the
AgentCard advertises the extension, the `x402.payment.required` challenge reaches the client intact,
and a bogus proof re-challenges without throwing. `npm test` in that folder.
:::

## Where the buyer's payload comes from

A2A carries the buyer's payment as a **raw JSON object** under `x402.payment.payload` — the *same*
object the HTTP path base64-encodes into the `payment-signature` header. Until the A2A `A2APayer`
buyer ships, the simplest way to produce one is to pay an HTTP 402 with a
[`PipRailClient`](/making-payments/piprail-client/) and decode the `payment-signature` it sends:

```ts
import { PipRailClient, decodeBase64Json, HEADER_SIGNATURE, A2A_PAYLOAD_KEY } from '@piprail/sdk'

// The buyer pays a normal HTTP 402 once — its PipRailClient retries the request with the proof in the
// `payment-signature` header:
const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.KEY } })
await client.fetch('https://merchant.example/api/resource')

// Wherever that request lands (your HTTP gate, or a capturing fetch — `req` is the inbound request),
// the base64 `payment-signature` header it carried decodes to the EXACT object A2A wants:
const buyerPayload = decodeBase64Json(req.headers[HEADER_SIGNATURE])

// Hand it to a Merchant Agent over A2A:
const submission = { kind: 'message', role: 'user', taskId, metadata: { [A2A_PAYLOAD_KEY]: buyerPayload } }
```

The committed [`x402-parity-sandbox/suites/04-a2a-google.mjs`](https://github.com/piprail/piprail/blob/main/examples/basics/x402-parity-sandbox/suites/04-a2a-google.mjs)
is the working instance: it pays a real Base-mainnet payment and routes the decoded payload
**through the A2A handler** (`pay.handleMessage`), proving an end-to-end settle. (It runs over plain
`node:http`, not a JSON-RPC A2A runtime — it exercises the handler + the on-chain settle, not the
`@a2a-js/sdk` wiring.)

## The Task lifecycle

`handleMessage` mirrors `gate.verify()`'s [`VerifyPaymentResult`](/accepting-payments/verifying-payments/)
exactly, then dresses the verdict in an A2A Task. Each step pairs a Task `state` with an
`x402.payment.status` — and PipRail emits **only** the spec-correct **merchant** statuses
(`payment-required` / `payment-completed` / `payment-failed`):

| Step | Inbound | What PipRail returns | Task `state` · `x402.payment.status` |
|---|---|---|---|
| 1. Service request | `message/send` with **no** `x402.payment.payload` | a fresh challenge in `x402.payment.required` | `input-required` · `payment-required` |
| 2. Buyer submits a proof | `message/send` carrying `x402.payment.payload` | dispatched through `gate.verifyObject` | — |
| 3a. **Valid** (`kind: 'paid'`) | — | the served artifacts + a success receipt | `completed` · `payment-completed` |
| 3b. **Rejected** (`kind: 'invalid'`) | — | a fresh challenge + a failure receipt + error code — **retryable** | `input-required` · `payment-failed` |
| 3c. No usable proof (`kind: 'challenge'`) | — | a fresh challenge | `input-required` · `payment-required` |
| 3d. **Settlement error** (`SettlementError` thrown) | — | a **terminal** failure | `failed` · `payment-failed` |
| 3e. Settle OK but `fulfill` threw | — | the success receipt + an error-annotation artifact | `completed` · `payment-completed` |

Read the pairings carefully — they're the part most adapters get wrong. The key idea: the
**`x402.payment.status`** says *what happened to the payment*, while the A2A Task **`state`** says
*whether you can retry*. A failed payment is `payment-failed` either way — `input-required` when it's
retryable, `failed` when it's terminal.

- **`input-required` + `payment-required`** — a genuine challenge: the **first** 402 (no payload
  yet) or a present-but-empty payload (3c). No payment has failed, so the status is
  `payment-required` with **no** error code and **no** failure receipt.
- **`input-required` + `payment-failed`** — a submitted proof that **failed verification** (expired /
  wrong amount / replayed; 3b). Per the spec a failed payment is `payment-failed`, but it's still
  **retryable**: the Task stays `input-required`, a fresh challenge is re-issued in
  `x402.payment.required`, and the reason rides in the appended **failure receipt** +
  **`x402.payment.error`** code — so the buyer can fix the issue and retry on the **same** `taskId`.
- **`completed` + `payment-completed`** — the money moved. The success receipt is in
  `x402.payment.receipts[]` and the served work is in the Task's `artifacts[]`.
- **`failed` + `payment-failed`** — a settlement-side error: the relayer/facilitator never moved
  funds (only on the [`exact` rail](/accepting-payments/exact-rail-seller/)). Same status as a
  rejection, but **terminal** (`state: failed`) — re-submitting the same authorization won't help
  until the merchant fixes their relayer.

:::note[Why `payment-failed` for a rejection, and why not `payment-rejected`?]
The A2A x402 spec (§9) is a MUST: *"If a payment fails, the server MUST set the x402.payment.status
to payment-failed"* — and its worked example is an **expired signature** (a verification failure),
which emits `payment-failed` + `EXPIRED_PAYMENT`. Google's reference merchant executor matches it
exactly (`verify_response.is_valid == false → record_payment_failure → PAYMENT_FAILED`), while
leaving the Task `state` `input-required` for retry. So **retryability lives on the Task `state`, not
the status**. Separately, **`payment-rejected`** and **`payment-submitted`** are **client→merchant**
statuses (the *client* rejecting your offered requirements, or submitting a payload) — a *merchant*
never emits them. A merchant's only statuses are `payment-required`, `payment-completed`, and
`payment-failed`.
:::

Every failure carries a conformant receipt in the append-only `x402.payment.receipts` array:
`{ success: false, transaction: "", errorReason }`, plus `network` when it can be attributed (the
buyer's submitted rail for a settlement failure, the challenge's single rail for a rejection;
best-effort, omitted only when genuinely ambiguous). The `transaction: ""` is deliberate — the x402
v2 SettlementResponse marks `transaction` Required ("empty string if settlement failed"), so it's an
explicit empty string, never a missing key. (A **success** receipt is a *superset* of x402's
`SettleResponse` — it also carries `scheme` / `asset` / `payTo` / `verifiedAt`; a strict
`SettleResponse` consumer simply ignores the extras.)

## `gate.verifyObject(payload)` — the raw-JSON verify seam

The HTTP path verifies a **base64** `payment-signature` header; A2A carries the payment as a raw
JSON object in `metadata['x402.payment.payload']`. `gate.verifyObject(rawObject)` is the
object-level twin of `gate.verify` — it runs the **identical dispatch** (upto → exact →
onchain-proof), reads `sig.payload.nonce` off the object exactly as HTTP does, and re-derives every
trusted field (`payTo` / `amount` / `asset` / `network`) from your own config. It just skips the
base64 decode. Its mint-side twin is **`gate.challenge(url)`** — the same call `handleMessage` uses
to build the `x402.payment.required` block. For manual adapters, the low-level codecs
`toA2APaymentRequired`, `toA2APaymentReceipts`, `fromA2APaymentRequired`, and `fromA2APaymentPayload`
are exported too.

```ts
const result = await gate.verifyObject(message.metadata['x402.payment.payload'])
// result.kind: 'paid' | 'invalid' | 'challenge' — the SAME VerifyPaymentResult as gate.verify()
```

Two properties matter for A2A, and `createA2APaymentHandler` relies on both:

- **Shared replay set.** Pass the *same* gate instance to `createA2APaymentHandler`, and HTTP and
  A2A share **one** used-proof set. A proof settled over HTTP can't be replayed over A2A, or
  vice-versa — the nonce is claimed once, in one set, regardless of transport.
- **Never throws on malformed input.** A garbage, empty, or `null` payload object doesn't crash — it
  simply yields `kind: 'challenge'`, a fresh 402. (The *only* throw is a `SettlementError` on the
  `exact` rail, which the handler catches and maps to a `failed` Task; see the lifecycle table.)

You normally never call `verifyObject` yourself — `handleMessage` does, on the payload it reads out
of the inbound message. It's documented here because it's the seam that makes A2A and HTTP one gate.

## Co-resident with HTTP — one gate, one replay set

If you accept payments over **both** HTTP and A2A, build **one** gate and pass it to both adapters.
That's the whole trick — a proof settled on either transport is then un-replayable on the other:

```ts
import { requirePayment, createA2APaymentHandler, createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

app.use('/api', requirePayment({ gate }))            // HTTP
const pay = createA2APaymentHandler({ gate })         // A2A — SAME gate, SAME replay set
```

:::caution[The trap: two gates]
If you instead pass **inline options** (`createA2APaymentHandler({ chain, token, amount, payTo })`),
the handler builds its **own** gate with its **own** replay set — and a proof could be settled once
over each transport. If you must build separate gates, give them a shared store:

```ts
const used = new Set<string>()
const store = { isUsed: (r) => used.has(r), markUsed: (r) => { used.add(r) } } // or Redis, etc.
const httpGate = createPaymentGate({ /* … */, ...store })
const pay = createA2APaymentHandler({ /* … inline opts … */, ...store })       // same isUsed/markUsed
```

Passing the single shared `gate` avoids the trap entirely — prefer it. See
[Replay protection](/accepting-payments/replay-protection/).
:::

## Metadata keys

The payment state rides in five namespaced metadata keys, exported as constants so you never
hard-code a typo. A standard A2A reader ignores them, and they coexist with any other metadata.

| Constant | String value | Carries |
|---|---|---|
| `A2A_STATUS_KEY` | `x402.payment.status` | the `A2APaymentStatus` — PipRail (merchant) **emits** `payment-required` / `payment-completed` / `payment-failed`; `payment-submitted` / `payment-rejected` are **client→merchant** statuses it reads, never emits |
| `A2A_REQUIRED_KEY` | `x402.payment.required` | the raw `X402Challenge` (NOT base64) on a challenge |
| `A2A_PAYLOAD_KEY` | `x402.payment.payload` | the raw payment payload object the buyer submits (fed to `verifyObject`) |
| `A2A_RECEIPTS_KEY` | `x402.payment.receipts` | the append-only `(X402Receipt \| SettleOutcome)[]` history |
| `A2A_ERROR_KEY` | `x402.payment.error` | the spec error enum (e.g. `EXPIRED_PAYMENT`) on a rejection/failure |

Extension activation rides in an HTTP header on the A2A request:

| Constant | Value | Purpose |
|---|---|---|
| `A2A_EXTENSIONS_HEADER` | `X-A2A-Extensions` | the header a client sends to opt into the x402 extension |
| `A2A_X402_EXTENSION_URI_V01` | `https://github.com/google-a2a/a2a-x402/v0.1` | the default extension URI (the seller's `agentCardExtension()` advertises this) |
| `A2A_X402_EXTENSION_URI_V02` | `https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2` | the newer v0.2 URI (AP2 Embedded-Flow targets; carriage not yet built) |

```ts
import {
  A2A_STATUS_KEY, A2A_REQUIRED_KEY, A2A_PAYLOAD_KEY, A2A_RECEIPTS_KEY, A2A_ERROR_KEY,
  A2A_EXTENSIONS_HEADER,
} from '@piprail/sdk'

const rawPayload = message.metadata?.[A2A_PAYLOAD_KEY] // read by constant, not a string literal
```

PipRail maps its lowercase verify codes to the spec's screaming-snake error enum for
`x402.payment.error` (`payment_expired → EXPIRED_PAYMENT`, `tx_already_used → DUPLICATE_NONCE`,
`amount_too_low → INVALID_AMOUNT`, …) via the exported `toA2AErrorCode(code)`. The raw PipRail code
is still preserved in the re-challenge's `extensions.piprail`, so a buyer agent branches identically
across transports.

## Options

```ts
createA2APaymentHandler({
  gate,                       // the shared PaymentGate (RECOMMENDED — one replay set across transports)
  fulfill: async (ctx) => [], // ({ taskId, receipt, message }) → A2AArtifact[] to attach on success
  taskStore,                  // optional bounded store correlating a follow-up to its in-flight Task
  taskTtlMs,                  // TTL for the default in-memory task store (default = the replay window)
  // …or, instead of `gate`, any inline RequirePaymentOptions to build a fresh gate (see the trap above).
})
```

| Option | Type | Purpose |
|---|---|---|
| `gate` | `PaymentGate` | **The primary form.** Pass the SAME gate your HTTP path uses → one shared replay set. |
| `fulfill` | `(ctx: { taskId, receipt, message }) => A2AArtifact[] \| Promise<A2AArtifact[]>` | Produce the served artifacts for a settled task. Omit for a metadata-only completion. |
| `taskStore` | `A2ATaskStore` | A bounded, pluggable TRANSPORT-lifecycle store — correlates a follow-up `message/send` to its in-flight Task and accumulates `receipts[]`. Default = an in-memory TTL Map. NOT on the verification path. |
| `taskTtlMs` | `number` | TTL (ms) for the default task store. Default = `maxTimeoutSeconds * 1000` (the replay window). |

:::caution[The fulfill artifact shape]
A fulfill artifact is `{ name, parts: [{ kind: 'text', text }] }` — the content lives under `parts`,
**not** flat on the artifact. Returning `[{ name: 'result', text: '…' }]` puts the text where no A2A
reader looks. Each part is an `A2APart` (`kind: 'text' | 'data' | 'file'`). `fulfill` is optional —
omit it for a metadata-only "payment accepted" completion (the Task still reaches `completed` with the
receipt, just with no artifacts attached). You don't set `artifactId` — the host adapter assigns it (it's
a required `@a2a-js/sdk` field; the mount above stamps it). If you publish to a non-`@a2a-js/sdk` runtime,
assign one yourself.
:::

The `taskStore` holds only the per-task receipt history (`A2ATaskRecord = { receipts? }`) — no nonce,
no security state. That history is **bounded** to the most recent `MAX_TASK_RECEIPTS` (64) entries:
a real task holds one or two, but a hostile caller pinning one `taskId` and streaming throw-producing
payloads could otherwise grow it without limit, so only the tail is kept.

The returned handler is `{ handleMessage, agentCardExtension, gate }`.
`agentCardExtension({ required?, version? })` produces the `A2AExtensionDeclaration` to push into your
AgentCard — set `required: true` to reject callers that didn't activate the extension, and
`version: 'v0.2'` to advertise the newer URI (the URI only; AP2 mandate carriage is not yet built).
The `gate` is re-exposed as an escape hatch for advanced flows (`gate.describe()`,
`gate.landingPage()`).

## See also

- [Verifying payments (HTTP)](/accepting-payments/verifying-payments/) — `gate.verify`, the base64
  sibling of `verifyObject`, and the shared `VerifyPaymentResult`.
- [Replay protection](/accepting-payments/replay-protection/) — the shared used-proof set both
  transports key off, and the `isUsed` / `markUsed` hooks for multi-instance deploys.
- [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) — the gate
  this handler wraps.
- [The exact rail (seller)](/accepting-payments/exact-rail-seller/) — the only rail that settles on
  the server, and so the only one that can produce a `failed` · `payment-failed` Task.
