---
title: Pay any x402 server (the exact rail)
description: Opt the client into the standard x402 `exact` scheme so it can pay any x402 server, not just PipRail gates — EVM + EIP-3009 (USDC/EURC), gas-free for the buyer.
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
  wallet: { privateKey: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'exact'],   // pay PipRail rails AND standard exact rails
})
```

:::note
`schemes` defaults to `['onchain-proof']`. The zero-config path is byte-identical to before
this rail existed — `exact` is strictly opt-in.
:::

## How the exact rail differs

With `onchain-proof`, the client broadcasts the payment itself and proves it. With `exact`, the
buyer **signs an EIP-3009 authorization with its own wallet** and the server (or a
merchant-chosen facilitator) broadcasts it. So the buyer spends roughly **zero gas** — only the
token funds the payment — and PipRail hosts and settles nothing. (When the merchant points
settlement at a free facilitator like PayAI, no one runs a gas-funded key at all — settlement is
fully gasless end to end.)

| | `onchain-proof` (default) | `exact` (opt-in) |
| --- | --- | --- |
| Who broadcasts | The client | The server / facilitator |
| Buyer pays gas | Yes (native coin) | No (~0) |
| Pays which servers | PipRail gates | Any standard x402 server |
| Proof | Tx ref, verified locally | A signed EIP-3009 authorization |

## What exact can settle

The `exact` rail is **EVM + EIP-3009 only** — the canonical USDC and EURC deployments, which
expose `transferWithAuthorization`. The client re-derives each token's EIP-712 domain on-chain
before signing, so a lying or absent server-supplied domain can't produce a silently-invalid
signature.

| Works on `exact` | Stays on `onchain-proof` |
| --- | --- |
| EVM USDC / EURC (EIP-3009) | Any non-EVM family (Solana, TON, …) |
| An EOA signer | USDT (needs Permit2), native coin, plain ERC-20 |
| | A contract / EIP-1271 / EIP-7702 signer |

The chains the buyer rail knows by x402 network slug are **`ethereum`, `base`, `arbitrum`,
`optimism`, `polygon`, and `avalanche`** (the EIP-3009 USDC deployments). An `exact` rail on any
other slug simply isn't selected — it falls back to `onchain-proof`.

When you enable both schemes, the client gathers `onchain-proof` rails first, so on a dual-rail
402 the default selection is unchanged. An `exact` rail is only ever picked when the bound EVM
driver can actually settle it.

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

If a 402 offers only an `exact` rail and the bound family can't pay it — a non-EVM chain, a
non-EIP-3009 token, or a contract / EIP-1271 / EIP-7702 signer — the client throws
[`UnsupportedSchemeError`](/errors/error-hierarchy/) (`.code === 'UNSUPPORTED_SCHEME'`) rather
than signing something that can't settle.

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
EIP-3009 authorization **nonce** (a `0x…` 32-byte value, *not* a tx hash). Recover by checking the
token's `authorizationState(from, nonce)` and re-presenting the **same** authorization — never
re-sign:

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
