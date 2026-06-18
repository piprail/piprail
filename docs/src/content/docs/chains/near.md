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

## Standard `exact` rail — gasless for the buyer via NEP-366 (NEP-141 tokens)

Beside the default `onchain-proof` rail, PipRail also speaks the **ratified x402 `exact` scheme for
NEAR** ([`scheme_exact_near.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md),
x402 v2). The buyer signs a **NEP-366 `SignedDelegateAction`** authorizing exactly one NEP-141
`ft_transfer` (to `payTo`, the exact `amount`, the mandatory 1 yoctoNEAR) with a **full-access key** —
and **never broadcasts it or holds any NEAR**. A relayer wraps that delegate in its own outer
transaction, prepays the gas + the yocto, and submits it. The agent (buyer) is **completely gasless**.

This rail is **opt-in** and only ever offered for **NEP-141 tokens** (USDC / USDT, or a custom token
you pass). Native NEAR is **not** exact-payable — the scheme is defined over `ft_transfer` — so native
always stays on the zero-setup `onchain-proof` rail. Defaults are unchanged: an `onchain-proof`-only
client behaves exactly as before.

### Paying (the buyer / agent — gasless)

Enable `'exact'` in `schemes` and the client builds + signs the `SignedDelegateAction` for any NEAR
`exact` rail it's offered. It spends **zero NEAR** (the merchant's relayer pays):

```ts
const client = new PipRailClient({
  chain: 'near',
  wallet: { accountId: 'agent.near', key: 'ed25519:…' }, // MUST be a full-access key (see below)
  schemes: ['onchain-proof', 'exact'],
})
await client.fetch('https://api.example.com/data') // 402 → signs a delegate (0 NEAR) → 200
```

:::caution[The buyer's key must be a FULL-ACCESS key]
A NEP-141 `ft_transfer` attaches exactly **1 yoctoNEAR**, and NEAR **function-call** access keys
cannot attach a positive deposit — so the relayer (or facilitator) will reject a delegate signed by a
function-call key. The buyer must sign with a **full-access** key. (Implicit 64-hex accounts created
from their key are full-access by construction.)
:::

### Receiving (the merchant) — self-settle today

NEAR `exact` is **self-settled** today: the merchant runs a small **relayer** (a funded NEAR account)
that the gate uses to submit the buyer's signed delegate. The **buyer stays gasless**; the merchant's
relayer pays the **sub-cent NEAR** network fee to receive — exactly like PipRail's self-settle on
Solana / Algorand / Aptos. This is the standard, working configuration:

```ts
createPaymentGate({
  chain: 'near',
  token: 'USDC',          // or 'USDT' — any NEP-141; native is onchain-proof only
  amount: '0.01',
  payTo: 'merchant.near',
  exact: {
    settle: 'self',
    relayer: { accountId: 'relayer.near', key: 'ed25519:…' }, // a funded NEAR key that pays settle gas
  },
})
```

The relayer:

- needs a **little NEAR** for gas (each settle costs ≈ 0.0003 NEAR — well under a cent);
- **must not equal the payer** (that's the buyer), but **may equal `payTo`** (the merchant can relay
  its own incoming payment — NEAR's outer/inner-transaction split allows it);
- should use a **dedicated key** you can fund + rotate, not your cold treasury key (it's a hot key the
  gate signs with on every settle).

Unlike EVM/Solana/Algorand — where the merchant co-signs **one slot** of the buyer's transaction —
the NEAR relayer wraps the delegate in a **separate outer transaction it fully owns**, then waits for
the inner `ft_transfer` receipt to finish executing across shards before the gate returns `200`.

### Gas model + the sponsor drain guard

| Party | Pays gas? |
| --- | --- |
| Buyer / agent | **No** — signs off-chain, holds zero NEAR |
| Merchant relayer (self-settle) | **Yes** — the sub-cent settle fee + the 1 yoctoNEAR, prepaid on submit |

Because the relayer **prepays both the gas and the attached deposit** of the delegated call, a hostile
buyer could try to drain it by signing a valid sub-cent transfer with a huge `gas` or a large
`deposit`. PipRail's gate **re-derives every field from your trusted rail and refuses the delegate
before the relayer ever signs** if the attached `deposit` ≠ exactly **1 yoctoNEAR** or the `gas`
exceeds **300 TGas** (an honest payload uses ~30 TGas). It also re-checks the token contract, `payTo`,
`amount`, single-action shape, and expiry against the rail — never the client's echo.

### Storage registration (NEP-145) — required to send AND receive

A NEP-141 token only moves between accounts that are **storage-registered** on that token
(`storage_deposit`, ≈ 0.00125 NEAR once per account+token). For the `exact` rail that means **both the
buyer (sender) and `payTo` (recipient) must be registered** on the token, or the `ft_transfer` panics.
Check the recipient with [`planPayment()`](/making-payments/plan-payment/) /
`recipientReady()` (`planPayment()` surfaces the `RECIPIENT_NOT_READY` blocker; `recipientReady()`
returns the `NOT_REGISTERED` reason) before you rely on the rail. Register out of band once; it persists.

:::caution[No third-party facilitator settles NEAR yet — use self-settle]
PipRail also has a **facilitator (Mode-B)** path — `exact: { settle: { facilitator } }` — where a
keyless third-party relayer would make **both** sides gasless. It is fully wired and will work the
moment a real NEAR facilitator ships, **but no production x402 facilitator settles NEAR today.** Some
facilitators **advertise** `near:mainnet` in their `/supported` endpoint while their backend cannot
actually deserialize/settle a NEAR request (verified against the public `x402-rs` facilitator stack,
which has no NEAR implementation). **Do not** point a NEAR gate at a facilitator unless you have
**confirmed it genuinely settles `near:mainnet`** end-to-end. This is also why PipRail's zero-config
keyless auto-pick (`exact: true`) deliberately **excludes** NEAR — it would otherwise route to a
facilitator that 400s. Until a real one lands, **`settle: 'self'` is the supported gasless-for-buyer
configuration.**
:::
