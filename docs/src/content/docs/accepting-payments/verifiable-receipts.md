---
title: Verifiable receipts (seller)
description: Emit a self-contained, anyone-verifiable receipt on every settled payment — chain-grounded by default (no key), with an optional EIP-712 service-delivery attestation. Backendless, byte-compatible with the x402 offer-receipt extension.
sidebar:
  order: 5
---

## Introduction

A PipRail gate already proves every payment by re-deriving each field from the settlement
transaction your own RPC confirmed (that's [verification](/accepting-payments/verifying-payments/)).
A **verifiable receipt** packages that proof so it travels: the buyer keeps a small, self-contained
record, and **anyone** — the buyer, an auditor, a reputation system, a court — can re-run the *same*
on-chain verification later with only an RPC. No key, no backend, no PipRail account, nothing hosted
in between.

That makes the receipt fundamentally different from what
[Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) covers. That page is the **delivery /
reconciliation** side — `onPaid` fires *inside your server* so you can fulfil the order and persist
the spend. This page is the **verifiability** side — what the buyer takes *away*, re-checkable by a
third party who never trusts you. The two are independent: you can run `onPaid` without receipts, or
receipts without `onPaid`, or both.

You opt in with one option on
[`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/):

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: true, // emit a chain-grounded receipt on every settled payment
})
```

:::note[Default off → byte-identical]
Omitting `receipts` leaves the 402 **and** the 200 byte-for-byte identical to before this feature.
The whole mechanism is purely-additive metadata a standard x402 client ignores: `accepts[]`, the
status code, and the pay path never change. Turn it on and the only difference is an extra
`extensions['offer-receipt']` block on the `PAYMENT-RESPONSE` header.
:::

## The two tiers

A receipt has two independent proof layers. Tier 1 is automatic the moment receipts are on; Tier 2
is an extra opt-in signature.

| | **Tier 1 — chain-grounded** (the default when receipts are on) | **Tier 2 — service attestation** (opt-in, EVM-only) |
|---|---|---|
| Authority | the settlement **tx** the chain already signed | the merchant's signature over the official EIP-712 `RECEIPT_TYPES` |
| Proves | *funds provably moved* to `payTo` for at least `amount` | *the resource was **served*** — the one thing the chain can't attest |
| Key needed | **none** | the merchant's existing `payTo` wallet (no new key) |
| New infra | none — reuses the driver's `verify()` | none — signs with the key you already have |
| Verified by | [`PipRailClient.verifyReceipt`](/making-payments/verifying-receipts/) | [`PipRailClient.verifyAttestation`](/making-payments/verifying-receipts/) |
| Wire slot | `extensions['offer-receipt'].info.settlement` (PipRail) | `extensions['offer-receipt'].info.receipt` (the spec slot) |

### Tier 1 — chain-grounded (no key)

`receipts: true` stamps the verified [`X402Receipt`](/accepting-payments/receipts-and-onpaid/#the-x402receipt)
plus the reconstruction metadata a third party needs into the offer-receipt block: the `resource`
URL, the asset `decimals`, and — for the five memo/nonce-bound families — the challenge
[`nonce`](#the-nonce-field--memononce-bound-families). A verifier re-reads the settlement tx through
the chain's own driver and **ignores every claim in the receipt** — so the receipt can't lie about
who was paid, in what asset, or how much. There is no key, no signature, and nothing to compromise:
the *chain* is the authority. This is the minimum, and it's on for every settled payment when
`receipts` is set.

### Tier 2 — service-delivery attestation (EVM-only)

The chain can prove the money moved. It *cannot* prove you actually **served** the resource the buyer
paid for. For that single gap, sign the official x402 `offer-receipt` EIP-712 receipt with your
**existing `payTo` wallet** — a verifier then checks `recover(signature) === payTo`, so the
"I delivered" claim collapses to an on-chain fact (the same key that received the money signed the
attestation). Zero new infrastructure.

```ts
createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: { attest: { wallet: { key: process.env.PAYTO_KEY } } },
})
```

The `wallet` is the **same `{ key }` form** every PipRail wallet takes — the merchant's `payTo`
private key. PipRail signs the FROZEN official domain `{ name: 'x402 receipt', version: '1',
chainId: 1 }` (chainId `1` for *every* network — even non-EVM payment chains — so signing is uniform)
and the load-bearing `RECEIPT_TYPES` field order
(`version, network, resourceUrl, payer, issuedAt, transaction`), byte-matched against
`@x402/extensions`. The signed message follows the §5.3 empty-string rule. Verify it with
[`PipRailClient.verifyAttestation`](/making-payments/verifying-receipts/).

:::note[Tier 2 degrades gracefully — it can never fail your 200]
Tier 2 is **EVM-only** (the EIP-712 signing path lives in the EVM driver). Setting `attest` on a
**non-EVM gate** degrades to a Tier-1 chain-grounded receipt with a one-time `console.warn`, never a
throw. A **signing failure** (a bad key, a signer fault) degrades the same way. And the
`attest: { jws }` arm is **reserved for a future managed signer (R3) — not yet implemented**;
supplying it today also degrades to Tier-1 with a warning. In every case the receipt is still emitted
and the 200 still serves — exactly like [`onPaid`'s isolation](/accepting-payments/receipts-and-onpaid/#sync-or-async--and-always-isolated).
:::

## The wire shape

When receipts are on, the gate adds an `extensions['offer-receipt'].info` block to the
SettlementResponse on the `PAYMENT-RESPONSE` header. Field placement is spec-faithful so a stock
reader and a PipRail reader both work:

```jsonc
{
  "scheme": "onchain-proof",
  "success": true,
  "network": "eip155:8453",
  "transaction": "0x9f…",          // the settled on-chain tx (empty "" when includeTxHash:false)
  "asset": "0x833589fC…",
  "amount": "50000",
  "payer": "0x857b…",
  "payTo": "0xMerchant…",
  "verifiedAt": "2026-06-20T…Z",
  "nonce": "…",                     // the challenge nonce (Template-A re-verify); present when receipts on
  "extensions": {
    "offer-receipt": {
      "info": {
        "settlement": { /* PipRail's X402Receipt — the chain-grounded record (Tier 1) */ },
        "resource":   { "url": "https://api.example.com/report" },
        "decimals":   6,
        "receipt":    { /* the official SignedReceipt — present ONLY for a Tier-2 attestation */ }
      }
    }
  }
}
```

- **`info.settlement`** holds PipRail's chain-grounded [`X402Receipt`](/accepting-payments/receipts-and-onpaid/#the-x402receipt)
  — a PipRail-namespaced sibling a stock `@x402/extensions` reader ignores, and the record
  `verifyReceipt` re-reads.
- **`info.receipt`** is the **spec slot**: the official `SignedReceipt` (`{ format, payload,
  signature, signer }`). It is present **only** when a Tier-2 attestation was signed, so a stock
  reader (`extractReceiptFromResponse` → `info.receipt`) reads the signed receipt **byte-compatibly**.
  When there's no attestation (Tier-1 only), `info.receipt` is absent — a stock reader correctly sees
  "no signed receipt", because there isn't one.

A PipRail client reconstructs the full self-contained
[`PipRailReceipt`](/making-payments/verifying-receipts/) — `{ piprail, receipt, resource, decimals,
attestation? }` — from this block in one pure read (no chain call). With receipts **off**, none of
this is emitted and both the 402 and the 200 are byte-identical to before.

## The `ReceiptOption` interface

`receipts` accepts `true`/`{}` (Tier-1 with defaults) or a `ReceiptOption` object:

```ts
interface ReceiptOption {
  /** Put the settlement tx hash in the receipt. **Default true** — see the divergence below. */
  includeTxHash?: boolean
  /** Canonical resource URL embedded in the receipt (what was paid for). Default '' — the buyer's
   *  client fills it from the URL it fetched; set it here to ground the raw header a third party
   *  reads directly off the wire. */
  resource?: string
  /** Tier-2: also sign an EIP-712 delivery attestation with the merchant's payTo wallet (EVM).
   *  `{ wallet: { key } }` → the merchant's existing payTo key.
   *  `{ jws }`            → a reserved managed signer (R3) — NOT yet implemented; degrades to Tier-1. */
  attest?: { wallet: unknown } | { jws: unknown }
}
```

### `includeTxHash` — a deliberate divergence from the reference default

PipRail defaults `includeTxHash` to **`true`** — the settlement tx hash is in the receipt, so it's
third-party verifiable on-chain out of the box. This **inverts** the x402 reference implementation's
privacy-minimal default (which omits the tx, per §5.2/§11 of the spec). The *envelope* stays
byte-compatible; the *default* is PipRail's, because the whole pitch is the open, self-verifiable
chain. Market it as **"byte-compatible envelope, PipRail-default verifiability,"** never "drop-in
identical defaults."

:::caution[Payer-privacy trade-off — decide deliberately]
A receipt that carries the tx hash bundles a portable `{ payer ↔ resource ↔ tx ↔ merchant }` linkage
that is *more* correlatable than the bare on-chain tx — and that privacy cost lands on the **payer**,
who didn't choose the flag. If your buyers need privacy, set `receipts: { includeTxHash: false }`.
Per the spec's §5.3 empty-string rule, a suppressed tx becomes the empty string `''` on the wire
**and** in the signed Tier-2 message (never an omitted key — verifiers treat `''` as absence). With
the tx suppressed the Tier-1 receipt is **no longer third-party on-chain-verifiable** (it carries no
tx to re-read) — pair it with a **Tier-2 attestation**, which still proves delivery against your
`payTo` key, for a privacy-preserving but still-provable receipt.
:::

### The `nonce` field — memo/nonce-bound families

Five families bind a payment to the challenge by carrying the nonce in an on-chain **memo / note /
comment** rather than in a tx digest: **Stellar, XRPL, NEAR, Algorand, TON** (x402 "Template A"). To
re-verify one of these off-chain, the verifier has to re-scan the merchant's account for *that exact
nonce* — so the receipt must carry it. When `receipts` is on, the gate stamps the challenge `nonce`
(the value it minted into the 402 and the buyer echoed back) onto `X402Receipt.nonce` automatically.

The other families (EVM, Solana, Tron, Sui, Aptos, and every native coin — "Template B") are
digest-bound: they verify on the `transaction` alone, so for them the `nonce` is purely
informational. You don't configure any of this — it's automatic — but it's why a receipt from a
Template-A chain that *lost* its nonce can't be re-verified, while a digest-bound one can.

### `verifiableReceipts` in the self-describe block

When receipts are on **and** [self-describe](/discovery/self-describing-endpoints/) is on (it is by
default), the gate stamps a `verifiableReceipts: true` flag into the `extensions.piprail` block on the
**402 challenge**. So a crawler or agent reading just the 402 — before paying anything — knows the
200 will carry a self-verifiable receipt. It's one boolean; cross-reference
[self-describing endpoints](/discovery/self-describing-endpoints/) for the full block.

## Worked examples

### A basic Tier-1 gate

The minimum. No key, third-party on-chain verifiable out of the box:

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: true,
})
// Every settled payment now ships an X402Receipt at info.settlement,
// carrying the tx hash, decimals, resource URL, and (where relevant) the nonce.
```

### A Tier-2 attested gate

Adds the EIP-712 service-delivery signature with your existing receive key:

```ts
const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: {
    resource: 'https://api.example.com/report',   // ground the raw header a third party reads
    attest: { wallet: { key: process.env.PAYTO_KEY } }, // the SAME { key } every PipRail wallet takes
  },
})
// Now info.receipt also carries the official SignedReceipt — recover(sig) === payTo proves you served it.
```

:::tip
Set `resource` when a third party may read the **raw** `PAYMENT-RESPONSE` header without a PipRail
client (the client otherwise fills `resource.url` from the URL it fetched). For Tier-2 it's the
signed `resourceUrl` field, so it's what the attestation actually commits to.
:::

### A privacy-mode gate (no tx hash, attestation for proof)

For a merchant who doesn't want to bundle the payer→tx linkage but still wants a provable receipt:

```ts
const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…',
  receipts: {
    includeTxHash: false,                          // wire `transaction` becomes '' (§5.3)
    attest: { wallet: { key: process.env.PAYTO_KEY } }, // delivery is still provable via the signature
  },
})
// Tier-1 is no longer on-chain re-readable (no tx), but verifyAttestation still proves you served it.
```

## See also

- [Verifying receipts (buyer / anyone)](/making-payments/verifying-receipts/) — capture with
  `lastReceipt()` and re-verify with `verifyReceipt` / `verifyAttestation`.
- [Receipts & onPaid](/accepting-payments/receipts-and-onpaid/) — the *delivery* side: persist a
  settled receipt to your own store or webhook. That's reconciliation; this page is *verifiability*.
- [Self-describing endpoints](/discovery/self-describing-endpoints/) — the `verifiableReceipts` flag
  on the 402.
- [Verifying payments](/accepting-payments/verifying-payments/) — the in-process verification a
  receipt re-packages.
