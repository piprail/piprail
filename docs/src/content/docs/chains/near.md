---
title: NEAR
description: Accept and pay x402 payments on NEAR — native NEAR (zero-setup) plus native USDC and USDT, with the storage_deposit caveat for tokens.
sidebar:
  order: 5
---

## Introduction

NEAR is the "user-owned AI" chain (its co-founder co-authored the Transformer paper), with both
Circle USDC and Tether USDT native on-chain. Name `chain: 'near'` and the driver **auto-mounts**
on first use — a pure-EVM install never downloads its library.

NEAR is unusual in PipRail: it uses **both** proof templates. Native NEAR is digest-bound (the
easy, zero-setup path); the NEP-141 token path is memo-bound and needs a one-time
`storage_deposit`. Both are covered below.

## Install the peer dependency

The NEAR library is an optional peer, lazy-loaded the first time you name `chain: 'near'`:

```bash
npm install near-api-js
```

## Wallet shape

A NEAR wallet is `{ accountId, key }`, where `key` is an `ed25519:…` secret key — NEAR signing
needs *both* an account id and the secret key (not just a private key). The presence of
`accountId` is what tells the SDK this is a NEAR wallet.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  wallet: { accountId: 'agent.near', key: process.env.AGENT_KEY }, // ed25519:… secret
  chain: 'near',
})
```

`payTo` is a NEAR account id — a named account like `merchant.near`, or a 64-hex implicit
account. See [Wallets by family](/making-payments/wallets-by-family/) for every family's shape.

## Supported tokens

Name a token by symbol, `'native'`, or a custom NEP-141 contract:

| `token` | What it is |
| --- | --- |
| `'native'` | Native NEAR (24 decimals). **Zero-setup** — digest-bound, no `storage_deposit`. |
| `'USDC'` | Circle's native USDC (`17208628…36133a1`, 6dp) — **not** the bridged `…factory.bridge.near` (USDC.e). |
| `'USDT'` | Tether's native USDt (`usdt.tether-token.near`, 6dp). |
| `{ contractId, decimals }` | Any other NEP-141 token, by contract account id. |

```ts
import { requirePayment } from '@piprail/sdk'

// Express/Connect middleware that turns this route paid-only:
requirePayment({ chain: 'near', token: 'USDC', amount: '0.10', payTo: 'merchant.near' })
```

NEAR is the volatile gas coin, so for stable pricing pay in USDC/USDT; for no-setup flows,
native NEAR is ideal.

## Native NEAR — the zero-setup path

`token: 'native'` pays in NEAR via a plain `Transfer`, **digest-bound** like EVM/Solana/Sui:
the proof is `<accountId>:<txHash>`, verified by tx hash + a recency window + the gate's
single-use proof set. Native needs **no `storage_deposit`** and a transfer even *creates* a
fresh implicit recipient — there is nothing to register first.

```ts
requirePayment({ chain: 'near', token: 'native', amount: '0.10', payTo: 'merchant.near' })
```

## Tokens need `storage_deposit` (the receive prerequisite)

Before an account can *receive* a NEP-141 token it must be storage-registered on **that exact
token contract** (NEP-145) — a one-time ~0.00125 NEAR call, **per account per token**. Both the
**merchant (`payTo`)** and the **payer** must be registered, or the payer's `ft_transfer`
panics.

[`planPayment()`](/making-payments/plan-payment/) surfaces an unregistered recipient as a
`RECIPIENT_NOT_READY` blocker before you spend, and a payment to an unready recipient raises a
[`RecipientNotReadyError`](/errors/error-hierarchy/):

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url) // → PaymentPlan | null (null when not 402-gated)

if (!plan) {
  await client.fetch(url) // not payment-gated — just fetch it
} else if (plan.payable) {
  await client.fetch(url) // safe — we checked
} else {
  console.log(plan.fundingHint) // e.g. "recipient isn't registered on usdt.tether-token.near"
}
```

The payer needs a little **NEAR for gas** either way — native or token.

## When a payment can't go through

`client.fetch(url)` pays the cheapest settleable rail. If the wallet or recipient isn't ready it
throws a typed [`PipRailError`](/errors/error-hierarchy/) — branch on the stable `.code` rather than
the message. On NEAR the two you'll meet are `RECIPIENT_NOT_READY` (the `payTo` account isn't
`storage_deposit`-registered on the token) and `INSUFFICIENT_FUNDS` (the payer is short on the
token or on NEAR for gas):

```ts
import {
  RecipientNotReadyError,
  InsufficientFundsError,
} from '@piprail/sdk'

try {
  const res = await client.fetch(url)
  // → a normal Response once the proof verifies (200 + the gated resource)
} catch (err) {
  if (err instanceof RecipientNotReadyError) {
    // fix the RECIPIENT: storage_deposit-register payTo on the token (~0.00125 NEAR)
    console.error('recipient not ready:', err.message)
  } else if (err instanceof InsufficientFundsError) {
    // fix the PAYER: top up the token, or add NEAR for gas
    console.error('payer is short:', err.message)
  } else {
    throw err
  }
}
```

:::tip
Check readiness *before* you spend with [`planPayment()`](/making-payments/plan-payment/) — it
reports the same conditions as `blockers` (`RECIPIENT_NOT_READY`, `INSUFFICIENT_TOKEN`,
`INSUFFICIENT_GAS`) instead of throwing, so you can branch on data rather than catch.
:::

:::caution
Implicit accounts (64-hex) don't exist until funded with NEAR — fund the account first (a native
payment to one *creates* it). And don't confuse the built-in Circle USDC (`17208628…36133a1`)
with the bridged `…factory.bridge.near` (USDC.e); they're different tokens.
:::

## Proof binding — both templates

NEAR is the one family that uses both [proof templates](/concepts/proof-binding/):

| Asset | Template | How it's bound |
| --- | --- | --- |
| Native NEAR | B — digest-bound | proof `<accountId>:<txHash>`, verified by tx hash + recency + single-use set |
| NEP-141 tokens | A — memo-bound | the challenge nonce rides in the `ft_transfer` **`memo`** |

NEAR has no account-history RPC, so the token path verifies **by tx hash** and only trusts an
`ft_transfer` event emitted by the *real* token contract — `verify()` re-derives every checked
field from the trusted `accept`, never the client-supplied ref. See [Replay
protection](/accepting-payments/replay-protection/) for the single-use proof set.

:::caution
Do not route through NEAR Intents or solvers — that re-introduces a third-party facilitator.
PipRail uses plain transfers plus local receipt verification on purpose. See [Verifying
payments](/accepting-payments/verifying-payments/).
:::

## Standard `exact` rail — gasless via NEP-366 (NEP-141 tokens)

Beside the default `onchain-proof` rail, PipRail also speaks the **ratified x402 `exact` scheme for
NEAR** (`scheme_exact_near.md`). The buyer signs a **NEP-366 `SignedDelegateAction`** authorizing
exactly one NEP-141 `ft_transfer` (to `payTo`, the exact amount, the mandatory 1 yoctoNEAR) with a
**full-access key** — then a **keyless x402 facilitator's relayer prepays the gas + the yocto and
submits**. The buyer holds **zero NEAR**, and with a keyless facilitator the merchant pays nothing
either: both sides are gasless.

```ts
// Buyer: opt into exact, and the client builds + signs the SignedDelegateAction for any NEAR exact
// rail it's offered (USDC / USDT — NEP-141 tokens only; native NEAR stays onchain-proof).
const client = new PipRailClient({ chain: 'near', wallet, schemes: ['onchain-proof', 'exact'] })
await client.fetch('https://api.example.com/data')
```

NEAR `exact` is **facilitator-settled** (unlike EVM/Solana/Algorand, PipRail does not self-settle it:
the NEAR relayer wraps the delegate action in its own outer transaction — a funded hot relayer the
charter avoids running). A merchant points the gate at an x402 facilitator that implements
`scheme_exact_near.md` for `near:mainnet`:

```ts
createPaymentGate({
  chain: 'near', token: 'USDC', amount: '0.01', payTo: 'merchant.near',
  exact: { settle: { facilitator: 'https://your-near-facilitator.example' } },
})
```

:::caution[Facilitator coverage is still rolling out]
The NEAR exact **payload PipRail builds is proven on mainnet** (a real NEP-366 meta-transaction
settles a USDC/USDT `ft_transfer` gaslessly — the buyer spends zero NEAR, single-use via the on-chain
access-key nonce). But **facilitator support for `near:mainnet` is still emerging across the x402
ecosystem** — some facilitators advertise NEAR in `/supported` without yet settling it. Confirm your
facilitator actually settles `near:mainnet` before relying on it; this is why PipRail's built-in
keyless auto-pick (`exact: true`) does not yet include a NEAR facilitator.
:::

:::note
The buyer must sign with a **full-access key**: NEP-141 `ft_transfer` attaches 1 yoctoNEAR, which a
function-call access key can't do, so the relayer rejects it. Native NEAR is **not** exact-payable
(the scheme is defined over `ft_transfer`) — it stays on the zero-setup `onchain-proof` rail.
:::
