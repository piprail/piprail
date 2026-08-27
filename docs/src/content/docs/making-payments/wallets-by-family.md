---
title: Wallets — one field, every chain
description: 'The wallet shape is always { key } — the chain''s secret as a string. NEAR also needs accountId. What key holds per chain.'
sidebar:
  order: 3
---

## Introduction

A `PipRailClient` takes one `wallet` and one `chain`. **The wallet is always `{ key }`** — the
chain's secret as a string. The `chain` selector routes to a driver family, and that family knows
how to read its own secret format. One shape, every chain:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.AGENT_KEY } })
// → a PipRailClient bound to Base, ready to quote / plan / pay
```

The **only** exception is NEAR, which also needs an `accountId` (an account id can't be derived
from the key) — so NEAR is `{ accountId, key }`. Everything else is just `{ key }`.

:::note[New in v2]
Earlier versions used a different field name per chain (`privateKey`/`secretKey`/`seed`/`secret`/
`mnemonic`). **v2 unifies them all to `key`.** If you pass an old name you get a clear, one-line
migration error pointing you at `{ key }`. See [Migrating from v1](#migrating-from-v1) below.
:::

## What `key` is, per chain

`key` always holds that chain's standard secret string — the SDK validates the format for the
chain you named:

| Family | What `key` holds |
| --- | --- |
| EVM (`'base'`, `'bnb'`, … any EVM chain) | a `0x…` hex private key |
| Tron | a 32-byte hex private key (secp256k1, like EVM) |
| Sui | a `suiprivkey1…` bech32 secret (or a raw 32-byte `Uint8Array`) |
| Aptos | an AIP-80 `ed25519-priv-0x…` secret (or a raw `0x…` hex key) |
| Solana | a base58 secret string (or a raw `Uint8Array`) |
| TON | a 24-word mnemonic (a string or `string[]`) — add `version: 'v5r1'` for a W5 wallet |
| Algorand | a 25-word mnemonic |
| Stellar | an `S…` secret seed |
| XRPL | an `s…` secret seed |
| NEAR | an `ed25519:…` secret — **plus** `accountId` (see below) |

```ts
new PipRailClient({ chain: 'base',     wallet: { key: process.env.AGENT_KEY } })   // 0x… hex
new PipRailClient({ chain: 'solana',   wallet: { key: process.env.SOLANA_SECRET } }) // base58
new PipRailClient({ chain: 'ton',      wallet: { key: process.env.TON_MNEMONIC } })  // 24 words
new PipRailClient({ chain: 'xrpl',     wallet: { key: process.env.XRPL_SEED } })     // s… seed
new PipRailClient({ chain: 'aptos',    wallet: { key: process.env.APTOS_KEY } })     // ed25519-priv-0x…
```

## NEAR — `{ accountId, key }`

NEAR is the one family that needs two fields: the named account it signs as, plus its key. The
`key` is an `ed25519:…` secret.

```ts
new PipRailClient({
  chain: 'near',
  wallet: { accountId: 'agent.near', key: process.env.NEAR_KEY }, // key = ed25519:…
})
```

## Advanced — bring your own signer object

Beyond the simple `{ key }` string, each family also accepts its own **native, pre-built signer
object** for when you've already constructed one (a hardware signer, an injected browser wallet, a
custom transport). These are type-specific to each ecosystem:

| Family | Bring-your-own object |
| --- | --- |
| EVM | `{ walletClient }` — a viem `WalletClient` with an attached account |
| Solana | `{ signer }` — a `@solana/web3.js` `Keypair` |
| TON | `{ keyPair }` — a `@ton/crypto` `KeyPair` (+ `version`) |
| Stellar / Sui | `{ keypair }` — a stellar-sdk `Keypair` / a `@mysten/sui` `Ed25519Keypair` |
| XRPL | `{ wallet }` — an xrpl.js `Wallet` |
| Aptos / Algorand | `{ account }` — an Aptos `Account` / an algosdk `{ addr, sk }` |

These are optional power-user paths — `{ key }` is the simple default for every chain.

## Injected browser wallet — `{ walletClient }`

On EVM you can hand the client an injected viem `walletClient` instead of a raw key — the visitor
signs with their own wallet, and no secret ever touches your page source.

```ts
import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'

// The SDK needs a walletClient with an ATTACHED account — connect first.
const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' })
const walletClient = createWalletClient({ account, chain: base, transport: custom(window.ethereum) })
const client = new PipRailClient({ chain: 'base', wallet: { walletClient } })
```

:::caution
A raw `{ key }` belongs only in a **server's** environment — never in code shipped to a browser,
where the page source is public. In a browser, use an injected `walletClient`.
:::

## Migrating from v1

v1 named the secret field per chain; v2 uses `key` everywhere. The mechanical change:

```diff
- new PipRailClient({ chain: 'base',   wallet: { privateKey: KEY } })
- new PipRailClient({ chain: 'solana', wallet: { secretKey: KEY } })
- new PipRailClient({ chain: 'xrpl',   wallet: { seed: KEY } })
- new PipRailClient({ chain: 'stellar',wallet: { secret: KEY } })
- new PipRailClient({ chain: 'ton',    wallet: { mnemonic: KEY } })
- new PipRailClient({ chain: 'near',   wallet: { accountId, privateKey: KEY } })
+ new PipRailClient({ chain,           wallet: { key: KEY } })   // every chain
+ new PipRailClient({ chain: 'near',   wallet: { accountId, key: KEY } })
```

`privateKey` → `key`, `secretKey` → `key`, `seed` → `key`, `secret` → `key`, `mnemonic` → `key`.
The **value** is unchanged (same hex / base58 / seed / mnemonic). The bring-your-own object fields
(`walletClient`, `signer`, `keyPair`, `keypair`, `wallet`, `account`) are unchanged. If you pass a
v1 field name, the SDK throws a `WrongFamilyError` whose message names the exact `{ key }` fix.

For the MCP server, nothing changes — its env vars (`PIPRAIL_PRIVATE_KEY`, `PIPRAIL_<CHAIN>_KEY`)
are the same.

## Wrong shape → `WrongFamilyError`

The chain picks the family, and the family validates the wallet on first use. If the wallet (or a
`payTo`, or a token) is given in another family's form — an `0x…` address on Solana, a `{ mint }`
token on a Stellar chain — or a pre-v2 secret field name, the bind throws a typed
[`WrongFamilyError`](/errors/error-hierarchy/) (`.code === 'WRONG_FAMILY'`) rather than failing
obscurely later.

```ts
import { PipRailClient, WrongFamilyError } from '@piprail/sdk'

// a pre-v2 field name → a clear migration error on first request
const client = new PipRailClient({ chain: 'base', wallet: { privateKey: '0x…' } })

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof WrongFamilyError) {
    console.error(err.code, err.message) // → 'WRONG_FAMILY' '…replace { privateKey } with { key }.'
  } else {
    throw err
  }
}
```

The error is raised lazily — the driver auto-mounts and binds the wallet on the first call (see
the [PaymentDriver architecture](/concepts/payment-driver-architecture/)), so a misconfigured
client constructs fine but throws the moment it tries to act.

:::note
Which chains run in the browser is a library question, not a wallet one. EVM works out of the box
from a bare CDN import; `solana`, `sui`, and `near` work with an
[import map](/getting-started/installation/) that pins each peer's CDN URL; and `ton`, `tron`,
`xrpl`, and `stellar` rely on libraries that assume Node, so pay on those from a backend. See the
[chains overview](/chains/overview/) and [installation](/getting-started/installation/).
:::

Per-chain receive prerequisites, token coverage, and proof binding live on each chain's page —
start at the [chains overview](/chains/overview/). Once a wallet is bound, the read-only
[`planPayment()`](/making-payments/plan-payment/) tells you whether it can actually settle a given
402.
