---
title: How it works
description: The 402 round-trip, merchant-local verification, and why PipRail needs no backend, database, or facilitator.
sidebar:
  order: 4
---

## Introduction

PipRail's whole design follows from one constraint: **no backend.** No server PipRail runs sits
between you and your money. That sounds like a limitation; it's the opposite — it's what lets
payments settle straight to your wallet, with nothing to sign up for and no fee to skim.

## The round-trip

A payment is a four-step HTTP exchange:

1. **Challenge.** The client requests a gated resource. The server answers `402 Payment
   Required` with an x402 challenge describing what it will accept (chain, asset, amount,
   recipient, a one-time nonce).
2. **Pay.** The client picks an acceptable rail, broadcasts the transfer on-chain from its own
   wallet, and re-requests the resource — this time carrying a proof of payment.
3. **Verify.** The server re-derives every field it cares about from its **own trusted
   challenge** (never the client's echo), then checks the proof on-chain against its own RPC.
4. **Deliver.** If the proof is valid, recent, and unused, the server returns `200` with the
   goods.

```
client ──GET /report──────────────▶ server
client ◀──402 + challenge────────── server
client ──(pay on-chain)──▶ blockchain
client ──GET /report + proof──────▶ server ──(verify on-chain)──▶ its own RPC
client ◀──200 + the goods────────── server
```

## Verification is local — there's no facilitator

A "facilitator" is the third party most x402 stacks use to verify and settle payments. PipRail
has none. The server verifies the proof **itself**, on-chain, against the RPC you give it, plus
an in-memory used-proof set and a recency window to stop replays.

:::note
The replay store is pluggable. For a single instance the in-memory set is enough; for a
multi-instance deploy, pass your own `isUsed` / `markUsed` (e.g. backed by Redis) so a proof
can't be spent twice across machines.
:::

## Proof binding — so a payment can't be forged or replayed

A proof must be cryptographically bound to the specific challenge it answers. PipRail uses two
templates, picked per family:

- **Template A — memo/nonce-bound** (Stellar, XRPL, NEAR, Algorand, TON): the challenge nonce
  rides in a memo/note/comment, and `verify()` matches it on the merchant's own account.
- **Template B — digest-bound** (EVM, Solana, Tron, Sui, Aptos, and every native coin): the
  proof is the transaction hash/digest, verified by reading the transaction plus a recency
  window and a single-use proof set.

Either way, `verify()` re-derives every checked field from the **trusted challenge**, so a
forged echo can't redirect it. The details per family live in [Proof
binding](/concepts/proof-binding/).

## One driver per family

Under the hood, each chain family is a self-contained **driver** (`evm`, `solana`, `ton`, …)
implementing one contract. The protocol layer — the parts that issue challenges, parse
envelopes, and run the client — depends only on that contract, never on `viem` or any chain
library. That's what makes non-EVM families **lazy-load on demand**: a pure-EVM install never
pulls in Solana or TON code.

Read more in [The PaymentDriver architecture](/concepts/payment-driver-architecture/).

## Why backendless is allowed

The x402 v2 spec (§7) explicitly permits merchant-local verification — "resource servers MAY…
host the endpoints themselves." So PipRail's shape isn't a clever workaround; it's the
spec-blessed path, just taken all the way.
