---
title: Pay any x402 server (the exact rail)
description: Opt the client into the standard x402 `exact` scheme so it can pay any x402 server, not just PipRail gates — EVM (EIP-3009 USDC/EURC or Permit2 for any ERC-20), Solana (any SPL token), Algorand (any ASA), and Aptos (any Fungible Asset), gas-free for the buyer.
sidebar:
  order: 8
---

## Introduction

By default a [`PipRailClient`](/making-payments/piprail-client/) pays only PipRail's native
`onchain-proof` rail — the backendless scheme where the client pays first and proves it with a
tx ref. That covers every PipRail gate, but most of the public x402 web (the dominant
`exact`-on-Base flow) speaks the ratified **`exact`** scheme instead. Opt into it and the same
client can pay *any* standard x402 server.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'exact'],   // pay PipRail rails AND standard exact rails
})
```

:::note
`schemes` defaults to `['onchain-proof']`. The zero-config path is byte-identical to before
this rail existed — `exact` is strictly opt-in.
:::

## How the exact rail differs

With `onchain-proof`, the client broadcasts the payment itself and proves it. With `exact`, the
buyer **signs with its own wallet** and *someone else* broadcasts it — the merchant's relayer, or a
merchant-chosen **facilitator** (keyless on EVM EIP-3009, Solana, and Algorand). So the buyer spends
roughly **zero gas** — only
the token funds the payment — and PipRail hosts and settles nothing. **The buyer is gasless either way:
how the merchant settles (its own relayer vs a facilitator) is the merchant's call and invisible to the
buyer.** When the merchant points settlement at a free facilitator like **PayAI**, no one runs a
gas-funded key at all — settlement is fully gasless end to end (see
[Gasless payments](/making-payments/gasless-payments/)).

| | `onchain-proof` (default) | `exact` (opt-in) |
| --- | --- | --- |
| Who broadcasts | The client | The server / facilitator |
| Buyer pays gas | Yes (native coin) | No (~0) |
| Pays which servers | PipRail gates | Any standard x402 server |
| Proof | Tx ref, verified locally | A signed EIP-3009 authorization, a Permit2 witness, **or** a partial-signed Solana transaction |

## What exact can settle

The `exact` rail works on **EVM, Solana, Algorand, Aptos, and NEAR**, via one of six on-chain methods. The
402's rail names which one (`extra.assetTransferMethod`), and the client picks the matching signer
automatically:

- **`eip3009`** (EVM) — canonical USDC/EURC and other tokens exposing `transferWithAuthorization`. The
  client re-derives the token's EIP-712 domain on-chain before signing, so a lying or absent
  server-supplied domain can't produce a silently-invalid signature. Fully gasless for the buyer.
- **`permit2`** (EVM) — any ERC-20 **without** EIP-3009, most notably **Binance-Peg USDC/USDT on BNB
  Chain** (no native Circle USDC exists on BNB). The client signs a Permit2 `PermitWitnessTransferFrom`
  whose `spender` is the canonical x402ExactPermit2Proxy and whose `witness.to` binds the recipient
  (so a relayer can't redirect funds). Gasless per-payment too — **after a one-time `approve(Permit2)`**
  the SDK does lazily the first time you pay that token.
- **`svm`** (Solana) — **any** SPL token (USDC, USDT, …). The client builds the SPL `TransferChecked`
  with the merchant as the transaction **fee payer**, signs only its own slot, and sends the
  partially-signed transaction; the gate co-signs as fee payer and broadcasts. No EIP-3009 equivalent,
  no proxy, no approval — gasless for the buyer regardless of token. See
  [Gasless payments](/making-payments/gasless-payments/).
- **`algorand`** (Algorand) — **any** ASA (USDCa, …). The client signs an ASA transfer at **fee 0**,
  atomically grouped with the sponsor's fee-pooling `pay`; the sponsor signs that fee txn and submits
  the group. No token feature required — gasless for the buyer regardless of token.
- **`aptos`** (Aptos) — **any** Fungible Asset (USDC, USD₮, …). The client signs a fee-payer
  (sponsored, AIP-39) `primary_fungible_store::transfer` (sender slot only); the sponsor adds the
  fee-payer signature and submits. No token feature required — gasless for the buyer regardless of token.

| Works on `exact` | Stays on `onchain-proof` |
| --- | --- |
| EVM EIP-3009 (USDC / EURC; FDUSD & USD1 on BNB) | The other non-EVM families (TON, Tron, NEAR, Sui, Stellar, XRPL) |
| EVM Permit2 — any ERC-20 (e.g. Binance-Peg USDC on BNB) | The chain's native coin (incl. SOL, ALGO, APT) |
| Solana SVM — any SPL token (USDC / USDT) | A contract / EIP-1271 / EIP-7702 signer (EVM) |
| Algorand ASA (USDCa) · Aptos FA (USDC / USD₮) | |

An `exact` rail is selected only when the 402 names a network **your bound chain supports** — the
client matches each offered rail against its own chain via the driver (matching the network whether
it's a CAIP-2 id or a chain slug — see [Interoperability](#interoperability-any-network-label) below)
and settles on that chain. So an EIP-3009/Permit2 rail on your bound EVM chain, or an SVM rail on
a Solana-bound client, is payable; an `exact` rail naming a different chain (or a family without an
`exact` scheme) simply isn't selected and falls back to `onchain-proof`.

## Interoperability: any network label

The `exact` rail is the *standard* x402 scheme, so a PipRail client interoperates with the wider x402
ecosystem out of the box — any server or facilitator that speaks `exact`, **however it labels the
network**. Before matching a rail to your bound chain the client normalizes the rail's network, so a
402 that names the chain as a **CAIP-2 id** (`eip155:8453`) *or* a **chain slug** (`base`, `bsc`,
`polygon`) is matched and paid identically. You don't have to know, or configure, which form a given
facilitator emits — both resolve to the same chain.

This matters because facilitators in the wild are inconsistent: the same endpoint may advertise a rail
as `eip155:56` in one place and `bsc` (or `56`) in another. PipRail pays all of them. A label that
resolves to a **different** chain than the one you're bound to — or an unrecognized one — is simply not
selected, never mis-paid; the trusted EIP-712 domain (which fixes the chain id at signing time) is the
final guard regardless of the label.

When you enable both schemes, the client gathers `onchain-proof` rails first, so on a dual-rail
402 the default selection is unchanged. An `exact` rail is only ever picked when the bound
driver can actually settle it (EVM EIP-3009/Permit2, Solana SVM, the Algorand ASA rail, the Aptos FA rail, or the NEAR NEP-366 meta-tx).

To make the client *prefer* the gasless `exact` rail when a gate offers both, enable
[`autoRoute`](/making-payments/fetch-and-autoroute/) (`new PipRailClient({ …, autoRoute: true })`, or
per call `fetch(url, { autoRoute: true })`): it pays the **cheapest settleable** rail, and since the
buyer-gasless `exact` rail estimates at ~0 gas, it wins automatically. Without `autoRoute` the dual-rail
default stays `onchain-proof`; a foreign `exact`-only server is paid over `exact` either way.

## Paying

Once a scheme is enabled, paying is the same call as ever — [`fetch`/`get`/`post`](/making-payments/fetch-and-autoroute/)
handle the 402 transparently and pick the right path per rail:

```ts
const res = await client.get('https://api.example.com/report')
const data = await res.json()
// → the gated JSON, paid for via exact (or onchain-proof) transparently
```

Your spend [`policy`](/spend-controls/payment-policy/) and `onBeforePay` hook gate an `exact`
payment **before** the wallet signs anything — exactly as they gate an `onchain-proof` payment.

## Enabling it per call

You can leave the constructor on the default and flip schemes for a single request, overriding
the constructor's `schemes` for that call:

```ts
const url = 'https://api.example.com/report'
await client.fetch(url, { schemes: ['exact'] })
```

## Read-only planning sees exact too

[`planPayment()`](/making-payments/plan-payment/) and [`quote()`](/making-payments/quote/) honour
the enabled schemes. On an `exact` rail, only the **token** balance gates payability (the buyer
spends no gas), so an `INSUFFICIENT_GAS` blocker never applies and gas-basis warnings are
suppressed.

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)   // analyses exact rails when enabled
if (!plan) {
  await client.fetch(url)        // not gated — fetch it for free
} else if (plan.payable) {
  await client.fetch(url, { autoRoute: true })
} else {
  console.log(plan.fundingHint)  // one-line, human-readable: what to top up
}
```

`planPayment()` returns `null` when the URL isn't payment-gated, so null-guard it before reading
`payable`.

## When exact can't settle

If a 402 offers only an `exact` rail and the bound family can't pay it — a family without an
`exact` scheme (TON, Tron, NEAR, Sui, Stellar, XRPL), the chain's native coin
(incl. SOL, ALGO, APT), or a contract / EIP-1271 / EIP-7702 signer — the client throws
[`UnsupportedSchemeError`](/errors/error-hierarchy/) (`.code === 'UNSUPPORTED_SCHEME'`) rather
than signing something that can't settle. (A non-EIP-3009 ERC-20 is **not** in this list — it pays
via Permit2; nor is an SPL token on Solana — it pays via SVM.)

```ts
import { PipRailClient, UnsupportedSchemeError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  await client.fetch(url, { schemes: ['exact'] })
} catch (err) {
  if (err instanceof UnsupportedSchemeError) {
    // this chain/asset/signer can't pay the exact rail — fall back to onchain-proof
    console.error(err.message)
  } else {
    throw err
  }
}
```

:::caution
A common case is the reverse: a **default** (`onchain-proof`-only) client hits an `exact`-only
402 it *could* pay on its EVM chain. That throws [`NoCompatibleAcceptError`](/errors/error-hierarchy/)
with a one-line remedy — enable the rail with `schemes: ['onchain-proof', 'exact']` (or per call,
`fetch(url, { schemes: ['exact'] })`).
:::

## Failure modes worth knowing

The `exact` pay path is deliberately more conservative than the `onchain-proof` retry loop: the
buyer signs **once** and the same header is re-presented on every retry — it never re-signs a
fresh nonce.

- A **transport error or timeout** after the authorization is submitted throws
  [`PaymentTimeoutError`](/errors/error-hierarchy/) carrying the nonce as `.ref` — the facilitator
  may have already settled, so verify on-chain and **never re-pay**.
- A definitive facilitator rejection (`success: false`) throws
  [`MaxRetriesExceededError`](/errors/error-hierarchy/) — fix the cause, then re-present the
  **same** signed authorization, never a fresh one.
- A `5xx` is returned as-is: a server-side settle failure leaves your authorization valid and its
  nonce unused, so nothing is recorded as spent.

On an `exact` rail, the `.ref` carried by `PaymentTimeoutError` / `MaxRetriesExceededError` is the
authorization **nonce** — the EIP-3009 nonce (a `0x…` 32-byte value) or, on the Permit2 method, the
Permit2 nonce (a uint256). It is *not* a tx hash. Recover by checking the nonce's on-chain state
(EIP-3009 `authorizationState(from, nonce)`, or the Permit2 nonce bitmap) and re-presenting the
**same** authorization — never re-sign:

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  await client.fetch(url, { schemes: ['exact'] })
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // .ref exists ONLY on these two classes — the EIP-3009 nonce on the exact rail
    console.log('recover with this authorization nonce, do NOT re-pay:', err.ref)
  } else {
    throw err
  }
}
```

:::tip
Verify against your target facilitator before production. For the MCP server, enable the rail
with `PIPRAIL_SCHEMES=onchain-proof,exact` (see [MCP configuration](/mcp/configuration/)). To get
*paid* via `exact`, see the [seller side](/accepting-payments/exact-rail-seller/); the low-level
EIP-3009 codecs live in the [reference](/reference/exact-lowlevel/).
:::
