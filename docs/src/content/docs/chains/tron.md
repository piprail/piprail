---
title: "Accept USDT payments on Tron"
description: Pay and get paid in USD₮ (or native TRX) on Tron — the largest stablecoin rail on earth — with digest-bound verification and no built-in USDC.
sidebar:
  label: Tron
  order: 4
---

## Introduction

Tron is the single largest stablecoin-payment rail on earth — it holds roughly 45% of all USDT
in circulation. You name `chain: 'tron'`; the driver **auto-mounts** on first use, so a pure-EVM
install never downloads the Tron library. Tron settles in **USD₮ (TRC-20)** by default, with
**native TRX** available too.

## Install the peer dependency

Tron's library is an optional peer dep, lazy-loaded the first time you name the chain. Install it
once:

```bash
npm install tronweb
```

That single dynamic `import()` is what keeps non-Tron installs lean. See the
[PaymentDriver architecture](/concepts/payment-driver-architecture/) for how auto-mounting works.

## The wallet

A Tron wallet is `{ key }` — a 32-byte hex key (Tron uses secp256k1, the same key format
as EVM). The `chain: 'tron'` selector is what routes to the Tron driver.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  wallet: { key: process.env.AGENT_KEY }, // 32-byte hex, with or without 0x
  chain: 'tron',
})
```

`payTo` is a Base58 `T…` address. Passing an `0x…` address throws
[`WrongFamilyError`](/errors/error-hierarchy/). The full matrix of wallet shapes lives in
[Wallets by family](/making-payments/wallets-by-family/).

## Accepting payments

On the server, name the chain and token — the canonical USD₮ contract is pre-filled, so you never
paste an address:

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'tron', token: 'USDT', amount: '0.10', payTo: 'T…' })
```

## Tokens

Tron ships **USD₮ only**, mirroring TON's "USD₮ only" decision. Native TRX is also a valid
payment asset.

| `token` | Asset | Decimals | Notes |
| --- | --- | --- | --- |
| `'USDT'` | USD₮ (TRC-20, Tether-native) | 6 | The default. Contract pre-filled and verified on-chain. |
| `'native'` | TRX | 6 | Supported for completeness; TRX is volatile gas, so prefer USD₮ for stable pricing. |
| `{ address, decimals }` | Any other TRC-20 | — | Base58 `T…` contract — pass it yourself. |

:::caution
**There is no built-in USDC on Tron.** Circle discontinued minting native USDC on Tron (Feb 2024)
and Tron is absent from Circle's contract-address list; the only USDC there is a third-party
bridge. So USDC is intentionally absent — if you must use it, pass it as a custom
`{ address, decimals }`.
:::

A custom TRC-20 is just its Base58 contract plus decimals:

```ts
requirePayment({
  chain: 'tron',
  token: { address: 'T…', decimals: 6 },
  amount: '0.10',
  payTo: 'T…',
})
```

## Gas is real money — budget TRX

Unlike most chains, Tron gas is a meaningful cost. A USD₮ transfer burns Energy (~30k unstaked ≈
several TRX), so **the payer must hold TRX as well as USD₮**. Use
[`estimateCost()`](/making-payments/estimate-cost/) to budget the *total* — payment plus TRX gas —
before any funds move. Tron is where this matters most.

```ts
const url = 'https://api.example.com/report'
const { quote, cost } = await client.estimateCost(url)
// → { quote: PipRailQuote, cost: CostEstimate }
// cost is the network fee in TRX (the native gas coin), separate from the USD₮ payment:
console.log(quote.amountFormatted, quote.symbol) // '0.10' 'USDT' — the payment
console.log(cost.feeFormatted, cost.feeSymbol)   // e.g. '6.5' 'TRX' (cost.feeDecimals === 6)
```

:::tip
For tiny test sends, rent Energy from a service like TronZap or feee.io for ~1–2 TRX instead of
burning ~27. A first **native** TRX payment to a brand-new recipient also pays Tron's ~1 TRX
account-creation fee (sender side).
:::

## Receiving needs no setup

Unlike NEAR (`storage_deposit`), Stellar/XRPL (trustlines), or Algorand (ASA opt-in), a Tron
recipient needs **no account setup** to receive USD₮ — any valid `T…` address can be paid. So
[`planPayment()`](/making-payments/plan-payment/) won't raise a `RECIPIENT_NOT_READY` blocker for
Tron on the USD₮ path. The only readiness requirement is on the **payer** side: enough TRX for
Energy/bandwidth.

See [planPayment()](/making-payments/plan-payment/) for the full readiness check.

## When a payment can't go through

On Tron the headline failure is a **gas shortfall**: you hold USD₮ but not enough TRX to cover
Energy. Both an empty token balance and an empty TRX balance converge on one typed
[`InsufficientFundsError`](/errors/error-hierarchy/) (`.code === 'INSUFFICIENT_FUNDS'`) — its
message names which one is short and echoes the raw chain code. Catch it on `fetch`:

```ts
import { InsufficientFundsError, PipRailError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  const res = await client.fetch(url)
  console.log(res.status) // → 200 once the proof verifies
} catch (err) {
  if (err instanceof InsufficientFundsError) {
    // On Tron this is usually "no TRX for Energy", not "no USD₮".
    console.error('Fund the payer (USD₮ and/or TRX):', err.message)
  } else if (err instanceof PipRailError) {
    console.error(`Payment failed [${err.code}]:`, err.message)
  } else {
    throw err
  }
}
```

To distinguish a token shortfall from a gas shortfall *before* spending, call
[`planPayment()`](/making-payments/plan-payment/): it reports them as separate `INSUFFICIENT_TOKEN`
and `INSUFFICIENT_GAS` blockers (with a `fundingHint`) rather than throwing.

## Proof binding — digest-bound (Template B)

Tron verification is **digest-bound** (Template B): the proof is the transaction id, and
`verify()` confirms the transfer by reading the tx, checking the recipient + amount, applying a
recency window, and recording the txid in a single-use proof set. A USD₮ payment is a TRC-20
`Transfer` event; a native TRX payment is a plain `TransferContract` — the same path, just reading
the contract instead of the event log.

Two Tron specifics worth knowing:

- **Verification reads the solidity node.** The merchant verifies the confirmed transfer on Tron's
  solidity (finality) node, not the full node — the proof only counts once it's solidified.
- **Finality is slow-ish.** A tx solidifies after ~19 blocks (~57s); until then `verify()` reads
  `tx_not_found` and is retried.

Because the proof is single-use, multi-instance deployments should plug in a persistent
`isUsed`/`markUsed` store and keep `maxTimeoutSeconds` tight. See
[Replay protection](/accepting-payments/replay-protection/) and
[Proof binding](/concepts/proof-binding/) for the mechanics.

:::note
Tron's CAIP-2 id (`tron:mainnet`) is internal — Tron isn't in the official x402 CAIP-2 registry.
This has zero interop impact, since PipRail verifies every proof locally against your own RPC
rather than relying on a facilitator.
:::

## Run server-side

Tron's `tronweb` library doesn't ship a clean browser ESM build, so run the Tron path
**server-side** — the identical one line, on Node/Bun/Deno/Workers. The public TronGrid RPC
(`https://api.trongrid.io`) is rate-limited; pass your own `rpcUrl` in production.
