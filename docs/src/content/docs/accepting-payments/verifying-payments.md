---
title: Verifying payments
description: How a gate turns an incoming payment header into a paid / challenge / invalid verdict — verified on-chain against your own RPC, with no facilitator in the loop.
sidebar:
  order: 3
---

## Introduction

`gate.verify(headerValue)` is the one call that decides whether a request has paid. You hand it
the incoming `payment-signature` header; it reads the proof's transaction **on-chain, against
your own RPC**, and returns a structured `VerifyPaymentResult` you branch on. There is no
facilitator, no PipRail server, no callback to a third party — verification runs in your
process. (The Express middleware [`requirePayment`](/accepting-payments/require-payment-and-gate/)
wraps exactly this; reach for the gate when you're on Hono, Fastify, Workers, or anything else.)

## Calling verify

Build one gate per gated resource and reuse it — its in-memory used-proof set is what stops a
proof being redeemed twice. Pass the header value (a missing header is fine — it just means
"first request, no proof yet").

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
})

const result = await gate.verify(req.headers['payment-signature'])
// → { kind: 'paid' | 'challenge' | 'invalid', … }
```

## The VerifyPaymentResult

`verify()` returns the discriminated union `VerifyPaymentResult` — `switch` on `kind`:

```ts
switch (result.kind) {
  case 'paid':      /* 200 + the resource */                       break
  case 'challenge': /* 402 + result.challenge (first request) */   break
  case 'invalid':   /* 402 + result.challenge (proof rejected) */  break
}
```

| `kind` | When | What to send back |
| --- | --- | --- |
| `'paid'` | A valid, recent, unused proof verified on-chain | `200` + the resource, and the `result.receiptHeader` as the `payment-response` header |
| `'challenge'` | No proof on the request yet | `402` + `result.challenge` (and `result.requiredHeader` as the `payment-required` header) |
| `'invalid'` | A proof was submitted but failed verification | `402` + `result.challenge` — the rejection carries a **fresh** re-challenge so a standard client can retry |

Each variant carries the headers you need to set. These are illustrative shapes of the
`VerifyPaymentResult` union — branch on `kind` and TypeScript narrows to the right one:

```ts
// kind: 'paid'      → { receipt: X402Receipt; receiptHeader: string }
// kind: 'challenge' → { challenge: X402Challenge; requiredHeader: string; statusCode: 402 }
// kind: 'invalid'   → { error: string; detail: string;
//                       challenge: X402Challenge; requiredHeader: string; statusCode: 402 }
```

:::caution
On both `'challenge'` and `'invalid'`, send back `result.challenge` with the `402`. The invalid
result's `challenge` is a full v2 `PaymentRequired` body with `accepts[]` (so a standard client
can immediately retry), the human reason in `error`, and the machine code in
`extensions.piprail`. The legacy [`toInvalidBody`](#legacy-invalid-body) helper omits `accepts[]`
and is deprecated.
:::

## The receipt

On `'paid'`, `result.receipt` is the verified settlement — every field re-derived from the
trusted `accept`, not from the client's submission:

```ts
interface X402Receipt {
  scheme: 'onchain-proof' | 'exact'
  success: true
  network: string      // CAIP-2, e.g. 'eip155:8453'
  transaction: string  // the verified on-chain tx id (settled payment)
  asset: string
  amount: string       // base units
  payer: string
  payTo: string
  verifiedAt: string
}
```

Set `result.receiptHeader` as the `payment-response` header so the client gets its receipt, then
serve the resource. To log or fulfil on every settled payment, prefer the
[`onPaid` callback](/accepting-payments/receipts-and-onpaid/) — it fires once after verification
succeeds.

## What "verified" means

A proof reaches `'paid'` only if **all** of these hold, each checked against the chain itself:

- The proof's transaction exists on-chain and didn't revert.
- It paid the **right asset and amount** to **your `payTo`** — re-derived from the server's own
  resolved spec, so a forged `accepted` echo can't redirect the check.
- It has at least `minConfirmations` confirmations (default `1`).
- It landed inside the recency window — no older than `maxTimeoutSeconds` (default `600`).
- Its proof ref hasn't been redeemed before (replay protection).

```ts
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
  minConfirmations: 3,      // wait for more confirmations before granting access
  maxTimeoutSeconds: 300,   // tighten the replay / recency window to 5 minutes
})
```

See [Proof binding](/concepts/proof-binding/) for how each family ties a proof to its challenge,
and [Replay protection](/accepting-payments/replay-protection/) for the used-proof set.

## Why a proof was rejected

The driver's `verify()` returns a `VerifyResult` — `{ ok: false, error, detail }` — where `error`
is a closed `VerifyErrorCode`. The gate carries it onto the `'invalid'` result (`result.error` is
the code, `result.detail` the human text) and stamps it into the re-challenge's
`extensions.piprail.{ code, detail }`. Branch on the code rather than parsing prose:

| `VerifyErrorCode` | Meaning |
| --- | --- |
| `tx_not_found` | Proof tx not on-chain yet — usually RPC lag (transient). |
| `insufficient_confirmations` | Mined, but fewer than `minConfirmations` (transient, EVM). |
| `tx_reverted` | The tx is on-chain but failed / reverted. |
| `wrong_recipient` | Paid, but not to `payTo`. |
| `amount_too_low` | Paid to `payTo`, but less than required. |
| `transfer_not_found` | No matching transfer (asset / amount / nonce) to `payTo`. |
| `payment_expired` | Older than `maxTimeoutSeconds` — outside the recency window. |
| `tx_already_used` | The proof was already redeemed (replay) — emitted by the gate. |
| `no_meta` | The tx carries no metadata to inspect (Solana). |
| `signature_invalid` | `exact` rail only: the EIP-712 authorization didn't recover to the payer. |

Some codes are family-specific by design (account-watch chains collapse "wrong recipient" into
`transfer_not_found`; `insufficient_confirmations` needs a discrete confirmation count). The full
table lives on the [VerifyErrorCode reference](/errors/verify-error-code/).

:::note
`verify()` **fails closed**. If an RPC read fails, the driver returns `tx_not_found` and the gate
replies `402` (locked) — never `paid`. An RPC outage can't trick the gate into unlocking. The
gate also **releases the replay claim** on any failure, so the same proof can be re-submitted
once your node recovers — the proof is never burned.
:::

## Reading the verdict in your handler

`verify()` never throws on a *bad payment* — a rejected proof comes back as `kind: 'invalid'`,
not an exception. The one thing that *does* throw is a server-side **settlement** failure on the
`exact` rail (covered below). Here's a complete Hono handler that covers all three verdicts plus
that one throw:

```ts
import { createPaymentGate, SettlementError } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
})

app.get('/report', async (c) => {
  let result
  try {
    result = await gate.verify(c.req.header('payment-signature'))
  } catch (err) {
    // A valid `exact` payment that couldn't be SETTLED server-side (relayer out of
    // gas, facilitator down). NOT the payer's fault — answer 5xx, never 402.
    if (err instanceof SettlementError) return c.json({ error: 'settlement_failed' }, 502)
    throw err
  }

  switch (result.kind) {
    case 'paid':
      c.header('payment-response', result.receiptHeader)
      return c.json({ report: 'your data' })            // 200 + the resource

    case 'challenge':
    case 'invalid':
      // Both send back a full v2 re-challenge so a standard client can retry.
      c.header('payment-required', result.requiredHeader)
      return c.json(result.challenge, 402)
  }
})
```

## Verifying the exact rail

If you opted into the standard [`exact` rail](/accepting-payments/exact-rail-seller/), the same
`verify()` call also handles inbound EIP-3009 payments — the gate parses both the v2 and v1 inner
payload shapes; pass it whichever header your client sent — the `requirePayment` middleware reads
`payment-signature` then falls back to `x-payment`. You don't change
how you call it. One extra failure mode applies: when a valid, simulated `exact` payment can't be
**settled** server-side (your relayer is out of gas, or a chosen facilitator is down), `verify()`
throws a `SettlementError` instead of returning `'invalid'`. That's not the payer's fault — their
authorization stays valid and unused — so your adapter should answer `5xx`, never `402`:

```ts
import { createPaymentGate, SettlementError } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.AGENT_KEY } },
})

let result
try {
  result = await gate.verify(headerValue)
} catch (err) {
  if (err instanceof SettlementError) return c.json({ error: 'settlement_failed' }, 502)
  throw err
}
```

The built-in `requirePayment` middleware does this for you (it answers `502` on a
`SettlementError`). For framework wiring patterns, see
[Framework adapters](/accepting-payments/framework-adapters/).

## Legacy invalid body

`X402InvalidBody` is the **deprecated** minimal rejection shape that the `toInvalidBody(result)`
helper returns:

```ts
interface X402InvalidBody {
  x402Version: 2
  status: 'invalid'
  error: string
  detail: string
}
```

It carries no `accepts[]`, so a standard x402 client that receives it **can't retry**. The gate's
`kind: 'invalid'` result already gives you a fully conformant re-challenge (`result.challenge`) —
emit that instead. `toInvalidBody` remains only for back-compat with hand-rolled adapters; new
code should never reach for it.
