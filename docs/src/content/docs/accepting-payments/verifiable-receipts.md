---
title: Verifiable receipts (seller)
description: Emit a self-contained, anyone-verifiable receipt on every settled payment — chain-grounded by default (no key), with an optional EIP-712 service-delivery attestation. Backendless, byte-compatible with the x402 offer-receipt extension.
sidebar:
  order: 5
---

## Introduction

A PipRail gate already proves a payment by re-deriving every field from the settlement
transaction your own RPC confirmed. **Verifiable receipts** package that proof so the buyer
— or *anyone* — can re-run the same verification later, against the chain, with only an RPC.
No key, no backend, no PipRail account.

You opt in with one option on [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/):

```ts
createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: true, // emit a chain-grounded receipt on every settled payment
})
```

Omitting `receipts` leaves the 402 **and** the 200 byte-for-byte identical to before — this is
purely additive. The receipt rides on the `PAYMENT-RESPONSE` header inside an
`extensions['offer-receipt'].info` block: PipRail's chain-grounded settlement record sits at
`info.settlement` (a PipRail sibling), and — when you enable a Tier-2 attestation — the official
SignedReceipt sits at the spec's `info.receipt` slot, so a stock `@x402/extensions` reader
(`extractReceiptFromResponse` → `info.receipt`) reads the signed receipt unchanged
(**byte-compatible** for the attested path). A PipRail client reconstructs the full self-contained
[`PipRailReceipt`](/making-payments/verifying-receipts/) from both.

## Two tiers

| | **Tier 1 — chain-grounded** (the default when receipts are on) | **Tier 2 — service attestation** (opt-in, EVM-only) |
|---|---|---|
| Authority | the settlement **tx** the chain already signed | the merchant's signature over the official EIP-712 `RECEIPT_TYPES` |
| Proves | *funds provably moved* to `payTo` for `amount` | *the resource was **served*** — the one thing the chain can't attest |
| Key needed | **none** | the merchant's existing `payTo` wallet (EIP-712) |
| New infra | none — reuses the driver's `verify()` | none — signs with the key you already have |

### Tier 1 — chain-grounded (no key)

`receipts: true` stamps the verified [`X402Receipt`](/reference/api/) plus the reconstruction
metadata a third party needs (the resource URL, the asset `decimals`, and — for the five
memo/nonce-bound families: Stellar, XRPL, NEAR, Algorand, TON — the challenge **`nonce`**) into
the offer-receipt block. The buyer re-verifies it with
[`PipRailClient.verifyReceipt`](/making-payments/verifying-receipts/) — which **ignores the
receipt's claims** and re-reads the chain. The minimum receipt needs no key at all.

### Tier 2 — service-delivery attestation (EVM-only)

The chain can prove the money moved, but not that you *served* the resource. For that, sign the
official x402 offer-receipt EIP-712 receipt with your **existing `payTo` wallet** — a verifier
checks `recover(signature) === payTo`, so key-to-service binding collapses to an on-chain fact.

```ts
createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: { attest: { wallet: { privateKey: process.env.PAYTO_KEY } } },
})
```

PipRail signs the official `{ name: 'x402 receipt', version: '1', chainId: 1 }` domain and the
load-bearing `RECEIPT_TYPES` field order, so the attestation is byte-compatible with
`@x402/extensions`. Verify it with
[`PipRailClient.verifyAttestation`](/making-payments/verifying-receipts/).

:::note
Tier 2 is **EVM-only** (the EIP-712 signing path). Setting `attest` on a non-EVM gate degrades
to a Tier-1 chain-grounded receipt with a one-time warning — it never throws. A signing failure
likewise degrades to Tier-1; emitting the receipt can never fail your 200.
:::

## `includeTxHash` — a deliberate divergence from the reference default

PipRail defaults `includeTxHash` to **`true`** — the settlement tx hash is in the receipt, so it
is third-party verifiable on-chain out of the box. This **inverts** the x402 reference
implementation's privacy-minimal default (which omits the tx). The wire envelope stays
byte-compatible; the *default* is PipRail's — market it as **"byte-compatible envelope,
PipRail-default verifiability"**, never "drop-in identical defaults".

:::caution[Payer-privacy trade-off — read before flipping nothing]
A receipt that carries the tx hash bundles a portable `{ payer ↔ resource ↔ tx ↔ merchant }`
linkage that is *more* correlatable than the bare on-chain tx — and that privacy cost lands on
the **payer**, who did not choose the flag. If your buyers need privacy, set
`receipts: { includeTxHash: false }`. Per the spec's §5.3 empty-string rule, a suppressed tx
becomes the empty string `''` on the wire and in the signed message (never an omitted key), and
the receipt is no longer third-party on-chain-verifiable — use Tier-2 attestation for that case.
:::

## Options

```ts
interface ReceiptOption {
  /** Put the settlement tx hash in the receipt. Default true (see the caution above). */
  includeTxHash?: boolean
  /** The canonical resource URL to embed (what was paid for). The buyer's client also fills
   *  this from the URL it fetched; set it here to ground the raw header a third party reads.
   *  Default '' (the client fills it). */
  resource?: string
  /** Tier-2: also sign an EIP-712 delivery attestation with the merchant's payTo wallet (EVM). */
  attest?: { wallet: unknown }
}
```

When receipts are on, the gate's [self-describe block](/discovery/self-describing-endpoints/)
also carries a `verifiableReceipts: true` flag, so a crawler reading the 402 knows the 200 will
carry a self-verifiable receipt.

## See also

- [Verifying receipts (buyer / anyone)](/making-payments/verifying-receipts/) — capture + re-verify.
- [Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) — the *delivery* side (persist a
  settled receipt to your own store / webhook). That is reconciliation; this page is *verifiability*.
