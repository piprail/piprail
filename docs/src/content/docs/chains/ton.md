---
title: "TON"
description: Take and make payments on TON (the Telegram blockchain) in USD₮ or native Toncoin — the one chain that needs a free RPC API key, plus its memo-bound proof.
sidebar:
  order: 3
---

## Introduction

TON (The Open Network, the Telegram blockchain) is a non-EVM family. Name it — `chain: 'ton'` —
and the driver **auto-mounts on first use**, so a pure-EVM or Solana install never downloads the
TON libraries. The protocol layer is unchanged; only the wallet shape and one RPC caveat differ.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'ton', token: 'USDT', amount: '0.10', payTo: 'EQ…' })
```

## Install the peer dependency

The TON libraries are optional peer deps — install them once and the lazy import finds them:

```bash
npm install @ton/ton @ton/core @ton/crypto
```

## The wallet

A TON wallet is a 24-word `{ mnemonic }` (a `string[]` or one space-separated string) or a ready
`{ keyPair }`. The wallet contract defaults to `v4`; pass `version: 'v5r1'` for a W5 wallet — it
**must match** the version your funded address was created with.

```ts
import { PipRailClient } from '@piprail/sdk'

const mnemonic = process.env.TON_MNEMONIC // 24 words, space-separated or a string[]

const client = new PipRailClient({ chain: 'ton', wallet: { mnemonic } })
// W5 wallet: new PipRailClient({ chain: 'ton', wallet: { mnemonic, version: 'v5r1' } })
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
new PipRailClient({ chain: 'ton', wallet: { mnemonic }, rpcUrl })
```

:::tip
Free keys take about 30 seconds: message **@tonapibot** on Telegram, or sign up at
toncenter.com. Skip the key and you'll hit rate limits; add it and TON is as seamless as every
other chain.
:::

## Tokens

Name the symbol; the SDK fills in the jetton master and decimals.

| Token | Built in | Notes |
| --- | --- | --- |
| `'USDT'` | Yes | USD₮ (Tether-native, dominant on TON). Master + 6 decimals verified on-chain. |
| `'native'` | Yes | Toncoin (TON), 9 decimals (nanoton). |
| custom jetton | — | Any other jetton via `{ master, decimals }` (e.g. USDe). |

```ts
// A custom jetton is { master, decimals }:
requirePayment({ chain: 'ton', token: { master: 'EQ…', decimals: 6 }, amount: '0.10', payTo })
```

:::caution
**Native USDC does not exist on TON** — Circle doesn't issue it there, so it's intentionally
absent and `token: 'USDC'` throws [`UnknownTokenError`](/errors/error-hierarchy/). Pay in
`'USDT'`, `'native'`, or a custom jetton.
:::

## Receive prerequisite — none

The merchant needs no setup. The payer's attached gas (~0.05 TON, leftover refunded)
auto-deploys the merchant's jetton wallet on first receipt, so there's no trustline or opt-in to
register — `planPayment()` won't raise `RECIPIENT_NOT_READY` for TON. The payer, however,
**needs Toncoin for gas** even when paying USD₮ — budget it with
[`estimateCost()`](/making-payments/estimate-cost/), which reports the fee in the native coin.

```ts
const { quote, cost } = await client.estimateCost('https://api.example.com/report')
// → { quote: { amountFormatted: '0.10', symbol: 'USDT', … }, cost: { amountFormatted: '0.0…', symbol: 'TON', basis: 'estimated' } }
// cost is the network fee in TON (the native gas coin), separate from the USD₮ payment
```

## When the payer can't cover gas

The headline TON caveat is that even a USD₮ payment burns Toncoin for gas, so a wallet flush with
USD₮ but short on TON still can't settle. [`planPayment()`](/making-payments/plan-payment/) reports
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
    // fund the payer — USD₮ for the payment, and TON for gas
    console.error('Top up the TON wallet (USD₮ and/or Toncoin gas):', err.message)
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
  console.log(plan.fundingHint) // e.g. "needs ~0.05 TON for gas"
}
```

## Proof binding — Template A (memo-bound)

TON uses [Template A](/concepts/proof-binding/): the challenge nonce rides in the jetton transfer
**comment**, and `verify()` matches it on the merchant's own jetton wallet — so a look-alike
jetton can't satisfy the gate, and the proof is cryptographically bound to the challenge that
issued it.

:::note
TON settles **asynchronously** — value crosses contracts, so a credit can take seconds to appear.
Because of that the proof ref is a self-contained **locator** (`ton:<jetton-wallet>|<nonce>`), not
a tx hash. `verify()` re-derives every checked field from the trusted `accept`, never the
client-supplied ref.
:::

## Server-side only

TON's libraries don't ship a clean browser ESM build yet, so run the TON path **server-side** —
the identical one line, on Node, Bun, Deno, or Workers. The lazy import means a pure-EVM page
never downloads them. See [Chains & tokens](/concepts/chains-and-tokens/) for the full
cross-chain caveat list.
