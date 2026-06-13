---
title: The exact rail (seller)
description: Opt into the ratified x402 `exact` scheme so any standard x402 client can pay your gate — self-settle with your own relayer, or delegate to a facilitator you choose.
sidebar:
  order: 7
---

## Introduction

PipRail gates default to the `onchain-proof` scheme: the client pays first, then proves it
with a tx ref your gate verifies locally. The ratified x402 `exact` scheme is the inverse —
the client signs (an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
`transferWithAuthorization` on EVM, a partial-signed `TransferChecked` transaction on Solana) and
*someone else* broadcasts it. Opting into `exact` makes your gate payable by **any** standard
x402 client (and is the only path onto Coinbase's Bazaar directory), while staying backendless:
PipRail still hosts nothing.

You opt in by passing `exact` to [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/).
The gate then **dual-advertises**: each rail offers an `exact` entry *and* the `onchain-proof`
entry in the same 402, so a standard client picks `exact` while a PipRail client picks
`onchain-proof`. Omitting `exact` leaves the challenge byte-identical to before.

:::note
The `exact` rail covers **EVM ERC-20** and **Solana SPL** tokens, via the method the gate picks
automatically: **EIP-3009** for EVM tokens that expose `transferWithAuthorization` (USDC, EURC),
**Permit2** for any other EVM ERC-20 (e.g. **Binance-Peg USDC/USDT on BNB**), or **SVM** for any
Solana SPL token (USDC, USDT — the merchant is the transaction fee payer). It does **not** cover
native coins (incl. SOL) or families without an `exact` scheme (TON, Tron, NEAR, Sui, Aptos,
Algorand, Stellar, XRPL); those stay `onchain-proof`-only, and mixing them in one gate is fine. See
[Gasless payments](/making-payments/gasless-payments/).
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

The `relayer` is the gas-paying wallet that broadcasts the settle — **distinct from `payTo`, the
receive address**. On EVM pass `{ privateKey }` or bring your own viem signer with `{ walletClient }`;
on **Solana** pass `{ secretKey }` (a `Uint8Array` or base58 string) or `{ signer }`. It broadcasts
EIP-3009's `transferWithAuthorization` (USDC/EURC), the Permit2 proxy's `settle` (e.g. BNB), or — on
Solana — **co-signs the buyer's `TransferChecked` as the fee payer** and submits it. Either way the
signature binds the recipient (`to` / `witness.to` = `payTo`, or the recomputed recipient ATA on
Solana), so a front-runner can only push the same funds to the same `payTo` — there is no redirect risk.

:::caution[Solana: the fee payer must differ from `payTo`]
On the Solana SVM rail the relayer is the transaction **fee payer**, and a scheme MUST-rule forbids
the fee payer from appearing in any instruction — so it **must be a different key from `payTo`**. The
gate enforces this. The buyer pays zero SOL; your relayer pays only the (sub-cent) network fee. The
recipient's token account must already exist (the exact rail won't create it). **Prefer Mode B (a
facilitator) on Solana for a _fully_ gasless gate** — then neither you nor the buyer pays any SOL.
:::

:::caution
`settle: 'self'` requires `relayer`. Omit it and the gate throws at setup. Keep the relayer
funded with native coin: if it can't broadcast, the gate returns **5xx** (a `SettlementError`,
emitted as HTTP `502`), never a 402 — the payer's signed authorization stays valid and unused,
so they can retry once you top it up.
:::

## Mode B — delegate to a facilitator (EVM **and** Solana)

Instead of running a relayer, delegate verify + settle to a third-party x402 facilitator **you
choose** (Coinbase CDP, x402.org, PayAI, or any compatible one). No relayer key, and the
facilitator pays gas. Under the hood this is just two HTTP POSTs to the facilitator's
configured URL — PipRail hosts nothing. Works on **EVM and Solana**.

:::caution[A facilitator settles EIP-3009 + SVM — not Permit2]
Third-party facilitators settle the *standard* `exact` schemes: **EIP-3009** (EVM — USDC, EURC) and
**SVM** (Solana — any SPL token). They do **not** understand PipRail's **Permit2** payload (it settles
through PipRail's own `x402ExactPermit2Proxy`), so a non-EIP-3009 EVM token (e.g. Binance-Peg USDC/USDT
on BNB) **can't** go through a facilitator — it's **self-settle only** (Mode A). PipRail enforces this:
a *forced* `method: 'permit2'` with `settle: { facilitator }` throws at setup, and an *auto*-selected
Permit2 simply isn't advertised over the facilitator (that token falls back to `onchain-proof`). For a
fully-gasless facilitator gate, use an **EIP-3009** token on EVM, or **any SPL token** on Solana.
:::

:::tip[Gasless settlement with a free facilitator]
Point `facilitator` at a **free, no-auth** facilitator like **PayAI**
(`https://facilitator.payai.network`) and the whole flow is **gasless** — the buyer only **signs**
(no gas), you run **no relayer key**, and PayAI **broadcasts the transfer and pays the gas**. No
`authHeaders` needed. Works on Base/EVM **and Solana** (PayAI is Solana-first):

```ts
// EVM (Base):
requirePayment({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } } })

// Solana — fully gasless (neither buyer nor merchant pays SOL; PayAI does). The gate reads the
// facilitator's fee-payer pubkey from its GET /supported automatically (or pin it with
// `settle: { facilitator, feePayer }`). Live-proven on mainnet:
requirePayment({ chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourSolanaReceiveAddr',
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } } })
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

On **Solana**, there's also a *challenge-time* read: the gate fetches the facilitator's fee-payer
pubkey from its `GET /supported` (to advertise it so the buyer can build the transaction). If that's
unreachable, the gate **drops the `exact` rail** for that chain (serving `onchain-proof`); if it was
the only exact rail, it throws a clear error naming the cause. Pin it with `settle: { facilitator,
feePayer }` to remove the dependency entirely. The full three-failure-point breakdown — challenge-time
discovery, settle transport/auth (502), and a facilitator rejection (402) — is in
[Gasless payments → When the facilitator fails](/making-payments/gasless-payments/#when-the-facilitator-fails).

## The `ExactRailOption`

The `exact:` object you pass to `requirePayment` / `createPaymentGate` is an `ExactRailOption`,
exported from `@piprail/sdk`:

```ts
import type { ExactRailOption } from '@piprail/sdk'
```

| Field | Type | Purpose |
| --- | --- | --- |
| `settle` | `'self'` \| `{ facilitator: string; authHeaders?: () => Promise<Record<string, string>>; feePayer?: string }` | Pick the mode: your own relayer (`'self'`) or a facilitator URL you choose. `feePayer` (Solana only, optional) pins the facilitator's fee-payer pubkey instead of discovering it from `GET /supported`. |
| `relayer` | EVM `{ privateKey }` / `{ walletClient }`, or Solana `{ secretKey }` / `{ signer }` | **Required for `settle: 'self'`** — the gas-paying wallet that broadcasts the settle (EIP-3009 `transferWithAuthorization`, the Permit2 proxy `settle`, or the Solana fee-payer co-sign). Distinct from `payTo` (**must differ** on Solana). Ignored in facilitator mode. |
| `method` | `'eip3009'` \| `'permit2'` \| `'auto'` | Which EVM transfer method to advertise. `'auto'` (default) uses EIP-3009 when the token supports it, else Permit2 (so BNB's Binance-Peg USDC "just works"). Pin one to force it. **Ignored on Solana** (always SVM). **`'permit2'` requires `settle: 'self'`** — a third-party facilitator can't settle Permit2 (see the Mode B caution above). |

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

The payer signs off-chain (an EIP-3009 authorization, a Permit2 witness transfer, or — on Solana — a
partial-signed `TransferChecked` transaction) and **never broadcasts** — your relayer (Mode A) or the
facilitator (Mode B) does. The buyer side is covered on [The exact rail (buyer)](/making-payments/exact-buyer/).

In Mode A, before broadcasting, the gate verifies the inbound payment locally against the trusted
rail: the signature must recover to the authorizer, the recipient must equal `payTo`, the value must
cover the amount, and it must be unexpired with its nonce unused. On **EIP-3009** the EIP-712 domain is
**read on-chain** from the token, never assumed — canonical USDC's domain name is `"USD Coin"` (not
`"USDC"`), and EURC's is `"Euro Coin"` on Ethereum/Avalanche but `"EURC"` on Base, so only the on-chain
read is authoritative. On **Permit2** the same checks apply (`witness.to` = `payTo`, `permitted.amount`
≥ the price, the Permit2 nonce unused, `spender` = the canonical x402ExactPermit2Proxy). On **Solana
(SVM)** the gate re-derives the recipient ATA from `payTo`, requires the `TransferChecked` mint + amount
to match, enforces the fee-payer safety rules (the fee payer in no instruction, never a program, never
drained), checks the buyer's signature via a `sigVerify` simulation, then co-signs as fee payer and
broadcasts.

:::tip
If you request `exact` but none of your offered rails can carry it (a single native-coin gate, or a
family without an `exact` scheme), the gate throws a clear error at setup rather than silently shipping
`onchain-proof` only. Offer an EVM ERC-20 (EIP-3009 USDC/EURC, or any token via Permit2) or a Solana
SPL token, or drop `exact`.
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
