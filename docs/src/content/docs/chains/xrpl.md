---
title: "Accept USDC payments on XRP Ledger"
description: 'Take and make payments on the XRP Ledger in USDC, Ripple''s RLUSD, or native XRP — its memo-bound proof, the trustline/activation prerequisite.'
sidebar:
  label: XRP Ledger
  order: 10
---

## Introduction

The XRP Ledger (XRPL) is a non-EVM family that's payment-native: ~3–5s single-step finality, no
reorgs, with a built-in Memo and DestinationTag the protocol uses for proof binding. Name it —
`chain: 'xrpl'` — and the driver **auto-mounts on first use**, so a pure-EVM or Solana install
never downloads the XRPL library. The protocol layer is unchanged; only the wallet shape and the
receive prerequisite differ.

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({ chain: 'xrpl', token: 'USDC', amount: '0.10', payTo: 'r…' })
```

## Install the peer dependency

The XRPL library is an optional peer dep — install it once and the lazy import finds it:

```bash
npm install xrpl
```

## The wallet

An XRPL wallet is `{ key }`, where `key` is an `s…` family secret seed — or a ready `{ wallet }`
(an xrpl.js `Wallet`, if you built it yourself). `payTo` is a classic `r…` address.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'xrpl',
  wallet: { key: process.env.XRPL_SEED },  // 's…' secret seed
})
```

The shape is checked synchronously at bind time, so passing an EVM, Solana, TON, or Stellar
wallet fails fast with a [`WrongFamilyError`](/errors/error-hierarchy/). See [Wallets by
family](/making-payments/wallets-by-family/) for the full set of shapes, and
[PipRailClient](/making-payments/piprail-client/) for the client surface.

## Tokens

Name the symbol; the SDK fills in the issuer and currency code. Both built-in issuers were
verified live on mainnet before shipping (the on-ledger `Domain` and currency code read off
`gateway_balances`).

| Token | Built in | Notes |
| --- | --- | --- |
| `'USDC'` | Yes | Circle USDC. Issuer `Domain` `https://circle.com` verified on mainnet. |
| `'RLUSD'` | Yes | Ripple's RLUSD. Issuer `Domain` `https://ripple.com/` verified on mainnet. |
| `'native'` | Yes | XRP, 6 decimals (drops — 1 drop = 1e-6 XRP). |
| custom IOU | — | Any other issued currency via `{ issuer, currencyHex, decimals }`. |

```ts
import { requirePayment } from '@piprail/sdk'

// A custom issued currency is { issuer, currencyHex, decimals }:
requirePayment({
  chain: 'xrpl',
  // 160-bit hex for a 4+ char code, e.g. 'MYTKN':
  token: { issuer: 'r…', currencyHex: '4D59544B4E000000000000000000000000000000', decimals: 6 },
  amount: '0.10',
  payTo: 'r…',
})
```

:::caution
**No built-in USDT on XRPL** — `token: 'USDT'` is intentionally absent. Pay in `'USDC'`,
`'RLUSD'`, `'native'`, or a custom IOU.
:::

:::note
XRPL issued currencies aren't fixed-decimal: they cross the ledger as decimal strings (up to 15
significant digits), so the `decimals` in a custom token is the SDK's base-unit **scaling
convention** (6 dp is the canonical stablecoin precision), not an on-ledger fixed precision. The
driver converts to and from XRPL's decimal strings at the edges. Currency codes longer than 3
characters — USDC and RLUSD both qualify — use the 160-bit hex form.
:::

## Receive prerequisite — activation + a trustline

To **receive** an issued asset (USDC/RLUSD), the merchant (`payTo`) must (1) be an **activated**
account — holding the ~1 XRP base reserve to exist — and (2) hold a **trustline** (`TrustSet`) to
that issuer's currency *before* its first IOU payment. Native XRP needs neither. The payer must
be activated and trustlined too.

When the recipient isn't ready, PipRail raises [`RecipientNotReadyError`](/errors/error-hierarchy/)
— a chain requirement, not an SDK bug — echoing the raw XRPL engine code and the fix:

| Raw XRPL code | What it means | Fix |
| --- | --- | --- |
| `tecNO_DST_INSUF_XRP` / `tecNO_DST` | `payTo` isn't activated (needs ≥1 XRP base reserve to exist) | send the recipient ≥1 XRP to activate it |
| `tecNO_LINE` / `tecPATH_DRY` | recipient has no trustline for the IOU | add the trustline on the recipient |
| `tecDST_TAG_NEEDED` | recipient requires a DestinationTag (PipRail sets one automatically) | — |

Reserves are **locked, not spent** (~1 XRP base + an owner reserve per trustline) — recoverable.

Check readiness *before* you spend with [`planPayment()`](/making-payments/plan-payment/): it
surfaces a not-ready recipient as a `RECIPIENT_NOT_READY` blocker rather than throwing, so an
agent branches on data instead of broadcasting into a stranded payment:

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)
// → PaymentPlan | null (null when the URL isn't 402-gated)

if (!plan) {
  await client.fetch(url) // not payment-gated — just fetch it
} else if (plan.payable) {
  await client.fetch(url) // safe — we checked
} else {
  console.log(plan.fundingHint) // e.g. "recipient has no trustline for USDC"
}
```

See [planPayment()](/making-payments/plan-payment/) for the full readiness model and the
`RECIPIENT_NOT_READY` blocker.

## Proof binding — Template A (memo-bound)

XRPL uses [Template A](/concepts/proof-binding/): the challenge nonce rides in a **Memo** — the
cryptographic binding — plus a derived **DestinationTag** for deliverability (some accounts, like
the RLUSD issuer, set `requireDestinationTag`). `verify()` re-derives every checked field from
the trusted `accept`, never the client-supplied ref, so a forged echo can't redirect it.

:::caution
Verification compares **`delivered_amount`** — what actually arrived — never `Amount`. A
successful payment using `tfPartialPayment` can advertise a large `Amount` while delivering
almost nothing; checking the delivered amount closes that attack. The driver also never sets
`tfPartialPayment` when paying, so it always requires full delivery.
:::

## Server-side only

:::note
The XRPL library doesn't ship a clean browser ESM build yet, so run the XRPL path
**server-side** — the identical one line, on Node, Bun, Deno, or Workers. The lazy import means a
pure-EVM page never downloads it. See [Chains & tokens](/concepts/chains-and-tokens/) for the
full cross-chain caveat list.
:::

## Endpoints

The default RPC is a public community cluster (`https://xrplcluster.com/`) — rate-limited and not
for sustained business use. Pass your own `rpcUrl` in production:

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'xrpl', token: 'USDC', amount: '0.10', payTo: 'r…', rpcUrl: 'https://your-xrpl-node/' })

const client = new PipRailClient({
  chain: 'xrpl',
  wallet: { key: process.env.XRPL_SEED },
  rpcUrl: 'https://your-xrpl-node/',
})
```
