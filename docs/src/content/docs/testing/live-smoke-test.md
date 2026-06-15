---
title: Live mainnet smoke test
description: Prove a chain end to end — a real 402 → pay → confirm → verify → 200 round-trip plus a replay reject, on mainnet, with a tiny amount and a funded wallet.
sidebar:
  order: 2
---

## Introduction

Unit and contract tests prove the protocol; a live smoke test proves the *chain*. It runs the
whole loop against a real network — a merchant gate issues a `402`, a [`PipRailClient`](/making-payments/piprail-client/)
pays on-chain, the gate verifies the proof, and the request returns `200` — then submits the same
proof again and confirms the gate rejects it. If that passes on mainnet with real money, the
driver is correct.

Keep the amount tiny (`'0.001'`) and use a wallet you fund on purpose. This is the same kind of
round-trip [`local-verification`](/testing/local-verification/) does without a network; here the
chain is real.

:::danger
Real money moves on this page. The wallet key reaches a live network, so use a **dedicated test
key** (`process.env.AGENT_KEY`) holding tiny amounts — never a production key, and never a key
checked into source.
:::

## The round-trip you're proving

Stand up a real gate, point a client at it, and pay. The gate verifies the on-chain transfer
against its own RPC before the handler runs — nothing is mocked.

```ts
import express from 'express'
import { requirePayment, PipRailClient } from '@piprail/sdk'

const app = express()
app.get(
  '/report',
  requirePayment({ chain: 'base', token: 'USDC', amount: '0.001', payTo: '0xYourWallet' }),
  (_req, res) => res.json({ unlocked: true }),
)
const server = app.listen(0) // throwaway localhost gate, real chain underneath
const port = (server.address() as import('node:net').AddressInfo).port
```

```ts
import { PipRailError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
  policy: { maxAmount: '0.01', tokens: ['USDC'] },
})

try {
  const res = await client.fetch(`http://127.0.0.1:${port}/report`)
  console.log(res.status)            // 200 — paid, verified, unlocked
  console.log(client.spent().count)  // 1 — settled exactly once
} catch (err) {
  // Real money is in flight, so handle a failed settlement explicitly rather than crashing.
  if (err instanceof PipRailError) {
    console.error(`payment failed [${err.code}]: ${err.message}`)
    // e.g. PAYMENT_DECLINED · INSUFFICIENT_FUNDS · RECIPIENT_NOT_READY · PAYMENT_TIMEOUT
  } else {
    throw err
  }
}
```

The `policy` cap is your seatbelt: even pointed at a real network, the client refuses anything
over `maxAmount` before any send. See [spend policy](/spend-controls/payment-policy/) for the
full set of caps.

## Then prove the replay reject

A correct gate redeems a proof once. Re-submitting the *same* settled proof must come back
`tx_already_used` (the in-memory used-proof set defeats double-spend). A `client.fetch`
round-trip never hands the merchant the raw proof header, so drive the gate directly: take an
`accepted` rail from `gate.challenge()`, frame the proof yourself with `buildSignatureHeader`,
and verify it twice.

```ts
import { createPaymentGate, buildSignatureHeader } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: '0xYourWallet' })

// The rail the proof claims — taken from a fresh challenge, so nonce + asset already match.
const { challenge } = await gate.challenge('https://api.example.com/report')
const accepted = challenge.accepts.find((a) => a.scheme === 'onchain-proof')!

// `txHash` is the proof ref you got back after paying on-chain (the settled tx hash).
const txHash = '0xYourSettledTxHash'
const proofHeader = buildSignatureHeader({
  x402Version: 2,
  accepted,
  payload: { nonce: accepted.extra.nonce, txHash },
})

const first = await gate.verify(proofHeader)
console.log(first.kind)            // → 'paid'   (verified, settled once)

const second = await gate.verify(proofHeader)
console.log(second.kind, second.kind === 'invalid' && second.error)
// → 'invalid' 'tx_already_used'  (the used-proof set defeats the replay)
```

:::note
The replay reject is half the proof. A round-trip alone shows a payment *can* settle; the second
verify shows it can't settle **twice**. A driver isn't done until both pass on mainnet.
:::

## Use a funded wallet

The payer needs the payment token **and** a little of the chain's native coin for gas — they're
separate balances. Fund a dedicated test wallet with tiny amounts before you run; never put a
production key on the open internet.

```ts
const url = 'https://api.example.com/report'
const plan = await client.planPayment(url)

if (!plan) {
  console.log('not payment-gated — nothing to fund')
} else if (!plan.payable) {
  console.log(plan.fundingHint)
  // → "Can't settle on base: add ~0.000021 ETH for gas (to pay 0.10 USDC)."
}
```

[`planPayment()`](/making-payments/plan-payment/) is the pre-flight: it returns `null` when the
URL isn't payment-gated (so null-guard it), and otherwise reads your balances, the gas, and
recipient readiness, telling you exactly what to top up — so you fund the wallet once instead of
discovering a shortfall mid-test. On chains with a receive prerequisite (a Stellar/XRPL
trustline, an Algorand ASA opt-in, a NEAR `storage_deposit`) the `payTo` account must be set up
too, or verification has nothing to find. See [Why payments fail](/errors/why-payments-fail/).

## Per-template gotchas

The two [proof-binding](/concepts/proof-binding/) templates fail differently, so check the right
thing:

| Template | Chains | What to confirm |
| --- | --- | --- |
| **B — digest-bound** | EVM, Solana, Tron, Sui, Aptos | The proof is the tx hash; verify reads the confirmed transfer + recency window + single-use set. |
| **A — memo/nonce-bound** | Stellar, XRPL, TON, NEAR, Algorand | The challenge nonce rides in the memo/note/comment, matched on the merchant's own account. |

A few rails settle slowly or read on a confirmed node — give `maxTimeoutSeconds` headroom and
expect a wait on TON (asynchronous settlement) and Tron (verified on the solidity node).

## A reference harness — the Anvil end-to-end

For EVM you don't need mainnet at all: the `examples/sdk-sandbox` harness runs the same accept ↔
pay round-trip — USDC **and** the native coin — against a **local Anvil fork of Base** with fake
funds, and asserts the second redemption is `tx_already_used`. It forks via a public RPC, deals
itself fake USDC by writing contract storage, and skips cleanly if Anvil isn't installed — so
it's a regression gate that costs nothing.

```bash
cd examples/sdk-sandbox && npm install   # suite 05 imports the installed @piprail/sdk
node run-all.mjs                          # suite 05 is the live on-chain round-trip
```

Suite 05 runs against the installed `@piprail/sdk` (a real `node_modules` dir), and `examples/`
isn't a root workspace member — so `npm run build:sdk` doesn't reach it; you `npm install` instead.
To exercise **working-tree** SDK code (it imports `../../../sdk/dist`), build first and run suite 07:

```bash
npm run build:sdk
node examples/sdk-sandbox/suites/07-exact-rail.mjs
```

Use the fork to prove the *shape* of the loop, and a funded mainnet wallet to prove the *chain*.
For deterministic, offline tests of your own integration code, stub the driver instead — see
[Mocking](/testing/mocking/).
