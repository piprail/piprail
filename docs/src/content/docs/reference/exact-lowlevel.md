---
title: "The exact scheme low-level codec"
description: The EVM, EIP-3009 building blocks behind the standard exact rail — parse requirements, read a token's true on-chain domain, and frame an X-PAYMENT header by hand.
sidebar:
  order: 3
---

## Introduction

PipRail's gates default to `onchain-proof` (the payer pays first, proves with a tx ref, the
server verifies locally). The standard x402 `exact` scheme is a different shape — an EIP-3009
signed authorization the server settles — and PipRail interops with it in both directions.

You almost never call this module. The **high-level paths** cover the common cases: pay any
standard x402 server with [`schemes: ['exact']`](/making-payments/exact-buyer/), and get paid
over `exact` with [`createPaymentGate({ exact })`](/accepting-payments/exact-rail-seller/).
This page is the **low-level codec tier** underneath them — for hand-rolled clients, v1
servers, or custom flows. These codecs are **EVM-only** and cover the **EIP-3009** method
(canonical USDC and EURC). The `exact` scheme's other EVM method, **Permit2**, makes
ERC-20s _without_ EIP-3009 — like Binance-Peg USDC/USDT on BNB Chain — `exact`-payable too; its
mechanics and low-level exports (`PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`,
`PERMIT2_WITNESS_TYPES`) live in [Gasless payments](/making-payments/gasless-payments/). On
**Solana**, the `exact` payload is a different shape entirely — a base64 partial-signed
`TransferChecked` transaction (`ExactSvmPaymentPayload`, the `svm` method), built and verified inside
the Solana driver, not via these EVM codecs. The serialized transaction also carries a spec-required
**SPL-Memo** instruction (the rail's `extra.memo`, else a random hex nonce for uniqueness) — it lives
inside the transaction, not as a separate wire field; see [Gasless payments](/making-payments/gasless-payments/#solana--how-svm-gasless-works).
(The chain's native coin — incl. SOL — is never `exact`-payable.)

:::note
Everything here is exported from `@piprail/sdk`. The buyer/seller engines that wire these
pieces together (`payExactEvm`, `verifyAndSettleExactEvm`) are internal — reach for the
high-level paths instead of reimplementing them.
:::

## Parse a 402 challenge — `parseExactRequirements`

Given a raw x402 challenge body, pull out the `exact` rails it offers. It tolerates
`x402Version` 1 or 2 and both the `maxAmountRequired` and `amount` field names. It returns `[]`
when the body has no `exact` entries, and `null` when the body isn't a recognisable x402
challenge — so null-guard the result before you iterate it.

```ts
import { parseExactRequirements } from '@piprail/sdk'

const res = await fetch('https://api.example.com/report')
const rails = parseExactRequirements(await res.json())
// → ExactAccept[] | null

if (!rails) {
  // not a recognisable x402 challenge — nothing to pay
} else {
  for (const rail of rails) {
    console.log(rail.network, rail.maxAmountRequired, rail.asset)
  }
}
```

Each entry is an `ExactAccept` — the fields the codec consumes:

| Field | Meaning |
| --- | --- |
| `scheme` | Always `'exact'`. |
| `network` | x402 network slug (e.g. `'base'`). |
| `maxAmountRequired` | Amount in base units. |
| `asset` | The EIP-3009 token contract address. |
| `payTo` | Recipient address. |
| `maxTimeoutSeconds` | How long the authorization stays valid (defaults to `600`). |
| `extra` | The server's *claimed* EIP-712 domain `{ name, version }` — do not trust it (see below). |
| `description` / `resource` | Optional descriptive fields. |

## Resolve the chain id — `chainIdForExactNetwork`

EIP-712 signing needs the chain id, but a 402 carries only a network *slug*. `EXACT_NETWORK_SLUGS`
maps the slugs PipRail ships with EIP-3009 USDC to their chain ids; `chainIdForExactNetwork`
resolves one, returning `null` for an unknown slug.

```ts
import { chainIdForExactNetwork } from '@piprail/sdk'

chainIdForExactNetwork('base')      // → 8453
chainIdForExactNetwork('arbitrum')  // → 42161
chainIdForExactNetwork('mantle')    // → null — an EVM preset, but not in the `exact` set
```

The shipped set is `ethereum`, `base`, `arbitrum`, `optimism`, `polygon`,
`avalanche`, `bnb` (with `bsc` as an alias — both → `56`), and the EIP-3009-verified chains
`sonic`, `linea`, `celo`, `unichain`, `worldchain`, `sei`, `hyperevm`, `monad`, `zksync`,
`injective` (mainnets only — no testnet presets). (It's a reference helper, not the
gate — the `exact` rail is offered on **any** EVM chain whose token is EIP-3009 or whose chain has
the Permit2 proxy.)

## Read the token's true domain — `readExactDomain`

This is the one call you should never skip. An EIP-3009 signature is over the token's EIP-712
domain, and the domain `name` is **not** the symbol — canonical USDC's name is `"USD Coin"`,
and EURC is `"Euro Coin"` on Ethereum/Avalanche but `"EURC"` on Base. Only the on-chain read is
authoritative, so `readExactDomain` reads `name()` and `version()` directly from the contract.

```ts
import { readExactDomain } from '@piprail/sdk'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const pub = createPublicClient({ chain: base, transport: http() })
const domain = await readExactDomain(pub, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
// → { name: 'USD Coin', version: '2' }   — or null
```

It returns `null` when the asset is **not** an EIP-3009 token: it probes `authorizationState`,
which exists only on EIP-3009 tokens and reverts on a plain ERC-20 or USDT. A `null` domain is
your signal that the token isn't `exact`-payable — pay it via `onchain-proof` instead.

:::caution
Trusting the server-supplied `extra.{name, version}` instead of reading the chain is the exact
trap the deprecated `buildExactAuthorization` falls into: a lying or absent value yields a
silently-invalid signature. Re-derive the domain on-chain.
:::

## Frame the header — `encodeXPaymentHeader`

Once you hold a signed authorization, encode it into an `X-PAYMENT` header value. This emits the
**v1 flat shape** — `{ x402Version, scheme, network, payload }` base64-encoded — which is what
Coinbase's original reference emits and what every x402 gate and facilitator still accepts.
`x402Version` defaults to `1` to stay consistent with that flat shape.

```ts
import { encodeXPaymentHeader } from '@piprail/sdk'

// `authorization` + `signature` come from the signing step below.
const header = encodeXPaymentHeader({
  network: 'base',
  authorization,   // ExactAuthorization
  signature,       // Hex (0x…)
})
// → a base64 string for the `X-PAYMENT` header

const url = 'https://api.example.com/report'
await fetch(url, { headers: { 'X-PAYMENT': header } })
```

The `ExactAuthorization` it frames is the EIP-3009 message the payer signs: `from`, `to`,
`value`, `validAfter`, `validBefore` (the three numeric fields are **decimal strings** on the
wire), and a 32-byte hex `nonce`.

## The EIP-712 type set — `EIP3009_TYPES`

If you sign the authorization yourself, `EIP3009_TYPES` is the exact `TransferWithAuthorization`
type set the token expects — pass it straight to viem's `signTypedData`. The `value`,
`validAfter`, and `validBefore` fields are `uint256` in the type set but **decimal strings** on
`ExactAuthorization`, so cast them to `bigint` before signing — viem rejects a string for a
`uint256`:

```ts
import { EIP3009_TYPES, readExactDomain } from '@piprail/sdk'
import type { ExactAccept, ExactAuthorization } from '@piprail/sdk'
import type { Account, PublicClient, WalletClient } from 'viem'

declare const publicClient: PublicClient   // for the on-chain domain read
declare const walletClient: WalletClient   // your viem wallet client (signs)
declare const account: Account             // the EOA paying
declare const accept: ExactAccept          // one entry from parseExactRequirements()
declare const chainId: number              // from chainIdForExactNetwork(accept.network)
declare const authorization: ExactAuthorization

const domain = await readExactDomain(publicClient, accept.asset)
if (!domain) throw new Error('not exact-payable')

const signature = await walletClient.signTypedData({
  account,
  domain: { ...domain, chainId, verifyingContract: accept.asset },
  types: EIP3009_TYPES,
  primaryType: 'TransferWithAuthorization',
  message: {
    ...authorization,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
  },
})
// → a Hex (0x…) signature to pass to encodeXPaymentHeader / buildExactSignatureHeader
```

Pair this with `BuildExactParams` — the parameter shape (`account`, `accept`, `chainId`, `now`,
`nonce`) the deterministic test/codec primitive accepts.

:::note
The production buyer (`schemes: ['exact']`) does all of this for you, and refuses what can't
settle: it throws a typed [`UnsupportedSchemeError`](/errors/error-hierarchy/)
(`.code === 'UNSUPPORTED_SCHEME'`) when the asset isn't an EIP-3009 token (USDT, native coin, a
plain ERC-20 → `readExactDomain` is `null`) or the signer is a contract / EIP-1271 /
EIP-7702-delegated account — in every case, fall back to `onchain-proof`.
:::

## The seller ABI — `eip3009Abi`

`eip3009Abi` is the minimal EIP-3009 ABI a seller needs: both `transferWithAuthorization`
overloads (the 65-byte `(v, r, s)` form and the `(bytes signature)` ERC-1271 form), the
`authorizationState` replay check, and `name()` / `version()` for the domain. It mirrors
Circle's deployed FiatToken, so you can read or settle against any canonical USDC contract.

```ts
import { eip3009Abi } from '@piprail/sdk'
import { createPublicClient, http, type Hex } from 'viem'
import { base } from 'viem/chains'

const pub = createPublicClient({ chain: base, transport: http() })

const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'  // Base USDC
const payer = '0xYourWallet'                                 // the authorizer
const nonce = '0x…' as Hex                                   // the 32-byte authorization nonce

const used = await pub.readContract({
  address: token,
  abi: eip3009Abi,
  functionName: 'authorizationState',
  args: [payer, nonce],
})
// → boolean — true ⇒ this authorization is spent or canceled
```

## Avoid `buildExactAuthorization`

`buildExactAuthorization` builds and signs an authorization in one call, but it is
**`@deprecated`**: it trusts the server-supplied `accept.extra.{name, version}` for the EIP-712
domain (a lying or absent value produces a silently-invalid signature) and calls
`account.signTypedData` directly — which is `undefined` on a bring-your-own `JsonRpcAccount`. It
survives only as a deterministic codec building block for tests.

For real buyer flows, use [`schemes: ['exact']`](/making-payments/exact-buyer/) on the client.
It re-derives the domain on-chain with `readExactDomain`, refuses a contract / EIP-1271 /
EIP-7702-delegated signer before signing, generates a CSPRNG nonce, and signs via the wallet
client:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  schemes: ['exact'],
})

const res = await client.fetch('https://api.example.com/report')   // pays a standard exact server
const data = await res.json()
// → the gated JSON, paid for via exact transparently
```

See [Pay the exact rail (buyer)](/making-payments/exact-buyer/) and [Sell the exact rail
(seller)](/accepting-payments/exact-rail-seller/) for the high-level paths, and the [wire
codecs](/reference/wire-codecs/) for the envelope types these slot into.
