---
title: Defining accepts
description: The RequirePaymentOptions shape, either single-rail shorthand or a multi-rail accept[], that says exactly which chains, tokens, and amounts a gate will take.
sidebar:
  order: 2
---

## Introduction

`RequirePaymentOptions` is the one object you pass to
[`requirePayment`](/accepting-payments/require-payment-and-gate/) or
[`createPaymentGate`](/accepting-payments/require-payment-and-gate/). It declares **what you
accept**: which chain, which token, how much, and where the money lands. There are two forms,
a single-rail shorthand and a multi-rail `accept[]`, and you pass exactly one of them.

## Single-rail shorthand

The common case: name the `chain`, `token`, `amount`, and `payTo` at the top level. One rail,
one line.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })
```

`token` is required. Every gate states exactly what it takes, so there's never any doubt
whether a route wants USDC, USDT, or the native coin. Name a built-in symbol (`'USDC'`,
`'USDT'`), use `'native'` for the chain's own coin, or pass a custom token by address. The
symbol is all you write; the SDK fills in the contract address and decimals.

```ts
requirePayment({ chain: 'bnb',    token: 'USDT',   amount: '1',     payTo: '0xYourWallet' })
requirePayment({ chain: 'base',   token: 'native', amount: '0.001', payTo: '0xYourWallet' }) // ETH
requirePayment({ chain: 'solana', token: 'USDC',   amount: '0.10',  payTo: 'YourSolanaAddr' })
```

`amount` is **human units**, given as a **plain-decimal string**: `'0.10'` is ten cents of a
6-decimal USDC, not ten base units. The SDK scales it to base units against the token's decimals,
so you never write `100000`. It must be a literal decimal: **scientific notation (`'1e3'`) is
rejected** with an [`InvalidConfigError`](/errors/error-hierarchy/), never silently read as `1000`.
See [Chains and tokens](/concepts/chains-and-tokens/) for the full token grammar and custom-token
descriptors per family.

## Multi-rail: `accept[]`

To offer **several rails in one challenge**, pass `accept[]`. The agent pays with whatever it
holds, on whichever of the offered chains it can settle.

```ts
import { requirePayment } from '@piprail/sdk'

const BASE_RPC = process.env.BASE_RPC   // your own RPC per chain (public ones are rate-limited)
const TRON_RPC = process.env.TRON_RPC
const SOL_RPC  = process.env.SOL_RPC

requirePayment({
  payTo: '0xYourWallet',
  accept: [
    { chain: 'base',   token: 'USDC', amount: '0.10', payTo: '0xYourWallet', rpcUrl: BASE_RPC },
    { chain: 'tron',   token: 'USDT', amount: '0.10', payTo: 'T…',           rpcUrl: TRON_RPC },
    { chain: 'solana', token: 'USDC', amount: '0.10', payTo: 'YourSolanaAddr', rpcUrl: SOL_RPC },
  ],
})
```

The two forms are **mutually exclusive**. Pass `accept[]` *or* top-level
`chain`/`token`/`amount`, never both. Passing both, or neither in full, throws a clear `Error` on
the **first request** (the gate resolves lazily, not at construction time). Under `requirePayment`
that error is forwarded to `next(err)`.

### Per-rail overrides and fallbacks

Each `AcceptOption` carries its own `chain`, `token`, and `amount`, and may override `payTo` and
`rpcUrl` for its chain. When omitted, both fall back to the top-level value.

| Field | Per-rail behaviour |
| --- | --- |
| `chain` / `token` / `amount` | Required on every entry; describe that one rail. |
| `payTo` | Falls back to the top-level `payTo` when omitted. |
| `rpcUrl` | Falls back to the top-level `rpcUrl` when omitted. |

:::caution
Address shapes differ across families (`0x…` on EVM, base58 on Solana, `r…` on XRPL, `T…` on
Tron, …), so a single top-level `payTo` only works for one family. Give a **per-option `payTo`**
for every non-EVM rail, or the gate throws when it validates the address that doesn't match its
chain.
:::

Each rail also resolves through its **own** driver with its **own** `rpcUrl`, so one throttled
public RPC can't take down verification for the others. In production, set `rpcUrl` on every rail
because public endpoints are rate-limited. The `rpcUrl` is used server-side only; it is never leaked
into the challenge.

## How the client picks

A [`PipRailClient`](/making-payments/piprail-client/) is bound to **one** chain: its own `chain`
plus wallet. When it receives a multi-rail challenge it picks the offered rail whose network it
supports **and** whose [spend policy](/spend-controls/payment-policy/) allows, pays that one, and
ignores the rest. With [`autoRoute`](/making-payments/fetch-and-autoroute/) on it pays the
cheapest *settleable* rail; [`planPayment()`](/making-payments/plan-payment/) shows you the
ranking first. To compare cost across chains yourself, point one client per chain at the same URL
and compare their [`estimateCost()`](/making-payments/estimate-cost/) results.

On the gate side, verification selects the matching rail by **network + asset** and re-derives
every checked field from its own trusted spec, so a forged echo of the offered terms can't redirect
it. See [Verifying payments](/accepting-payments/verifying-payments/).

## Describing the charge

`description` is shown to the agent inside the challenge, a short human label for what the
payment buys.

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  description: 'One market-data report',
})
```

## Timing and confirmations

| Option | Default | Purpose |
| --- | --- | --- |
| `maxTimeoutSeconds` | `600` | Max age of an accepted payment, in seconds. How long a challenge stays valid. |
| `minConfirmations` | `1` | Confirmations required on-chain before access is granted. |

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  maxTimeoutSeconds: 120,   // tighten the recency window
  minConfirmations: 2,      // wait for two confirmations
})
```

A tighter `maxTimeoutSeconds` shrinks the replay window; pair it with a persistent
[replay store](/accepting-payments/replay-protection/) for multi-instance deploys.

## Further options

The remaining `RequirePaymentOptions` fields are covered on their own pages: `onPaid` on
[Receipts and onPaid](/accepting-payments/receipts-and-onpaid/), `isUsed`/`markUsed` on
[Replay protection](/accepting-payments/replay-protection/), `exact` on the
[exact rail](/accepting-payments/exact-rail-seller/), and `discovery` on
[Discover and register](/discovery/discover-and-register/). The full type lives in the
[API reference](/reference/api/).
