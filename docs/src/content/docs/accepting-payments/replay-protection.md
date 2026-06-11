---
title: Replay protection
description: How a gate stops the same proof from being redeemed twice — an in-memory used-proof set plus a recency window, swappable for a shared store across instances.
sidebar:
  order: 5
---

## Introduction

A payment proof is a public on-chain transaction hash. Anyone who sees one settled payment
could try to present that same hash again to unlock the resource for free. A gate stops that
two ways: an **in-memory used-proof set** (each proof redeems exactly once) and a **recency
window** (`maxTimeoutSeconds`, default 600s) that rejects stale proofs. Both are on by default
— you don't configure anything for the single-process case.

This is one half of why a forged or replayed payment can't work; the other half is [proof
binding](/concepts/proof-binding/), which ties every checked field back to the gate's own
trusted spec.

## How it works

Each [gate](/accepting-payments/require-payment-and-gate/) keeps a `Set` of redeemed proof
refs, scoped to that gate. When a proof arrives, the gate reserves its ref *before* doing any
on-chain read; if the ref is already in the set, the proof is rejected as `tx_already_used`:

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })

// proofHeader is the client's `payment-signature` header value (base64).
const first = await gate.verify(proofHeader)
// → { kind: 'paid', receipt: { scheme, success: true, transaction, … }, receiptHeader }

const second = await gate.verify(proofHeader)
// → { kind: 'invalid', error: 'tx_already_used', detail, challenge, requiredHeader, statusCode: 402 }
```

So reuse **one gate per route** and let it live for the lifetime of the process. A fresh gate
on every request would have an empty set and defeat the guard.

:::note
`verify()` returns a `VerifyPaymentResult` — a `{ kind: 'paid' | 'challenge' | 'invalid' }`
union — and **never throws** for a rejected proof. Branch on `result.kind`; on `'invalid'`,
the machine code is in `result.error` (a [`VerifyErrorCode`](/errors/verify-error-code/)) with
a human `result.detail`. See [verifying payments](/accepting-payments/verifying-payments/).
:::

## The recency window

`maxTimeoutSeconds` bounds how old a proof may be. A proof older than the window is rejected as
stale (`payment_expired`), which caps your exposure: even a leaked proof is only redeemable
while it's recent.

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  maxTimeoutSeconds: 120,   // tighter than the 600s default
})
```

:::tip
A tight window plus a single-use set is the production combination for the digest-bound chains
(EVM, Solana, Tron, Sui, Aptos): the proof is single-use, and the window keeps the set small.
See [proof binding](/concepts/proof-binding/) for which chains bind by digest versus memo.
:::

## No false unlocks on flaky RPC

Verification **fails closed**. If the gate's on-chain read fails — a rate-limited public RPC
429s the lookup after the tx is already mined — the gate returns `402 (locked)`, never `paid`.
An RPC outage can't be turned into free access.

Just as important, a failed verification **releases the reservation**. The proof isn't burned,
so the payer can re-submit the *same* proof once the RPC recovers — they never have to re-pay.

```ts
const result = await gate.verify(proofHeader)
// RPC read failed → { kind: 'invalid', error: 'tx_not_found', detail, …, statusCode: 402 }
// (locked, 402) — the proof ref is freed; the same proofHeader can be re-submitted later.
if (result.kind === 'invalid') {
  console.log(result.error)   // → 'tx_not_found'
}
```

:::caution
On the client side, the rule on a confirmation timeout is **re-verify or re-submit the proof,
never re-pay** — a fresh payment double-spends. The proof stays redeemable until the gate's
`maxTimeoutSeconds` window elapses. See [why payments fail](/errors/why-payments-fail/).
:::

## Sharing across instances — `isUsed` / `markUsed`

The built-in set is per-process. If you run multiple instances behind a load balancer, an
in-memory set in each process can't stop a proof being redeemed once per instance. Pass your
own store with the `isUsed` / `markUsed` hooks — a Redis `SET NX` is the canonical choice:

```ts
import { createPaymentGate } from '@piprail/sdk'
import { createClient } from 'redis'

const redis = createClient()
await redis.connect()

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  isUsed:   (ref) => redis.exists(`piprail:proof:${ref}`).then(Boolean),
  markUsed: (ref) => { redis.set(`piprail:proof:${ref}`, '1', { EX: 900 }) },
})
```

| Hook | Signature | Called |
| --- | --- | --- |
| `isUsed` | `(ref: string) => boolean \| Promise<boolean>` | Before verifying — return `true` if this proof was already redeemed. |
| `markUsed` | `(ref: string) => void \| Promise<void>` | After a payment verifies successfully — record the redeemed proof. |

Providing either hook switches the gate off its built-in set entirely; `markUsed` fires only on
success, so a custom store never records a proof that failed verification.

:::caution
The built-in set reserves a ref **synchronously**, so two concurrent requests carrying the same
proof can't both be redeemed. A custom store can't make that guarantee on its own — make the
check-and-reserve atomic (Redis `SET NX`) if you need the same protection against a concurrent
double-redeem. Your `isUsed` / `markUsed` receive the **raw** ref (the default set lowercases
EVM tx hashes for you; a custom store does not).
:::

Running more than one gate instance is the headline production concern — it's the first item on the
[Running in production](/getting-started/running-in-production/) checklist.

## What the ref is, per chain

The replay key is the proof's identifying ref. For the default `onchain-proof` rail it's the
transaction hash (`payload.txHash`). For the standard [`exact` rail](/accepting-payments/exact-rail-seller/),
it's the EIP-3009 authorization `nonce` — claimed the same way, with the on-chain
`authorizationState` as a second canonical guard. Either way, a redeemed ref can't be redeemed
twice.
