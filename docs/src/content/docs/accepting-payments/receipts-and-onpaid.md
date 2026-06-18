---
title: "Receipts & onPaid"
description: Record every settled payment — the onPaid callback (sync or async, fully isolated), the enriched PaidReceipt, awaitOnPaid, at-least-once delivery with deliverReceipt, and buildReceiptHeader for hand-rolled servers.
sidebar:
  order: 4
---

## Introduction

A gate verifies a payment on-chain, then needs to *do* something with it — fulfil an order,
log the spend, increment a counter. The `onPaid` callback is where that happens, and the
[`PaidReceipt`](#the-paidreceipt) it hands you is the verified record of the payment: amount
(base **and** formatted), asset, payer, and the settled transaction id. Everything in a receipt
was re-derived from your own trusted [`accept`](/accepting-payments/defining-accepts/) during
[verification](/accepting-payments/verifying-payments/), never taken from the client. The hook is
isolated, may be sync or async, and can deliver receipts durably — all covered below.

`onPaid` has a mirror — [`onFailed`](#failure-notifications--onfailed) — that fires when a
submitted proof is *rejected* (`gate.verify()` returns `kind: 'invalid'`). Wire both and the gate
notifies you of every settlement **and** every rejection, with the buyer told the same machine
reason; that section is at the end.

## The `onPaid` callback

Pass `onPaid` to [`requirePayment`](/accepting-payments/require-payment-and-gate/) or
`createPaymentGate`. It fires after verification succeeds and the proof has been recorded as
used — so by the time it runs, the payment is real and replay-safe. It receives a
[`PaidReceipt`](#the-paidreceipt): the wire receipt **plus** the display fields the gate already
computed (`decimals`, `symbol`, `amountFormatted`) and a stable `idempotencyKey`, so you never
need a second lookup to record or render it:

```ts
requirePayment({
  chain: 'bnb', token: 'FDUSD', amount: '0.05', payTo: '0xYourWallet',
  onPaid: (r) => console.log(`paid ${r.amountFormatted} ${r.symbol} — tx ${r.transaction}`),
  // r.amount is still base units ("50000…"); r.amountFormatted is "0.05"; r.idempotencyKey = the tx id
})
```

### Sync or async — and always isolated

`onPaid` may be **synchronous or `async`**. Either way it is fully isolated: a thrown error **or
a rejected promise** is caught and routed to `onPaidError` — it can never break the request,
hold up a response it isn't awaiting, or escape as an `unhandledRejection` that crashes the
process. So the natural async handler is safe:

```ts
onPaid: async (r) => {
  await db.insert('payments', { tx: r.transaction, amount: r.amount })  // a rejection here is isolated
},
onPaidError: (err, r) => logger.error({ err, tx: r.transaction }, 'receipt persist failed'),
```

:::tip[Make failures visible]
Without `onPaidError`, a failing receipt hook is swallowed silently (the safe default — it
protects the request). Set `onPaidError` to log, alert, or queue the dropped receipt so a
delivery failure never disappears.
:::

### Fire-and-forget, or `awaitOnPaid`

By default `onPaid` is **fire-and-forget**: the gate does not block the response on it. That
keeps latency low, but it means a process crash between settlement and your side-effect drops
that receipt. Two ways to make it durable:

- **`awaitOnPaid: true`** — the gate awaits the hook before serving the resource, so "receipt
  recorded" is guaranteed on the happy path (at the cost of that latency). A rejection is still
  isolated to `onPaidError`; it never turns a settled payment into a 402.
- **Push to a durable queue inside the hook** — keep the hook fast (enqueue and return) and do
  the heavy work in your own worker. For a webhook, use [`deliverReceipt`](#reliable-delivery).

### The idempotency contract

`onPaid` is **at-least-once**. With the default in-memory [replay store](/accepting-payments/replay-protection/)
it fires exactly once per proof. But across **multiple instances** sharing a custom
`isUsed`/`markUsed` store, two nodes can settle the same proof in a race and each fire once.
**Always dedupe on `receipt.idempotencyKey`** (a unique index or upsert):

```ts
onPaid: async (r) => {
  await db.payments.upsert({ where: { tx: r.idempotencyKey }, create: { …r }, update: {} })
}
```

## The `X402Receipt`

The receipt is the verified settlement record, identical for both the `onchain-proof` and
`exact` rails:

```ts
interface X402Receipt {
  scheme: 'onchain-proof' | 'exact'
  success: true            // always true — a failed verification is a 402, never a receipt
  network: Caip2           // CAIP-2 network id, e.g. 'eip155:8453'
  transaction: string      // the SETTLED on-chain tx id (see below)
  asset: AssetId           // the token paid: a 0x… address, an SPL mint, or 'native'
  amount: string           // base units (already scaled by decimals)
  payer: AddressId         // who paid
  payTo: AddressId         // your receive address, re-derived from the trusted accept
  verifiedAt: string       // ISO timestamp of verification
}
```

| Field | What it is |
| --- | --- |
| `transaction` | The on-chain id of the **settled** payment — an EVM/Tron/Stellar/XRPL/NEAR tx hash, a Solana signature, or a Sui digest. This is the verified tx itself, not the submit-time proof ref. |
| `amount` | Base units. Divide by the token's decimals to render it (e.g. `100000` USDC = `0.10`). |
| `asset` | The asset id — `'native'` for the chain's coin, otherwise the chain-specific token id. |
| `payer` | The address the payment came from, read off-chain during verification. |

:::caution
`amount` is in **base units**, not the human-readable string. A 6-decimal token like USDC
reports `0.10` as `"100000"`. The wire receipt is deliberately exact — but the `PaidReceipt`
your `onPaid` hook receives also carries the display fields, so you rarely touch base units.
:::

### The `PaidReceipt`

`onPaid` and `onPaidError` get a `PaidReceipt` — every `X402Receipt` field **plus** the
merchant-facing extras the gate already resolved for the challenge, so a receipt handler never
needs a second lookup:

```ts
interface PaidReceipt extends X402Receipt {
  decimals: number          // the token's on-chain decimals (pairs with `amount`)
  symbol?: string           // 'USDC', 'FDUSD', … when known
  amountFormatted: string   // "0.05" — derived from the SETTLED `amount`, not the requested price
  idempotencyKey: string    // the settled tx id; dedupe at-least-once delivery on this
}
```

The wire `X402Receipt` (the header, `result.receipt`) stays the lean settlement record; the
enrichment is only on the hook payload.

## Recording a settled payment

The two fields you almost always want are `amount` and `transaction` — the *how much* and the
*proof on-chain*. Together with `payer` they're enough to credit an account or fulfil an order:

```ts
onPaid: (receipt) => {
  db.insert('payments', {
    payer: receipt.payer,
    asset: receipt.asset,
    amount: receipt.amount,        // base units
    tx: receipt.transaction,       // the settled on-chain id
    network: receipt.network,
    at: receipt.verifiedAt,
  })
}
```

Because `transaction` is unique and `onPaid` only fires after the gate's
[replay store](/accepting-payments/replay-protection/) has claimed the proof, `idempotencyKey`
(= `transaction`) is your dedupe key. On one instance it fires once per proof; across instances
it's [at-least-once](#the-idempotency-contract), so make your write idempotent on that key.

## Reliable delivery

A stateless gate can't be a durable webhook on its own — that's exactly why `deliverReceipt`
exists. It POSTs a settled `PaidReceipt` to **your own** endpoint with retries + exponential
backoff, an HMAC-SHA256 signature, and an idempotency-key header. It **never throws** (a failed
delivery comes back as `{ delivered: false, … }`), so it's safe as the body of an `onPaid` hook:

```ts
import { createPaymentGate, deliverReceipt } from '@piprail/sdk'

createPaymentGate({
  chain: 'bnb', token: 'FDUSD', amount: '0.05', payTo: '0xYourWallet',
  awaitOnPaid: true,                                  // record before serving the resource
  onPaid: (r) => deliverReceipt(r, {
    url: process.env.RECEIPTS_WEBHOOK,                 // YOUR endpoint — PipRail hosts nothing
    secret: process.env.RECEIPTS_SECRET,              // signs the body: `piprail-signature: sha256=…`
  }),
  onPaidError: (err, r) => logger.error({ err, tx: r.transaction }, 'receipt delivery threw'),
})
```

On your receiver: verify the `piprail-signature` (HMAC-SHA256 of the raw body with your secret)
and **upsert on the `idempotency-key` header** — `deliverReceipt`'s retries and at-least-once
`onPaid` both mean the same receipt may arrive more than once.

It retries `408`/`429`/`5xx` and transport errors; a permanent `4xx` stops immediately. By default
`retries: 5` (up to 6 POSTs) with a 10s per-attempt timeout. Tune it
with `retries`, `timeoutMs`, `backoff`, `headers`, and observe each try with `onAttempt`:

```ts
const result = await deliverReceipt(receipt, {
  url, secret,
  retries: 8,                 // up to 9 POSTs
  timeoutMs: 5000,            // per attempt
  onAttempt: ({ attempt, status, willRetry }) => metrics.inc('receipt.try', { attempt, status, willRetry }),
})
if (!result.delivered) deadLetter.push(receipt)   // give up gracefully after the budget
```

For a queue instead of a webhook, keep the hook fast and let your worker do the heavy lifting:

```ts
onPaid: (r) => queue.add('receipt', r),           // enqueue-and-return; the worker reconciles + retries
```

## Hand-rolled servers — `buildReceiptHeader`

If you're driving `createPaymentGate` yourself rather than using the Express middleware, the
`'paid'` result already carries a ready-to-send header in `result.receiptHeader`. Set it under
both the v2 and v1 response header names so any client reads it. Accept the inbound proof from
**either** the v2 `payment-signature` header or the legacy v1 `x-payment` header — the gate
parses both:

```ts
import {
  createPaymentGate,
  SettlementError,
  HEADER_SIGNATURE,
  HEADER_SIGNATURE_V1,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_RESPONSE_V1,
} from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })

let result
try {
  result = await gate.verify(req.headers[HEADER_SIGNATURE] ?? req.headers[HEADER_SIGNATURE_V1])
  // → { kind: 'paid', receipt, receiptHeader }            on a verified, unused proof — fires onPaid
  //   { kind: 'challenge', challenge, requiredHeader, statusCode: 402 }   no proof yet — fires NEITHER hook
  //   { kind: 'invalid', error, detail, challenge, requiredHeader, statusCode: 402 }  rejected proof — fires onFailed
} catch (err) {
  // ONLY the optional `exact` rail throws: a server-side settle failure (relayer out of gas,
  // facilitator down) is NOT the payer's fault — reply 5xx, never a 402 (which says "re-pay").
  if (err instanceof SettlementError) {
    res.statusCode = 502
    res.end(JSON.stringify({ x402Version: 2, error: 'settlement_failed', detail: err.message }))
    return
  }
  throw err
}

if (result.kind === 'paid') {
  res.setHeader(HEADER_RESPONSE, result.receiptHeader)
  res.setHeader(HEADER_RESPONSE_V1, result.receiptHeader)   // legacy x-payment-response
  // ... serve the resource
} else {
  // 'challenge' (first hit) or 'invalid' (rejected proof) — both carry `challenge`
  res.setHeader(HEADER_REQUIRED, result.requiredHeader)
  res.statusCode = 402
  res.end(JSON.stringify(result.challenge))   // always send result.challenge — it carries accepts[]
}
```

For a fully bespoke flow where you already hold an `X402Receipt` and need to encode it yourself,
`buildReceiptHeader` is the raw codec — base64 JSON of the receipt, the inverse of the client's
[`parseReceipt`](/reference/wire-codecs/):

```ts
import { buildReceiptHeader, HEADER_RESPONSE } from '@piprail/sdk'

const receipt = result.receipt   // an X402Receipt from a 'paid' gate.verify() result
res.setHeader(HEADER_RESPONSE, buildReceiptHeader(receipt))
// → 'eyJzY2hlbWUiOiJvbmNoYWluLXByb29mIiwic3VjY2VzcyI6dHJ1ZSwi…'  (base64 JSON)
```

:::note
The built-in `requirePayment` middleware sets both headers for you on a `'paid'` result, and
returns `502` on a `SettlementError` itself — you only reach for `buildReceiptHeader` and the
manual `try/catch` when you've stepped outside the gate entirely. See the
[wire codecs](/reference/wire-codecs/) reference for the full envelope set.
:::

## Failure notifications — `onFailed`

`onPaid` tells you when a payment *settled*. `onFailed` is its exact mirror: it fires when a
**submitted proof is rejected** — when [`gate.verify()`](/accepting-payments/verifying-payments/)
returns `kind: 'invalid'`. Wrong amount, expired, replayed, unknown asset, wrong recipient, a bad
`exact`-rail signature — any verdict that becomes a 402 rejection fires `onFailed`. It carries the
**same machine `code`** the buyer's client is told for that rejection, so both sides see one
consistent reason for the same failure.

Pass it to [`requirePayment`](/accepting-payments/require-payment-and-gate/) or `createPaymentGate`
exactly like `onPaid` — it fires through both, because it fires *inside* `gate.verify()`:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  onPaid:   (r) => console.log(`paid ${r.amountFormatted} ${r.symbol} — tx ${r.transaction}`),
  onFailed: (f) => console.warn(`rejected: ${f.code} — ${f.detail}`),  // the mirror of onPaid
})
```

### The `FailedPayment`

`onFailed` and `onFailedError` get a `FailedPayment`. A rejection has **no settlement**, so —
unlike a [`PaidReceipt`](#the-paidreceipt) — there's no tx hash, amount, or payer to report. It's
exactly three fields:

```ts
interface FailedPayment {
  code: VerifyErrorCode   // the canonical rejection reason — the SAME code the buyer is given
  detail: string          // human-readable detail, e.g. "Paid 40000, required 500000."
  transient: boolean      // true for the two transient codes — the proof may still be settling
}
```

| Field | What it is |
| --- | --- |
| `code` | The closed [`VerifyErrorCode`](/errors/verify-error-code/) for the rejection — `amount_too_low`, `payment_expired`, `tx_already_used`, `transfer_not_found`, `signature_invalid`, … Branch on this; it's the same code the buyer's client reads off `extensions.piprail.code`. |
| `detail` | The human-readable explanation, for logs — e.g. `"Paid 40000, required 500000."` or `"Proof 0xabc… was already redeemed."`. |
| `transient` | `true` only for the two transient codes `tx_not_found` / `insufficient_confirmations` — the proof may still be settling and the buyer auto-retries. `false` for a definitive rejection the buyer must fix. See below. |

### The `transient` flag — real failures vs lag

A rejection isn't always a *real* failure. The two transient codes —
[`tx_not_found`](/errors/verify-error-code/) (the proof tx hasn't propagated to your RPC node yet,
or the read itself blipped) and `insufficient_confirmations` (mined, but not yet
`minConfirmations` deep) — mean the proof may **still be settling**. The buyer's client
[retries automatically](/errors/why-payments-fail/), so a `transient: true` rejection is usually
followed by `onPaid` on a later attempt once the node catches up.

So **alert on `!transient`**, log everything:

```ts
onFailed: (f) => {
  metrics.inc('payment.rejected', { code: f.code })   // count every rejection
  if (!f.transient) {
    // a DEFINITIVE rejection the buyer must fix (wrong amount, expired, replayed, bad signature)
    alerts.warn(`payment rejected: ${f.code} — ${f.detail}`)
  }
  // f.transient === true → normal RPC lag; the buyer is already retrying. Don't page anyone.
}
```

Nothing is hidden: every rejected attempt — transient or not — fires `onFailed`. The flag just
tells you whether it's worth waking someone up. See
[`VerifyErrorCode`](/errors/verify-error-code/) for the full transient-vs-definitive table.

### Sync or async — and always isolated

Identical to `onPaid`. `onFailed` may be **synchronous or `async`**, and is fully isolated: a
thrown error **or a rejected promise** is caught and routed to `onFailedError` — it can never break
the request, hold up a response it isn't awaiting, or escape as an `unhandledRejection`:

```ts
onFailed: async (f) => {
  await db.insert('failed_attempts', { code: f.code, detail: f.detail, transient: f.transient })  // a rejection here is isolated
},
onFailedError: (err, f) => logger.error({ err, code: f.code }, 'failure-record persist failed'),
```

`onFailedError(error, failure)` is the mirror of [`onPaidError`](#sync-or-async--and-always-isolated):
it observes a throw inside `onFailed`, and is itself isolated (even a throwing error handler can't
break a request). Without it, a failing `onFailed` hook is swallowed silently — set it to log or
alert the dropped record.

### Fire-and-forget, or `awaitOnFailed`

By default `onFailed` is **fire-and-forget**: the gate doesn't block the 402 rejection on it.
`awaitOnFailed: true` mirrors [`awaitOnPaid`](#fire-and-forget-or-awaitonpaid) — the gate awaits
the hook before the 402 is returned, so "failure recorded" is guaranteed before the caller is told.
A rejection inside the hook is still isolated to `onFailedError`.

### When it fires — and when it doesn't

`onFailed` fires on a **real rejection** and nothing else. The three cases it deliberately does
*not* cover:

| Outcome | `onFailed`? | Why |
| --- | --- | --- |
| `kind: 'invalid'` — a submitted proof was rejected | **yes** | This is the rejection verdict — wrong amount, expired, replayed, bad signature, … |
| `kind: 'challenge'` — no proof yet (the normal first request) | no | A first 402 is the start of the flow, not a failure. |
| `verify()` **throws** — a transient RPC error re-throws, or a 5xx [`SettlementError`](/accepting-payments/exact-rail-seller/) | no | A throw isn't a payment *verdict* — it's an infrastructure fault. The gate returns 5xx, the buyer's signed authorization stays valid + unused, and there's nothing to record as a buyer failure. |

That last row is the important distinction: a definitive `kind: 'invalid'` rejection (the buyer's
proof is wrong) fires `onFailed`; a thrown `SettlementError` (your relayer is out of gas, or a
facilitator is down) does **not** — it's your infrastructure, not the buyer's payment. See
[the exact rail](/accepting-payments/exact-rail-seller/) for the settle-failure path.

:::caution[The honest limit — pre-send failures never reach the gate]
A backendless gate is **passive** — it only ever sees a request that arrives. So a failure the
buyer hits *before* submitting a proof reaches **only the buyer's client**, never `onFailed`: the
buyer can't afford it ([`InsufficientFundsError`](/errors/why-payments-fail/)), a
[spend policy](/spend-controls/payment-policy/) or `onBeforePay` declines it
([`PaymentDeclinedError`](/errors/why-payments-fail/)), no settleable rail exists, or the buyer
just abandons the flow. None of those send anything to your endpoint, so no gate — PipRail's or
anyone's — can observe them. `onFailed` covers **every rejection that does reach the gate**; for
the buyer's-eye view of the rest, see the [client events](/making-payments/events/) below.
:::

### Recording both outcomes — the payment-system pattern

The two hooks together let a gate persist a complete record — every settlement *and* every
rejection — to your own store, with no PipRail backend or database in the path. This is the shape
the runnable [`examples/payment-system/`](https://github.com/piprail/piprail/tree/main/examples/payment-system)
demo uses (merchant + buyer, both sides, success + failure persisted to SQLite with a `/ledger`
dashboard):

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  awaitOnPaid: true,                                   // record the receipt before serving the goods
  // ✅ SUCCESS — fires after a verified settlement. at-least-once → dedupe on idempotencyKey.
  onPaid: (r) => paymentsTable.upsert({
    where: { tx: r.idempotencyKey },
    create: { tx: r.transaction, payer: r.payer, amount: r.amountFormatted, symbol: r.symbol, at: r.verifiedAt },
    update: {},
  }),
  // ⚠️  FAILURE — the mirror. A rejection has no tx/amount/payer; record the reason.
  onFailed: (f) => failuresTable.insert({
    code: f.code, detail: f.detail, transient: f.transient, at: new Date(),
  }),
  // Both hooks are fully isolated — a throw routes to the *Error seam, never breaking the request.
  onPaidError:   (err, r) => logger.error({ err, tx: r.transaction }, 'receipt persist failed'),
  onFailedError: (err, f) => logger.error({ err, code: f.code }, 'failure persist failed'),
})
```

Both `requirePayment` and `createPaymentGate` fire `onFailed` identically — it lives inside
`gate.verify()`, which the middleware calls for you. (Want the *buyer's* side of these same
failures — a single `onEvent` stream that also catches the pre-send declines the gate can't?
See [Events & observability](/making-payments/events/).)
