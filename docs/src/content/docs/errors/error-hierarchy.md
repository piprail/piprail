---
title: PipRailError hierarchy
description: Every error the SDK throws — the abstract PipRailError base, its seventeen typed subclasses, each stable .code, and what to do about it.
sidebar:
  order: 2
---

## Introduction

Everything the SDK throws is a [`PipRailError`](/errors/error-model/) — an abstract base class
with one contract: a stable `SCREAMING_SNAKE` `.code` and a `.name` set to the subclass name.
A thrown error is always a config, flow, wallet, registry, or affordability problem the caller
can act on. (A *rejected proof* is the other channel — a returned
[`VerifyErrorCode`](/errors/verify-error-code/), never a throw.)

Catch SDK-originated errors and ignore the rest with one guard:

```ts
import { PipRailClient, PipRailError } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PipRailError) console.error(err.code, err.message)
  else throw err // not ours — rethrow
}
```

The base [`PipRailError`](/errors/error-model/) **and every one of the seventeen concrete
subclasses below is a named export** from `@piprail/sdk`, so you can either branch on
`err.code` after a broad `instanceof PipRailError` catch, or `import` the specific class and
narrow on it directly (`err instanceof PaymentDeclinedError`).

## The base class

`PipRailError` is `abstract`, so you never construct it — you catch it. Every subclass extends
`Error`, supports `{ cause }` (the untouched chain-library error is preserved there), and
exposes a `readonly code`. Branch on `.code` for stable, machine-readable handling; read
`.message` for the human reason.

```ts
abstract class PipRailError extends Error {
  abstract readonly code: string
}
```

## The seventeen subclasses

Every class below is exported from the package root and is caught by
`err instanceof PipRailError`. The `.code` is the stable string to branch on.

| Class | `.code` | Meaning |
| --- | --- | --- |
| `InsufficientFundsError` | `INSUFFICIENT_FUNDS` | The **payer** can't cover the transfer plus fees / reserve / its own trustline. |
| `RecipientNotReadyError` | `RECIPIENT_NOT_READY` | The **recipient** (`payTo`) isn't set up to receive on this chain (not activated / no trustline / not registered / not opted-in). |
| `WrongChainError` | `WRONG_CHAIN` | A bring-your-own `walletClient` is on a different chain than configured. |
| `WrongFamilyError` | `WRONG_FAMILY` | The wallet, `payTo`, or token was given in another family's shape (e.g. an `0x…` address on Solana). |
| `UnknownTokenError` | `UNKNOWN_TOKEN` | A built-in token symbol the chosen chain doesn't ship (e.g. `token: 'DOGE'`). |
| `MissingDriverError` | `MISSING_DRIVER` | A family's optional peer deps aren't installed — message names the exact `npm install`. |
| `UnsupportedNetworkError` | `UNSUPPORTED_NETWORK` | No registered driver recognised the given `chain` value. |
| `PaymentTimeoutError` | `PAYMENT_TIMEOUT` | Broadcast confirmed, but the **server** didn't return 200 in time — carries `.ref`. |
| `ConfirmationTimeoutError` | `CONFIRMATION_TIMEOUT` | Broadcast OK, but the tx didn't confirm within the driver's window — re-check the ref. |
| `MaxRetriesExceededError` | `MAX_RETRIES_EXCEEDED` | Paid, retried, still 402 — the server rejected the proof on every attempt; carries `.ref`. |
| `PaymentDeclinedError` | `PAYMENT_DECLINED` | The client refused to pay **before any send** — over policy, or an `onBeforePay` hook said no. |
| `InvalidEnvelopeError` | `INVALID_ENVELOPE` | The server returned 402 but the PAYMENT-REQUIRED envelope was missing or malformed. |
| `NoCompatibleAcceptError` | `NO_COMPATIBLE_ACCEPT` | The challenge offered no `accepts[]` entry the client can pay on its chain + enabled schemes. |
| `UnsupportedSchemeError` | `UNSUPPORTED_SCHEME` | Asked to pay a scheme the bound family / asset / signer can't settle, with no fallback rail. |
| `NonReplayableBodyError` | `NON_REPLAYABLE_BODY` | `init.body` was provided but isn't replayable (e.g. a one-shot `ReadableStream`). |
| `SettlementError` | `SETTLEMENT_FAILED` | An `exact`-rail payment was valid but settlement failed **server-side** — the gate throws this so the adapter returns 5xx, never 402. |
| `WalletRequiredError` | `WALLET_REQUIRED` | A wallet-bound op (pay / plan / sign) was called on a **read-only** client built with no `wallet`. The read-only methods (quote / discover / register / budget) still work. |

## Affordability always converges — `InsufficientFundsError`

"Wallet can't pay" always surfaces as one error, no matter the chain. The detection differs
per family (EVM walks viem's `BaseError`, Stellar reads Horizon `result_codes`, Solana and TON
match the message), but every path throws the same `InsufficientFundsError` with
`.code === 'INSUFFICIENT_FUNDS'`.

```ts
try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PipRailError && err.code === 'INSUFFICIENT_FUNDS') {
    // fund the payer: more token, native gas, or reserve
  } else throw err
}
```

`toInsufficientFundsError(err)` is the shared backstop that powers this — it's exported for
custom drivers. Inside a custom driver's `send()` catch block, it matches a chain library's
"can't afford it" message and returns an `InsufficientFundsError`, or `null` on a miss so the
original error propagates unchanged:

```ts
import { toInsufficientFundsError } from '@piprail/sdk'

// inside a custom PaymentDriver's send():
try {
  await broadcast(tx) // the chain library's send/broadcast call
} catch (err) {
  throw toInsufficientFundsError(err) ?? err
}
```

:::tip
`INSUFFICIENT_FUNDS` and `RECIPIENT_NOT_READY` are deliberately distinct because the fix is
opposite: fund the **payer** vs. set up the **recipient** (activate the account, add a
trustline, `storage_deposit`-register, or opt into the ASA). The recipient error states the requirement in plain
language and echoes the raw chain code (e.g. `(XRPL: tecNO_DST_INSUF_XRP)`).
:::

## Recovering a broadcast proof — `.ref`

`PaymentTimeoutError` and `MaxRetriesExceededError` mean the transaction is already on-chain;
**these are the only two classes that carry `.ref`**, the broadcast proof. The base
`PipRailError` and `ConfirmationTimeoutError` have no `.ref`, so narrow on the two concrete
classes before reading it. The recovery rule is the same for each:
**re-verify or re-submit `ref` — never re-pay.** A fresh payment would double-spend. The proof
stays redeemable until the server's `maxTimeoutSeconds` recency window elapses (default 600s).

```ts
import { PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    const ref = err.ref // the already-broadcast proof
    // re-submit ref to the server — do NOT re-pay
  } else throw err
}
```

For an `exact` rail, `MaxRetriesExceededError.ref` is the EIP-3009 authorization **nonce**
(a `0x…` value, not a tx hash) — re-present the same signed authorization, and check the
token's `authorizationState(from, nonce)` before assuming it didn't settle.

## Why a payment was declined — `DeclineReasonCode`

`PaymentDeclinedError` fires before any send when a [spend policy](/spend-controls/payment-policy/)
or an `onBeforePay` hook refuses the quote. Its `.code` is always `'PAYMENT_DECLINED'`; the
optional `.reasonCode` is a typed hint so an agent can branch on the cause without parsing the
message.

| `reasonCode` | Meaning | Retry? |
| --- | --- | --- |
| `'POLICY'` | A chain / host / token / per-payment cap refused it. | After fixing the target. |
| `'BUDGET'` | The per-(network, asset) lifetime `maxTotal` cap. | No — budget exhausted. |
| `'OUTSIDE_WINDOW'` | The rolling `windowTotal` cap. | Yes — once the window slides. |
| `'SESSION_EXPIRED'` | The session TTL elapsed. **Terminal.** | No — restart / extend the TTL. |
| `'APPROVAL'` | An `onBeforePay` hook (e.g. MCP human-in-the-loop) declined. **Terminal.** | No — don't auto-retry. |

```ts
import { PaymentDeclinedError } from '@piprail/sdk'

try {
  await client.fetch(url)
} catch (err) {
  if (err instanceof PaymentDeclinedError && err.reasonCode === 'SESSION_EXPIRED') {
    // terminal for this process — extend the session, don't retry the payment
  } else throw err
}
```

`DeclineReasonCode` is exported as a type for use in your own handlers.

## Missing driver vs. unsupported network

A deliberate split: `MISSING_DRIVER` means a family's lazy `import()` failed because its
optional peer deps aren't installed (the message names the exact `npm install` and sets
`{ cause }`); `UNSUPPORTED_NETWORK` means no driver recognised the `chain` value at all. Don't
reuse one for the other — see [Chains and tokens](/concepts/chains-and-tokens/) for the family
peer deps.
