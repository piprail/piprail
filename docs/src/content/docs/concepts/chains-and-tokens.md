---
title: "Chains & tokens"
description: One chain parameter picks the chain, the token, and the settlement family — here's what's covered and how the built-in presets are filled in.
sidebar:
  order: 4
---

## Introduction

PipRail charges and pays the same way everywhere — `requirePayment({ chain, token, amount, payTo })`
to charge, `new PipRailClient({ chain, wallet }).fetch(url)` to pay. A single `chain` value
selects the chain, its tokens, and the settlement family behind it. There is **no allowlist**:
the popular chains ship as presets for convenience, and any other EVM chain works by passing
its details directly.

## What's covered

Every major EVM chain plus a range of non-EVM families, each reached through the same `chain`
parameter:

| Family | `chain` values |
| --- | --- |
| **EVM** | `ethereum`, `base`, `arbitrum`, `optimism`, `polygon`, `bnb`, `avalanche`, `mantle`, `sonic`, `linea`, `scroll`, `celo`, `zksync`, `unichain`, `worldchain`, `sei`, `injective`, `hyperevm`, `monad`, `kaia` — **plus any other EVM chain** by viem `Chain` or `{ id, rpcUrl }` |
| **Solana** | `solana` |
| **TON** | `ton` |
| **Tron** | `tron` |
| **NEAR** | `near` |
| **Sui** | `sui` |
| **Aptos** | `aptos` |
| **Algorand** | `algorand` |
| **Stellar** | `stellar` |
| **XRP Ledger** | `xrpl` |

The authoritative, always-current list and the per-chain receive prerequisites live in
[Chains overview](/chains/overview/). Mainnets only — there are no testnet presets.

```ts
// On the server you charge; pass your own receiving address as payTo.
requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })   // EVM preset
requirePayment({ chain: 'solana', token: 'USDC', amount: '0.10', payTo: 'YourSolanaAddr' })
```

## The token rule

You name a token by symbol and PipRail resolves the canonical contract for that chain. The
coverage follows a simple rule:

| Token | Where it's built in |
| --- | --- |
| **USDC** | Almost everywhere Circle issues it natively. |
| **USDT** | Most chains — **omitted where the chain's "USDT" is a bridged LayerZero/USDT0 token** rather than Tether-native. |
| **EURC** | Where Circle issues it — on EVM that's Ethereum, Base, and Avalanche; also Stellar. |
| **RLUSD** | XRP Ledger. |
| **native coin** | Valid on **every** family via `token: 'native'`. |

The native coin (ETH, SOL, XRP, …) is the chain's gas token and is always a valid payment
asset. Anything else works by address — there's no allowlist for tokens either:

```ts
requirePayment({ chain: 'base', token: 'native', amount: '0.10', payTo: '0xYourWallet' })
requirePayment({
  chain: 'arbitrum',
  token: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  amount: '0.10',
  payTo: '0xYourWallet',
})
```

The custom-token shape is per-family — an EVM `{ address, decimals }`, a Solana
`{ mint, decimals }`, a TON `{ master, decimals }`, and so on. The full set of shapes is on
[Chains overview](/chains/overview/).

:::note
The omission of USDT on some chains is deliberate. PipRail only ships a symbol when it maps to
the issuer-native token. Where a chain's "USDT" is actually a bridged USDT0 / LayerZero token,
`token: 'USDT'` is left out — pass it as a custom `{ address, decimals }` if you specifically
want it. See [Chains overview](/chains/overview/) for the per-chain provenance.
:::

## Per-chain setup & caveats — at a glance

Most chains are zero-setup: install, name the chain, add a wallet. A few have one-time caveats
worth knowing **before you ship** — the peer library to install, what the *recipient* must do to
receive a token, and which native coin pays gas. Each family page has the full detail.

| Chain | Install (lazy peer) | To **receive**, the recipient needs… | Gas / notes |
| --- | --- | --- | --- |
| **EVM** ([all presets](/chains/overview/)) | `viem` (core dep) | nothing | native coin (ETH/BNB/POL/AVAX/…) |
| **[Solana](/chains/solana/)** | `@solana/web3.js @solana/spl-token bs58` | nothing (the SDK auto-creates the token account) | SOL |
| **[TON](/chains/ton/)** | `@ton/ton @ton/core @ton/crypto` | nothing (jetton wallet auto-deploys on first receipt) | TON · **needs a free toncenter RPC key** (`@tonapibot` on Telegram, in `rpcUrl`); ships USD₮, no native USDC |
| **[Tron](/chains/tron/)** | `tronweb` | nothing | **real TRX** for energy/bandwidth; ships USD₮ (native TRX also works) |
| **[NEAR](/chains/near/)** | `near-api-js` | a NEP-141 token (USDC/USDT): one-time **`storage_deposit`** (~0.00125 NEAR). Native NEAR: nothing | NEAR · set `accountId` |
| **[Sui](/chains/sui/)** | `@mysten/sui` | nothing | SUI · USDC only (no native USDT) |
| **[Aptos](/chains/aptos/)** | `@aptos-labs/ts-sdk` | nothing (primary FA store auto-creates) | APT |
| **[Algorand](/chains/algorand/)** | `algosdk` | USDC: one-time **ASA opt-in** (a 0-amount self-transfer). Native ALGO: nothing | ALGO · USDC only |
| **[Stellar](/chains/stellar/)** | `@stellar/stellar-sdk` | for USDC/EURC: a **trustline** + the account funded above its base reserve. Native XLM: nothing | XLM · USDC + EURC |
| **[XRP Ledger](/chains/xrpl/)** | `xrpl` | for USDC/RLUSD: a **trustline** + the account activated (≥1 XRP reserve). Native XRP: nothing | XRP · USDC + RLUSD |

A recipient that isn't set up surfaces as a typed [`RecipientNotReadyError`](/errors/why-payments-fail/)
(or a `RECIPIENT_NOT_READY` blocker from [`planPayment()`](/making-payments/plan-payment/)) with the
exact fix — never a silent failure. The base-reserve XLM/XRP is **locked, not spent**.

:::note
EVM, Solana, Tron, Sui, and Aptos need no receive setup at all. Native coin is zero-setup on
**every** family. The caveats above only apply to the specific issued tokens noted.
:::

## The built-in EVM registry — `CHAINS`

`CHAINS` is the exported registry of built-in EVM presets. Each preset carries the underlying
viem `Chain` and a `tokens` map keyed by uppercase symbol, with the canonical address and
decimals pre-filled — so you never paste a token address for a supported chain:

```ts
import { CHAINS } from '@piprail/sdk'

CHAINS.base.tokens.USDC
// → { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' }
```

A `ChainPreset` is shaped like this:

```ts
interface ChainPreset {
  chain: Chain                       // the viem chain (id, name, native coin, RPCs)
  defaultRpc?: string                // override only where viem's default is unreliable
  tokens: Record<string, TokenInfo>  // canonical tokens, keyed by UPPERCASE symbol
}

interface TokenInfo {
  address: `0x${string}`
  decimals: number
  symbol: string
}
```

Iterate `CHAINS` to build a chain picker, or read a preset directly when you want the canonical
address for a known chain. `ChainName` is the union of built-in preset keys (`'base' | 'ethereum'
| …`).

:::tip
On **BNB Chain**, all five built-in stablecoins are **18 decimals**, not 6 (the preset carries the
correct decimals, so naming `token: 'USDC'` is always right — don't hardcode 6). Provenance differs:
**USDC/USDT are Binance-Peg** (not EIP-3009 → the `exact` rail uses Permit2), while **FDUSD, USD1, and U
are EIP-3009** (→ the gasless `transferWithAuthorization` path, no Permit2 approve). The SDK
auto-selects per token; see [Gasless payments](/making-payments/gasless-payments/).
:::

## Any other EVM chain

You're not limited to the presets. For an EVM chain PipRail doesn't ship, pass a viem `Chain`
or a bare `{ id, rpcUrl }`, plus the token you want paid in. If viem can reach the RPC, PipRail
works on it:

```ts
requirePayment({
  chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' },
  token: { address: '0xB12BFcA5A55806AaF64E99521918A4bf0fC40802', decimals: 6 },
  amount: '0.10',
  payTo: '0xYourWallet',
})
```

The accepted `chain` types are captured by `ChainInput`:

| Form | Use when |
| --- | --- |
| `ChainName` (`'base'`, …) | A built-in EVM preset. |
| viem `Chain` | An EVM chain you already have a viem definition for. |
| `{ id, rpcUrl, name?, nativeCurrency? }` | Any EVM chain by id + RPC. Native coin defaults to 18-decimal ETH; override `nativeCurrency` if it isn't. |

When you pass a raw viem `Chain` or `{ id, rpcUrl }` that happens to match a built-in chain id,
symbol resolution still works — the preset's tokens are looked up by chain id.

## RPC endpoints

The public default RPC on every chain is rate-limited. **Pass your own `rpcUrl` in
production.** There is no separate API-key field — fold any key into the URL:

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  rpcUrl: 'https://base-mainnet.example.com/v2/YOUR_KEY',
})
```

Each entry in a multi-rail `accept[]` can carry its own `rpcUrl`. A few non-EVM families
effectively **require** a keyed endpoint (TON's keyless toncenter is too slow for
`verify()`) — those caveats are on each chain's page under [Chains](/chains/overview/).
