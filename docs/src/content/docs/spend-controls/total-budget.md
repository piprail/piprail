---
title: Total budget (cross-token)
description: One spend cap across every stablecoin and every chain — "$20 total, full stop" — plus payment-count caps. A unit-of-account sum, never a price oracle.
sidebar:
  order: 2
---

## The problem: per-token caps multiply

[`maxTotal`](/spend-controls/payment-policy/) is a lifetime cap **per `(network, asset)` pair**.
That is exact and oracle-free, but it has a sharp edge once a buyer holds several tokens on several
chains: the *same* cap applies independently to *each* pair.

```ts
// ⚠️ This does NOT mean "$20 total".
policy: { maxTotal: '20.00', tokens: ['USDC', 'USDT'] }
// across base + solana + xrpl → up to $20 for base-USDC, ANOTHER $20 for base-USDT,
// ANOTHER $20 for solana-USDC … = up to $20 × every (chain × token) pair.
```

When you mean **"spend at most $20, across everything"**, reach for `maxTotalPerDenom`.

## `maxTotalPerDenom` — one number across everything

A **denomination** is a unit of account you cap as a whole: e.g. `USD` across every USD
stablecoin, on every chain.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxTotalPerDenom: { USD: '20.00' } }, // $20 total — full stop
})
```

The SDK sums the **human value** of every token of that denomination — USDC, USDT, and any other
USD stablecoin — and refuses the payment that would push the running total past the cap, with a
typed [`PaymentDeclinedError`](/errors/error-hierarchy/) (`reasonCode: 'BUDGET'`,
`policyCode: 'MAX_TOTAL_DENOM'`). It coexists with the per-asset `maxTotal`; **the stricter cap wins.**

:::note[This is not a price oracle]
PipRail still reads no market and never prices a volatile coin. A token's denomination is a
**static, ship-time label** (the same kind of fact as its symbol or decimals); the grand total
simply **adds up tokens you've grouped as one unit, each counted 1:1**. Native coins (ETH, SOL, …)
and unrecognised tokens have **no denomination** — they are never in a bucket. Cap those with
`maxTotal` or the [count caps](#cap-the-number-of-payments) below.
:::

### Which tokens count as which unit

The built-in labels cover every stablecoin PipRail ships:

| Denomination | Tokens |
|---|---|
| `USD` | USDC · USDT · USD1 · FDUSD · U · RLUSD |
| `EUR` | EURC |

Extend or override them with `denomFor` (your assertion of equivalence — by symbol or asset id):

```ts
policy: {
  maxTotalPerDenom: { USD: '20.00' },
  denomFor: { PYUSD: 'USD', '0xMyCustomStable…': 'USD' },
}
```

## Staged examples

### ① One chain, one token

```ts
const client = new PipRailClient({
  chain: 'base', wallet,
  policy: { maxTotalPerDenom: { USD: '5.00' } },
})
// USDC payments stop once $5 total has been spent.
```

### ② One chain, many stablecoins (the cross-token sum)

```ts
const client = new PipRailClient({
  chain: 'base', wallet,
  policy: { maxTotalPerDenom: { USD: '5.00' } },
})
// 0.05 USDC + 0.05 USDT = $0.10 toward the SAME $5 cap. They are not tracked separately.
```

### ③ Many chains, ONE budget

Use [`MultiChainPayer.fromWallets`](/making-payments/multi-chain/): it gives every chain's client a
**shared ledger**, so the grand total spans all of them.

```ts
import { MultiChainPayer } from '@piprail/sdk'

const payer = MultiChainPayer.fromWallets({
  wallets: {
    base:   { key: process.env.EVM_KEY! },
    solana: { key: process.env.SOLANA_SECRET! },
    xrpl:   { key: process.env.XRPL_SEED! },
  },
  policy: { maxTotalPerDenom: { USD: '20.00' } }, // $20 across base + solana + xrpl, combined
})

await payer.get('https://api.example.com/paid') // pays the first funded chain that can settle
payer.budget().byDenom[0] // → { denom: 'USD', spentFormatted: '…', remainingFormatted: '…', … }
```

### ④ USD and EUR side by side

```ts
policy: { maxTotalPerDenom: { USD: '20.00', EUR: '5.00' } }
// Two independent grand totals — USDC/USDT roll into USD, EURC into EUR.
```

### ⑤ Cap the number of payments

Counts need no oracle, so they span **every** chain and token — including native coins:

```ts
policy: {
  maxPayments: 100,            // lifetime cap on the NUMBER of payments
  maxPaymentsPerWindow: 10,    // …and at most 10 within the rolling window
  windowSeconds: 3600,         // the window width (shared with windowTotal)
}
```

A breach is `reasonCode: 'BUDGET'` for `maxPayments`, `reasonCode: 'OUTSIDE_WINDOW'` for
`maxPaymentsPerWindow`.

## Reading the grand total

[`client.budget()`](/spend-controls/spend-ledger/) exposes the leash. The denomination rows are
present **from the start** (before any spend) because the cap is a single declared number, so an
agent can preview its headroom up front:

```ts
const b = client.budget()
b.byDenom // [{ denom: 'USD', spentFormatted: '0', capFormatted: '20', remainingFormatted: '20', fraction: 0 }]
b.counts  // { settled: 0, lifetimeCap: 100, lifetimeRemaining: 100, … }
```

## Survive a restart

By default these totals are in-memory (the session is the process). Add a
[durable spend store](/spend-controls/persistence/) and the grand total + counts resume after a
crash or redeploy.

## In the MCP server

```bash
PIPRAIL_MAX_TOTAL_DENOM="USD:20.00,EUR:5.00"   # cross-token grand total
PIPRAIL_MAX_PAYMENTS=100                        # lifetime payment count
PIPRAIL_MAX_PAYMENTS_PER_WINDOW=10              # + PIPRAIL_WINDOW_SECONDS
PIPRAIL_WINDOW_SECONDS=3600
```

In multi-chain mode (`PIPRAIL_CHAINS`) the clients share one ledger automatically, so the grand
total spans every funded chain. See [MCP configuration](/mcp/configuration/).
