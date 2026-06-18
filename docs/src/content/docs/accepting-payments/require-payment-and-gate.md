---
title: requirePayment & createPaymentGate
description: Turn any route paid-only — Express middleware with requirePayment, or framework-agnostic logic with createPaymentGate.
sidebar:
  order: 1
---

## Introduction

These are the two server-side entry points. `requirePayment` is drop-in Express/Connect
middleware; `createPaymentGate` is the same logic, framework-free, for everything else. Both
turn a resource paid-only: it answers `402` until a payment verifies on-chain, then it runs.

:::note
Before you start, you need a wallet address to be paid to (`payTo`) and an RPC endpoint for the
chain. PipRail never holds funds — the payment settles directly to `payTo`.
:::

## Express / Connect — `requirePayment`

Drop it in front of any route handler:

```ts
import { requirePayment } from '@piprail/sdk'

app.get(
  '/report',
  requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' }),
  (req, res) => res.json({ report: 'unlocked' }),
)
```

The middleware issues the 402 challenge, verifies the proof on the retry, and only then calls
`next()`. Your handler never runs unpaid. A server-side settlement failure on the optional
`exact` rail (relayer out of gas / facilitator down) returns `502` — never a 402 — so a payer is
never told to re-pay for the merchant's fault.

## Any framework — `createPaymentGate`

`createPaymentGate` returns a [`PaymentGate`](#the-paymentgate-object) — a plain object you drive
yourself — ideal for Hono, Fastify, Cloudflare Workers, Next.js route handlers, Bun, or Deno:

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })

// Hono example
app.get('/report', async (c) => {
  const result = await gate.verify(c.req.header('payment-signature'))
  // → { kind: 'paid', receipt, receiptHeader }  on a verified, unused proof

  if (result.kind !== 'paid') {
    // 'challenge' (first hit) or 'invalid' (rejected proof) — both carry `challenge`
    c.header('payment-required', result.requiredHeader)
    return c.json(result.challenge, 402)
  }

  c.header('payment-response', result.receiptHeader)
  return c.json({ report: 'unlocked' })
})
```

`gate.verify()` returns a discriminated
[`VerifyPaymentResult`](/accepting-payments/verifying-payments/):

| `kind` | Meaning | What to return |
| --- | --- | --- |
| `'paid'` | A valid, recent, unused proof | `200` + the resource (+ `result.receiptHeader`) |
| `'challenge'` | No proof yet (first request) | `402` + `result.challenge` |
| `'invalid'` | A proof that failed verification | `402` + `result.challenge` |

:::caution
Always send back `result.challenge` on the 402 — it carries the `accepts[]` a standard client
needs to retry. (The legacy `toInvalidBody` helper omits it and is deprecated.)
:::

## The PaymentGate object

`createPaymentGate` returns a `PaymentGate` with four methods — all driven by you, none of
which move anything on-chain except an actual verified payment:

| Method | Returns | Use |
| --- | --- | --- |
| `gate.verify(header)` | `Promise<VerifyPaymentResult>` | Verify the inbound `payment-signature` header on each request. |
| `gate.challenge(url?)` | `Promise<{ challenge, requiredHeader }>` | Mint a fresh 402 challenge (new nonce) for a URL — when you issue the 402 yourself. |
| `gate.describe(url?)` | `Promise<ResourceDescription>` | Static, nonce-free metadata for discovery emitters (no nonce minted). |
| `gate.landingPage(challenge)` | `string` | Render the self-describing HTML landing page for a human who opens the gated URL in a browser (from a `challenge`). |

`requirePayment` is just `createPaymentGate` wrapped in an Express adapter — it builds one gate
per gated route and reuses it (the gate's in-memory used-proof set is what stops a proof being
redeemed twice).

## Defining what you accept

The single-rail form (`chain` + `token` + `amount` + `payTo`) is the common case. To offer
**several rails at once**, pass `accept[]` — the client pays with whatever it holds:

```ts
requirePayment({
  payTo: '0xYourWallet',
  accept: [
    { chain: 'base', token: 'USDC', amount: '0.10' },
    { chain: 'polygon', token: 'USDC', amount: '0.10' },
    { chain: 'solana', token: 'USDC', amount: '0.10', payTo: 'YourSolanaAddr' },
  ],
})
```

Each entry can override `payTo` and `rpcUrl` for its chain (per-family `payTo` usually lives on
the entry, since address shapes differ across chains). The single and multi forms are mutually
exclusive — pass one or the other. See [Defining
accepts](/accepting-payments/defining-accepts/) for the full options.

## Receipts and `onPaid`

Pass an `onPaid` callback to record every settled payment — log it, fulfil an order, increment a
counter. It fires after verification succeeds, with an enriched
[`PaidReceipt`](/accepting-payments/receipts-and-onpaid/#the-paidreceipt) (the wire receipt **plus**
`decimals` / `symbol` / `amountFormatted` / `idempotencyKey`):

```ts
requirePayment({
  chain: 'bnb', token: 'FDUSD', amount: '0.05', payTo: '0xYourWallet',
  onPaid: (r) => console.log(`paid ${r.amountFormatted} ${r.symbol} — tx ${r.transaction}`),
})
```

`onPaid` may be **sync or async** and is fully isolated — a thrown error or a rejected promise can
never break the request (route them to `onPaidError`). It's fire-and-forget by default; set
`awaitOnPaid` to record before the resource is served, and for a durable webhook use
[`deliverReceipt`](/accepting-payments/receipts-and-onpaid/#reliable-delivery). Delivery is
**at-least-once** — dedupe on `idempotencyKey`. See
[Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) for the full story.

## Failure notifications — `onFailed`

`onFailed` is the **mirror of `onPaid`**: it fires when a submitted proof is *rejected* — every
time `gate.verify()` returns [`kind: 'invalid'`](/accepting-payments/verifying-payments/) (wrong
amount, expired, replayed, unknown asset, wrong recipient, bad signature, …). Where `onPaid`
records a settlement, `onFailed` records a rejection, so you can log, count, or alert on bad
attempts with the same machinery:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  onPaid:   (r) => log.info({ tx: r.transaction }, `paid ${r.amountFormatted} ${r.symbol}`),
  onFailed: (f) => { if (!f.transient) log.warn({ code: f.code }, `rejected: ${f.detail}`) },
})
```

It receives a `FailedPayment` — and because a rejection has no settlement, it's a much leaner
shape than `PaidReceipt` (no tx, no amount, no payer):

```ts
interface FailedPayment {
  code: VerifyErrorCode   // the SAME machine code the buyer's client is told (e.g. 'amount_too_low')
  detail: string          // human text, e.g. "Paid 40000, required 500000."
  transient: boolean      // true only for tx_not_found / insufficient_confirmations
}
```

The `code` is identical to the one the buyer's client receives for that rejection (both sides see
one consistent reason — see the [VerifyErrorCode table](/accepting-payments/verifying-payments/#why-a-proof-was-rejected)).
Use `transient` to avoid false alarms: it's `true` only for the two transient codes
(`tx_not_found` / `insufficient_confirmations`), where the proof may still be settling and the
buyer's client retries automatically — you'll usually then get `onPaid`. Alert only on
`!transient`.

`onFailed` shares `onPaid`'s isolation and lifecycle exactly: it may be **sync or async**; a thrown
error or a rejected promise is caught and routed to `onFailedError` — it can never break the
request or crash the process; and it's **fire-and-forget** unless you set `awaitOnFailed` to run
it before the 402 is returned.

:::note
`onFailed` fires on every rejection that **reaches the gate**, but a backendless gate is passive
by design: a failure the merchant never gets a request for — the buyer can't afford it, a
`policy` / `onBeforePay` declines it, or the buyer abandons before paying — is seen **only** by the
buyer's client (its [`payment-failed` event](/making-payments/events/) now carries that reason).
And a *thrown* error — a transient RPC blip that re-throws, or a 5xx
[`SettlementError`](/accepting-payments/verifying-payments/#verifying-the-exact-rail) — is not a
verdict, so it does **not** fire `onFailed`.
:::

## Key options

| Option | Purpose |
| --- | --- |
| `chain` / `token` / `amount` / `payTo` | The single-rail shorthand. |
| `accept[]` | Offer multiple chains/tokens in one challenge. |
| `rpcUrl` | Your RPC for verification (fold any API key in here). |
| `minConfirmations` | How many confirmations before a proof counts. Default `1`. |
| `maxTimeoutSeconds` | How long a challenge stays valid, in seconds. Default `600`. |
| `onPaid` | Callback after a payment verifies (sync or async; receives a `PaidReceipt`). |
| `onPaidError` | Observe a failing `onPaid` instead of swallowing it silently. |
| `awaitOnPaid` | Await `onPaid` before serving the resource (default `false` = fire-and-forget). |
| `onFailed` | Mirror of `onPaid`: callback after a submitted proof is *rejected* (`'invalid'`), receiving a `FailedPayment`. |
| `onFailedError` | Observe a failing `onFailed` instead of swallowing it silently (mirror of `onPaidError`). |
| `awaitOnFailed` | Await `onFailed` before the 402 is returned (default `false` = fire-and-forget). |
| `generateNonce` | Custom per-challenge nonce generator. Default `crypto.randomUUID()`. |
| `isUsed` / `markUsed` | Pluggable replay store for multi-instance deploys. |
| `exact` | Also accept the standard `exact` scheme — zero-config keyless (`exact: true`, Mode 0 — start here), your own relayer (`settle: 'self'`, Mode A), or a named facilitator (`settle: { facilitator }`, Mode B). |
| `selfDescribe` | Self-describe every 402 with an [`extensions.piprail`](/discovery/self-describing-endpoints/) block. Default `true`; set `false` to omit. |
| `discovery` | Emit the discovery manifest so crawlers can find this endpoint. |

Full reference: the [API page](/reference/api/). Standard-`exact` selling is covered on the
[exact rail page](/accepting-payments/exact-rail-seller/).
