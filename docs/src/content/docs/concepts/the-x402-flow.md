---
title: The x402 flow
description: The wire-level anatomy of an x402 payment — challenge, signature, receipt — and how PipRail's envelopes map to it.
sidebar:
  order: 1
---

## Introduction

x402 revives the dormant HTTP `402 Payment Required` status into a real protocol: a server
states its price in a structured challenge, a client answers with a proof, and the server
verifies and delivers. This page is the wire-level view of that exchange — useful when you're
debugging a 402, or building a client or server by hand.

## The three messages

Every payment is three HTTP headers, exchanged across two requests. PipRail carries each as a
lowercase, base64-JSON header — no `X-` prefix.

### 1. The challenge (server → client)

When a client hits a gated resource without payment, the server returns `402` with a
`payment-required` header carrying a base64-JSON challenge. The challenge lists one or more
`accepts` entries — each a rail it will take:

```jsonc
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/report" },
  "accepts": [
    {
      "scheme": "onchain-proof",
      "network": "eip155:8453",                              // Base, as CAIP-2
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      "amount": "100000",                                    // base units (0.10 USDC, 6 decimals)
      "payTo": "0xYourWallet",
      "maxTimeoutSeconds": 120,
      "extra": {
        "nonce": "…",                // one-time, binds the proof to this challenge
        "decimals": 6,
        "minConfirmations": 1,
        "amountFormatted": "0.10",   // human-readable, so the client can render it
        "symbol": "USDC"
      }
    }
  ]
}
```

:::note
Only `scheme`, `network`, `asset`, `amount`, `payTo`, and `maxTimeoutSeconds` are top-level on
an `accepts` entry. The rendering hints — `nonce`, `decimals`, `minConfirmations`,
`amountFormatted`, `symbol` — live under `extra`. (That's the shape of `X402AcceptEntry`; the
`exact` rail, `X402ExactAcceptEntry`, mirrors it with an `extra.assetTransferMethod` instead.)
:::

### 2. The signature / proof (client → server)

The client pays on-chain, then re-requests the resource carrying a `payment-signature` header
(PipRail also accepts the v1 `x-payment` header). For PipRail's `onchain-proof` scheme the
payload references the on-chain transaction — `{ nonce, txHash }`, the challenge nonce plus the
proof ref (an EVM tx hash, a Solana signature, a TON locator, …). For the standard `exact`
scheme the payload carries a signed EIP-3009 authorization instead.

### 3. The receipt (server → client)

On success the server returns `200` plus a `payment-response` header (v1 fallback:
`x-payment-response`) carrying a base64-JSON `X402Receipt` — a durable record of what settled:

```jsonc
{
  "scheme": "onchain-proof",
  "success": true,
  "network": "eip155:8453",
  "transaction": "0x…",   // the settled on-chain tx (was `txHash` pre-v2)
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "100000",
  "payer": "0x…",
  "payTo": "0xYourWallet",
  "verifiedAt": "2026-06-10T12:00:00.000Z"
}
```

The settled tx lives in `transaction`, not the submit-time `payload.txHash` — they differ on
TON/NEAR, where the proof ref is a composite locator rather than the final tx id.

## Settled or rejected — both sides hear the same reason

The receipt above is the *success* message. The wire flow also has a symmetric *failure* path,
and PipRail surfaces both verdicts to **both** parties with one consistent machine `code`:

| Outcome | Buyer learns it via | Merchant learns it via |
| --- | --- | --- |
| **Settled** | `200` + the `payment-response` receipt, and a `payment-settled` [event](/making-payments/events/) | the [`onPaid`](/accepting-payments/receipts-and-onpaid/) hook + `PaidReceipt` |
| **Rejected** | the thrown error + a `payment-failed` [event](/making-payments/events/) carrying `code` + `detail` | the [`onFailed`](/accepting-payments/receipts-and-onpaid/#failure-notifications--onfailed) hook + a `FailedPayment` |

A rejection is what `gate.verify()` returns as `kind: 'invalid'` — a wrong amount, an expired or
replayed proof, an unknown asset, the wrong recipient, a bad signature. There's no settlement, so
unlike a receipt it carries no tx/amount/payer — just the [`VerifyErrorCode`](/accepting-payments/verifying-payments/),
a human `detail`, and a `transient` flag. The buyer's `payment-failed` `code` **equals** the
merchant's `failure.code`, by design: one rejection, one reason, two notifications.

:::note
The first request (no proof yet) returns a plain `402` challenge — that's the start of the flow,
not a rejection, so it notifies neither side. One honest limit: a failure that never reaches the
gate — the buyer can't afford it, a [spend policy](/spend-controls/payment-policy/) / `onBeforePay`
declines it, or the buyer abandons — is seen **only by the buyer**, because a backendless gate is
passive. Every rejection that *does* reach `verify()` fires `onFailed`.
:::

## Three schemes

PipRail speaks three payment schemes:

- **`onchain-proof`** (default) — the payer broadcasts their own transfer and proves it. No
  facilitator, works on every family. This is PipRail's native rail.
- **`exact`** (opt-in) — the ratified x402 `exact` scheme: EIP-3009 signed authorizations on EVM,
  plus each family's exact variant (EVM Permit2, Solana SVM, Algorand, Aptos, NEAR NEP-366). Turn
  it on to **pay any standard x402 server** (see [the exact buyer](/making-payments/exact-buyer/))
  or to **get paid** — optionally **gasless**, by delegating settlement to a free facilitator like
  PayAI that broadcasts on Base and pays the gas (see
  [the exact rail seller](/accepting-payments/exact-rail-seller/)).
- **`upto`** (opt-in) — the ratified x402 `upto` scheme: a **metered** rail (EVM-Permit2 only) where
  the buyer signs a **maximum** and the merchant settles only the **actual** usage (≤ the max). Use it
  for usage-based billing — per-token LLM charges, per-call APIs, pay-per-compute. See
  [the upto rail seller](/accepting-payments/upto-rail-seller/) and
  [the upto buyer](/making-payments/upto-buyer/).

:::note
The challenge **envelope** PipRail emits is x402 v2-conformant. The difference between
`onchain-proof` and `exact` is the *scheme* (how the proof is formed), not the schema.
:::

## CAIP-2 networks and chain-native asset ids

x402 identifies the **network** with [CAIP-2](https://chainagnostic.org) (`eip155:8453` for Base,
`solana:…`, etc.). The **asset**, though, is the raw **chain-native identifier**, not CAIP-19: an
ERC-20 `0x…` address on EVM, an SPL mint on Solana, a jetton master on TON, `CODE:ISSUER` on
Stellar, or the literal `'native'` for the chain's coin. PipRail fills both in for you — you name a
friendly `chain` and `token`, and it emits the right `network` + `asset`.

## Building it by hand

The high-level [`PipRailClient`](/making-payments/piprail-client/) and
[`createPaymentGate`](/accepting-payments/require-payment-and-gate/) cover the 99% case. If you
need the raw codecs — `parseChallenge`, `buildChallengeHeader`, `buildSignatureHeader`,
`parseReceipt`, and the `HEADER_*` constants — they're exported for hand-rolled clients and
servers. See [Wire format codecs](/reference/wire-codecs/).
