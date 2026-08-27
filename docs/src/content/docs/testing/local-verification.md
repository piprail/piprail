---
title: Local verification
description: 'How a payment is verified with no backend — on-chain against your own RPC, plus an in-memory used-proof set and recency window.'
sidebar:
  order: 1
---

## Introduction

PipRail has no server, no database, and no facilitator — yet a gate still has to be sure a
payment really happened. It does that **locally**: when a proof arrives, `verify()` does a
targeted lookup on **your own RPC**, confirms the transaction succeeded and moved the required
amount of the right token to `payTo`, checks it's recent enough, and checks it hasn't been
redeemed before. All in-process — no facilitator round-trip — a single targeted read against
your own RPC.

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
})

// `headerValue` is the incoming `payment-signature` request header (or undefined).
const result = await gate.verify(headerValue) // reads your RPC
// → { kind: 'paid', receipt, receiptHeader }       on success
// → { kind: 'invalid', error, detail, challenge, … }  on a rejected proof
// → { kind: 'challenge', challenge, requiredHeader, … } when no proof was sent
```

`verify()` returns a [`VerifyPaymentResult`](/accepting-payments/verifying-payments/) — a
three-way union, never a thrown error for a bad proof. This page explains what that guarantees
and how the SDK's own tests pin it. For the gate API itself see
[requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/); for the
proof-binding theory see [Proof binding](/concepts/proof-binding/).

## What local verification checks

The proof is a real, public on-chain transaction. `verify()` re-derives **every** checked field
from the **trusted `accept`** it issued — never the client-supplied ref — so a forged echo can't
redirect it. A proof passes only when all of these hold:

| Check | What it confirms |
| --- | --- |
| Transaction exists & succeeded | A real, mined transfer (not reverted) on your RPC. |
| Amount + token + `payTo` | It moved at least the required amount of the right token to your wallet. |
| Recency | It's newer than `maxTimeoutSeconds` (default `600`s) — stale proofs are rejected. |
| Single-use | It hasn't been redeemed before (the in-memory used-proof set). |
| Confirmations | It has at least `minConfirmations` (default `1`). |

A failed check yields a typed [`VerifyErrorCode`](/errors/verify-error-code/) (`amount_too_low`,
`transfer_not_found`, `payment_expired`, `tx_reverted`, …) carried on a `kind: 'invalid'` result
— not a thrown error — and the gate answers `402`, never `paid`.

## Replay protection — used-proof set + recency window

One transaction can be redeemed **once**. The gate keeps an in-memory used-proof set, and the
recency window (`maxTimeoutSeconds`) rejects anything older. Together they bound the replay
surface to a single proof inside a short window.

```ts
createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
  maxTimeoutSeconds: 300, // tighten the window for higher-value endpoints
})
```

For multi-instance deploys, share the set across processes with the pluggable `isUsed` /
`markUsed` hooks (e.g. Redis `SET NX`). They take the proof `ref` and may be sync or async:

```ts
createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
  isUsed: async (ref) => (await redis.exists(ref)) === 1,
  markUsed: async (ref) => { await redis.set(ref, '1', 'NX') },
})
```

Full treatment on the [Replay protection](/accepting-payments/replay-protection/) page.

:::note
Verification **fails closed**. If the RPC read fails, the gate returns `tx_not_found` →
`402`, never `paid` — an outage can't be exploited for free access. On failure it also **releases
the replay claim**, so the same proof can be re-submitted once the RPC recovers; the proof isn't
burned.
:::

## The Vitest suite is the canonical contract

`sdk/test/` (Vitest) **is** the spec — behaviour changes there before it changes in the SDK. Run
it from the `sdk/` directory:

```bash
npm test            # vitest run — the full suite
npm run test:watch  # re-run on change while developing
```

The verification behaviour above is pinned by, among others, `verify.test.ts` (the per-template
proof checks and the recency-window rejection), `server.test.ts` (gate challenge + verify
branches, including `isUsed`/`markUsed`), `client.test.ts` (the pay loop), and the per-family
folders (`evm/`, `solana/`, `ton/`, …). Edge cases live in `edge-cases.test.ts`; cross-family
symmetry in `describe-asset.test.ts` and `conformance.test.ts`.

## How the suite verifies without a chain

Most tests never touch a live network. They register a **fake driver** so the protocol layer runs
against a controllable `ResolvedNetwork`, and stub `globalThis.fetch` so the 402 → pay → retry
loop is deterministic. A `PaymentDriver` is just `{ family, resolve() }`, and `resolve()` hands
back the `ResolvedNetwork`:

```ts
import { registerDriver, type ResolvedNetwork } from '@piprail/sdk'

declare const fakeNet: ResolvedNetwork // a controllable in-memory network (see Mocking)
declare const stubFetch: typeof fetch  // canned 402, then 200 on a proof

registerDriver({ family: 'stellar', resolve: () => fakeNet }) // no real RPC
globalThis.fetch = stubFetch
```

This is by design: because the protocol layer depends only on the `PaymentDriver` contract in
`drivers/types.ts` (zero chain libraries), a fake network is enough to exercise gates, the client,
policy, and the replay guard — fast, offline, and deterministic. See the
[PaymentDriver architecture](/concepts/payment-driver-architecture/) for the contract these fakes
implement. The full set of layers the suite covers — pure unit, fake-driver flow, and adversarial
— is the test contract in `sdk/STANDARDS.md` §4.

## When you need a real chain

The fake-driver suite proves the logic; it can't prove a chain's actual settlement. For a real
mainnet `402 → pay → confirm → verify → 200` round-trip (plus a replay-reject) against funded test
wallets, see the [Live smoke test](/testing/live-smoke-test/). To test **your own** integration
without spending, [Mocking](/testing/mocking/) shows how to register a fake driver and stub the
402 the way the suite does.
