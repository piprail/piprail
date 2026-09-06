---
title: VerifyErrorCode
description: The closed, chain-agnostic vocabulary a driver's verify() returns to say why an on-chain proof was rejected.
sidebar:
  order: 3
---

## Introduction

`VerifyErrorCode` is the second of PipRail's [two error channels](/errors/error-model/): the
**returned** one. Where a config or wallet problem *throws* a [`PipRailError`](/errors/error-hierarchy/),
the outcome of verifying an on-chain proof is *returned* — a driver's `verify()` never throws for
a rejected payment, it returns a [`VerifyResult`](/reference/wire-codecs/) carrying one of these codes.

```ts
type VerifyResult =
  | { ok: true; receipt: X402Receipt }
  | { ok: false; error: VerifyErrorCode; detail: string }
```

The set is **closed** — the compiler enforces it, so a driver can't invent a code, and every
family uses the same code for the same condition. An agent branches on `error`; the human-readable
`detail` is for logs.

## The codes

| Code | Meaning | Transient? |
| --- | --- | --- |
| `tx_not_found` | The proof tx isn't on chain yet (RPC lag), or a transient RPC read failed. | transient |
| `insufficient_confirmations` | Mined, but fewer than `minConfirmations` deep. | transient |
| `tx_reverted` | The tx is on chain but failed / reverted. | definitive |
| `no_meta` | The tx carries no metadata to inspect. | definitive |
| `wrong_recipient` | Paid, but not to `payTo`. | definitive |
| `amount_too_low` | Paid to `payTo`, but less than required. | definitive |
| `transfer_not_found` | No matching transfer (asset / amount / nonce) to `payTo`. | definitive |
| `payment_expired` | Older than `maxTimeoutSeconds` (the replay window) — OR the proof's on-chain timestamp is missing/non-finite, so its age can't be bounded (recency fails **closed**, never open). | definitive |
| `tx_already_used` | This proof was already redeemed — a replay. | definitive |
| `signature_invalid` | The `exact`-rail authorization is invalid — the signed payload didn't validate against the trusted rail. On EVM the EIP-712 signature didn't recover to the payer; on Solana, Algorand, Aptos, and NEAR the signed transaction / atomic group / delegate-action is unparseable, the signer or structure is wrong, or it trips a fee-payer/relayer drain guard. On XRPL the signed `Payment` blob is undecodable or unsigned, its `InvoiceID` doesn't bind the challenge, or it carries a field the scheme forbids (`Memos`, `Paths`, `DeliverMin`, `Delegate`, `tfPartialPayment`, or both `Amount` and `DeliverMax`). | definitive |
| `upto_settle_exceeds_max` | The [`upto` (metered) rail](/accepting-payments/upto-rail-seller/): the merchant's metered settle amount exceeds the maximum the buyer signed (`permitted.amount`). Gate/driver-enforced before any broadcast — nothing settles. | definitive |

:::note
This is also exactly what a **merchant** receives. When a submitted proof is rejected, the gate's
[`onFailed`](/accepting-payments/receipts-and-onpaid/) hook fires with a `FailedPayment` whose
`.code` is the same `VerifyErrorCode` from the table above (and whose `.detail` is the same
human-readable line) — so the buyer's client and the merchant's hook are told one consistent reason.
The **Transient?** column maps to `FailedPayment.transient`: `true` for the two transient codes,
`false` for a definitive rejection. Alert the merchant on `!transient` — a transient code usually
clears on the buyer's automatic retry and is followed by `onPaid`.
:::

## Transient vs definitive

`transient` means the proof may simply not have propagated to the server's RPC node yet;
`definitive` means retrying won't change the outcome. **These labels are informational** — the
built-in client retries *every* code up to `maxPaymentRetries` with a short backoff that absorbs
RPC lag, and does not branch on the code. A consumer building a custom client may branch on it.
On the gate side the same split surfaces as `FailedPayment.transient`
([`onFailed`](/accepting-payments/receipts-and-onpaid/)).

:::note
`verify()` fails closed. If the gate's RPC read fails, it returns `tx_not_found` and replies
`402` (locked) — never `paid`. An RPC outage can't trick a merchant into unlocking, and the gate
releases its replay claim on failure, so the same proof can be re-submitted once the RPC recovers.
:::

## Why each code appears

Most codes map to a stage of [proof binding](/concepts/proof-binding/) — find the tx, confirm it,
read the transfer, check it was unused.

- **`tx_not_found`** — the only transient that all drivers emit. The proof ref didn't resolve to
  a transaction on the merchant's RPC: it hasn't landed yet, or the read itself failed.
- **`insufficient_confirmations`** — the tx is mined but not yet `minConfirmations` deep. Emitted
  by families with a discrete confirmation depth (EVM and XRPL); the client retries after the backoff.
- **`tx_reverted`** — the transaction exists on chain but its execution failed, so nothing settled.
- **`no_meta`** — Solana-specific: the transaction returned no metadata to inspect, so the transfer
  can't be read.
- **`wrong_recipient`** — a digest-bound transfer landed, but not to the merchant's `payTo`.
- **`amount_too_low`** — the transfer reached `payTo` but paid less than the rail required.
- **`transfer_not_found`** — no transfer matching the asset, amount, and nonce was found on
  `payTo`. On account-watch chains this also absorbs "wrong recipient" (see below).
- **`payment_expired`** — the proof is older than the rail's `maxTimeoutSeconds` recency window. On
  the `exact` rail, this is also an expired or not-yet-valid EIP-3009 authorization. It **also** fires
  when the proof's on-chain timestamp is missing or non-finite (a degraded RPC): the age can't be
  bounded, so the recency check fails **closed** (`"Cannot bound the age … — failing closed."`) rather
  than letting an unbounded-age proof through.
- **`tx_already_used`** — the verify-style code the gate emits for the onchain-proof replay set — and
  that the EVM `exact` / Permit2 driver also returns via the token's on-chain `authorizationState` /
  Permit2 nonce check.
- **`signature_invalid`** — `exact`-rail only: the signed authorization didn't validate against the
  trusted rail. On EVM the EIP-712 signature didn't recover to the claimed payer; on Solana,
  Algorand, Aptos, and NEAR the signed transaction / atomic group / delegate-action is unparseable,
  its signer or structure is wrong, or it exceeds the fee-payer/relayer drain-guard caps. See
  [the exact rail](/accepting-payments/exact-rail-seller/).

## Family-specificity is structural, not drift

Some codes are emitted only by certain families because of how that chain is verified — not
because of inconsistency.

| Behaviour | Why |
| --- | --- |
| `no_meta` is Solana-only | Only Solana exposes a "no transaction metadata" condition. |
| `insufficient_confirmations` is EVM/XRPL-style | It needs a discrete confirmation count. |
| Account-watch chains (TON, Stellar) never say `wrong_recipient` | They scan the merchant account, so "wrong recipient" and "no payment" both collapse to `transfer_not_found`. |
| EVM / Solana digest verifiers report a short token payment as `transfer_not_found` | The digest path has no nonce binding to anchor an `amount_too_low`; nonce-bound chains (TON, Stellar) can say `amount_too_low`. |

All of these are correct. See [Payment driver architecture](/concepts/payment-driver-architecture/)
for the two verification templates behind the split.

## What the agent receives

A rejected proof becomes a conformant v2 `402` re-challenge: a full body with `accepts[]` (so a
standard client can retry), the human reason in `error`, and the machine code in
`extensions.piprail.{code,detail}`. The built-in [`requirePayment`](/accepting-payments/require-payment-and-gate/)
adapter emits this automatically; the client relays the reason to the agent. When the client
finally gives up, `MaxRetriesExceededError` embeds the last server rejection — for example:

```text
… Last server rejection: amount_too_low — Paid 40000, required 500000.
```

:::caution
A reverted, expired, or rejected proof is **not** a reason to re-pay. On a broadcast-but-unconfirmed
failure (`MAX_RETRIES_EXCEEDED` / `PAYMENT_TIMEOUT`) read `.ref` and re-submit *that* proof — a
fresh payment would double-spend. See [Why payments fail](/errors/why-payments-fail/).
:::
