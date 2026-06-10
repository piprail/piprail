---
title: "Receipts & onPaid"
description: Record every settled payment — the onPaid callback, the X402Receipt shape, and buildReceiptHeader for hand-rolled servers.
sidebar:
  order: 4
---

## Introduction

A gate verifies a payment on-chain, then needs to *do* something with it — fulfil an order,
log the spend, increment a counter. The `onPaid` callback is where that happens, and the
[`X402Receipt`](/reference/wire-codecs/) it hands you is the verified record of the payment:
amount, asset, payer, and the settled transaction id. Everything in a receipt was re-derived from
your own trusted [`accept`](/accepting-payments/defining-accepts/) during
[verification](/accepting-payments/verifying-payments/), never taken from the client.

## The `onPaid` callback

Pass `onPaid` to [`requirePayment`](/accepting-payments/require-payment-and-gate/) or
`createPaymentGate`. It fires **once**, after verification succeeds and the proof has been
recorded as used — so by the time it runs, the payment is real and replay-safe:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  onPaid: (receipt) => console.log('paid', receipt.amount, 'tx', receipt.transaction),
  // receipt.amount is base units ("100000"); receipt.transaction is the settled on-chain tx id
})
```

It receives the `X402Receipt` and returns nothing. A throw inside `onPaid` is swallowed — a
logging hook can never break the request or hold up the response:

```ts
onPaid: (receipt) => {
  fulfilOrder(receipt.payer, receipt.amount)   // even if this throws, the payer still gets a 200
}
```

:::note
`onPaid` is fire-and-forget: it is called synchronously, the response is not awaited, and its
return value is ignored. Do durable work (a database write, a queue push) in a way that doesn't
need the request to wait on it.
:::

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
reports `0.10` as `"100000"`. The challenge's `amountFormatted` carries the display string, but
the receipt is deliberately exact.
:::

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
[replay store](/accepting-payments/replay-protection/) has claimed the proof, it doubles as an
idempotency key — the same payment can't drive two `onPaid` calls on one instance.

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
  // → { kind: 'paid', receipt, receiptHeader }            on a verified, unused proof
  //   { kind: 'challenge', challenge, requiredHeader, statusCode: 402 }   no proof yet
  //   { kind: 'invalid', error, detail, challenge, requiredHeader, statusCode: 402 }  rejected proof
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
