---
title: Permit2 & BNB Chain
description: Pay and get paid over the x402 `exact` scheme on tokens without EIP-3009 — Binance-Peg USDC/USDT on BNB Chain — using Permit2 and the canonical x402ExactPermit2Proxy. No backend, no facilitator, buyer-gasless after a one-time approval.
sidebar:
  order: 9
---

## Why Permit2

The x402 `exact` scheme has two on-chain transfer methods. **EIP-3009**
(`transferWithAuthorization`) is the default — but it only exists on tokens that implement it
(canonical Circle USDC, EURC). **BNB Chain has no such token**: Circle has not issued native USDC
on BNB (CCTP excludes BSC), so its USDC/USDT are **Binance-Peg** wrappers (18-decimal) that do
**not** implement EIP-3009.

The `exact` scheme's second method, **`permit2`**, covers exactly these tokens — *any* ERC-20 —
via Uniswap's canonical **Permit2** contract and the canonical **x402ExactPermit2Proxy**. PipRail
ships it on both sides, so BNB is a first-class `exact` chain (it also pays Binance x402 / BNB
"Agent Survival Pack" endpoints, which settle the Peg tokens via Permit2).

:::tip[Live-proven]
The full round-trip — buyer signs → proxy self-settles → merchant paid → replay rejected — is
proven on **BNB mainnet** with real USDC. Both contracts are canonical CREATE2 deployments present
on BNB: Permit2 `0x0000…78BA3` and the x402ExactPermit2Proxy `0x402085…20001`.
:::

## The gasless exception: FDUSD & USD1 (EIP-3009)

Not every BNB stablecoin needs Permit2. **FDUSD** (First Digital USD) and **USD1** (World Liberty
Financial USD) — both built into the `bnb` preset, both 18-decimal — **are EIP-3009 tokens**. For
them the `exact` rail uses `transferWithAuthorization` directly, so the buyer signs and pays
**zero gas with no Permit2 approval at all** — the cleanest possible path. The SDK **auto-selects**
per token: USDC/USDT (Binance-Peg) → Permit2; FDUSD/USD1 → EIP-3009.

A wrinkle PipRail handles for you: FDUSD and USD1 **hardcode** their EIP-712 domain version (`"1"`)
and don't expose a `version()` function, so [`readExactDomain`](/reference/exact-lowlevel/) **derives
the version by matching the token's on-chain `DOMAIN_SEPARATOR`** — making them first-class EIP-3009
tokens with no config (and the trick generalizes to any `version()`-less EIP-3009 token).

```ts
// FDUSD / USD1 on BNB → gasless EIP-3009 (no approve). Buyer needs only the stablecoin.
const client = new PipRailClient({ chain: 'bnb', wallet: { privateKey }, schemes: ['exact'] })
await client.fetch('https://some-bnb-x402-endpoint/api/data')
```

Both are **live-proven on BNB mainnet** (gasless EIP-3009 round-trip, replay rejected). Combined with
a [facilitator](/accepting-payments/exact-rail-seller/) that broadcasts, **neither buyer nor seller
pays gas** — buyer signs for free, facilitator settles.

## How it works

| | EIP-3009 method | **Permit2 method** |
| --- | --- | --- |
| Buyer signs | `transferWithAuthorization` (token domain) | `PermitWitnessTransferFrom` (Permit2 domain) |
| Spender in the signature | — | the canonical **x402ExactPermit2Proxy** |
| Recipient binding | `to` in the auth | `witness.to` (the proxy enforces it) |
| One-time setup | none | `approve(Permit2)` once per token (buyer, ~46k gas) |
| Per-payment buyer gas | ~0 | ~0 (after the one-time approval) |
| Seller settles via | the token's `transferWithAuthorization` | the proxy's `settle(...)` |

The proxy binds `transferDetails.to == witness.to`, so a relayer can only push the signed funds to
the signed recipient — the same no-redirect guarantee EIP-3009's `to`-binding gives. The buyer
re-derives nothing sensitive: the `spender` is the SDK's constant proxy and the EIP-712 domain is
Permit2's own, so a lying server can only mis-price its *own* rail (your spend
[`policy`](/spend-controls/payment-policy/) still caps the amount).

## Pay on BNB (buyer)

Opt the client into `exact` and point it at BNB. The SDK detects that the rail is `permit2` from
the 402's `extra.assetTransferMethod`, does the one-time `approve(Permit2)` lazily the first time,
then signs each payment gas-free:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'bnb',
  wallet: { privateKey: process.env.AGENT_KEY! }, // needs USDC + a little BNB for the one-time approve
  schemes: ['onchain-proof', 'exact'],            // exact is opt-in
})

// Pays any BNB x402 endpoint (Binance x402, Pieverse, or a PipRail gate) over Permit2.
const res = await client.fetch('https://some-bnb-x402-endpoint/api/data')
```

Nothing else changes — [`fetch`/`planPayment`/`quote`](/making-payments/fetch-and-autoroute/) work
the same. `estimateCost` reports the rail as gasless, noting the one-time Permit2 approval.

## Get paid on BNB (seller)

A gate on a non-EIP-3009 token **auto-selects Permit2** — no extra config. Your relayer broadcasts
the proxy `settle`; funds land at `payTo`:

```ts
import { requirePayment } from '@piprail/sdk'

const gate = requirePayment({
  chain: 'bnb', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } },
  // method defaults to 'auto' → Permit2 here (USDC on BNB isn't EIP-3009)
})
```

The advertised `exact` rail carries `extra.assetTransferMethod: 'permit2'` (and omits the token
EIP-712 `name`/`version`, which Permit2 doesn't use). Verification re-derives every checked field
from your trusted rail — `witness.to` must equal `payTo`, `permitted.amount` must cover the price,
the `spender` must be the x402ExactPermit2Proxy, and the Permit2 nonce must be unused (replay
protection, the same as EIP-3009). A settle failure returns 5xx and leaves the signature valid.

See the full buyer and seller references: [The exact rail (buyer)](/making-payments/exact-buyer/)
· [The exact rail (seller)](/accepting-payments/exact-rail-seller/).

## Notes

- **Only on-chain action for the buyer** is the one-time `approve(Permit2)` per token — after that,
  every payment is a gas-free signature.
- **Native coin and non-EVM chains** still can't use `exact` — they stay on `onchain-proof`.
- The canonical addresses are exported for advanced use: `PERMIT2_ADDRESS`,
  `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES` from `@piprail/sdk`.
