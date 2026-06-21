---
title: Replay protection & recovery
description: How a gate stops a proof being redeemed twice (a bounded in-memory used-proof set + a recency window), what happens to a payment when a request doesn't finish, and how to share the store across instances.
sidebar:
  order: 5
  label: Replay protection
---

## Introduction

A payment proof is a public on-chain transaction hash. Anyone who sees one settled payment
could try to present that same hash again to unlock the resource for free. A gate stops that
two ways: an **in-memory used-proof set** (each proof redeems exactly once) and a **recency
window** (`maxTimeoutSeconds`, default 600s) that rejects stale proofs. Both are on by default
— you don't configure anything for the single-process case, and the set is
[**bounded**](#bounded-memory) so it can't grow forever.

This is one half of why a forged or replayed payment can't work; the other half is [proof
binding](/concepts/proof-binding/), which ties every checked field back to the gate's own
trusted spec.

:::tip[The short version]
- A proof redeems **exactly once**, and only while it's recent — replay and forgery both fail.
- A **failed or interrupted** verification (RPC blip, not-yet-confirmed, a thrown read) **frees
  the proof**, so the payer retries the *same* proof — they never re-pay.
- The one unrecoverable case is narrow and deliberate: the proof verified, then *delivery*
  failed after. That's **at-most-once by design** — see [Paid but didn't
  receive](#paid-but-didnt-receive--the-recovery-model).
:::

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

## Bounded memory

The recency window does double duty: it also **bounds the used-proof set**. Because a proof older
than `maxTimeoutSeconds` is rejected as stale *regardless* of the set, the gate evicts an entry
once it ages past the window — there's no reason to remember a proof the recency check would reject
anyway. So the built-in set holds at most **one window's worth of recent proofs**, not every proof
the gate has ever seen. A long-lived gate (a process that runs for weeks under PM2) stays flat
instead of leaking memory, and eviction is safe: a dropped proof, re-presented, fails the recency
check, so replay is still impossible.

You don't configure this — it follows `maxTimeoutSeconds`. A tighter window keeps the set smaller;
a wide window (say a day) deliberately remembers a day of proofs, which is exactly what's needed to
stop replay over that window. A **custom** `isUsed`/`markUsed` store owns its own eviction — give it
a TTL equal to the window (the Redis example below uses `EX: 900` for a 600s window plus slack).

## No false unlocks on flaky RPC

Verification **fails closed**. If the gate's on-chain read fails — a rate-limited public RPC
429s the lookup after the tx is already mined — the gate returns `402 (locked)`, never `paid`.
An RPC outage can't be turned into free access.

Just as important, a failed verification **releases the reservation**. The proof isn't burned,
so the payer can re-submit the *same* proof once the RPC recovers — they never have to re-pay.
This holds whether `verify()` returns a rejection **or throws** (an unexpected RPC exception is
caught and the reservation released, then rethrown) — a transient blip never permanently burns a
valid proof.

```ts
const result = await gate.verify(proofHeader)
// RPC read failed → { kind: 'invalid', error: 'tx_not_found', detail, …, statusCode: 402 }
// (locked, 402) — the proof ref is freed; the same proofHeader can be re-submitted later.
if (result.kind === 'invalid') {
  console.log(result.error)   // → 'tx_not_found'
}
```

## Paid but didn't receive — the recovery model

The question worth understanding before you ship: **a buyer pays, then the request doesn't finish
— what happens to their money?** The answer depends entirely on *where* it failed, and the gate is
deliberately built so that almost every failure is recoverable without re-paying.

| Where it fails | The payment | The proof | Recoverable? |
| --- | --- | --- | --- |
| Client paid on-chain but the request never reached the gate (or dropped pre-verify) | settled | never reserved | ✅ **Yes** — re-send the same proof |
| Gate's read failed / threw / tx not yet confirmed (transient) | settled | reserved, then **released** | ✅ **Yes** — re-send the same proof |
| Recency window elapsed before a successful retry | settled | n/a | ❌ Expired (`payment_expired`) — widen `maxTimeoutSeconds` if your settle is slow |
| **Verify succeeded, then delivery failed *after*** (server crashed mid-response; connection dropped after the 402→200) | settled | **burned** | ⚠️ **Not via the same proof** — at-most-once by design |

The first two rows are the common cases, and they Just Work: the proof is **freed on any
non-success**, so the payer (or the [`PipRailClient`](/making-payments/piprail-client/), which
retries automatically) re-presents the *same* proof and gets in — no second payment.

### Why the last row is at-most-once — and why that's correct

Once a proof **verifies successfully** it's burned, and the gate then hands `{ kind: 'paid' }` to
your handler, which serves the bytes. If delivery fails *after* that point, the proof is already
spent and re-presenting it is rejected as a replay. There is no "re-serve it within a grace
window," and that's a **deliberate security choice, not a gap**:

- The proof is a **public on-chain transaction hash** — anyone watching the chain (or sniffing the
  header) can see it. A re-serve window would be exactly the window in which a stranger who never
  paid could replay that hash for free.
- A verify-only, backendless gate hands "paid" to your app and your app ships the response; the gate
  can't know whether the bytes arrived, and it **can't safely re-serve a public proof later**.

This is the classic "exactly-once delivery is impossible" tradeoff, and PipRail picks
**at-most-once (secure)** over at-least-once (replayable). Issuing a private re-access token would
require sessions — server state — which is the backend this project is defined against.

### Living with it

For the typical x402 resource (a sub-cent, idempotent, regenerable API response) the rare
verify-succeeded-then-delivery-lost case is a negligible loss. When it matters more:

- **Keep the delivered payload regenerable** so a buyer who re-requests (and re-pays) gets the same
  thing — most data endpoints already are.
- **Record every settlement out-of-band** with [`onPaid` + a durable receipt
  webhook](/accepting-payments/receipts-and-onpaid/), so you can reconcile or comp a buyer who paid
  and provably didn't receive — dedupe on the receipt's `idempotencyKey`.
- **Keep prices low and per-call**; x402 is built for many tiny payments, not one large one whose
  loss stings.

## The client's half — never re-pay

The [`PipRailClient`](/making-payments/piprail-client/) is built to never turn a delivery hiccup
into a double-spend. Once it broadcasts a payment it **holds the proof ref and re-presents the same
proof** on every retry (it never re-pays), and it's patient when a tx is broadcast-but-not-yet-confirmed.
If it ultimately gives up, it throws a typed error that **carries the proof** so you can recover:

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  const res = await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // The payment was BROADCAST. err.ref is the on-chain proof.
    // Re-submit ref to the SAME URL to finish delivery — NEVER pay again (it would double-spend).
    console.log('paid but not delivered; recover with proof', err.ref)
  }
}
```

:::caution
The rule on any post-broadcast failure is **re-verify or re-submit the proof, never re-pay** — a
fresh payment double-spends. The proof stays redeemable until the gate's `maxTimeoutSeconds` window
elapses. See [why payments fail](/errors/why-payments-fail/).
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

Provide **both** `isUsed` and `markUsed` together to switch the gate off its built-in set
entirely — they're validated as a pair at gate construction, and building a gate
(`requirePayment` / `createPaymentGate`) with only one **throws immediately** (only `isUsed`
would record nothing, so every proof replays; only `markUsed` would reject nothing — either
silently disables replay protection). `markUsed` fires only on success, so a custom store never
records a proof that failed verification.

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
