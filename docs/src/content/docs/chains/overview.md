---
title: "EVM chains & any other chain"
description: The built-in EVM preset registry, how resolveChain normalises a chain name, viem Chain, or bare { id, rpcUrl }, and how to pay on any EVM chain with no allowlist.
sidebar:
  order: 1
---

## Introduction

A chain is a parameter you pass, not an allowlist the SDK ships. The popular EVM mainnets are
built in by **name** (`chain: 'base'`), each with canonical USDC pre-filled so you never paste a
token address. Any other EVM chain works by passing a viem `Chain` or a bare `{ id, rpcUrl }` —
if viem can reach the RPC, PipRail works on it.

This page covers the EVM side. The non-EVM families each have their own page (Solana, TON, Tron,
NEAR, Sui, Aptos, Algorand, Stellar, XRPL), and the cross-chain setup caveats live in
[Chains & tokens](/concepts/chains-and-tokens/).

## Name a built-in chain — the easy path

Every gate and client takes `chain`. Pass one of the built-in names and the SDK fills in the
chain id, a default RPC, and the canonical token addresses:

```ts
import { requirePayment } from '@piprail/sdk'

// USDC on Base, paid to your wallet — middleware you drop in front of a route.
requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })
```

`token: 'native'` pays in the chain's own gas coin (ETH, BNB, POL, AVAX, …) — accepted on every
preset:

```ts
requirePayment({ chain: 'bnb', token: 'native', amount: '0.01', payTo: '0xYourWallet' }) // BNB
```

## Any other EVM chain — no allowlist

Don't see your chain in the registry? Pass a viem `Chain` or a bare `{ id, rpcUrl }`, plus the
exact token to be paid in. There's no gatekeeping — the registry is a convenience, not a limit.

```ts
requirePayment({
  chain: { id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' }, // any EVM chain
  token: { address: '0x0b9aB...4802', decimals: 6 },               // any ERC-20 — symbol is optional
  amount: '0.10',
  payTo: '0xYourWallet',
})
```

`symbol` on a custom token is **optional** (display-only metadata); `address` and `decimals` are
what the SDK actually pays and verifies against. When you pass a custom chain, the SDK still
recognises a built-in token address if its chain id matches a preset — so symbol resolution keeps
working even off the named path.

An **invalid token** is rejected up front, at config time, with a typed
[`WrongFamilyError`](/errors/error-hierarchy/) — never a raw viem error later on the verify path:
a non-`0x` token `address` (e.g. a Tron `T…` string), or another family's token shape (a Solana
`{ mint }`, a Stellar `{ issuer, code }`) on an EVM chain. A valid address is checksum-normalized
for you. This mirrors how a non-`0x` `payTo` is rejected at config time.

## The built-in EVM registry — `CHAINS`

`CHAINS` is the registry itself: an object keyed by chain name, each value a `ChainPreset`. It's
exported so you can iterate it — build a chain picker, list what's supported, or read a token
address — without hardcoding anything.

```ts
import { CHAINS } from '@piprail/sdk'

for (const [name, preset] of Object.entries(CHAINS)) {
  console.log(name, preset.chain.id, Object.keys(preset.tokens))
}
// → base 8453 [ 'USDC', 'EURC' ]
// → bnb 56 [ 'USDC', 'USDT', 'FDUSD', 'USD1', 'U' ]
// → … one line per built-in chain
```

Each preset carries the underlying viem `chain`, an optional `defaultRpc` override (set only
where viem's bundled default is unreliable), and the well-known `tokens` keyed by uppercase
symbol:

```ts
interface ChainPreset {
  chain: Chain                       // viem chain: id, name, native coin, default RPCs
  defaultRpc?: string                // RPC used when the caller passes no rpcUrl
  tokens: Record<string, TokenInfo>  // well-known tokens, keyed by UPPERCASE symbol
}

interface TokenInfo {
  address: `0x${string}`
  decimals: number
  symbol: string
}
```

### Token coverage

USDC is built in on every preset except where Circle issues none; USDT where it's Tether-native;
EURC where Circle issues it. Every address was verified on-chain (symbol + decimals) before
shipping. The current registry:

| `chain` | Network | Built-in tokens |
|---|---|---|
| `'ethereum'` | Ethereum | USDC, USDT, EURC |
| `'base'` | Base | USDC, EURC |
| `'arbitrum'` | Arbitrum | USDC, USDT |
| `'optimism'` | Optimism | USDC, USDT |
| `'polygon'` | Polygon | USDC, USDT |
| `'bnb'` | BNB Chain | USDC, USDT, FDUSD, USD1, U |
| `'avalanche'` | Avalanche | USDC, USDT, EURC |
| `'mantle'` | Mantle | USDC, USDT |
| `'sonic'` | Sonic | USDC, USDT |
| `'linea'` | Linea | USDC, USDT |
| `'scroll'` | Scroll | USDC, USDT |
| `'celo'` | Celo | USDC, USDT |
| `'zksync'` | zkSync Era | USDC, USDT |
| `'unichain'` | Unichain | USDC, USDT |
| `'worldchain'` | World Chain | USDC |
| `'sei'` | Sei | USDC |
| `'injective'` | Injective | USDC, USDT |
| `'hyperevm'` | HyperEVM (Hyperliquid) | USDC |
| `'monad'` | Monad | USDC |
| `'kaia'` | Kaia (ex-Klaytn) | USDT |

`token: 'native'` works on all of them. For the issuer-native-vs-bridged provenance of each
USDC/USDT, the EURC EIP-712 caveat, and BNB's 18-decimal peg tokens, see
[Chains & tokens](/concepts/chains-and-tokens/).

:::note
On **BNB Chain**, all five built-in stablecoins are **18 decimals**, not 6 (the preset has it
right — name `token: 'USDC'` and don't hardcode 6). They split by provenance: **USDC/USDT are
Binance-Peg** (not EIP-3009 → the `exact` rail uses **Permit2**), while **FDUSD, USD1 and U
(United Stables)** are **EIP-3009** (→ the gasless `transferWithAuthorization` path, **no Permit2
approve**, and settleable by a keyless facilitator). `U` is the first-listed token in Binance's own
x402 set (U/USD1/USDT/USDC) — live-proven on BNB mainnet (Pieverse sponsored the gas). The SDK
auto-selects per token — see [Gasless payments](/making-payments/gasless-payments/).
:::

## Resolving a chain — `resolveChain`

`resolveChain(input, rpcUrlOverride?)` is the one function that normalises whatever you pass for
`chain` into the `{ chain, chainId, rpcUrl, tokens }` the wallet and verifier need. The gate and
client call it for you; you rarely call it directly, but it documents exactly how the three input
shapes resolve.

```ts
import { resolveChain } from '@piprail/sdk'

const resolved = resolveChain('base')
// → { chain: <viem Chain>, chainId: 8453, rpcUrl: 'https://…', tokens: { USDC, EURC } }

resolveChain(someViemChain)                                   // a full viem Chain
resolveChain({ id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' }) // a bare { id, rpcUrl }
```

It returns a `ResolvedChain`:

```ts
interface ResolvedChain {
  chain: Chain
  chainId: number
  rpcUrl: string
  tokens: Record<string, TokenInfo>  // built-in tokens for this chain (empty if unknown)
}
```

### The three input shapes — `ChainInput`

`ChainInput` is the union `chain` accepts. How each resolves:

| Input | `rpcUrl` resolution | `tokens` |
| --- | --- | --- |
| `ChainName` (e.g. `'base'`) | `rpcUrlOverride` → preset `defaultRpc` → viem default | the preset's tokens |
| viem `Chain` | `rpcUrlOverride` → the chain's viem default | built-in tokens if the id matches a preset, else `{}` |
| `{ id, rpcUrl }` | `rpcUrlOverride` → the `rpcUrl` you passed | built-in tokens if the id matches a preset, else `{}` |

A bare `{ id, rpcUrl }` may also carry an optional `name` (defaults to `EVM <id>`) and
`nativeCurrency` (defaults to 18-decimal ETH):

```ts
resolveChain({
  id: 1313161554,
  rpcUrl: 'https://mainnet.aurora.dev',
  name: 'Aurora',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
})
```

### The `rpcUrl` override

Pass `rpcUrl` on the gate or client and it wins over every default. Public RPCs are
rate-limited, so production callers should always pass their own (there's no separate API-key
field — fold any key into the URL):

```ts
requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  rpcUrl: 'https://base-mainnet.example.com/v2/YOUR_KEY',
})
```

:::caution
An unknown chain name throws. Via a gate or client (the normal path) it surfaces as a typed
[`UnsupportedNetworkError`](/errors/error-hierarchy/) (`.code === 'UNSUPPORTED_NETWORK'`,
`instanceof PipRailError`) — `resolveChain`'s helpful message (the built-in names + "pass a viem
`Chain` or `{ id, rpcUrl }`") is preserved verbatim inside it. A `{ id, rpcUrl }` with no `rpcUrl`,
or a chain whose viem default has no usable RPC, also throws: an EVM chain has no implicit RPC.
:::

## Types

All of these are exported from `@piprail/sdk`:

| Type | What it is |
| --- | --- |
| `ChainName` | A built-in EVM chain name — `keyof typeof CHAINS`. |
| `ChainInput` | What `chain` accepts: a `ChainName`, a viem `Chain`, or `{ id, rpcUrl, name?, nativeCurrency? }`. |
| `ResolvedChain` | The normalised `{ chain, chainId, rpcUrl, tokens }` returned by `resolveChain`. |
| `ChainPreset` | One registry entry: `{ chain, defaultRpc?, tokens }`. |
| `TokenInfo` | A built-in token: `{ address, decimals, symbol }`. |
