---
title: The upto rail — metered billing (seller)
description: Charge a variable amount up to a signed maximum — the buyer authorizes a ceiling, you serve, meter the actual usage, and self-settle exactly what was used. EVM-Permit2, backendless, no fee.
sidebar:
  order: 8
---

## Introduction

The ratified x402 `upto` scheme is for **metered / variable-amount** billing: the buyer signs a
Permit2 authorization for a **maximum**, you serve the resource and measure the *actual* usage,
then settle exactly that (`actual ≤ max`) — billing what was used, not a fixed price. It is the
right rail for token-metered LLM endpoints, per-row data queries, and pay-per-compute.

PipRail settles it the backendless way: through the canonical on-chain `x402UptoPermit2Proxy`
**from your own relayer** (which is the bound `witness.facilitator`) — no third-party facilitator,
no fee, no custody. `actual === 0` settles nothing on-chain (a zero-charge receipt).

:::note
`upto` is **EVM-Permit2 only** — the spec bans EIP-3009 (it fixes the amount at sign time) and has
no non-EVM variant. It works on any ERC-20 on a chain where the `x402UptoPermit2Proxy` is deployed
(Ethereum, Base, Arbitrum, Optimism, Polygon, BNB), **never** a native coin or a non-EVM family.
:::

## The supported shape — call `gate.verify()` directly and meter inside `settleAmount`

Because settlement happens **after** you know the usage, `upto` inverts PipRail's usual
verify→settle→serve order. The supported handler shape is: receive the request → serve/compute
enough to know the usage → `await gate.verify(header)` whose **`settleAmount` callback returns the
metered actual** → write the body. You compute usage *inside* the callback.

```ts
import { createPaymentGate } from '@piprail/sdk'

const PRICE_PER_TOKEN = 1n // base units per unit of work

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', payTo: '0xMerchant…',
  amount: '0.50', // the MAXIMUM ceiling the buyer authorizes
  upto: {
    relayer: { privateKey: process.env.RELAYER_KEY }, // your gas key = the bound facilitator
    settleAmount: ({ maxAmount }) => meterTokensUsed() * PRICE_PER_TOKEN, // the ACTUAL, after serving
  },
})

// your handler (any framework):
async function handle(req, res) {
  const completion = generate(req)          // serve/compute first…
  const header = req.headers['payment-signature']
  const result = await gate.verify(header)  // …settleAmount() runs here, with the metered actual
  if (result.kind === 'paid') {
    res.setHeader('payment-response', result.receiptHeader)
    res.json(completion)                    // …then emit the body
  } else {
    res.status(402).setHeader('payment-required', result.requiredHeader).json(result.challenge)
  }
}
```

`settleAmount` can return a **bigint** (base units), or a string in raw / `"NN%"` / `"$X"` form;
`"0"`/`0n` charges nothing and broadcasts no transaction. The gate clamps the actual to the
advertised max and rejects an over-max callback defensively (`upto_settle_exceeds_max`).

:::caution[`requirePayment` (the Express middleware) does NOT support `upto`]
`requirePayment` calls `gate.verify()` and *then* hands off to your route handler — so settlement
would happen **before** the handler serves, when the metered usage isn't known yet. Constructing
`requirePayment({ upto })` therefore **throws** at construction with an actionable message. Use
`createPaymentGate` + `gate.verify()` directly and meter inside `settleAmount`, as above.
:::

## Lifecycle + safety

- The gate **dual-advertises**: each 402 offers the `upto` rail *and* the `onchain-proof` rail, so
  a standard `upto` client picks `upto` while a PipRail client picks `onchain-proof`. Omitting
  `upto` leaves the challenge byte-identical.
- The buyer's Permit2 **nonce is claimed before metering**, so even a zero-charge burns it
  (replay-safe). **A settle failure releases the nonce** (the buyer's still-valid authorization can
  be re-presented); **a settle success burns it** (at-most-once). A re-present of a settled nonce
  returns `tx_already_used`.
- The signature is always re-verified against the **signed maximum** (`permitted.amount`), never the
  settle amount, and the on-chain proxy enforces `transferDetails.to == witness.to` and
  `msg.sender == witness.facilitator` — so only your relayer can settle, only to your `payTo`.
- A genuine relayer/broadcast failure surfaces as a `SettlementError` (your adapter returns 5xx,
  the buyer's authorization stays valid for retry); a merchant-callback error releases the nonce and
  rejects so the buyer can re-present.

## Buyer side

A PipRail buyer opts into paying `upto` rails with `schemes: ['upto']` and **budgets against the
MAX** (the server *may* charge the full ceiling); the client records the **actual** settled amount
once it reads it back from the settlement response. See
[The exact rail (buyer)](/making-payments/exact-buyer/) for the parallel signing flow.
