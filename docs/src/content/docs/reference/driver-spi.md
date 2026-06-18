---
title: "Driver SPI — bring your own family"
description: The PaymentDriver contract and registerDriver(), so you can teach PipRail a new chain family without touching the protocol layer.
sidebar:
  order: 4
---

## Introduction

PipRail's protocol layer — `requirePayment`, `createPaymentGate`, `PipRailClient`, the wire
codecs — depends on **one interface** and nothing else: the `PaymentDriver` contract in
`drivers/types.ts`. It never imports `viem`, `@solana/web3.js`, or any chain library directly.
That seam is public. You can implement the contract for a chain PipRail doesn't ship and register
it at runtime, and every protocol feature — gating, paying, planning, the agent tools — works
against it unchanged.

This is the advanced escape hatch. For built-in chains you never touch it; see
[Payment-driver architecture](/concepts/payment-driver-architecture/) for how the shipped
families use the same contract.

:::caution
This is the lowest-level public surface in the SDK. A driver moves real funds and verifies real
proofs — get the [proof-binding](/concepts/proof-binding/) and
[error](/errors/error-model/) contracts right before you ship one. The built-in drivers under
`drivers/<family>/` are the reference implementation; mirror them.
:::

## Registering a driver

A `PaymentDriver` is stateless: a `family` tag plus a `resolve()` that recognises a chain
selector and binds it to one concrete network. `registerDriver()` adds it to the registry.

```ts
import { registerDriver, type PaymentDriver } from '@piprail/sdk'

const myDriver: PaymentDriver = {
  family: 'evm',                       // a ChainFamily tag
  resolve(opts) {
    if (!recognise(opts.chain)) return null   // let another driver try
    return bindNetwork(opts)                  // a ResolvedNetwork
  },
}

registerDriver(myDriver)
```

`resolve()` returns `null` when it doesn't recognise the selector, so the registry can fall
through to another driver. Returning a `ResolvedNetwork` claims it.

```ts
interface PaymentDriver {
  readonly family: ChainFamily
  resolve(opts: ResolveOptions): ResolvedNetwork | null
}

interface ResolveOptions {
  chain: unknown    // the developer-supplied `chain` selector
  rpcUrl?: string
}
```

:::note
`ChainFamily` is a **closed union** of the families the SDK ships (`'evm' | 'solana' | 'ton' |
'stellar' | 'xrpl' | 'tron' | 'sui' | 'near' | 'aptos' | 'algorand'`). A custom driver tags
itself with one of those values. To add a genuinely new family name, the SPI is in-source — you
extend the union in `drivers/types.ts` and wire a lazy loader in `drivers/index.ts`, following
the [add-a-chain procedure](/concepts/chains-and-tokens/).
:::

## The ResolvedNetwork contract

`resolve()` hands back a `ResolvedNetwork` — a driver bound to one network, carrying its
`family` and resolved CAIP-2 `network` id. This is the full surface the gate and client call.
Each method's **error behaviour is fixed** by the [error standard](/errors/error-model/):
resolution methods throw typed `PipRailError`s; `verify` *returns* a result and never throws on a
transient RPC read.

| Method | Side | What it does |
| --- | --- | --- |
| `supports(network)` | both | Does this bound network handle that CAIP-2 string? |
| `resolveToken(token)` | both | Turn a `TokenInput` into a `ResolvedToken`. |
| `describeAsset(asset)` | both | The SDK's *own* trusted decimals/symbol for a known asset, or `null`. Pure, no RPC. |
| `assertValidPayTo(payTo)` | both | Throw if `payTo` is invalid for this family. (A general family-validity check; called server-side today.) |
| `bindWallet(wallet)` | payer | Validate + wrap the user's wallet into a `WalletHandle`. |
| `send(wallet, accept)` | payer | Broadcast payment; resolve to the proof ref (tx hash / signature). |
| `confirm(ref, minConfirmations)` | payer | Wait until `ref` reaches confirmations; resolve a `ConfirmInfo`. |
| `estimateCost(accept, opts?)` | payer | Best-effort gas estimate in the native coin. Never throws. |
| `balanceOf(wallet, asset)` | payer | The bound wallet's token + native balance. Never throws. |
| `recipientReady(payTo, asset)` | payer | Can `payTo` receive yet? The chain's one-time prerequisite. Never throws. |
| `verify(ref, accept)` | server | Verify `ref` satisfies `accept`, RPC-only, in-process. **Returns** a `VerifyResult`. |

The three required reads on the payer side — `estimateCost`, `balanceOf`, `recipientReady` — plus
the server-side `verify` are what power [`planPayment()`](/making-payments/plan-payment/),
[`estimateCost()`](/making-payments/estimate-cost/), and local
[verification](/accepting-payments/verifying-payments/). A new contract method is implemented in
**all** families, never just one.

### `verify` returns, it never throws

`verify` is the heart of the server side. It re-derives every checked field from the trusted
`accept` — never the client-supplied ref — and returns a discriminated `VerifyResult`. A
transient RPC read is **not** an error: it comes back as a `tx_not_found`
[`VerifyErrorCode`](/errors/verify-error-code/), so a momentary hiccup reads as "not yet", not a
forgery.

```ts
async verify(ref, accept): Promise<VerifyResult> {
  // re-derive payTo / amount / asset from `accept`, read the chain, match
  // return { ok: true, receipt }
  //      | { ok: false, error: 'amount_too_low', detail: 'paid 0.05, required 0.10' }
  // → on a `{ ok: false }` result `detail` is REQUIRED (a human-readable string);
  //   `error` must be a VerifyErrorCode member (e.g. 'amount_too_low', 'wrong_recipient',
  //   'transfer_not_found', 'tx_not_found') — see /errors/verify-error-code/.
}
```

### Never-throw reads — `null` over a false `0`

`estimateCost`, `balanceOf`, and `recipientReady` are payer-side, informational, and never
throw. When a read is unavailable they degrade truthfully rather than guessing:

- `balanceOf` returns `{ token, native }` in base units, with a field `null` (unknown) when its
  read failed — **never `0`**, which would falsely read "broke".
- `estimateCost` falls back to a `'heuristic'` constant (vs `'estimated'` from a live read).
- `recipientReady` returns `{ ready: 'unknown' }` on a transient probe failure.

```ts
interface WalletBalance {
  token: bigint | null   // payment-token balance, base units, or null if unreadable
  native: bigint | null  // native gas-coin balance; equals `token` when asset is 'native'
}
```

## Token shapes

`resolveToken(token)` accepts a `TokenInput` — `'native'`, a symbol string (`'USDC'`), or a
per-family token object — and returns a uniform `ResolvedToken`:

```ts
interface ResolvedToken {
  asset: string      // 0x… | base58 mint | 'native'
  decimals: number
  symbol?: string
}
```

Each family declares its own object shape for a token-by-identifier. A driver accepts the shape
that matches its family:

| Family | Shape | Key fields |
| --- | --- | --- |
| EVM | `EvmToken` | `address: 0x…`, `decimals` |
| Solana | `SolanaToken` | `mint`, `decimals` |
| TON | `TonToken` | `master`, `decimals` |
| Stellar | `StellarToken` | `issuer`, `code`, `decimals` |
| XRPL | `XrplToken` | `issuer`, `currencyHex`, `decimals` |
| Tron | `TronToken` | `address` (Base58 `T…`), `decimals` |
| Sui | `SuiToken` | `coinType` (`package::module::TYPE`), `decimals` |
| NEAR | `NearToken` | `contractId`, `decimals` |
| Aptos | `AptosToken` | `metadata` (object address), `decimals` |
| Algorand | `AlgorandToken` | `assetId` (numeric), `decimals` |

`describeAsset(asset)` is the inverse for *known* assets: a pure, synchronous lookup of the SDK's
own decimals/symbol, used to enforce the spend budget against a token's true decimals (so a
server can't understate a price by lying about `extra.decimals`) and to flag symbol mismatches.
It returns `null` for an asset the SDK can't safely price.

## The cost estimate

`estimateCost(accept, opts?)` returns a `CostEstimate` denominated in the chain's **native**
coin — the gas token, distinct from the payment token (you pay in USDC but burn ETH / SOL / TRX
for gas). `opts.from` (the payer address) sharpens fees that depend on the sender, notably Tron
energy; omit it for a typical estimate.

```ts
interface CostEstimate {
  feeSymbol: string       // 'ETH' | 'SOL' | 'TRX' | …
  feeDecimals: number     // 18 EVM, 9 Solana/TON, 7 Stellar, 6 XRPL/Tron
  fee: string             // native base units, non-negative integer string
  feeFormatted: string    // '0.000021'
  basis: 'estimated' | 'heuristic'
  detail?: string         // 'gas ~21000 @ 12 gwei'
}
```

Build it with the shared `nativeCost()` helper so every family's shape stays identical. A
standard `exact` rail estimates the *buyer's* gas as ~0 — the server or facilitator broadcasts
the signed authorization.

## Recipient readiness

`recipientReady(payTo, asset)` reports the chain's **one-time receive prerequisite** — the thing
a recipient must do before it can hold an asset. Families with no prerequisite (EVM, Solana,
TON, Tron, Sui, Aptos, and every native coin) report `ready: 'n/a'`.

```ts
async recipientReady(payTo, asset):
  Promise<{ ready: boolean | 'n/a' | 'unknown'; reason?: RecipientReason }>
```

When a prerequisite is missing, return `{ ready: false, reason }` so the planner tells the agent
to fix the **recipient**, not its own balance:

| `RecipientReason` | Family | Meaning |
| --- | --- | --- |
| `NO_TRUSTLINE` | Stellar / XRPL | The account holds no trustline for this asset. |
| `NOT_REGISTERED` | NEAR | `payTo` isn't `storage_deposit`-registered on the NEP-141 token. |
| `NOT_OPTED_IN` | Algorand | `payTo` hasn't opted into the ASA. |
| `INACTIVE` | Stellar / XRPL | The account doesn't exist / isn't reserve-funded yet. |

## Optional methods

Several methods carry an optional `?`. Because they're optional, omitting one leaves today's
behaviour and **does not** trigger the "implement in all families" rule for required methods — a
family ships them only when its chain supports them. The `exact`-rail methods are implemented by
**EVM**, **Solana**, **Algorand**, **Aptos**, and **NEAR** today; `exactDomain` / `exactPermit2Supported` are EVM-specific.

| Method | Purpose |
| --- | --- |
| `resolveExactRail(input)` | Server side. Resolve the chain-specific `exact` rail descriptor for an asset — `{ method, extra }` (EVM `eip3009`/`permit2` + EIP-712 `name`/`version`; Solana `svm` + `feePayer`/`tokenProgram`; Algorand `algorand` + `feePayer`; Aptos `aptos` + `feePayer`; NEAR `near` + `feePayer`), or `null` when the asset/chain can't carry `exact`. This is what keeps `server.ts` family-agnostic — it never names a family, it just merges the returned `extra` into the rail. |
| `payExact(wallet, accept)` | Buyer side. Sign the `exact` payment so a PipRail agent can pay **any** standard x402 `exact` server: an EIP-3009 `transferWithAuthorization` (EVM), a partial-signed `TransferChecked` transaction (Solana), a sender-signed fee-payer (sponsored) transfer (Algorand, Aptos), or a NEP-366 `SignedDelegateAction` wrapping one NEP-141 `ft_transfer` that a relayer prepays gas (+ 1 yocto) and submits (NEAR). Omitting it means no `exact` rail is ever gathered/paid on that family. |
| `settleExactSelf(input)` | Server side (Mode A). Verify a standard `exact` payment locally, then self-settle by broadcasting from the merchant's relayer wallet (EVM: `transferWithAuthorization` / the Permit2 proxy; Solana: co-sign as fee payer; Algorand / Aptos: add the fee-payer signature and submit; NEAR: relay the buyer's `SignedDelegateAction` via the merchant's relayer, which prepays gas + the 1 yocto so the buyer stays gasless). |
| `exactDomain(asset)` | Server side (**EVM**). Read an EIP-3009 token's on-chain EIP-712 domain (`name`/`version`); `null` when the asset isn't EIP-3009. |
| `exactPermit2Supported()` | Server side (**EVM**). Whether the x402 Permit2 proxy is deployed on this chain (gates the Permit2 fallback). |
| `discoverySigner(wallet)` | A signer for **discovery only** (ownership proofs / SIWX index registration), never the payment path. |

The `exact` methods are covered for buyers under [paying an exact
rail](/making-payments/exact-buyer/), for sellers under [selling an exact
rail](/accepting-payments/exact-rail-seller/), and at the wire level on the
[low-level exact](/reference/exact-lowlevel/) page. `resolveExactRail` lets a new family add `exact`
support without touching the chain-agnostic protocol layer.

### The discovery signer

`discoverySigner(wallet)` returns the bound wallet's public address plus a message signer used
**only** for [open-index registration](/discovery/discover-and-register/) and ownership proofs —
never to move funds. It returns `null` if the bound wallet can't sign. A family ships it only
once an open index verifies its signatures (EVM today).

```ts
interface DiscoverySigner {
  address: string
  signMessage(message: string): Promise<string>   // EVM: eip191 hex
}
```

## The WalletHandle

`bindWallet(wallet)` validates the user's wallet config and wraps it in an opaque
`WalletHandle`. The single intentional `unknown` in the contract is `_native`: each driver
stashes its own wallet object there, and only that driver reads it back out in `send` /
`balanceOf` / `discoverySigner`.

```ts
interface WalletHandle {
  readonly _native: unknown   // your driver's own wallet object lives here
}
```

`confirm` resolves a minimal `ConfirmInfo` — a numeric-agnostic `height` string (block number on
EVM, slot on Solana) — so the protocol layer never assumes a chain's height type.

```ts
interface ConfirmInfo {
  height: string
}
```

:::tip
A fake `ResolvedNetwork` is also the canonical way the SDK's own flow tests exercise the protocol
layer without a chain: register a stub driver, stub `globalThis.fetch`, and assert behaviour
deterministically. See [mocking](/testing/mocking/) for the pattern.
:::
