---
title: quote()
description: Learn the price of a gated URL before paying it — the true token decimals and symbol, the policy verdict, and a scam-smell flag, with no funds moved.
sidebar:
  order: 4
---

## Introduction

`quote(url)` answers the first question an agent asks at a 402: *what does this cost, and can I
trust the number?* It does the initial request, and if the resource is payment-gated it returns
a `PipRailQuote` — the amount in the token's **true decimals**, the chain, the recipient, and
whether your `policy` would allow it. **No funds move.** It returns `null` when the URL isn't
gated (no 402).

It's the first of the read-only trio: `quote()` learns the price,
[`estimateCost()`](/making-payments/estimate-cost/) adds the gas, and
[`planPayment()`](/making-payments/plan-payment/) decides whether the wallet can actually settle it.

## Basic use

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'
const quote = await client.quote(url)
// → { amountFormatted: '0.10', symbol: 'USDC', network: 'eip155:8453',
//     payTo: '0xYourWallet', withinPolicy: true, recognized: true, … } | null

if (quote && quote.withinPolicy) {
  await client.fetch(url)  // pay it — we checked the price
}
```

If `quote` is `null`, the URL returned something other than a 402 — it isn't paid, so just
`fetch` it.

## The PipRailQuote

```ts
interface PipRailQuote {
  url: string
  chain: ChainSelector       // the chain this client is configured for
  network: Caip2
  asset: string              // 0x… / mint / jetton master / CODE:ISSUER / 'native'
  amount: string             // base units — what actually transfers
  amountFormatted: string    // human-readable, e.g. '0.10'
  decimals: number
  symbol?: string
  payTo: string
  description?: string
  maxTimeoutSeconds: number
  recognized: boolean        // did the SDK know this asset (and trust its decimals)?
  symbolMismatch: boolean    // challenge's symbol disagrees with the SDK's real one
  withinPolicy: boolean      // would the configured policy allow paying this?
  policyReason?: string      // prose, only when withinPolicy === false
  policyCode?: PolicyDenyCode // typed reason, only when withinPolicy === false
}
```

## True decimals — the SDK never trusts the server

A malicious or buggy server can state any `decimals` it likes in the challenge, which would let
it misrepresent what `0.10` means. PipRail doesn't take the server's word: when it recognises the
asset (`recognized: true`), `decimals`, `symbol`, and `amountFormatted` come from the **SDK's own
on-chain truth**, not the challenge. For an honest server they match; for a deceptive one, your
agent sees the real figure.

```ts
const quote = await client.quote(url)
if (!quote) return  // not a 402 — nothing to price

console.log(`${quote.amountFormatted} ${quote.symbol}`)  // '0.10 USDC' — re-derived from TRUE decimals
console.log(quote.recognized)                            // true → decimals/symbol are the SDK's
```

:::note
When the SDK doesn't recognise the asset (`recognized: false`), it falls back to the server's
stated decimals and symbol. If the challenge states no decimals and the SDK can't recognise the
token, `quote()` refuses to price it and throws `InvalidEnvelopeError` rather than guess.
:::

## symbolMismatch — the scam smell

`symbolMismatch` is `true` when the challenge's stated symbol disagrees with the symbol the SDK
knows for that asset (only ever set for a recognised token). It's a red flag worth surfacing — a
server claiming to charge "USDC" against a token whose real symbol is something else.

```ts
const quote = await client.quote(url)
if (quote?.symbolMismatch) {
  // the on-chain symbol differs from what the challenge claims — surface it, don't auto-pay
}
```

A mismatch doesn't block anything on its own; `fetch()` still pays the amount in true decimals.
[`planPayment()`](/making-payments/plan-payment/) surfaces the same signal as a `SYMBOL_MISMATCH`
warning.

## The policy verdict

If you constructed the client with a [`policy`](/spend-controls/payment-policy/), `quote()`
evaluates this payment against it and reports the verdict without enforcing it — `withinPolicy` is
the boolean, and when it's `false` you also get a human `policyReason` and a typed `policyCode`.
With no policy set, `withinPolicy` is always `true`.

```ts
const quote = await client.quote(url)
if (quote && !quote.withinPolicy) {
  console.log(quote.policyCode, '—', quote.policyReason)  // e.g. 'MAX_AMOUNT' — over per-payment cap
}
```

`policyCode` is one of the `PolicyDenyCode` values, so you can branch without parsing prose:

| `policyCode` | Why the policy would refuse it |
| --- | --- |
| `MAX_AMOUNT` | Over the per-payment ceiling. |
| `MAX_TOTAL` | Would exceed the lifetime spend cap. |
| `CHAIN` | The chain isn't on your allowlist. |
| `TOKEN` | The token isn't on your allowlist. |
| `HOST` | The resource host isn't allowed. |
| `UNKNOWN_TOKEN` | An unrecognised token, refused by policy. |
| `SESSION_EXPIRED` | The session's time envelope has ended. |
| `WINDOW_TOTAL` | The rolling-window spend cap is exhausted. |

:::note
`quote()` only *reports* the verdict — it never refuses. `fetch()` enforces it: a payment that
breaches the policy throws [`PaymentDeclinedError`](/errors/why-payments-fail/) before any funds
move. The coarser `PaymentDeclinedError.reasonCode` a `catch` sees is a lossy mapping of this
`policyCode` — see [Why payments fail](/errors/why-payments-fail/). Use `quote()` to see the
refusal coming.
:::

## Read-only by construction

`quote()` issues exactly one GET (or your chosen method via `init`) and, on a 402, parses the
challenge to build the quote. It signs nothing and broadcasts nothing — it can't move funds. Pass
a `RequestInit` to control the probe request:

```ts
const quote = await client.quote(url, { method: 'POST', headers: { accept: 'application/json' } })
```

For the gas estimate to go with the price, reach for
[`estimateCost()`](/making-payments/estimate-cost/); to know whether the wallet can actually
settle it, [`planPayment()`](/making-payments/plan-payment/).
