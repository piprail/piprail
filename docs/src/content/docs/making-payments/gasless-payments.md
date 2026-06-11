---
title: Gasless payments
description: How gasless x402 payments work in PipRail — the exact rail (the buyer signs, zero gas), its two methods EIP-3009 and Permit2, and a clear table of exactly which chains and tokens are gasless and which aren't.
sidebar:
  order: 9
---

This is the one page for **gasless payments**: what "gasless" means here, how PipRail does it, and a
clear table of **which chains and tokens are gasless** — and which aren't. If the EIP-3009 / Permit2 /
exact-rail terms have been confusing, read this top to bottom and they'll click.

## What "gasless" means

In an ordinary on-chain payment the buyer **broadcasts** the transfer and **pays the gas**. PipRail's
standard x402 **`exact` rail is gasless _for the buyer_**: the buyer only **signs** the transfer
off-chain (zero gas, no native coin needed), and someone else broadcasts it — the merchant's own
**relayer** (self-settle) or a **facilitator**. On the right token, *neither* side pays gas (the buyer
signs for free, a facilitator settles).

## Two rails: `onchain-proof` vs `exact`

PipRail offers up to two rails on a single 402; the agent picks one.

| | `onchain-proof` (default) | **`exact`** (gasless buyer) |
|---|---|---|
| Who broadcasts | the **buyer** | the merchant's relayer / a facilitator |
| Buyer pays gas? | **yes** (a normal transfer) | **no** — just signs |
| Where it works | **every** chain + token PipRail supports | **EVM** + a *signable* token (below) |
| Opt-in | default | `schemes: ['onchain-proof', 'exact']` |

`onchain-proof` is PipRail's backendless default — universal, but the buyer holds the gas token.
`exact` is the gasless upgrade, and it's what the wider x402 ecosystem (Coinbase, Binance, …) speaks.

## Two `exact` methods: EIP-3009 vs Permit2

The `exact` rail signs one of two ways, depending on the token. **PipRail auto-selects** per token
(`method: 'auto'`), so you rarely choose by hand.

| | **EIP-3009** (the gold path) | **Permit2** |
|---|---|---|
| Works on | tokens that implement `transferWithAuthorization` | **any** ERC-20 |
| Examples | Circle **USDC** & **EURC**, **FDUSD**, **USD1**, PYUSD | Binance-Peg USDC/USDT on BNB |
| Extra contract needed | **none** — the relayer calls the token directly | the canonical **Permit2** + the **x402ExactPermit2Proxy** |
| One-time setup | **none** | one `approve(Permit2)` per token (buyer, ~46k gas) |
| Per-payment buyer gas | **~0** | **~0** (after that one approval) |

**EIP-3009 is the cleanest** — no approval, no extra contract, the buyer needs only the stablecoin.
**Permit2 covers the gap** — tokens that *don't* implement EIP-3009 (most notably the Binance-Peg
USDC/USDT on BNB), at the cost of one approval and a proxy that must be deployed on the chain.

## ⭐ Which chains & tokens are gasless?

Read this as: *"on chain X, token Y is gasless via Z."* Anything not listed pays via `onchain-proof`
(buyer broadcasts; fees are tiny on most chains but not zero).

### Gasless via EIP-3009 — no approval, no proxy

| Token | Gasless on |
|---|---|
| **USDC** (native Circle) | Ethereum · Base · Arbitrum · Optimism · Polygon · Avalanche · **Sonic · Linea · Celo · Unichain · World Chain · Sei · HyperEVM · Monad · zkSync Era · Injective** |
| **EURC** | Ethereum · Base · Avalanche · World Chain |
| **FDUSD**, **USD1** | BNB Chain |

*(**17 chains, and counting.** Every native Circle USDC is the same Circle FiatToken contract that
implements EIP-3009 — so naming the chain is all it takes, no proxy and no approval. Each chain above
was verified on-chain before shipping: `authorizationState` present, EIP-712 domain `version` 2, and the
chain's real `eth_chainId` matched. The list grows as Circle issues native USDC on more chains.)*

### Gasless via Permit2 — one-time approval, needs the proxy

| Token | Gasless on |
|---|---|
| **USDC**, **USDT** (Binance-Peg) | BNB Chain |
| any ERC-20 | any chain with the x402 Permit2 proxy deployed (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB, Celo, World Chain, Sei, HyperEVM, Monad) |

### NOT gasless → `onchain-proof` (the buyer broadcasts)

- **Native coins** (ETH, BNB, MATIC, …) — no `transferFrom` to authorize.
- **All non-EVM families** — Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL. (Fees there
  are sub-cent, but the buyer signs *and* broadcasts.)
- **USDT** on chains where it isn't EIP-3009 **and** has no Permit2 proxy (Tether implements no EIP-3009
  anywhere) — and bridged USDC (e.g. Mantle, Scroll), which isn't the Circle FiatToken.

> PipRail never advertises a rail it can't settle: if a token isn't EIP-3009 **and** the chain has no
> Permit2 proxy, the gate simply offers `onchain-proof`, not a broken `exact` rail.

## Turn it on

**Buyer** — opt into `exact`; everything else is the same `fetch`/`quote`/`planPayment`:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY }, // needs the stablecoin; ~no gas for exact
  schemes: ['onchain-proof', 'exact'],           // exact is opt-in
})
await client.fetch('https://any-x402-endpoint/api/data') // pays the cheapest settleable rail
```

**Seller** — advertise `exact` beside `onchain-proof`; the method auto-selects per token. Settle with
your own relayer (you pay the settle gas) or a facilitator (they do):

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } }, // or { settle: { facilitator } }
})
```

With a **facilitator** settling and an **EIP-3009** token, **neither side pays gas** — the headline
gasless case. See the full how-tos: [the exact rail (buyer)](/making-payments/exact-buyer/) ·
[the exact rail (seller)](/accepting-payments/exact-rail-seller/).

## BNB Chain — a worked example of both methods

BNB is the instructive case because it uses *both* methods at once. Circle has not issued native USDC
on BNB, so its USDC/USDT are **Binance-Peg** (18-decimal) wrappers that **aren't EIP-3009** → they go
via **Permit2**. But **FDUSD** and **USD1** (both in the `bnb` preset) **are** EIP-3009 → they go the
clean gasless path, **no approval at all**. PipRail auto-selects: USDC/USDT → Permit2, FDUSD/USD1 →
EIP-3009. All four are live-proven on BNB mainnet.

A wrinkle PipRail handles for you: FDUSD and USD1 hardcode their EIP-712 domain version (`"1"`) and
don't expose `version()`, so [`readExactDomain`](/reference/exact-lowlevel/) **derives the version from
the on-chain `DOMAIN_SEPARATOR`** — making any `version()`-less EIP-3009 token first-class with no config.

## How the Permit2 method stays safe

The buyer signs a `PermitWitnessTransferFrom` whose `spender` is the canonical **x402ExactPermit2Proxy**
and whose `witness.to` binds the recipient. The proxy enforces `transferDetails.to == witness.to`, so a
relayer can only push the signed funds to the signed `payTo` — the same no-redirect guarantee EIP-3009's
`to`-binding gives. Verification re-derives every checked field from the merchant's **trusted** rail
(never the client echo); the Permit2 nonce is single-use (replay protection). Canonical addresses are
exported for advanced use: `PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES`,
`PERMIT2_PROXY_CHAIN_IDS`, `isPermit2ProxyChain` from `@piprail/sdk`.

## See also

- [The exact rail (buyer)](/making-payments/exact-buyer/) — pay any x402 server
- [The exact rail (seller)](/accepting-payments/exact-rail-seller/) — get paid over exact
- [Low-level exact codecs](/reference/exact-lowlevel/) — hand-rolled signing
- [Chains](/chains/overview/) — every chain's tokens + receive prerequisites
