---
title: estimateCost()
description: Price the gas before you pay — the best-effort native-coin network fee for a gated URL, alongside the quote, so an agent can budget payment plus gas.
sidebar:
  order: 5
---

## Introduction

`estimateCost(url)` answers the second question an autonomous agent must ask: *not just what
does this cost to pay, but what does it cost to send?* The payment leaves the wallet in the
token (USDC, USDT, native coin); the **gas** to broadcast it leaves in the chain's native coin
(ETH, SOL, TRX, …). Those are two different numbers, and a 402's price tells you only the first.

`estimateCost` returns both. It does the initial request and, if it's a 402, gives you a
[`PipRailQuote`](/making-payments/quote/) plus a `CostEstimate`. It reads RPC where that's cheap,
but it **never pays** — and returns `null` when the URL isn't payment-gated.

## Basic use

```ts
// `client` is the PipRailClient you configured earlier — see /making-payments/piprail-client/
const result = await client.estimateCost('https://api.example.com/report')

if (result) {
  console.log(result.quote.amountFormatted, result.quote.symbol)  // '0.10' 'USDC' — the payment
  console.log(result.cost.feeFormatted, result.cost.feeSymbol)    // '0.000021' 'ETH' — the gas
}
// → null when the URL isn't payment-gated (no 402)
// → { quote: PipRailQuote, cost: CostEstimate } when it is
```

## The PipRailCostQuote

The return value pairs the priced requirement with the gas to settle it:

```ts
interface PipRailCostQuote {
  quote: PipRailQuote   // what the payment is — amount, token, chain, recipient, policy
  cost: CostEstimate    // the network fee (gas) to send it, in the native coin
}
```

`quote` is exactly what [`quote()`](/making-payments/quote/) returns. `cost` is the new piece.

## The CostEstimate

Every driver computes its chain's fee — EVM gas × price, Solana lamports, Tron energy × price,
XRPL drops — as a bigint of native base units, then shapes it through `util/cost.ts`'s
`nativeCost()` helper, so the fields are identical on every chain:

| Field | Type | Meaning |
| --- | --- | --- |
| `feeSymbol` | `string` | The native fee coin's ticker — ETH, BNB, SOL, TON, XLM, XRP, TRX, … |
| `feeDecimals` | `number` | The native coin's decimals (18 EVM, 9 Solana/TON, 7 Stellar, 6 XRPL/Tron). |
| `fee` | `string` | Estimated fee in native base units (a non-negative integer string). |
| `feeFormatted` | `string` | The same fee, human-readable — e.g. `'0.000021'`. |
| `basis` | `'estimated' \| 'heuristic'` | How the number was derived (see below). |
| `detail?` | `string` | Optional note on what's included — e.g. `'gas ~21000 @ 12 gwei'`. |

## basis — how trustworthy is the number

`basis` labels the estimate's source so you can decide how much margin to keep:

| `basis` | Meaning |
| --- | --- |
| `'estimated'` | Derived from a live RPC read (EVM gas price, XRPL fee) — sharp. |
| `'heuristic'` | A typical-cost constant, used when an RPC read would be slow or unavailable. |

```ts
const result = await client.estimateCost(url)
if (result && result.cost.basis === 'heuristic') {
  // the gas figure is a ballpark — keep a wider native-coin margin
}
```

:::note
The fee is denominated in the **native coin**, never converted to fiat. Pricing it in a
currency needs your own price source — PipRail stays backendless and never calls an oracle.
This matters most on Tron, where a USD₮ transfer can burn real TRX.
:::

:::tip
On a standard `exact` rail (EIP-3009), the buyer's gas is estimated as **~0** — the merchant's
relayer or facilitator broadcasts the signed authorization, so you don't pay the send gas.
Plain `onchain-proof` rails (the default) estimate the gas you'll burn to broadcast yourself.
:::

## Budgeting payment plus gas

Together, the two numbers let an agent reason about the *total* before any funds move: the token
amount must be affordable, and there must be enough native coin left over for gas.

```ts
const result = await client.estimateCost('https://api.example.com/report')
if (result) {
  console.log(`Pay ${result.quote.amountFormatted} ${result.quote.symbol}`)
  console.log(`Gas  ~${result.cost.feeFormatted} ${result.cost.feeSymbol} (${result.cost.basis})`)
}
// → Pay 0.10 USDC
// → Gas  ~0.000021 ETH (estimated)
```

This is the middle step of the read-only trio: [`quote()`](/making-payments/quote/) learns the
price, `estimateCost()` adds the gas, and [`planPayment()`](/making-payments/plan-payment/) checks
your balances against both and tells you whether the whole thing is settleable. If you want the
verdict — not just the numbers — reach for `planPayment()`.

## Never throws (for a transient RPC issue)

Like every read-only method, `estimateCost` is safe to call speculatively. A transient RPC issue
falls back to a `'heuristic'` constant rather than raising, so a flaky endpoint degrades the
estimate's sharpness instead of crashing your agent.

The one exception is a **malformed 402 envelope**: if the server returns 402 but its
PAYMENT-REQUIRED body can't be parsed, `estimateCost` throws an
[`InvalidEnvelopeError`](/errors/error-model/) — the same as [`quote()`](/making-payments/quote/).
That's a broken endpoint, not a transient blip, so it surfaces rather than degrading silently.

```ts
import { InvalidEnvelopeError } from '@piprail/sdk'

try {
  const result = await client.estimateCost('https://api.example.com/report')
  // a bad RPC yields cost.basis: 'heuristic', not an exception
  if (result) console.log(result.cost.feeFormatted, result.cost.feeSymbol)
} catch (err) {
  if (err instanceof InvalidEnvelopeError) {
    console.warn('The 402 response was malformed — treat this endpoint as broken.')
  } else {
    throw err
  }
}
```
