---
title: Pay any x402 server (the exact rail)
description: 'Opt the client into the standard x402 `exact` scheme so it can pay any x402 server, not just PipRail gates.'
sidebar:
  order: 8
---

## Introduction

By default a [`PipRailClient`](/making-payments/piprail-client/) pays only PipRail's native
`onchain-proof` rail — the backendless scheme where the client pays first and proves it with a
tx ref. That covers every PipRail gate, but most of the public x402 web (the dominant
`exact`-on-Base flow) speaks the ratified **`exact`** scheme instead. Opt into it and the same
client can pay *any* standard x402 server.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'exact'],   // pay PipRail rails AND standard exact rails
})
```

:::note
`schemes` defaults to `['onchain-proof']`. The zero-config path is byte-identical to before
this rail existed — `exact` is strictly opt-in.
:::

## How the exact rail differs

With `onchain-proof`, the client broadcasts the payment itself and proves it. With `exact`, the
buyer **signs with its own wallet** and *someone else* broadcasts it — the merchant's relayer, or a
merchant-chosen **facilitator** (keyless on EVM EIP-3009, Solana, and Algorand). So the buyer spends
roughly **zero gas** — only
the token funds the payment — and PipRail hosts and settles nothing. **The buyer is gasless either way:
how the merchant settles (its own relayer vs a facilitator) is the merchant's call and invisible to the
buyer.** When the merchant points settlement at a free facilitator like **PayAI**, no one runs a
gas-funded key at all — settlement is fully gasless end to end (see
[Gasless payments](/making-payments/gasless-payments/)).

| | `onchain-proof` (default) | `exact` (opt-in) |
| --- | --- | --- |
| Who broadcasts | The client | The server / facilitator |
| Buyer pays gas | Yes (native coin) | No (~0) |
| Pays which servers | PipRail gates | Any standard x402 server |
| Proof | Tx ref, verified locally | A signed EIP-3009 authorization, a Permit2 witness, a partial-signed Solana transaction, an Algorand fee-pooled ASA group, an Aptos sponsored (fee-payer) transaction, **or** a NEAR NEP-366 SignedDelegateAction |

## What exact can settle

The `exact` rail works on **EVM, Solana, Algorand, Aptos, NEAR, and the XRP Ledger**, via one of seven on-chain methods. The
402's rail names which one (`extra.assetTransferMethod`), and the client picks the matching signer
automatically:

- **`eip3009`** (EVM) — canonical USDC/EURC and other tokens exposing `transferWithAuthorization`. The
  client re-derives the token's EIP-712 domain on-chain before signing, so a lying or absent
  server-supplied domain can't produce a silently-invalid signature. Fully gasless for the buyer.
- **`permit2`** (EVM) — any ERC-20 **without** EIP-3009, most notably **Binance-Peg USDC/USDT on BNB
  Chain** (no native Circle USDC exists on BNB). The client signs a Permit2 `PermitWitnessTransferFrom`
  whose `spender` is the canonical x402ExactPermit2Proxy and whose `witness.to` binds the recipient
  (so a relayer can't redirect funds). Gasless per-payment too — **after a one-time `approve(Permit2)`**
  the SDK does lazily the first time you pay that token.
- **`svm`** (Solana) — **any** SPL token (USDC, USDT, …). The client builds the SPL `TransferChecked`
  with the merchant as the transaction **fee payer**, adds a spec-required SPL-Memo instruction (the rail's
  `extra.memo`, else a random hex nonce) for transaction uniqueness, signs only its own slot, and sends the
  partially-signed transaction; the gate co-signs as fee payer and broadcasts. No EIP-3009 equivalent,
  no proxy, no approval — gasless for the buyer regardless of token. See
  [Gasless payments](/making-payments/gasless-payments/).
- **`algorand`** (Algorand) — **any** ASA (USDCa, …). The client signs an ASA transfer at **fee 0**,
  atomically grouped with the sponsor's fee-pooling `pay`; the sponsor signs that fee txn and submits
  the group. No token feature required — gasless for the buyer regardless of token.
- **`aptos`** (Aptos) — **any** Fungible Asset (USDC, USD₮, …). The client signs a fee-payer
  (sponsored, AIP-39) `primary_fungible_store::transfer` (sender slot only); the sponsor adds the
  fee-payer signature and submits. No token feature required — gasless for the buyer regardless of token.
- **`near`** (NEAR) — **any** NEP-141 token (USDC, USDT). The client signs a NEP-366
  `SignedDelegateAction` with its **full-access** key authorizing exactly one `ft_transfer` to `payTo`
  (the exact `amount`, `deposit: 1` yoctoNEAR, fixed 30 TGas); the merchant's relayer wraps it in its
  own outer transaction, prepays the gas **and** the yocto, and submits. The buyer holds **zero
  NEAR** — gasless regardless of token. Self-settle only today (no third-party NEAR x402 facilitator
  settles yet — see [Gasless payments](/making-payments/gasless-payments/)).
- **`sequence`** (XRP Ledger) — **native XRP**. The odd one out twice over. First, the method names
  the *sequencing* strategy rather than a transfer mechanism, because the ledger has exactly one way
  to move value; `sequence` is the scheme's default and every live rail omits the field. Second, it
  is the only rail where **the payer pays the network fee** — the fee is a field inside the signed
  transaction — so there is no sponsor and the buyer needs XRP for the amount *and* the ~12 drops.
  The client signs a complete `Payment` and broadcasts nothing; the merchant submits it. The
  challenge binds through `InvoiceID = SHA-256(extra.invoiceId)`, never a memo (the scheme has
  settlers reject `Memos`). Issued currencies such as RLUSD stay on `onchain-proof` for now: they
  state a decimal amount on the wire rather than base units, and the spend policy caps in base
  units, so paying one would misprice your cap.

| Works on `exact` | Stays on `onchain-proof` |
| --- | --- |
| EVM EIP-3009 (USDC / EURC; FDUSD, USD1 & U on BNB) | The remaining non-EVM families (TON, Tron, Sui, Stellar) |
| EVM Permit2 — any ERC-20 (e.g. Binance-Peg USDC on BNB) | Most native coins (SOL, ALGO, APT, NEAR) — **but not XRP**, which IS exact-payable |
| Solana SVM — any SPL token (USDC / USDT) | XRPL **issued** currencies (RLUSD & co — decimal wire amounts) |
| Algorand ASA (USDCa) · Aptos FA (USDC / USD₮) · NEAR NEP-141 (USDC / USDT, via NEP-366 meta-tx) | A contract / EIP-1271 / EIP-7702 signer (EVM) |
| **XRPL native XRP** (the payer pays its own fee) | |

An `exact` rail is selected only when the 402 names a network **your bound chain supports** — the
client matches each offered rail against its own chain via the driver (matching the network whether
it's a CAIP-2 id or a chain slug — see [Interoperability](#interoperability-any-network-label) below)
and settles on that chain. So an EIP-3009/Permit2 rail on your bound EVM chain, or an SVM rail on
a Solana-bound client, is payable; an `exact` rail naming a different chain (or a family without an
`exact` scheme) simply isn't selected and falls back to `onchain-proof`.

## The transfer method is optional — and usually absent

`extra.assetTransferMethod` names which on-chain mechanism a rail uses, but **the scheme makes it
optional and most live rails omit it**. `scheme_exact_evm.md` is explicit:

> If no `assetTransferMethod` is specified in `PaymentRequired.extra`, clients should default to
> `"eip3009"`.

Only the *non-default* methods (`permit2`, `erc7710`) are required to name themselves, and the
Solana, Algorand, Aptos, NEAR and Hedera schemes never define the key at all — their required extra
is `feePayer`. Measured against the live CDP Bazaar catalogue (15,686 resources, 40,388 `exact`
rails, 2026-09-06): **9%** of rails carry the marker, while **78%** carry only the EIP-712 domain
(`extra.name` + `extra.version`).

So PipRail applies the spec default. A rail with no marker, an empty `extra`, or no `extra` block at
all is paid as `eip3009`, and the buyer re-derives the token's EIP-712 domain on-chain anyway — the
absent field costs nothing in safety. A rail naming a method PipRail does **not** implement (the
spec's `erc7710`) is skipped rather than signed blind, because a signature built for the wrong
mechanism would only be rejected by the merchant's facilitator.

Four helpers expose that contract if you are building a client by hand:

```ts
import {
  exactTransferMethod,          // the effective method: what the rail names, or the spec default
  isSettleableExactMethod,      // can any PipRail driver sign this rail?
  KNOWN_EXACT_TRANSFER_METHODS, // the set we implement, across all families
  DEFAULT_EXACT_TRANSFER_METHOD // 'eip3009'
} from '@piprail/sdk'

exactTransferMethod({ ...rail, extra: { name: 'USD Coin', version: '2' } }) // → 'eip3009'
exactTransferMethod({ ...rail, extra: { assetTransferMethod: 'permit2' } }) // → 'permit2'
isSettleableExactMethod({ ...rail, extra: { assetTransferMethod: 'erc7710' } }) // → false
```

:::caution
Read the method through `exactTransferMethod`, never as a bare `extra.assetTransferMethod`.
Requiring the field is a subtle way to reject most of the x402 web — PipRail shipped exactly that
bug, and [`planPayment`](/making-payments/plan-payment/) now reports the inferred method on each
option (`option.method`, e.g. `'eip3009 (default)'`) so it is visible rather than implicit.
:::

## Paying an x402 **v1** server

x402 v2 replaced v1 on the wire — the header moved `X-PAYMENT` → `PAYMENT-SIGNATURE`, the challenge
moved into a base64 `payment-required` header, `maxAmountRequired` became `amount`, and slug networks
became CAIP-2. But v1 servers are still deployed (251 of the 15,686 catalogued resources), so PipRail
follows Postel's law: **emit strict v2, accept liberal v1 and v2.**

You don't configure anything. When a server answers with a v1 body the client normalizes it, prices
it identically, and answers on the v1 wire (`X-PAYMENT`, the flat payload, and the network slug
echoed back exactly as the server wrote it, because v1 verifiers string-compare it). The two codecs
are exported for hand-built clients:

```ts
import { normalizeV1Challenge, buildV1PaymentHeader } from '@piprail/sdk'

const challenge = normalizeV1Challenge(await res.json())  // v1 body → the standard shape, or null
const header = buildV1PaymentHeader({ scheme: 'exact', network: 'base', payload })
```

## The XRP Ledger, in full

XRPL is the only `exact` family that breaks two rules the others share, so it is worth reading once
rather than discovering at runtime.

**1. The payer pays the fee — `exact` is not gasless here.** On every other family the merchant or a
facilitator broadcasts and absorbs the gas, which is why `exact` normally means "you need the token
and no native coin". On the XRP Ledger the fee is a *field inside the signed transaction* and the
ledger charges it to that transaction's own `Account`, so there is nobody else to charge. The scheme
says so outright: `extra.areFeesSponsored` **must** be `false`. You still only sign — the merchant
submits — but budget **XRP for the amount *and* the fee** (~12 drops = 0.000012 XRP). An agent
holding exactly the payment amount cannot pay an XRPL rail.

**2. The native coin IS payable — and only here.** Everywhere else `exact` is a token-only scheme and
the native coin falls back to `onchain-proof`. On XRPL an `exact` payment is simply a signed
`Payment`, and native XRP is the most natural thing to send: 863 of the 1,732 live XRPL rails are
priced in XRP.

### What PipRail signs

A `Payment` carrying only what the scheme allows, and deliberately nothing else:

| field | value |
| --- | --- |
| `Amount` | the rail's `amount`, verbatim — an **integer drops** string |
| `Destination` | the rail's `payTo` |
| `InvoiceID` | `SHA-256(extra.invoiceId)`, when the rail states one — **this is the challenge binding** |
| `SourceTag` / `DestinationTag` | copied verbatim, only when the rail states them |
| `LastLedgerSequence` | derived from the rail's own `maxTimeoutSeconds` (~4s a ledger, clamped to 5–60 ledgers) |
| `Flags` | `tfFullyCanonicalSig`, and never `tfPartialPayment` |
| `Memos`, `Paths`, `DeliverMin`, `DeliverMax`, `SendMax`, `Delegate`, `NetworkID` | **absent** — the scheme has settlers reject them |

The binding deserves a note: PipRail's `onchain-proof` XRPL path binds the challenge with a **memo**,
and the `exact` scheme *forbids* memos. The two paths therefore share no code, and the exact rail
binds through `InvoiceID` instead. `invoiceId` is present on 1,732 of 1,732 live rails, so in
practice it is always on.

### What is not supported yet, and why

**Issued currencies (RLUSD, USDC-on-XRPL) stay on `onchain-proof`.** The two XRPL asset forms use
different wire conventions — native XRP is an integer drops string (`"10000"`), an issued currency is
a **decimal** `value` (`"0.01"`). PipRail prices and spend-caps every rail in base units, so reading
an IOU's `"12"` as base units would understate a 12-RLUSD payment by a factor of 10¹⁵ and let it slip
under a policy cap while you signed the real amount. Rather than special-case that in the signer,
issued-currency rails are dropped before they can be planned. Native XRP is 863 of the 1,732 live
rails; the rest wait until decimal amounts are safe end to end.

**`assetTransferMethod: "ticketSequence"` is skipped.** The scheme allows `"sequence"` (the default,
and what every live rail means by omitting the field) or `"ticketSequence"`, which needs a Ticket
pre-minted on the payer's account. PipRail doesn't manage tickets, so such a rail is skipped at
selection rather than planned and then failed at signing. No live rail names it.

### Interop status, honestly

The rail is proven end to end on mainnet against a PipRail gate, including a rejected replay. A paid
round-trip against a **third-party** XRPL merchant has **not** yet succeeded: two live vendors refuse
our payload with `invalid_payload`, from their own pre-check — their facilitator never sees it. The
same client, envelope and header pay one of those same gateways successfully on its **Base** rail, so
the envelope is not the problem, and our transaction matches a payment that merchant has accepted
from another client on every field visible on the ledger. We think the deployed XRPL dialect has
drifted from the ratified scheme. If you hit this, it is known — not something you have misconfigured.

## Interoperability: any network label

The `exact` rail is the *standard* x402 scheme, so a PipRail client interoperates with the wider x402
ecosystem out of the box — any server or facilitator that speaks `exact`, **however it labels the
network**. Before matching a rail to your bound chain the client normalizes the rail's network, so a
402 that names the chain as a **CAIP-2 id** (`eip155:8453`) *or* a **chain slug** (`base`, `bsc`,
`polygon`) is matched and paid identically. You don't have to know, or configure, which form a given
facilitator emits — both resolve to the same chain.

This matters because facilitators in the wild are inconsistent: the same endpoint may advertise a rail
as `eip155:56` in one place and `bsc` (or `56`) in another. PipRail pays all of them. A label that
resolves to a **different** chain than the one you're bound to — or an unrecognized one — is simply not
selected, never mis-paid; the trusted EIP-712 domain (which fixes the chain id at signing time) is the
final guard regardless of the label.

When you enable both schemes, the client gathers `onchain-proof` rails first, so on a dual-rail
402 the default selection is unchanged. An `exact` rail is only ever picked when the bound
driver can actually settle it (EVM EIP-3009/Permit2, Solana SVM, the Algorand ASA rail, the Aptos FA rail, or the NEAR NEP-366 meta-tx).

To make the client *prefer* the gasless `exact` rail when a gate offers both, enable
[`autoRoute`](/making-payments/fetch-and-autoroute/) (`new PipRailClient({ …, autoRoute: true })`, or
per call `fetch(url, { autoRoute: true })`): it pays the **cheapest settleable** rail, and since the
buyer-gasless `exact` rail estimates at ~0 gas, it wins automatically. Without `autoRoute` the dual-rail
default stays `onchain-proof`; a foreign `exact`-only server is paid over `exact` either way.

## Paying

Once a scheme is enabled, paying is the same call as ever — [`fetch`/`get`/`post`](/making-payments/fetch-and-autoroute/)
handle the 402 transparently and pick the right path per rail:

```ts
const res = await client.get('https://api.example.com/report')
const data = await res.json()
// → the gated JSON, paid for via exact (or onchain-proof) transparently
```

Your spend [`policy`](/spend-controls/payment-policy/) and `onBeforePay` hook gate an `exact`
payment **before** the wallet signs anything — exactly as they gate an `onchain-proof` payment.

## Enabling it per call

You can leave the constructor on the default and flip schemes for a single request, overriding
the constructor's `schemes` for that call:

```ts
const url = 'https://api.example.com/report'
await client.fetch(url, { schemes: ['exact'] })
```

## Read-only planning sees exact too

[`planPayment()`](/making-payments/plan-payment/) and [`quote()`](/making-payments/quote/) honour
the enabled schemes. On an `exact` rail, only the **token** balance gates payability (the buyer
spends no gas), so an `INSUFFICIENT_GAS` blocker never applies and gas-basis warnings are
suppressed.

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)   // analyses exact rails when enabled
if (!plan) {
  await client.fetch(url)        // not gated — fetch it for free
} else if (plan.payable) {
  await client.fetch(url, { autoRoute: true })
} else {
  console.log(plan.fundingHint)  // one-line, human-readable: what to top up
}
```

`planPayment()` returns `null` when the URL isn't payment-gated, so null-guard it before reading
`payable`.

## When exact can't settle

If a 402 offers only an `exact` rail and the bound family can't pay it — a family without an
`exact` scheme (TON, Tron, Sui, Stellar, XRPL), the chain's native coin
(incl. SOL, ALGO, APT, NEAR), or a contract / EIP-1271 / EIP-7702 signer — the client throws
[`UnsupportedSchemeError`](/errors/error-hierarchy/) (`.code === 'UNSUPPORTED_SCHEME'`) rather
than signing something that can't settle. (A non-EIP-3009 ERC-20 is **not** in this list — it pays
via Permit2; nor is an SPL token on Solana — it pays via SVM.)

```ts
import { PipRailClient, UnsupportedSchemeError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  await client.fetch(url, { schemes: ['exact'] })
} catch (err) {
  if (err instanceof UnsupportedSchemeError) {
    // this chain/asset/signer can't pay the exact rail — fall back to onchain-proof
    console.error(err.message)
  } else {
    throw err
  }
}
```

:::caution
A common case is the reverse: a **default** (`onchain-proof`-only) client hits an `exact`-only
402 it *could* pay on its EVM chain. That throws [`NoCompatibleAcceptError`](/errors/error-hierarchy/)
with a one-line remedy — enable the rail with `schemes: ['onchain-proof', 'exact']` (or per call,
`fetch(url, { schemes: ['exact'] })`).
:::

## Failure modes worth knowing

The `exact` pay path is deliberately more conservative than the `onchain-proof` retry loop: the
buyer signs **once** and the same header is re-presented on every retry — it never re-signs a
fresh nonce.

- A **transport error or timeout** after the authorization is submitted throws
  [`PaymentTimeoutError`](/errors/error-hierarchy/) carrying the nonce as `.ref` — the facilitator
  may have already settled, so verify on-chain and **never re-pay**.
- A definitive facilitator rejection (`success: false`) throws
  [`MaxRetriesExceededError`](/errors/error-hierarchy/) — fix the cause, then re-present the
  **same** signed authorization, never a fresh one.
- A `5xx` is returned as-is: a server-side settle failure leaves your authorization valid and its
  nonce unused, so nothing is recorded as spent.

On an `exact` rail, the `.ref` carried by `PaymentTimeoutError` / `MaxRetriesExceededError` is the
authorization **nonce** — the EIP-3009 nonce (a `0x…` 32-byte value) or, on the Permit2 method, the
Permit2 nonce (a uint256). It is *not* a tx hash. Recover by checking the nonce's on-chain state
(EIP-3009 `authorizationState(from, nonce)`, or the Permit2 nonce bitmap) and re-presenting the
**same** authorization — never re-sign:

On the non-EVM `exact` rails the `.ref` is likewise the family's single-use marker, recovered
differently: **Solana** — the buyer's transaction signature (a duplicate signature is the chain's
replay guard; plus the SPL-Memo nonce when present); **Algorand** — the atomic group / transaction
id; **Aptos** — the sender's account sequence number; **NEAR** — the access-key nonce (carried as
`accountId:nonce`). The discipline is identical: verify the marker on-chain, re-present the *same*
signed payload, never re-sign and never re-pay.

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

const url = 'https://api.example.com/report'

try {
  await client.fetch(url, { schemes: ['exact'] })
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // .ref exists ONLY on these two classes — the EIP-3009 nonce on the exact rail
    console.log('recover with this authorization nonce, do NOT re-pay:', err.ref)
  } else {
    throw err
  }
}
```

:::tip
Verify against your target facilitator before production. For the MCP server, enable the rail
with `PIPRAIL_SCHEMES=onchain-proof,exact` (see [MCP configuration](/mcp/configuration/)). To get
*paid* via `exact`, see the [seller side](/accepting-payments/exact-rail-seller/); the low-level
EIP-3009 codecs live in the [reference](/reference/exact-lowlevel/).
:::
