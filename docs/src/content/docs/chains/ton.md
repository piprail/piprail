---
title: "Accept USDT payments on TON"
description: 'Take and make payments on TON (the Telegram blockchain) in USD₮ or native Gram (formerly Toncoin), the one chain that needs a free RPC API key.'
sidebar:
  label: TON
  order: 3
---

## Introduction

TON (The Open Network, the Telegram blockchain) is a non-EVM family. Name it with `chain: 'ton'`
and the driver **auto-mounts on first use**, so a pure-EVM or Solana install never downloads the
TON libraries. The protocol layer is unchanged; only the wallet shape and one RPC caveat differ.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'ton', token: 'USDT', amount: '0.10', payTo: 'EQ…' })
```

## TON, Gram & the network id

Three names show up on this chain. Here's the map, because it trips people up:

| What | Value | Stays the same? |
| --- | --- | --- |
| **Network** (the blockchain) | The Open Network, **TON** | ✅ Select it with `chain: 'ton'`. |
| **Native coin** (the token) | **Gram** · ticker `GRAM` | 🔁 Renamed from *Toncoin* (`TON`) on **2026-06-15**. |
| **CAIP-2 network id** (on the wire) | **`tvm:-239`** | ✅ The canonical id x402 tooling matches on. |

### The Gram rebrand is token-only

On **2026-06-15**, a TON community governance vote renamed the native token **Toncoin → Gram** and
its ticker **`TON` → `GRAM`**. It is a *presentation-layer* change: balances, addresses, smart
contracts, jettons, and staking are untouched, with **no migration, swap, or bridge**. So in the SDK,
`chain: 'ton'` and `token: 'native'` are exactly as before; the only difference is that the native
coin's **symbol now reads `GRAM`** (e.g. a 402's `extra.symbol`, and `estimateCost`'s `feeSymbol`).
USD₮ and every other jetton are unaffected.

### The network id is `tvm:-239` (not `ton:-239`)

Every x402 payment labels its chain with a [CAIP-2](https://chainagnostic.org/CAIPs/caip-2)
identifier: a universal `namespace:reference` string that lets any wallet, facilitator, or
discovery index agree on **which chain** a payment is on. For TON mainnet that is **`tvm:-239`**:

- **`tvm`** is the namespace for the **T**ON **V**irtual **M**achine family, per the
  [chain-agnostic registry](https://namespaces.chainagnostic.org/tvm/caip2). (There is **no** `ton`
  namespace; that was a non-canonical id some tools, PipRail included, used early on.)
- **`-239`** is TON mainnet's *network global id*, a constant carried in every TON block. (Testnet is `-3`.)

PipRail emits the canonical **`tvm:-239`** so its TON 402s are matchable by standard x402 clients and
discovery indexes; an inbound challenge that still uses the legacy `ton:-239` is accepted and
normalized on parse, so nothing breaks either way. (Unrelated: the SDK-internal proof **locator**
`ton:<jetton-wallet>|<nonce>` is a private string, **not** the network id, and it is unchanged.)

## Install the peer dependency

The TON libraries are optional peer deps. Install them once and the lazy import finds them:

```bash
npm install @ton/ton @ton/core @ton/crypto
```

## The wallet

A TON wallet is `{ key }`, where `key` is a 24-word mnemonic (a `string[]` or one space-separated
string), or a ready `{ keyPair }`. The wallet contract defaults to `v4`; pass `version: 'v5r1'`
for a W5 wallet, and it **must match** the version your funded address was created with.

```ts
import { PipRailClient } from '@piprail/sdk'

const mnemonic = process.env.TON_MNEMONIC // 24 words, space-separated or a string[]

const client = new PipRailClient({ chain: 'ton', wallet: { key: mnemonic } })
// W5 wallet: new PipRailClient({ chain: 'ton', wallet: { key: mnemonic, version: 'v5r1' } })
```

The shape is checked synchronously at bind time, so passing an EVM or Solana wallet fails fast
with a `WrongFamilyError`. See [Wallets by family](/making-payments/wallets-by-family/).

## You need a free RPC API key

TON is the only chain with a one-time setup step. The default keyless toncenter endpoint is
rate-limited (~1 req/s) and will stall `confirm()` / `verify()`, which poll and read archival
history. Use a keyed, archival-capable endpoint and **put the key in the URL**:

```ts
const rpcUrl = `https://toncenter.com/api/v2/jsonRPC?api_key=${process.env.TONCENTER_KEY}`
const payTo = 'EQ…' // your bounceable TON address (EQ… or UQ…)

requirePayment({ chain: 'ton', token: 'USDT', amount: '0.10', payTo, rpcUrl })
new PipRailClient({ chain: 'ton', wallet: { key: mnemonic }, rpcUrl })
```

:::tip
Free keys take about 30 seconds: message **@tonapibot** on Telegram, or sign up at
toncenter.com. Skip the key and you'll hit rate limits; add it and TON behaves like every
other chain.
:::

## Tokens

Name the symbol; the SDK fills in the jetton master and decimals.

| Token | Built in | Notes |
| --- | --- | --- |
| `'USDT'` | Yes | USD₮ (Tether-native, dominant on TON). Master + 6 decimals verified on-chain. |
| `'native'` | Yes | Gram (ticker `GRAM`, formerly Toncoin/`TON`), 9 decimals (nanoton). |
| custom jetton | n/a | Any other jetton via `{ master, decimals }` (e.g. USDe). |

```ts
// A custom jetton is { master, decimals }:
requirePayment({ chain: 'ton', token: { master: 'EQ…', decimals: 6 }, amount: '0.10', payTo })
```

:::caution
**Native USDC does not exist on TON.** Circle doesn't issue it there, so it's intentionally
absent and `token: 'USDC'` throws [`UnknownTokenError`](/errors/error-hierarchy/). Pay in
`'USDT'`, `'native'`, or a custom jetton.
:::

## Receive prerequisite: none

The merchant needs no setup. The payer's attached gas (~0.05 GRAM, leftover refunded)
auto-deploys the merchant's jetton wallet on first receipt, so there's no trustline or opt-in to
register, so `planPayment()` won't raise `RECIPIENT_NOT_READY` for TON. The payer, however,
**needs GRAM (the native coin) for gas** even when paying USD₮. Budget it with
[`estimateCost()`](/making-payments/estimate-cost/), which reports the fee in the native coin.

```ts
const { quote, cost } = await client.estimateCost('https://api.example.com/report')
// → { quote: { amountFormatted: '0.10', symbol: 'USDT', … }, cost: { feeFormatted: '0.0…', feeSymbol: 'GRAM', feeDecimals: 9, basis: 'heuristic' } }
// cost is the network fee in GRAM (the native gas coin), separate from the USD₮ payment
```

## When the payer can't cover gas

The headline TON caveat is that even a USD₮ payment burns GRAM (the native coin) for gas, so a wallet
flush with USD₮ but short on GRAM still can't settle. [`planPayment()`](/making-payments/plan-payment/) reports
that as a blocker without throwing; [`fetch()`](/making-payments/piprail-client/) throws a typed
[`InsufficientFundsError`](/errors/error-hierarchy/) (`.code === 'INSUFFICIENT_FUNDS'`) so you can
catch it and top up the right coin:

```ts
import { InsufficientFundsError } from '@piprail/sdk'

try {
  const res = await client.fetch('https://api.example.com/report')
  console.log(await res.text())
} catch (err) {
  if (err instanceof InsufficientFundsError) {
    // fund the payer: USD₮ for the payment, and GRAM for gas
    console.error('Top up the TON wallet (USD₮ and/or GRAM gas):', err.message)
  } else {
    throw err
  }
}
```

To branch *before* spending instead of catching, plan first:

```ts
const plan = await client.planPayment('https://api.example.com/report')
if (!plan) {
  await client.fetch('https://api.example.com/report') // not payment-gated
} else if (plan.payable) {
  await client.fetch('https://api.example.com/report')
} else {
  console.log(plan.fundingHint) // e.g. "add ~0.05 GRAM for gas"
}
```

## Proof binding: Template A (memo-bound)

TON uses [Template A](/concepts/proof-binding/): the challenge nonce rides in the jetton transfer
**comment**, and `verify()` matches it on the merchant's own jetton wallet, so a look-alike
jetton can't satisfy the gate, and the proof is cryptographically bound to the challenge that
issued it.

:::note
TON settles **asynchronously**, because value crosses contracts, so a credit can take seconds to appear.
Because of that the proof ref is a self-contained **locator** (`ton:<jetton-wallet>|<nonce>`), not
a tx hash. `verify()` re-derives every checked field from the trusted `accept`, never the
client-supplied ref.
:::

:::note[Jetton credits require a successful VM compute]
A **jetton** credit only counts if the merchant's jetton wallet actually *executed* the transfer:
`verify()` requires a successful `vm` compute phase. This rejects a forged `internal_transfer` body
sent to a **not-yet-deployed** merchant jetton wallet: it lands `aborted=false` with a *skipped*
compute (no code ran) and credits nothing, so the forged amount can't satisfy the gate. A **native
GRAM** transfer is exempt: value moves on message delivery regardless of the recipient's compute
phase (so a brand-new payTo can still receive native).
:::

## Server-side only

TON's libraries don't ship a clean browser ESM build yet, so run the TON path **server-side**:
the identical one line, on Node, Bun, Deno, or Workers. The lazy import means a pure-EVM page
never downloads them. See [Chains & tokens](/concepts/chains-and-tokens/) for the full
cross-chain caveat list.
