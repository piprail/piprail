---
title: "Sui"
description: Pay and get paid on Sui — a Move L1 with sub-second finality, native Circle USDC, and digest-bound verification with zero receiver setup.
sidebar:
  order: 6
---

## Introduction

Sui is a Move L1 with sub-second (~400ms) finality and native Circle USDC. Name it `'sui'` on
any gate or client and the driver **auto-mounts** on first use — a single dynamic import, so a
pure-EVM install never downloads it. Coins on Sui are owned objects identified by a `CoinType`
(a `package::module::TYPE` path), not a contract address.

```bash
npm install @mysten/sui
```

`@mysten/sui` is an optional peer — install it only on the chains you actually touch. See the
[architecture](/concepts/payment-driver-architecture/) for how lazy auto-mount works.

## Accept and pay on Sui

The named-chain shorthand works exactly as on every other family — name the chain, the token,
the amount, and where to be paid:

```ts
import { requirePayment, PipRailClient } from '@piprail/sdk'

requirePayment({ chain: 'sui', token: 'USDC', amount: '0.10', payTo: '0x…' })

const client = new PipRailClient({
  chain: 'sui',
  wallet: { key: process.env.AGENT_KEY },  // suiprivkey1…
})
```

`payTo` is a Sui `0x…` address (32-byte). The merchant verifies locally against an RPC; PipRail
never holds funds. See [PipRailClient](/making-payments/piprail-client/) for the full client API.

## The wallet

A Sui wallet is `{ key }` — a `suiprivkey1…` bech32 secret, or the raw 32-byte secret as a
`Uint8Array` — or a ready `{ keypair }` you built yourself (an `Ed25519Keypair` from
`@mysten/sui`):

```ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

new PipRailClient({ wallet: { key: process.env.AGENT_KEY }, chain: 'sui' })  // suiprivkey1…
new PipRailClient({ wallet: { keypair: Ed25519Keypair.generate() }, chain: 'sui' })
```

The field is named `key` (shared with EVM/Tron), but the `chain: 'sui'` selector routes
here and the format is validated by `Ed25519Keypair` — a hex `0x…` EVM key won't parse and
surfaces a clear `WrongFamilyError`. See [wallets by family](/making-payments/wallets-by-family/)
for every family's shape.

## Supported tokens

USDC is built in, with its coin type and 6 decimals verified live on mainnet
(`suix_getCoinMetadata`) before shipping. There is **no native USDT on Sui** — only a
Wormhole-bridged token, not Circle/Tether-redeemable — so it's intentionally absent. The native
coin SUI (9 decimals, MIST) is always a valid payment asset.

| `token` | What it is |
| --- | --- |
| `'USDC'` | Native Circle USDC (6 decimals). |
| `'native'` | SUI, the gas coin (9 decimals). |
| `{ coinType, decimals }` | Any other coin, by its fully-qualified coin type. |

To pay in a coin PipRail doesn't ship — the bridged USDT, or anything else — pass it inline:

```ts
requirePayment({
  chain: 'sui',
  token: { coinType: '0x…::usdc::USDC', decimals: 6 },
  amount: '0.10',
  payTo: '0x…',
})
```

## Receiver setup — none

Sui has **no receive prerequisite**. Any valid `0x…` (32-byte) Sui address receives immediately —
no trustline, no storage deposit, no opt-in, no activation. [`planPayment()`](/making-payments/plan-payment/)
will never raise a `RECIPIENT_NOT_READY` blocker on Sui.

The payer, however, needs **SUI for gas even when paying USDC**, and must already hold a coin
object of the asset being sent. The SDK ships the standard self-gas `Coin<USDC>` transfer.

:::note
Sui has a protocol-level **gasless** stablecoin path. This driver ships the standard self-gas
transfer (always available, verified by tx digest); the gasless path is a different tx shape and a
future enhancement — so don't treat this path as gas-free.
:::

## Plan before you pay

Because SUI is the gas coin even when the payment is in USDC, a payer can hold plenty of USDC and
still be unable to settle — the classic gas-token shortfall. [`planPayment()`](/making-payments/plan-payment/)
reads balances and gas on-chain and reports it as a blocker before any send (it never throws on
fundability):

```ts
const plan = await client.planPayment('https://api.example.com/report')
if (plan && !plan.payable) {
  console.log(plan.fundingHint)  // e.g. "needs more SUI for gas" — one human-readable line
}
// → PaymentPlan | null  (null when the URL isn't payment-gated)
```

When the payment token is fine but gas isn't, the blocker is `INSUFFICIENT_GAS` (vs
`INSUFFICIENT_TOKEN` when you're short the USDC itself). If you instead let
[`fetch(url, { autoRoute: true })`](/making-payments/fetch-and-autoroute/) settle and no rail is
fundable, it throws a `PaymentDeclinedError` whose `.message` is the same funding hint — before
any send:

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

try {
  await client.fetch('https://api.example.com/report', { autoRoute: true })
} catch (err) {
  if (err instanceof PaymentDeclinedError) {
    // unsettleable on Sui — likely short on SUI gas or USDC; .message carries the hint
    console.error(`Couldn't pay on Sui: ${err.message}`)
  } else {
    throw err
  }
}
```

## Proof binding — Template B (digest-bound)

Sui verification is **digest-bound**, like EVM and Solana: the proof ref is the tx digest. The
merchant reads the transaction's balance changes and looks for a positive change of the required
coin type to `payTo`. The watched recipient and coin type always come from the **trusted
`accept`**, never the client-supplied ref, so a forged echo can't redirect verification.

Because no memo binds the tx to *this* specific challenge beyond amount and recipient, the
single-use proof set and a tight recency window are load-bearing on Sui — the same as on every
digest-bound chain. For multi-instance deployments use a persistent `isUsed` / `markUsed` store
and keep `maxTimeoutSeconds` tight.

```ts
requirePayment({
  chain: 'sui', token: 'USDC', amount: '0.10', payTo: '0x…',
  maxTimeoutSeconds: 120,
  isUsed: (ref) => redis.exists(ref),   // persistent across instances
  markUsed: (ref) => redis.set(ref, 1),
})
```

See [proof binding](/concepts/proof-binding/) for how Templates A and B differ, and
[replay protection](/accepting-payments/replay-protection/) for the proof store.

## In the browser

Sui runs client-side: like `solana` and `near`, `@mysten/sui` resolves from the CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)
that pins each non-EVM peer's browser-ESM URL (see the browser story in
[Installation](/getting-started/installation/)) — the same one line as on Node, Bun, Deno, or
Workers. The lazy import means a page that doesn't name `'sui'` never downloads `@mysten/sui`.

:::caution
A bare `{ key }` is for server-side and trusted-agent use — never ship a real secret to a
browser. In the browser, build an `Ed25519Keypair` from a key the user controls and pass
`{ keypair }` instead.
:::
