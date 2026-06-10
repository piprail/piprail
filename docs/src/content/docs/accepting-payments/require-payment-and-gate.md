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

`createPaymentGate` returns a `PaymentGate` with three methods — all driven by you, none of
which move anything on-chain except an actual verified payment:

| Method | Returns | Use |
| --- | --- | --- |
| `gate.verify(header)` | `Promise<VerifyPaymentResult>` | Verify the inbound `payment-signature` header on each request. |
| `gate.challenge(url?)` | `Promise<{ challenge, requiredHeader }>` | Mint a fresh 402 challenge (new nonce) for a URL — when you issue the 402 yourself. |
| `gate.describe(url?)` | `Promise<ResourceDescription>` | Static, nonce-free metadata for discovery emitters (no nonce minted). |

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
counter. It fires once, after verification succeeds, with the verified
[`X402Receipt`](/accepting-payments/receipts-and-onpaid/):

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  onPaid: (receipt) => console.log('paid', receipt.amount, 'tx', receipt.transaction),
  // receipt.amount is base units; receipt.transaction is the on-chain settle tx id
})
```

A throw inside `onPaid` is swallowed — a logging hook can never break the request. See
[Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) for every field.

## Key options

| Option | Purpose |
| --- | --- |
| `chain` / `token` / `amount` / `payTo` | The single-rail shorthand. |
| `accept[]` | Offer multiple chains/tokens in one challenge. |
| `rpcUrl` | Your RPC for verification (fold any API key in here). |
| `minConfirmations` | How many confirmations before a proof counts. Default `1`. |
| `maxTimeoutSeconds` | How long a challenge stays valid, in seconds. Default `600`. |
| `onPaid` | Callback after a payment verifies. |
| `generateNonce` | Custom per-challenge nonce generator. Default `crypto.randomUUID()`. |
| `isUsed` / `markUsed` | Pluggable replay store for multi-instance deploys. |
| `exact` | Also accept the standard `exact` scheme (Mode A self-settle, or Mode B facilitator). |
| `discovery` | Emit the discovery manifest so crawlers can find this endpoint. |

Full reference: the [API page](/reference/api/). Standard-`exact` selling is covered on the
[exact rail page](/accepting-payments/exact-rail-seller/).
