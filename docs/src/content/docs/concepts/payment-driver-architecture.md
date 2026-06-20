---
title: "The PaymentDriver architecture"
description: How PipRail keeps the protocol layer chain-agnostic — one driver contract, one folder per chain family, and lazy auto-mount so pure-EVM installs stay clean.
sidebar:
  order: 2
---

## Introduction

PipRail supports many chains through one parameter — `chain: 'base' | 'solana' | …` — without
shipping an allowlist. The trick is a plug-in design: the protocol layer knows nothing about any
chain, and each chain family is a self-contained driver behind a single contract. This page is
the map of that design, so you know where everything lives before you read a chain page or
[add a family](/reference/driver-spi/).

## The layering

There are three layers, and they only ever depend downward:

```
protocol layer   index · server · client · x402 · policy · ledger · agent · discovery
   (chain-agnostic — ZERO viem / @solana / @ton / … imports)
        │  depends only on …
        ▼
driver contract  drivers/types.ts  (PaymentDriver / ResolvedNetwork)
        ▲  implemented by …
chain drivers    drivers/<family>/  chains · wallet · pay · verify · index
```

The protocol layer — `server.ts` ([requirePayment / createPaymentGate](/accepting-payments/require-payment-and-gate/)),
`client.ts` ([PipRailClient](/making-payments/piprail-client/)), and `x402.ts` (the
[wire envelopes](/reference/wire-codecs/)) — imports **only** `drivers/types.ts` and pure utils.
It contains zero `viem` and zero `@solana/web3.js`. A chain library is reached exclusively through
a driver.

:::note
This is enforced, not aspirational. The build's lazy-chunk invariant greps the compiled EVM bundle
and fails if any non-EVM chain import appears; a second grep asserts the chain-agnostic modules
never import `viem`. See `sdk/STANDARDS.md` §6.
:::

## The contract — `PaymentDriver` and `ResolvedNetwork`

A `PaymentDriver` is tiny and stateless. The registry hands it the developer's `chain` selector,
and it either binds a concrete network or declines:

```ts
interface PaymentDriver {
  readonly family: ChainFamily
  resolve(opts: ResolveOptions): ResolvedNetwork | null  // null → let another try
}
```

The real surface is the `ResolvedNetwork` it returns — a driver bound to one network. The protocol
layer calls only these methods, identical across every family:

| Method | Side | What it does |
| --- | --- | --- |
| `resolveToken` | both | Turn a `TokenInput` into a `ResolvedToken` — `{ asset, decimals, symbol? }` for this network. |
| `describeAsset` | both | The inverse for known assets — a resolved on-chain `asset` id back to its trusted `{ symbol?, decimals }`, or `null` when the SDK doesn't recognise it. |
| `assertValidPayTo` | both | Throw if `payTo` isn't valid for this family. |
| `bindWallet` / `send` / `confirm` | agent | Wrap a wallet, broadcast a payment, wait for confirmations. |
| `estimateCost` | agent | Best-effort gas in the native coin. Powers [`estimateCost()`](/making-payments/estimate-cost/). |
| `balanceOf` / `recipientReady` | agent | Read-only affordability + receive-readiness. Powers [`planPayment()`](/making-payments/plan-payment/). |
| `verify` | server | Verify a proof against `accept`, RPC-only, in-process. |

Identifiers cross this boundary as plain strings — CAIP-2 networks, base-unit amounts,
`0x…`/base58 addresses — so the protocol layer never touches a chain-native type. The one
intentional `unknown` is `WalletHandle._native`, where each driver stashes its own wallet object.

:::note
The contract pins each method's error behaviour. `resolveToken` / `bindWallet` throw typed
`PipRailError`s; `send` maps affordability to `InsufficientFundsError`; `verify` **returns** a
[`VerifyResult`](/errors/verify-error-code/) and never throws for an RPC hiccup. Full rules:
[the error model](/errors/error-model/).
:::

## Optional methods

A handful of contract methods are optional (`?`) and gate advanced rails per family. Omitting one
means that family simply doesn't offer the feature — the protocol layer skips it.

| Method | Available | Enables |
| --- | --- | --- |
| `resolveExactRail` / `settleExactSelf` / `payExact` | EVM + Solana + Algorand + Aptos + NEAR | Advertising, buying, and selling a standard [`exact` rail](/accepting-payments/exact-rail-seller/) (EVM EIP-3009/Permit2; Solana SVM; Algorand / Aptos fee-payer sponsored tx; NEAR NEP-366 SignedDelegateAction relayed by a fee-payer). |
| `resolveUptoRail` / `payUpto` / `settleUptoSelf` | EVM-Permit2 only | Advertising, buying, and selling a standard metered [`upto` rail](/accepting-payments/upto-rail-seller/) — the buyer signs a max, the merchant self-settles the actual via a Permit2 witness transfer. |
| `signReceipt` | EVM only | Tier-2 service-delivery attestation — sign the official x402 `offer-receipt` EIP-712 message so a buyer can [verify the resource was served](/making-payments/verifying-receipts/). |
| `exactDomain` / `exactPermit2Supported` | EVM only | The EVM method-selection (EIP-3009 vs Permit2). |
| `discoverySigner` | EVM today | SIWX [registration](/discovery/discover-and-register/) on open indexes. |

Because these are optional, adding one to a family does not trigger the "implement in all families"
rule that required methods carry. `resolveExactRail` is the seam that lets a family add `exact`
support (Solana was added this way) without the chain-agnostic protocol layer learning a new family.

## One folder per family

Each chain family is a self-contained driver under `drivers/<family>/`, and the families **mirror
each other file-for-file**:

```
drivers/evm/  solana/  ton/  stellar/  xrpl/  tron/  near/  sui/  aptos/  algorand/
              chains · wallet · pay · verify · index   (in every folder)
```

Functions are family-suffixed — `payEvm` / `paySolana`, `verifyEvm` / `verifyStellar` — so the
symmetry is visible at a glance. Adding a contract method means implementing it in all families.

The current set lives in `ChainFamily`:

```ts
type ChainFamily =
  | 'evm' | 'solana' | 'ton' | 'stellar' | 'xrpl'
  | 'tron' | 'sui' | 'near' | 'aptos' | 'algorand'
```

## Routing — `registry.ts`

`registry.ts` is the only place the families meet. `familyForChain(chain)` is pure and
synchronous: it reads the `chain` value and decides a family — string prefixes (`'solana'`,
`'stellar'`, …) route to non-EVM families, and everything else (a name, a viem `Chain`, or
`{ id, rpcUrl }`) is EVM.

```ts
familyForChain('base')            // 'evm'
familyForChain('solana')          // 'solana'
familyForChain({ id: 8453 })      // 'evm'
```

`resolveNetwork(opts)` then looks up the registered driver for that family and asks it to bind the
network. Drivers register themselves with `registerDriver(driver)` — the registry never imports a
driver itself.

## Lazy auto-mount — `index.ts`

EVM is registered eagerly because `viem` is a hard peer dependency that's always present. Every
other family loads **itself** the first time you name its chain — there is no `enableSolana()`
step. Naming `chain: 'solana'` just works, exactly like `chain: 'base'`:

```ts
// mounts the Solana driver on first use — no enableSolana() needed
requirePayment({ chain: 'solana', token: 'USDC', amount: '0.10', payTo: 'YourSolanaAddr' })
```

`drivers/index.ts` holds a loader map keyed by family. Each loader does one dynamic `import()` — a
separate code-split chunk — then calls `registerDriver`. So a pure-EVM consumer never pulls in
`@solana/web3.js`; it loads only when a Solana chain is actually used. The async `resolveNetwork`
that the gate and client use calls `ensureDriver(family)` first, which auto-imports and caches.

:::tip
If a non-EVM family's optional peer packages aren't installed, the loader throws a clear
`MissingDriverError` naming the exact `npm install` to run — e.g. `@ton/ton @ton/core @ton/crypto`
for TON. See [wallets by family](/making-payments/wallets-by-family/) for each family's deps.
:::

## Adding a family

Adding a chain family is a fixed shape, and the registry is built for it:

1. Implement the `PaymentDriver` + `ResolvedNetwork` contract under `drivers/<family>/`, mirroring
   the `chains · wallet · pay · verify · index` files.
2. Add one entry to the loader map in `drivers/index.ts` — its dynamic `import()` + `registerDriver`.

That's the whole wiring. The protocol layer needs no change, because it only ever spoke to the
contract. The full procedure — verifying token addresses on-chain, the test contract, and shipping
the logo on piprail.com — is the [Driver SPI](/reference/driver-spi/) reference.
