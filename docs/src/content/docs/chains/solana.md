---
title: Solana
description: Accept and pay x402 payments on Solana — SOL, USDC, and USDT — with one lazy peer dep, a Keypair wallet, digest-bound on-chain verification, and the gasless standard `exact` rail (the buyer pays zero SOL; any SPL token).
sidebar:
  order: 2
---

## Introduction

Solana works exactly like an EVM chain — you name it. The driver **auto-mounts** on first use
via a single lazy import, so a pure-EVM install never downloads the Solana libraries. The only
setup is installing the peer dependencies, and there is **no receiver prerequisite**: the
payer's transaction idempotently creates the recipient's token account for you.

```bash
npm install @solana/web3.js @solana/spl-token bs58
```

## Charge in one line

Name the chain and the token. Pass the recipient's **wallet address** as `payTo` (a base58
pubkey), never a token-account address.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'solana', token: 'USDC', amount: '0.10', payTo: 'YourSolanaAddr' })
```

The driver mounts on first use — there is no setup call. See
[requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/) for the
full server side.

## Pay in one line

A [`PipRailClient`](/making-payments/piprail-client/) bound to `solana` pays any 402 it can settle.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'solana',
  wallet: { secretKey: process.env.AGENT_KEY }, // base58 string or Uint8Array
})

const res = await client.fetch('https://api.example.com/report')
// → a normal Response — the 402 was paid and retried transparently
const report = await res.json()
```

## The wallet shape

Solana wallets are `{ secretKey }` or a ready `{ signer }`. The `secretKey` may be a
`Uint8Array` or a base58 string; the SDK wraps it into a `Keypair`. Passing an EVM wallet shape
(`{ privateKey }` or `{ walletClient }`) throws a clear
[`WrongFamilyError`](/errors/error-hierarchy/) on first use.

```ts
new PipRailClient({ chain: 'solana', wallet: { secretKey: process.env.AGENT_KEY } }) // base58 or Uint8Array
new PipRailClient({ chain: 'solana', wallet: { signer: keypair } })                  // a @solana/web3.js Keypair
```

See [Wallets by family](/making-payments/wallets-by-family/) for every family's wallet input.

## Supported tokens

| `token` | What it is | Decimals |
| --- | --- | --- |
| `'native'` | SOL | 9 |
| `'USDC'` | Circle-native USDC | 6 |
| `'USDT'` | Tether-native USDT | 6 |
| `{ mint, decimals }` | Any other SPL token, by mint | as given |

USDC and USDT are pre-filled with their canonical mints, so you never paste a mint address. Any
other SPL token works by passing `{ mint, decimals }` — no allowlist.

```ts
// A custom SPL token by mint:
const payTo = 'YourSolanaAddr'
requirePayment({ chain: 'solana', token: { mint: 'EPjF…Dt1v', decimals: 6 }, amount: '0.10', payTo })
```

## Gasless — the standard `exact` rail

Solana supports the ratified x402 **`exact`** scheme (the `svm` method), so any standard x402 client
can pay your gate **and** the buyer spends **zero SOL**. It works for **any SPL token** — USDC and
**USDT alike** — because the gasless-ness comes from the transaction's **fee payer**, not from a token
feature (there is no EIP-3009/Permit2 equivalent on Solana, and none is needed).

**Fully gasless via a facilitator (recommended)** — neither buyer nor merchant pays SOL; the
facilitator (e.g. [PayAI](https://facilitator.payai.network/), no API key) sponsors the gas. The gate
discovers the facilitator's fee-payer pubkey from its `GET /supported` automatically. **Live-proven on
mainnet.**

```ts
// Seller — fully gasless. No relayer, no SOL.
requirePayment({
  chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourReceiveAddr',
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } },
})

// Or self-settle with your own relayer (fee payer ≠ payTo) — your relayer pays the sub-cent fee:
//   exact: { settle: 'self', relayer: { secretKey: process.env.SOLANA_RELAYER_KEY } }

// Buyer — opt in; the client signs the transfer, the sponsor pays the fee.
new PipRailClient({ chain: 'solana', wallet, schemes: ['onchain-proof', 'exact'] })
```

The buyer partial-signs the canonical `[cu-limit, cu-price, TransferChecked]` transaction, leaving the
fee-payer slot empty; the facilitator (or your relayer) co-signs as fee payer and broadcasts. The buyer
needs only the token (zero SOL). The recipient's **token account must already exist** — the exact rail
won't create it (a brand-new recipient is payable on `onchain-proof`, which does). Native **SOL** is not
exact-payable. Full details: [Gasless payments](/making-payments/gasless-payments/) ·
[exact rail (buyer)](/making-payments/exact-buyer/) · [exact rail (seller)](/accepting-payments/exact-rail-seller/).

## Receiver setup — none

Solana needs **no recipient prerequisite**. The payer's transaction idempotently creates the
recipient's associated token account and pays its ~0.00204 SOL rent as part of the same
transfer, so `payTo` never has to opt in or register ahead of time.

:::note
Pass the recipient's **wallet address** as `payTo`, not a token-account address. The driver
derives the associated token account itself.
:::

The payer needs SOL for gas plus a funded source token account for the SPL token being sent.

## Proof binding — digest-bound (Template B)

Solana uses **Template B**: the payment proof is the transaction signature, and `verify()` reads
the transaction back from your RPC to prove it. It re-derives every checked field from the
trusted `accept`, never the client-supplied reference, and confirms four things:

- the transaction **exists and succeeded** (`meta.err === null`);
- it is **recent** — its `blockTime` falls inside the `maxTimeoutSeconds` window (a missing
  `blockTime` fails closed, not open);
- it actually **moved at least `amount`** of the asset to `payTo`, proven from the
  transaction's own balance deltas (`pre/postTokenBalances` for SPL, `pre/postBalances` for
  SOL) — the same way Solana Pay's `validateTransfer` does, robust to however the transfer was
  built;
- the signature is **single-use** against the proof set.

Because the proof is single-use, multi-instance deployments should plug in a persistent
`isUsed` / `markUsed` store and keep `maxTimeoutSeconds` tight. See
[Replay protection](/accepting-payments/replay-protection/) and
[Proof binding](/concepts/proof-binding/) for the shared model.

## Planning a payment before you spend

`planPayment(url)` reads balances, gas, and recipient readiness on-chain and tells you whether a
rail is settleable — without paying and without throwing. On Solana "I hold USDC but no SOL for
gas" surfaces as an `INSUFFICIENT_GAS` blocker rather than a failed broadcast. It returns
`PaymentPlan | null` (`null` when the URL isn't payment-gated), so null-guard the result first.

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)

if (!plan) {
  await client.fetch(url) // not payment-gated — fetch it for free
} else if (plan.payable) {
  await client.fetch(url) // safe — we checked
} else {
  console.log(plan.fundingHint) // one human-readable line: what to top up (SOL gas, or the token)
}
```

See [planPayment()](/making-payments/plan-payment/) for the full `PaymentPlan` shape.

## When a payment can't go through

Affordability always converges on one typed
[`InsufficientFundsError`](/errors/error-hierarchy/) (`.code === 'INSUFFICIENT_FUNDS'`) — whether
you're short on the **token** or short on **SOL for gas**. On Solana the gas-token shortfall is
the headline trap: you hold USDC but no SOL to send it. Catch it and read the `.code`:

```ts
import { PipRailError } from '@piprail/sdk'

const url = 'https://api.example.com/report'
try {
  const res = await client.fetch(url)
  const report = await res.json()
} catch (err) {
  if (err instanceof PipRailError && err.code === 'INSUFFICIENT_FUNDS') {
    // out of USDC, or out of SOL for gas — fund the payer and retry
    console.error('Payer is short:', err.message)
  } else {
    throw err
  }
}
```

:::tip
To tell a **gas** shortfall (no SOL) apart from a **token** shortfall (no USDC) *before* you
spend, call [`planPayment()`](/making-payments/plan-payment/): it distinguishes the two as
`INSUFFICIENT_GAS` vs `INSUFFICIENT_TOKEN` blockers, with a `shortfall` and a `fundingHint`.
:::

## RPC

The built-in default RPC (`api.mainnet-beta.solana.com`) is rate-limited. **Pass your own
`rpcUrl`** in production — there is no separate API-key field, so fold any key into the URL.

```ts
requirePayment({
  chain: 'solana',
  token: 'USDC',
  amount: '0.10',
  payTo: 'YourSolanaAddr',
  rpcUrl: process.env.SOLANA_RPC,
})
```

## In the browser

Solana runs in the browser as well as on the server: the libraries load from a CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
that pins them to a browser-ESM build. The lazy import means a pure-EVM page never downloads
them. For server-only the same one line runs unchanged on Node, Bun, Deno, or Workers.
