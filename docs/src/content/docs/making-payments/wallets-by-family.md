---
title: Wallets by family
description: The wallet shape each chain family expects — privateKey, secretKey, mnemonic, secret, seed, or accountId — and the WrongFamilyError you get when it's wrong.
sidebar:
  order: 3
---

## Introduction

A `PipRailClient` takes one `wallet` and one `chain`. The `chain` selector routes to a driver
family, and each family validates its own key format — so the wallet shape you pass depends on
the chain you name. Pass the wrong shape for the chain and you get a clear
[`WrongFamilyError`](/errors/error-hierarchy/) on first use, before any funds move.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { privateKey: process.env.AGENT_KEY } })
// → a PipRailClient bound to Base, ready to quote / plan / pay
```

## The shape per family

Each family accepts a primary secret-key form and (where it makes sense) a ready-built native
wallet object. The selector picks the family; the wallet must match it.

| Family | Wallet shape |
| --- | --- |
| EVM (`'base'`, `'bnb'`, … any EVM chain) | `{ privateKey }` (0x… hex) or a viem `{ walletClient }` |
| Tron | `{ privateKey }` (32-byte hex — secp256k1, like EVM) |
| Sui | `{ privateKey }` (`suiprivkey1…` bech32) or `{ keypair }` |
| Aptos | `{ privateKey }` (AIP-80 `ed25519-priv-0x…` or raw `0x…` hex) or `{ account }` |
| Solana | `{ secretKey }` (`Uint8Array` or base58 string) or `{ signer }` |
| TON | `{ mnemonic }` (24 words) or `{ keyPair }` (+ `version: 'v5r1'` for W5) |
| Algorand | `{ mnemonic }` (25 words) or `{ account }` (algosdk `{ addr, sk }`) |
| Stellar | `{ secret }` (`S…` seed) or `{ keypair }` |
| XRPL | `{ seed }` (`s…` seed) or `{ wallet }` |
| NEAR | `{ accountId, privateKey }` (privateKey = `ed25519:…` secret) |

## EVM, Tron, Sui, Aptos — `{ privateKey }`

The secp256k1 and Ed25519 families take a raw private key string. EVM and Tron both use
secp256k1 (Tron's key is the same 32-byte hex), while Sui and Aptos take their own encoded forms.

```ts
new PipRailClient({ chain: 'base', wallet: { privateKey: process.env.AGENT_KEY } })   // 0x… hex
new PipRailClient({ chain: 'tron', wallet: { privateKey: process.env.TRON_KEY } })    // 32-byte hex
new PipRailClient({ chain: 'sui', wallet: { privateKey: process.env.SUI_KEY } })      // suiprivkey1…
new PipRailClient({ chain: 'aptos', wallet: { privateKey: process.env.APTOS_KEY } })  // ed25519-priv-0x…
```

Sui also accepts a ready `{ keypair }` (an `Ed25519Keypair`); Aptos accepts a ready `{ account }`.

## Solana — `{ secretKey }`

Solana takes a `secretKey` as either a `Uint8Array` or a base58 string, or a ready `{ signer }`.

```ts
new PipRailClient({ chain: 'solana', wallet: { secretKey: process.env.SOLANA_SECRET } })  // base58
```

## TON & Algorand — `{ mnemonic }`

Both take a mnemonic — TON uses 24 words, Algorand uses 25. The mnemonic may be one
space-separated string or a `string[]`.

```ts
new PipRailClient({ chain: 'ton', wallet: { mnemonic: process.env.TON_MNEMONIC } })       // 24 words
new PipRailClient({ chain: 'algorand', wallet: { mnemonic: process.env.ALGO_MNEMONIC } }) // 25 words
```

On TON, add `version: 'v5r1'` for a W5 wallet — the default is `v4`. Algorand also accepts a
ready `{ account }` (an algosdk `{ addr, sk }`).

## Stellar & XRPL — `{ secret }` / `{ seed }`

Stellar takes a `secret` (an `S…` seed); XRPL takes a `seed` (an `s…` seed). Each also accepts
its native wallet object.

```ts
new PipRailClient({ chain: 'stellar', wallet: { secret: process.env.STELLAR_SECRET } })  // S…
new PipRailClient({ chain: 'xrpl', wallet: { seed: process.env.XRPL_SEED } })            // s…
```

Stellar accepts a ready `{ keypair }` (a stellar-sdk `Keypair`); XRPL accepts a ready
`{ wallet }` (an xrpl.js `Wallet`).

## NEAR — `{ accountId, privateKey }`

NEAR is the one family that needs two fields: the named account it signs as plus its key.
The `privateKey` is an `ed25519:…` secret.

```ts
new PipRailClient({
  chain: 'near',
  wallet: { accountId: 'agent.near', privateKey: process.env.NEAR_KEY },
})
```

## Injected browser wallet — `{ walletClient }`

On EVM you can hand the client an injected viem `walletClient` instead of a raw key — the visitor
signs with their own wallet, and no secret ever touches your page source.

```ts
import { createWalletClient, custom } from 'viem'

const walletClient = createWalletClient({ transport: custom(window.ethereum) })
const client = new PipRailClient({ chain: 'base', wallet: { walletClient } })
```

:::caution
Raw `{ privateKey }` (and the other secret-key forms) belong only in a **server's** environment —
never in code shipped to a browser, where the page source is public. In a browser, use an
injected `walletClient`.
:::

## Wrong shape → `WrongFamilyError`

The chain picks the family, and the family validates the wallet on first use. If the shape (or a
`payTo`, or a token) is given in another family's form — an `0x…` address on Solana, a `{ mint }`
token on a Stellar chain, a `{ seed }` wallet on EVM — the bind throws a typed
[`WrongFamilyError`](/errors/error-hierarchy/) (`.code === 'WRONG_FAMILY'`) rather than failing
obscurely later.

```ts
import { PipRailClient, WrongFamilyError } from '@piprail/sdk'

// chain says EVM, wallet is an XRPL seed → WrongFamilyError on first request
const client = new PipRailClient({ chain: 'base', wallet: { seed: 's…' } })

try {
  await client.fetch('https://api.example.com/report')
} catch (err) {
  if (err instanceof WrongFamilyError) {
    console.error(err.code, err.message) // → 'WRONG_FAMILY' '…an XRPL seed on an EVM chain…'
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
