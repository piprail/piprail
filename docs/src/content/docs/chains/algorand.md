---
title: Algorand
description: Accept and pay x402 payments on Algorand — native ALGO (zero-setup) plus native Circle USDC, with the one-time ASA opt-in caveat for receiving USDC.
sidebar:
  order: 8
---

## Introduction

Algorand is a pure-PoS, payments-focused L1: ~3s single-step finality with no reorgs, and
sub-cent fees. Name `chain: 'algorand'` and the driver **auto-mounts** on first use — a
pure-EVM install never downloads its library.

Assets are ASAs (Algorand Standard Assets), identified by a numeric **asset id** rather than a
contract address; native ALGO and ASAs both transfer in integer base units. Every transaction
carries an arbitrary **note field** (up to 1 KB), which is where the challenge nonce rides.

## Install the peer dependency

The Algorand library is an optional peer, lazy-loaded the first time you name `chain: 'algorand'`:

```bash
npm install algosdk
```

## Wallet shape

An Algorand wallet is `{ key }`, where `key` is a 25-word Algorand recovery phrase — or a ready
`{ account }` (an algosdk `{ addr, sk }`, if you built the signer yourself):

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  wallet: { key: process.env.ALGORAND_MNEMONIC! },  // 25 words
  chain: 'algorand',
})
```

`payTo` is a 58-character Algorand address. See [Wallets by
family](/making-payments/wallets-by-family/) for every family's shape, and
[`PipRailClient`](/making-payments/piprail-client/) for the full client surface.

:::note
The mnemonic field is named the same as TON's, but `chain: 'algorand'` routes here and the phrase
is validated as a **25-word** Algorand mnemonic — a 24-word TON phrase is the wrong length and
surfaces a clear `WrongFamilyError`.
:::

## Supported tokens

Name a token by symbol, `'native'`, or a custom ASA:

| `token` | What it is |
| --- | --- |
| `'native'` | Native ALGO (6 decimals, microAlgos). **Zero-setup** — no opt-in needed. |
| `'USDC'` | Circle's native USDC (ASA `31566704`, 6dp) — verified live on mainnet before shipping. |
| `{ assetId, decimals }` | Any other ASA, by numeric asset id. |

```ts
import { requirePayment } from '@piprail/sdk'

app.get(
  '/report',
  requirePayment({
    chain: 'algorand',
    token: 'USDC',
    amount: '0.10',
    payTo: 'YourAlgoAddr',  // 58-char Algorand address
  }),
  (req, res) => res.json({ ok: true }),
)
```

:::note
**USDC only for the stablecoin.** Tether deprecated/froze USDT on Algorand (2025-09-01), so it
fails the issuer-native rule and is intentionally absent. You can still pass it as a custom ASA
`{ assetId, decimals }` if you must.
:::

## Native ALGO — the zero-setup path

`token: 'native'` pays in ALGO and needs **no opt-in** at either end. It's the simplest way to
charge on Algorand: name the chain, name the amount, get paid.

```ts
import { requirePayment } from '@piprail/sdk'

app.get(
  '/report',
  requirePayment({
    chain: 'algorand',
    token: 'native',
    amount: '0.10',
    payTo: 'YourAlgoAddr',
  }),
  (req, res) => res.json({ ok: true }),
)
```

ALGO is the volatile gas coin, so for stable pricing pay in USDC; for no-setup flows, native
ALGO is ideal.

## Receiving USDC needs a one-time ASA opt-in

Before an account can *receive* USDC — or any ASA — it must **opt into that asset** once: a
0-amount asset-transfer to itself, which raises its minimum balance by 0.1 ALGO (locked, and
recoverable). Without it, the payment fails. The payer is implicitly opted-in if it already
holds USDC.

[`planPayment()`](/making-payments/plan-payment/) surfaces a recipient that hasn't opted in as a
`RECIPIENT_NOT_READY` blocker before you spend, and a payment to an unready recipient raises a
[`RecipientNotReadyError`](/errors/error-hierarchy/):

```ts
const plan = await client.planPayment('https://api.example.com/report')
if (!plan) {
  // not payment-gated — nothing to plan
} else if (!plan.payable) {
  console.log(plan.fundingHint)  // → "must opt into the USDC ASA" etc.
}
```

The opt-in is plain `algosdk` — PipRail stays a payments SDK, not a wallet manager. Run it once
per account, per ASA:

```ts
import algosdk from 'algosdk'

const account = algosdk.mnemonicToSecretKey(process.env.ALGORAND_MNEMONIC!)  // { addr, sk }
const algod = new algosdk.Algodv2('', 'https://mainnet-api.algonode.cloud', '')
const sp = await algod.getTransactionParams().do()
const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: account.addr,
  receiver: account.addr,
  amount: 0,
  assetIndex: 31566704,
  suggestedParams: sp,
})
await algod.sendRawTransaction(optIn.signTxn(account.sk)).do()  // one-time, per account per ASA
```

The payer needs a little **ALGO for gas** either way — fees are a flat 0.001 ALGO.

## Proof binding — Template A (note-bound)

Algorand uses [Template A](/concepts/proof-binding/): the challenge nonce rides in the
transaction's **note field**, so the proof is cryptographically bound to its challenge.
`verify()` reads the merchant account's inbound transfers via the indexer and re-derives every
checked field from the trusted `accept`, never the client-supplied ref. See [Verifying
payments](/accepting-payments/verifying-payments/) and [Replay
protection](/accepting-payments/replay-protection/).

## Endpoints

`rpcUrl` overrides the **algod** endpoint (used to submit transactions and fetch suggested
params). The verify side reads inbound transfers from an **indexer**, which uses the public
AlgoNode default — the public indexer is production-grade for this read, so overriding it is
rarely necessary. The public algod is rate-limited; pass your own `rpcUrl` in production.

:::tip
Algorand's `exact` scheme is part of the official x402 standard, but the incumbent on-chain path
there uses a hosted **facilitator**. PipRail is the backendless, no-facilitator option — the
payer broadcasts and the merchant verifies locally. See [Chains and
tokens](/concepts/chains-and-tokens/).
:::
