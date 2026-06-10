---
title: "Why did my payment fail?"
description: A practical triage of the errors a payment can throw — payer vs recipient, the never-re-pay rule, and why a flaky RPC never double-pays or falsely unlocks.
sidebar:
  order: 4
---

## Introduction

When a payment doesn't go through, PipRail tells you *why* in a typed, actionable way — never an
opaque chain-library blob. Every failure surfaces through one of two channels: a thrown
[`PipRailError`](/errors/error-model/) with a stable `.code` (catch it, branch on it), or a returned
[`VerifyErrorCode`](/errors/verify-error-code/) on the server side. This page is the triage map for
the thrown ones, ordered by what you'll actually hit.

The single most important rule lives at the bottom: a broadcast payment is **never** thrown away,
so you recover with the proof — you never re-pay.

## Catching it at all

Every error the SDK throws extends `PipRailError`, so you separate SDK-recognised failures from
arbitrary bugs in one check, then branch on the stable `.code`:

```ts
import { PipRailClient, PipRailError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'

try {
  const res = await client.fetch(url)
  // → a normal Response — payment (if any) already settled
  console.log(res.status)
} catch (err) {
  if (err instanceof PipRailError) console.log(err.code, err.message)
  else throw err // a genuine bug, not a payment outcome
}
```

The cleaner path is to not throw at all: [`planPayment(url)`](/making-payments/plan-payment/) and
[`canAfford(url)`](/making-payments/plan-payment/) read your wallet and the recipient *before*
spending and return a structured verdict, so most of the errors below become a pre-flight decision
instead of a runtime crash.

:::note
Every concrete error class named on this page is exported from `@piprail/sdk` — so a bare
`import { InsufficientFundsError, PaymentDeclinedError, … } from '@piprail/sdk'` resolves, and you
can narrow with `instanceof` instead of comparing `.code` strings.
:::

## Payer vs recipient — the two faces of "can't pay"

The most common confusion is treating every shortfall as "I'm broke." PipRail keeps the two cases
**deliberately distinct**, because the fix is the opposite — fund yourself, or set up the recipient.

| Code | Class | The fix |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `InsufficientFundsError` | Fund the **payer** — more of the payment token, or native coin for gas/reserve. |
| `RECIPIENT_NOT_READY` | `RecipientNotReadyError` | Set up the **recipient** (`payTo`) — it isn't provisioned to receive on this chain yet. |

Affordability always converges on one error on every chain — `InsufficientFundsError`, `.code ===
'INSUFFICIENT_FUNDS'` — whether the driver detected it from a structured chain error or by matching
the message:

```ts
import { InsufficientFundsError, RecipientNotReadyError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof InsufficientFundsError) {
    // top up; err.cause has the raw chain error for debugging
    console.log('Fund the payer:', err.message)
  } else if (err instanceof RecipientNotReadyError) {
    // the payTo isn't set up to receive — see below
    console.log('Set up the recipient:', err.message)
  } else {
    throw err
  }
}
```

`RecipientNotReadyError` is a chain *state* rule, not your balance. It fires on the few families with
a receive prerequisite, and the message states the requirement plus the raw chain code:

| Chain | The recipient needs… |
| --- | --- |
| XRPL | activation — an account must hold ≥1 XRP (base reserve) to exist; or a trustline / DestinationTag for the IOU. |
| Stellar | the account to exist (≥1 XLM reserve) and hold a trustline for the asset. |
| NEAR | `storage_deposit` registration on the NEP-141 token (~0.00125 NEAR). |

Chains with no receive prerequisite (EVM, Solana, Sui, Aptos, Tron, native TON/NEAR) never throw it.

:::tip
You don't have to discover either of these by failing. [`planPayment()`](/making-payments/plan-payment/)
reports them ahead of time as the `INSUFFICIENT_TOKEN` / `INSUFFICIENT_GAS` / `RECIPIENT_NOT_READY`
blockers, with a one-line `fundingHint` for exactly what to top up.
:::

## Refused before any send — `PAYMENT_DECLINED`

`PaymentDeclinedError` is thrown *before* any on-chain send: the quote exceeded your
[spend policy](/spend-controls/payment-policy/) (a per-payment / lifetime / rolling cap, or a
chain/token/host outside the allowlist), the session's [time envelope](/spend-controls/time-envelope/)
elapsed, or an `onBeforePay` approval hook said no. **Nothing moved.** A typed `.reasonCode` lets you
branch on the cause without parsing the message:

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PaymentDeclinedError) {
    if (err.reasonCode === 'SESSION_EXPIRED' || err.reasonCode === 'APPROVAL') {
      return // TERMINAL — do not retry
    }
    // 'POLICY' | 'BUDGET' | 'OUTSIDE_WINDOW' — adjust the cap or wait for the window to slide
    console.log('Declined:', err.reasonCode, err.message)
  } else {
    throw err
  }
}
```

`SESSION_EXPIRED` and `APPROVAL` are terminal — every further payment this process is refused, so
restart or extend the session rather than retrying.

## Nothing the wallet can pay — `NO_COMPATIBLE_ACCEPT` and `UNSUPPORTED_SCHEME`

These two say "the 402 offered rails, but not ones this wallet can settle." Keep them apart:

| Code | Meaning |
| --- | --- |
| `NO_COMPATIBLE_ACCEPT` | The challenge offered no `accepts[]` entry for the client's network and enabled schemes. The message names the enabled schemes. |
| `UNSUPPORTED_SCHEME` | Asked to pay a scheme the bound family/asset/signer can't settle, with no fallback — e.g. an [`exact`](/making-payments/exact-buyer/) rail on a non-EVM family, a non-EIP-3009 token (USDT, native, plain ERC-20), or a contract / EIP-1271 / EIP-7702 signer. |

The usual fix for `UNSUPPORTED_SCHEME` is to keep an `onchain-proof` rail in the offer, or pay with a
supported chain/token. Note `WRONG_FAMILY` is different again — that's a wallet, `payTo`, or token
given in *another family's shape* (an `0x…` address on Solana, a `{ mint }` token on Stellar).

## Setup mistakes — wrong family, unknown token, missing driver

These are configuration, not funds:

| Code | Class | Thrown when |
| --- | --- | --- |
| `WRONG_FAMILY` | `WrongFamilyError` | A wallet / `payTo` / token in another family's shape. |
| `WRONG_CHAIN` | `WrongChainError` | A bring-your-own `walletClient` is on a different chain than configured. |
| `UNKNOWN_TOKEN` | `UnknownTokenError` | A built-in symbol the chain doesn't ship (e.g. `token: 'DOGE'`) — use a symbol the chain ships, `'native'`, or pass the token by full descriptor. |
| `MISSING_DRIVER` | `MissingDriverError` | A non-EVM family's optional peer deps aren't installed; the message names the exact `npm install`. |
| `UNSUPPORTED_NETWORK` | `UnsupportedNetworkError` | No driver recognised the `chain` value. |
| `INVALID_ENVELOPE` | `InvalidEnvelopeError` | A `402` carried no parseable x402 challenge. |

`MISSING_DRIVER` (deps not installed) and `UNSUPPORTED_NETWORK` (chain not supported) are a deliberate
split — don't conflate them. See [Chains and tokens](/concepts/chains-and-tokens/) and
[Wallets by family](/making-payments/wallets-by-family/).

## The broadcast-but-stuck case — never re-pay

This is the one that matters most for an autonomous agent. Once a transfer broadcasts, the funds may
have moved — so the client **never throws the proof away**. If the broadcast succeeds but the client's
own `confirm()` times out (a throttled RPC that lands the tx but 429s the status poll), it emits a
`payment-unconfirmed` event, submits the proof to the server anyway with more patient retries, and
**never re-broadcasts**. If it still can't confirm, it throws one of these — the first two carry
`.ref`, the already-broadcast proof:

| Code | Class | Means |
| --- | --- | --- |
| `PAYMENT_TIMEOUT` | `PaymentTimeoutError` | Broadcast confirmed on-chain, but the server didn't return 200 within the timeout. Carries `.ref`. |
| `MAX_RETRIES_EXCEEDED` | `MaxRetriesExceededError` | Broadcast, retried, still 402. The message embeds the last server `error — detail`. Carries `.ref`. |
| `CONFIRMATION_TIMEOUT` | `ConfirmationTimeoutError` | Broadcast OK but didn't confirm in the driver's window. Re-check the proof ref you already have (no `.ref` on this class). |

:::danger
On `PAYMENT_TIMEOUT` / `MAX_RETRIES_EXCEEDED`, read `err.ref` and **re-verify or re-submit that proof —
never re-pay.** A fresh payment double-spends. The same proof stays redeemable until the server's
`maxTimeoutSeconds` recency window elapses (default 600s).
:::

`.ref` lives on exactly these two classes, so narrow on them before reading it (the base
`PipRailError` and `ConfirmationTimeoutError` have no `.ref`):

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    const proof = err.ref // recover with this — do NOT pay again
    // re-submit `proof` to the resource, or re-verify it on-chain
    console.log('Recover the proof, never re-pay:', proof)
  } else {
    throw err
  }
}
```

For an `exact` rail the `.ref` is the EIP-3009 authorization *nonce* (a `0x…` 32-byte value, not a tx
hash): re-present the same signed authorization, and check the token's `authorizationState(from, nonce)`
before assuming it didn't settle.

## Why a flaky RPC is safe — no false unlock, no double-pay

The same broadcast-is-sacred principle makes a throttled or lagging RPC harmless in both directions:

- **Verify fails closed (server).** If the gate's [`verify()`](/accepting-payments/verifying-payments/)
  RPC read fails, it returns `tx_not_found` and replies **402 (locked)** — never `paid`. An RPC outage
  can't trick a merchant into unlocking without a real, confirmed payment. The gate also **releases the
  replay claim** on a failed read, so the payer can re-submit the *same* proof once the RPC recovers —
  the proof is not burned. See [Replay protection](/accepting-payments/replay-protection/).
- **Confirm fails open, toward the proof (client).** A confirm timeout doesn't discard the broadcast; it
  defers to the server's on-chain verify (the authority) and never re-broadcasts.

The repeated-lag fix is a dedicated `rpcUrl` per chain, not retrying the payment.

## Settlement failed on an `exact` rail — a `5xx`, not your fault

On a standard [`exact`](/accepting-payments/exact-rail-seller/) rail, the merchant (or a facilitator)
broadcasts. If your authorization was valid (signature recovered, simulation passed) but the merchant's
relayer or facilitator couldn't broadcast it, the gate throws `SettlementError` (`SETTLEMENT_FAILED`)
and the adapter returns **5xx**, never 402. Your signed EIP-3009 authorization stays valid and its nonce
unused — re-present it once the merchant fixes their relayer. Re-paying would be wrong here too.

## When you'd rather not handle any of this

Agents that should never let a payment failure crash the loop should drive PipRail through the
[agent toolkit](/agent-toolkit/the-7-tools/): the `piprail_pay_request` tool catches **every**
`PipRailError` and returns a structured result instead of an exception —
`{ ok: false, code, reason, explain, ref?, reasonCode?, declined? }` — so a broadcast-but-unconfirmed
timeout reaches the model with its `.ref` and the never-re-pay rule already explained.
