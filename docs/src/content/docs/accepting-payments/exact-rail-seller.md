---
title: The exact rail (seller)
description: Opt into the ratified x402 `exact` scheme so any standard x402 client can pay your gate — self-settle with your own relayer, or delegate to a facilitator you choose.
sidebar:
  order: 7
---

## Introduction

PipRail gates default to the `onchain-proof` scheme: the client pays first, then proves it
with a tx ref your gate verifies locally. The ratified x402 `exact` scheme is the inverse —
the client signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
`transferWithAuthorization` and *someone else* broadcasts it. Opting into `exact` makes your
gate payable by **any** standard x402 client (and is the only path onto Coinbase's Bazaar
directory), while staying backendless: PipRail still hosts nothing.

You opt in by passing `exact` to [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/).
The gate then **dual-advertises**: each rail offers an `exact` entry *and* the `onchain-proof`
entry in the same 402, so a standard client picks `exact` while a PipRail client picks
`onchain-proof`. Omitting `exact` leaves the challenge byte-identical to before.

:::note
The `exact` rail is **EVM + EIP-3009 only** — that means USDC and EURC (and other EIP-3009
tokens). It does **not** cover USDT (needs Permit2), native coins, or any non-EVM chain. Those
rails stay `onchain-proof`-only, and mixing them in one gate is fine.
:::

## Mode A — self-settle with your own relayer

You hold a gas-paying **relayer** key and broadcast the authorization yourself. You pay gas to
*receive* (the inverse of `onchain-proof`, where the payer pays gas), and you keep the relayer
funded — but no third party is involved.

```ts
import { requirePayment } from '@piprail/sdk'

const gate = requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } },
})
// → Express/Connect middleware: drop it in front of a route and the route is paid-only.
//   The gate dual-advertises `exact` + `onchain-proof` in every 402.
```

The `relayer` is the gas-paying wallet that broadcasts the transfer — **distinct from `payTo`,
the receive address**. Pass an EVM `{ privateKey }`, or bring your own viem signer with
`{ walletClient }`. Self-settle uses `transferWithAuthorization` (not
`receiveWithAuthorization`), and the signature binds `to` = `payTo`, so a front-runner can only
push the same funds to the same `payTo` and waste their own gas — there is no redirect risk.

:::caution
`settle: 'self'` requires `relayer`. Omit it and the gate throws at setup. Keep the relayer
funded with native coin: if it can't broadcast, the gate returns **5xx** (a `SettlementError`,
emitted as HTTP `502`), never a 402 — the payer's signed authorization stays valid and unused,
so they can retry once you top it up.
:::

## Mode B — delegate to a facilitator

Instead of running a relayer, delegate verify + settle to a third-party x402 facilitator **you
choose** (Coinbase CDP, x402.org, PayAI, or any compatible one). No relayer key, and the
facilitator pays gas. Under the hood this is just two HTTP POSTs to the facilitator's
configured URL — PipRail hosts nothing.

:::tip[Gasless settlement with a free facilitator]
Point `facilitator` at a **free, no-auth** facilitator like **PayAI**
(`https://facilitator.payai.network`) and the whole flow is **gasless** — the buyer only
**signs** an EIP-3009 authorization (no gas), you run **no relayer key**, and PayAI
**broadcasts the transfer on Base and pays the gas**. No `authHeaders` needed.

```ts
const gate = requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } },
})
```

PipRail hosts no facilitator — it just POSTs `/verify` then `/settle` to the URL **you**
configure. This is the opt-in `exact` rail; your gate still dual-advertises `onchain-proof`
too, where the payer broadcasts and pays their own gas.
:::

```ts
const gate = requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: { facilitator: 'https://x402.org/facilitator' } },
})
```

For a facilitator that needs auth (e.g. Coinbase CDP's JWT), pass an async `authHeaders`
provider — its result is merged into every request. Omit it for the free, no-auth facilitators.

```ts
exact: {
  settle: {
    facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
    authHeaders: async () => ({ Authorization: `Bearer ${await mintCdpJwt()}` }),
  },
}
```

### How facilitator settlement works

The gate forwards the request to [`settleViaFacilitator()`](/reference/exact-lowlevel/), which
runs the x402 v2 wire contract against your chosen facilitator:

| Step | Endpoint | Outcome |
| --- | --- | --- |
| 1. Verify | `POST {url}/verify` | A cheap early reject (`isValid: false` → 402) before settling. |
| 2. Settle | `POST {url}/settle` | The facilitator broadcasts + waits; `success: false` → 402. |

Both protocol outcomes are HTTP 200 (the boolean flips). A **non-200** is a transport or auth
failure — `settleViaFacilitator` throws a `SettlementError`, and the gate replies 5xx rather
than a misleading 402. Critically, the `paymentRequirements` sent to the facilitator are always
rebuilt from the gate's **trusted rail** (`payTo` / `amount` / `asset` / `network`), never the
client's echo, so a forged payload can't redirect the settlement.

## The `ExactRailOption`

The `exact:` object you pass to `requirePayment` / `createPaymentGate` is an `ExactRailOption`,
exported from `@piprail/sdk`:

```ts
import type { ExactRailOption } from '@piprail/sdk'
```

| Field | Type | Purpose |
| --- | --- | --- |
| `settle` | `'self'` \| `{ facilitator: string; authHeaders?: () => Promise<Record<string, string>> }` | Pick the mode: your own relayer (`'self'`) or a facilitator URL you choose. |
| `relayer` | EVM `{ privateKey }` or `{ walletClient }` | **Required for `settle: 'self'`** — the gas-paying wallet that broadcasts `transferWithAuthorization`. Distinct from `payTo`. Ignored in facilitator mode. |

## Choosing a mode

| | Mode A — `settle: 'self'` | Mode B — `settle: { facilitator }` |
| --- | --- | --- |
| Who pays gas | You (relayer) | The facilitator |
| Gasless (no funded key anywhere) | No — you fund the relayer | Yes, with a free facilitator (e.g. PayAI) |
| Relayer key | Required | Not needed |
| Third party | None | The facilitator you choose |
| Bazaar listing | No | Yes |
| On a settle failure | 5xx, authorization stays valid | 5xx, authorization stays valid |

Mode A is the on-brand default — fully backendless, no third party in the loop. Reach for Mode B
when you'd rather not run a relayer, or when you specifically need the Bazaar listing.

## What the client signs (and what you verify)

The payer signs an EIP-3009 authorization off-chain and **never broadcasts** — your relayer
(Mode A) or the facilitator (Mode B) does. The buyer side is covered on
[The exact rail (buyer)](/making-payments/exact-buyer/).

In Mode A, before broadcasting, the gate verifies the inbound authorization locally against the
trusted rail: the signature must recover to the authorizer, `to` must equal `payTo`, the value
must cover the amount, the authorization must be unexpired and its on-chain nonce unused. The
EIP-712 domain is **read on-chain** from the token, never assumed — canonical USDC's domain name
is `"USD Coin"` (not `"USDC"`), and EURC's is `"Euro Coin"` on Ethereum/Avalanche but `"EURC"`
on Base, so only the on-chain read is authoritative.

:::tip
If you request `exact` but none of your offered rails can carry it (a single native-coin or
non-EVM gate), the gate throws a clear error at setup rather than silently shipping
`onchain-proof` only. Offer an EVM EIP-3009 token (USDC / EURC), or drop `exact`.
:::

## Replay protection and `onPaid`

Whichever mode you use, the EIP-3009 authorization **nonce** is replay-claimed in the gate's
used-proof set (the on-chain `authorizationState` is a second, canonical guard). Multi-instance
deploys share state through the same [`isUsed` / `markUsed`](/accepting-payments/replay-protection/)
hooks as `onchain-proof`. A settled `exact` payment fires the same
[`onPaid`](/accepting-payments/receipts-and-onpaid/) callback, with a receipt whose
`scheme` is `'exact'` and whose `transaction` is the settle tx hash.

```ts
const gate = requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } },
  onPaid: (receipt) => {
    console.log(receipt.scheme, receipt.transaction)
    // → 'exact' '0x9f…'   (the settle tx your relayer broadcast)
  },
})
```

## Low-level building blocks

These public exports back the high-level path — reach for them only when hand-rolling an
adapter. See the [low-level reference](/reference/exact-lowlevel/).

| Export | Purpose |
| --- | --- |
| `settleViaFacilitator` | Run the two-POST verify→settle contract against a facilitator (Mode B core). |
| `FacilitatorConfig` | A facilitator's base `url` + optional `authHeaders` provider. |
| `FacilitatorPaymentRequirements` | The trusted x402 `exact` requirements sent to the facilitator. |
| `SettleViaFacilitatorInput` | The full input to `settleViaFacilitator` (config + payload + receipt fields). |
| `readExactDomain` | Read a token's true on-chain EIP-712 `{ name, version }` — returns `null` if not EIP-3009. |
| `eip3009Abi` | The minimal seller-side EIP-3009 ABI. |
