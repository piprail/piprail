---
title: "Accept USDC payments on Aptos"
description: Accept and pay USDC, USD₮, or native APT on Aptos, the only Move L1 with both Circle-native USDC and Tether-native USD₮, and no receiver setup.
sidebar:
  label: Aptos
  order: 7
---

## Introduction

Aptos is a Move L1 with sub-second finality. PipRail treats it like any other family: name the
chain, name a token, add a wallet. The same `requirePayment` / `PipRailClient` calls you use on
EVM work here. Only the wallet shape and the token model differ.

Aptos is the **only Move L1 with both** Circle-native **USDC** and Tether-native **USD₮** built
in. Modern Aptos assets are **Fungible Assets (FA)**, identified by a metadata **object address**
(a `0x…` address), not a legacy `Coin<T>` type.

## Install the peer dependency

The Aptos driver depends on `@aptos-labs/ts-sdk`, an **optional peer**. It is lazy-loaded on first
use, so a pure-EVM install never downloads it. But if you name `chain: 'aptos'` you must have it
installed:

```bash
npm install @aptos-labs/ts-sdk
```

## Accept a payment

Charge in USDC, USD₮, or native APT. The SDK fills in the FA metadata address and decimals from
the built-in preset, so you never paste a token address:

```ts
import { requirePayment } from '@piprail/sdk'

app.get(
  '/report',
  requirePayment({ chain: 'aptos', token: 'USDC', amount: '0.10', payTo: '0x…' }),
  (req, res) => res.json({ report: 'unlocked' }),
)
```

`payTo` is an Aptos `0x…` (32-byte) address. `token: 'native'` pays in APT (8 decimals, octas).
Native APT transfers move APT's paired FA, so they emit the same
`0x1::fungible_asset::Deposit` event the stablecoins do, so one pay/verify path covers native +
USDC + USD₮.

## Pay a 402

On the buyer side, build a [`PipRailClient`](/making-payments/piprail-client/) with an Aptos
wallet and `fetch` the URL. The client answers the 402 challenge and pays automatically:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'aptos',
  wallet: { key: process.env.AGENT_KEY! }, // ed25519-priv-0x… or a raw 0x… 32-byte hex key
})

const url = 'https://api.example.com/report'
const res = await client.fetch(url)
// → a normal Response: paid, settled, and unlocked
const report = await res.json()
```

## Wallet shape

An Aptos wallet is `{ key }`: an **AIP-80** `ed25519-priv-0x…` secret, or a raw `0x…`
32-byte hex key. If you built one yourself, pass a ready `{ account }` (an
`@aptos-labs/ts-sdk` `Account`) instead:

| Field | Type | Notes |
| --- | --- | --- |
| `key` | `string` | An AIP-80 `ed25519-priv-0x…` secret, or a raw `0x…` hex key. |
| `account` | `Account` | A ready `@aptos-labs/ts-sdk` `Account`, if you built it yourself. |

```ts
import { Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk'

const wallet = {
  account: Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(process.env.AGENT_KEY!),
  }),
}
```

See [wallets by family](/making-payments/wallets-by-family/) for every family's wallet shape.

:::caution
`key` is shared by name with EVM/Tron/Sui, but `chain: 'aptos'` routes here and the value
is validated as an `Ed25519PrivateKey`. An EVM `0x…` key is the wrong length and surfaces a clear
`WrongFamilyError`; another family's wallet shape (`accountId`, a viem `walletClient`, a `keypair`,
…) is rejected the same way.
:::

## Tokens

| `token` | What it is |
| --- | --- |
| `'USDC'` | Circle-native USDC. FA metadata + 6 decimals verified on-chain before shipping. |
| `'USDT'` | Tether-native USD₮. FA metadata + 6 decimals (on-chain `0x1::fungible_asset::Metadata` reads symbol `USDt`). |
| `'native'` | APT, 8 decimals (octas). |
| `{ metadata, decimals }` | Any other Fungible Asset, by its metadata object address. No allowlist. |

For a custom FA, pass the **metadata** object address, not the issuer/creator address:

```ts
requirePayment({
  chain: 'aptos',
  token: { metadata: '0x…', decimals: 6 },
  amount: '0.10',
  payTo: '0x…',
})
```

## Receiver setup: none

Aptos needs no one-time receiver setup. Any valid Aptos address can receive: the recipient's
**primary FA store auto-creates** on first deposit. The sender just needs APT for gas. You will
not see [`RecipientNotReadyError`](/errors/error-hierarchy/) on Aptos.

## Planning a payment before you spend

[`planPayment(url)`](/making-payments/plan-payment/) reads balances, gas, and recipient readiness
on-chain and tells you whether a rail is settleable, without paying and without throwing. On
Aptos "I hold USDC but no APT for gas" surfaces as an `INSUFFICIENT_GAS` blocker rather than a
failed broadcast. It returns `PaymentPlan | null` (`null` when the URL isn't payment-gated), so
null-guard the result first:

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)

if (!plan) {
  await client.fetch(url) // not payment-gated, so fetch it for free
} else if (plan.payable) {
  await client.fetch(url) // safe, we checked
} else {
  console.log(plan.fundingHint) // one human-readable line: what to top up (APT gas, or the token)
}
```

See [planPayment()](/making-payments/plan-payment/) for the full `PaymentPlan` shape.

## When a payment can't go through

Affordability always converges on one typed
[`InsufficientFundsError`](/errors/error-hierarchy/) (`.code === 'INSUFFICIENT_FUNDS'`), whether
you're short on the **token** or short on **APT for gas**. On Aptos the gas-token shortfall is the
headline trap: you hold USDC but no APT to send it. Catch it and read the `.code`:

```ts
import { PipRailError } from '@piprail/sdk'

const url = 'https://api.example.com/report'
try {
  const res = await client.fetch(url)
  const report = await res.json()
} catch (err) {
  if (err instanceof PipRailError && err.code === 'INSUFFICIENT_FUNDS') {
    // out of USDC, or out of APT for gas. Fund the payer and retry
    console.error('Payer is short:', err.message)
  } else {
    throw err
  }
}
```

:::tip
To tell a **gas** shortfall (no APT) apart from a **token** shortfall (no USDC) *before* you
spend, call [`planPayment()`](/making-payments/plan-payment/): it distinguishes the two as
`INSUFFICIENT_GAS` vs `INSUFFICIENT_TOKEN` blockers, with a `shortfall` and a `fundingHint`.
:::

## Gasless: the `exact` rail (the buyer pays zero APT)

Beyond `onchain-proof`, Aptos supports the ratified x402 **`exact` rail** (opt-in), and it's **gasless
for the buyer**. Aptos has native **fee-payer (sponsored) transactions** (AIP-39): the buyer signs a
`0x1::primary_fungible_store::transfer` to `payTo` with the gas sponsor (`feePayer`) set, signing **only
the sender slot**, spending **zero APT**. The sponsor, either your own relayer or a keyless facilitator,
adds the fee-payer signature and submits, paying the sub-cent gas. The buyer holds only the FA (USDC / USD₮):

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({
  chain: 'aptos', token: 'USDC', amount: '0.10', payTo: '0x…',
  exact: { settle: 'self', relayer: { key: process.env.APTOS_RELAYER_KEY! } }, // pays the gas to receive
})
```

It's **one-shot**: the buyer needs only the advertised `feePayer` (no gas-station round-trip). Like
Algorand, the relayer **may be `payTo` itself** (the fee-payer signature is separate from the transfer, so there is
no isolation rule), so a single merchant account can self-settle. **Any Fungible Asset is gasless
equally** (USDC and USD₮ alike, with no EVM-style EIP-3009 token requirement). Native **APT** isn't
exact-payable and stays on `onchain-proof`. **Live-proven on Aptos mainnet.** Full mechanism: [Gasless
payments → Aptos](/making-payments/gasless-payments/#aptos-how-sponsored-tx-gasless-works).

Because your relayer co-signs a buyer-built transaction as the gas sponsor, the gate **caps the gas**
the sponsor will pay before signing (`MAX_GAS_AMOUNT_CAP` = 100 000 units, `MAX_GAS_UNIT_PRICE_CAP` =
2 000 octas/unit, so ≤ 2.0 APT worst case, i.e. 100 000 × 2 000 = 200 000 000 octas). A buyer can't inflate `max_gas_amount × gas_unit_price` to
drain it. See [sponsor protection](/making-payments/gasless-payments/#sponsor-protection-the-fee-drain-guard).

:::note[`exact: true` on Aptos]
Aptos has **no keyless x402 facilitator on mainnet** yet, so `exact: true` (the auto-pick-a-facilitator
shorthand) **degrades gracefully** to `onchain-proof` there. Use **self-settle** (above) for gasless
Aptos today; it's proven on mainnet.
:::

## Proof binding: Template B (digest-bound)

Aptos uses **Template B**, like Sui, EVM, and Solana: the proof ref is the **transaction hash**.
[`verify()`](/accepting-payments/verifying-payments/) reads the committed tx, confirms it
succeeded and is within the recency window, then matches FA `Deposit` events against the
recipient's primary store.

The binding never trusts the client. `verify()` re-derives `payTo`'s primary store for the
required metadata from the **trusted `accept`**, never the client-supplied ref, so a forged echo
can't redirect it. Because a primary store address is metadata-specific, matching the store also
confirms the asset.

:::caution
No memo binds an Aptos tx to *this* specific challenge beyond amount + recipient. On digest-bound
chains, a persistent [replay store](/accepting-payments/replay-protection/) (`isUsed` / `markUsed`)
and a tight `maxTimeoutSeconds` are **load-bearing** in multi-instance deployments. Set both in
production.
:::

For the full picture of how the two templates differ, see [Proof binding](/concepts/proof-binding/).

## RPC

The built-in default fullnode (`https://fullnode.mainnet.aptoslabs.com/v1`) is rate-limited. In
production, pass your own `rpcUrl`. There's no separate API-key field, so fold any key into the
URL:

```ts
requirePayment({
  chain: 'aptos', token: 'USDC', amount: '0.10', payTo: '0x…',
  rpcUrl: 'https://your-aptos-fullnode.example.com/v1',
})
```
