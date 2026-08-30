---
title: "Accept USDC payments on Stellar"
description: Pay and get paid on Stellar — native XLM, Circle USDC and EURC — with memo-bound proofs and a one-time trustline to receive.
sidebar:
  label: Stellar
  order: 9
---

## Introduction

Stellar is payment-native: ~5s single-step finality, sub-cent fees, and a built-in transaction
memo the proof binds to. Name `chain: 'stellar'` and the driver **auto-mounts** on first use —
the family's library loads lazily, so a pure-EVM install never downloads it.

```bash
npm install @stellar/stellar-sdk
```

This is an optional peer dependency. Install it only if you actually touch Stellar; the import
is dynamic, fired the first time you name the chain.

## Wallet

A Stellar wallet is `{ key }`, where `key` is an `S…` Ed25519 secret seed — or a ready
`{ keypair }` (a stellar-sdk `Keypair` you built yourself). `payTo` is a `G…` account address.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'stellar',
  wallet: { key: process.env.STELLAR_SECRET },  // 'S…' seed
})
```

Pass anything that looks like another family's wallet — a `signer`, a `keyPair`, an `account`, or
an `accountId` — and it's rejected up front with a [`WrongFamilyError`](/errors/error-hierarchy/).
See [Wallets by family](/making-payments/wallets-by-family/) for the full set of shapes.

## Tokens

USDC and EURC are built in — both Circle issuers verified live on Horizon mainnet before
shipping — and native XLM works with `token: 'native'`.

| `token` | Asset |
| --- | --- |
| `'USDC'` | Circle USDC (issuer pre-filled) |
| `'EURC'` | Circle EURC (issuer pre-filled) |
| `'native'` | XLM (Lumens) |

Stellar assets are universally **7 decimal places** — there's no per-asset `decimals` like an
ERC-20; USDC, EURC, and XLM are all 7dp. Any other classic asset works by passing it
explicitly as `{ issuer, code, decimals }`:

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({
  chain: 'stellar',
  token: { issuer: 'G…', code: 'XYZ', decimals: 7 },
  amount: '0.10',
  payTo: 'G…',
})
```

Internally an asset is identified across the wire as `CODE:ISSUER` (or `'native'` for XLM) — a
contract-address-free scheme native to Stellar.

## Receiving — the trustline prerequisite

:::caution
To **receive** an issued asset (USDC or EURC), the merchant account (`payTo`) must already
**exist** on-chain (funded above the ~1 XLM base reserve) **and** hold a **trustline**
(`changeTrust`) for that exact `code + issuer` before its first payment. No trustline → the
payment fails. Native XLM needs neither.
:::

Each trustline locks an additional **+0.5 XLM** of reserve, and the reserves are **locked, not
spent** — recoverable if you later remove the trustline. The driver sends a payment; it does
**not** create accounts, so both ends must already be funded above reserve. The **payer**
likewise needs its own trustline to hold and send the asset.

When `payTo` isn't ready, [`planPayment()`](/making-payments/plan-payment/) surfaces this as a
`RECIPIENT_NOT_READY` blocker before you spend — rather than letting you pay into a void — and a
payment to an unready recipient raises a
[`RecipientNotReadyError`](/errors/error-hierarchy/):

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'stellar',
  wallet: { key: process.env.STELLAR_SECRET },  // 'S…' seed
})

const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)

if (!plan) {
  // not payment-gated — fetch it for free
  await client.fetch(url)
} else if (plan.payable) {
  await client.fetch(url) // safe — we checked
} else {
  console.log(plan.fundingHint)  // "recipient has no trustline for the asset" etc.
}
// → PaymentPlan | null
```

See [planPayment()](/making-payments/plan-payment/) for the full readiness model.

## Proof binding

Stellar uses **Template A (memo-bound)**: the challenge nonce is written on-chain as a
`MEMO_HASH = sha256(nonce)`, so a proof is cryptographically bound to its challenge and can't
be replayed against a different one. Verification reads the payment to `payTo` on Horizon and
matches the memo hash, the amount, and the asset's `CODE:ISSUER` — every field re-derived from
the trusted `accept`, never the client-supplied ref.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'stellar', token: 'USDC', amount: '0.10', payTo: 'G…' })
```

See [Proof binding](/concepts/proof-binding/) for how Template A compares to the digest-bound
template, and [Verifying payments](/accepting-payments/verifying-payments/) for the verify path.

## Endpoint

The default Horizon endpoint (`https://horizon.stellar.org`) is public and rate-limited — pass
your own `rpcUrl` in production:

```ts
requirePayment({ chain: 'stellar', token: 'USDC', amount: '0.10', payTo: 'G…', rpcUrl: 'https://…' })
```

## Server-side only

:::note
Stellar's library doesn't ship a clean browser-ESM build yet, so use this family **server-side**
— the identical one line, on Node, Bun, Deno, or Workers. The lazy import means a pure-EVM
browser page never downloads it.
:::
