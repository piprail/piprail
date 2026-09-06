---
title: Wire-format codecs
description: The raw x402 envelope codecs — parse and build the challenge, signature, and receipt headers by hand when you're rolling your own client or server.
sidebar:
  order: 2
---

## Introduction

The high-level [`PipRailClient`](/making-payments/piprail-client/) and
[`createPaymentGate`](/accepting-payments/require-payment-and-gate/) cover the 99% case. These
are the raw codecs underneath them: pure functions that turn x402 envelopes into base64 header
values and back, with nothing chain-specific in them. Reach for these only when you're building
a client or server by hand — a non-Node runtime, a custom transport, or a protocol bridge.

Everything here is exported from `@piprail/sdk`. The codecs are chain-agnostic: identifiers
round-trip as plain strings (CAIP-2 networks, base-unit amounts), and each
[PaymentDriver](/concepts/payment-driver-architecture/) interprets them for its own chain.

## The three headers

PipRail's `onchain-proof` flow is three base64-JSON headers, all lowercase, no `X-` prefix:

| Constant | Header | Direction | Carries |
| --- | --- | --- | --- |
| `HEADER_REQUIRED` | `payment-required` | server → client | the 402 challenge |
| `HEADER_SIGNATURE` | `payment-signature` | client → server | the payment proof |
| `HEADER_RESPONSE` | `payment-response` | server → client | the receipt, on 200 |

```ts
import { HEADER_REQUIRED, HEADER_SIGNATURE, HEADER_RESPONSE } from '@piprail/sdk'
```

The round-trip is symmetric per side:

```
server: buildChallengeHeader  →  (verify)  →  buildReceiptHeader
client: parseChallenge  →  buildSignatureHeader  →  parseReceipt
```

## Building the challenge (server)

A server emits a 402 by base64-encoding an `X402Challenge` into the `payment-required` header.
The challenge carries the `resource` it gates and an `accepts[]` array — one entry per rail you
offer. Only `scheme` / `network` / `amount` / `asset` / `payTo` / `maxTimeoutSeconds` are
top-level; the `nonce`, `decimals`, `minConfirmations`, and `amountFormatted` live under `extra`.

```ts
import { buildChallengeHeader, HEADER_REQUIRED, type X402Challenge } from '@piprail/sdk'

const challenge: X402Challenge = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/report' },
  accepts: [{
    scheme: 'onchain-proof',
    network: 'eip155:8453',          // CAIP-2 (Base)
    amount: '100000',                // base units (0.10 USDC at 6 decimals)
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
    payTo: '0xYourWallet',
    maxTimeoutSeconds: 120,
    extra: { nonce: 'abc123', decimals: 6, minConfirmations: 1, amountFormatted: '0.10' },
  }],
}

res.status(402).setHeader(HEADER_REQUIRED, buildChallengeHeader(challenge))
// buildChallengeHeader → a base64-JSON string for the payment-required header
```

`buildReceiptHeader(receipt)` does the same for an `X402Receipt` on a successful 200 — see
[Receipts](/accepting-payments/receipts-and-onpaid/).

## Building the proof (client)

After paying on-chain, a client base64-encodes an `X402PaymentSignature` into the
`payment-signature` header and retries the request. The `accepted` field is the rail you chose,
echoed back verbatim from the challenge; the `payload` binds the challenge `nonce` to your proof
ref (`txHash` — an EVM tx hash, a Solana signature, a TON locator, …).

```ts
import {
  buildSignatureHeader, parseChallenge, pickAccept, HEADER_SIGNATURE,
} from '@piprail/sdk'

const url = 'https://api.example.com/report'
const res = await fetch(url)

const challenge = await parseChallenge(res)
if (!challenge) throw new Error('not a valid x402 402')

const chosenRail = pickAccept(challenge, (network) => network === 'eip155:8453')
if (!chosenRail) throw new Error('no rail I can pay')

// …pay chosenRail.amount of chosenRail.asset to chosenRail.payTo on-chain, then:
const txHash = '0x4f8e1c0b9a2d3e6f7081a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f7'

const value = buildSignatureHeader({
  x402Version: 2,
  accepted: chosenRail,                          // the X402AcceptEntry from the challenge
  payload: { nonce: chosenRail.extra.nonce, txHash },
})
// buildSignatureHeader → a base64-JSON string for the payment-signature header

await fetch(url, { headers: { [HEADER_SIGNATURE]: value } })
```

How the `nonce` rides in the proof — and how `verify()` re-derives every checked field from the
trusted `accept` rather than this echo — is covered under [proof binding](/concepts/proof-binding/).

## Parsing (both sides)

The parsers are tolerant: they read a base64 header value (or, for `parseChallenge`, a JSON
body fallback) and return a typed object or `null`. They never throw.

| Function | Reads | Returns |
| --- | --- | --- |
| `parseChallenge(response)` | `payment-required` header, then JSON body | `X402Challenge \| null` |
| `parseSignatureHeader(value)` | a `payment-signature` value | `X402PaymentSignature \| null` |
| `parseReceipt(response)` | `payment-response` header | `X402Receipt \| null` |

```ts
import { parseChallenge, parseReceipt } from '@piprail/sdk'

const url = 'https://api.example.com/report'
const res = await fetch(url)

if (res.status === 402) {
  const challenge = await parseChallenge(res)   // X402Challenge | null
  if (!challenge) throw new Error('402 with no valid x402 challenge')
  // …choose a rail, pay, retry…
}

const settledResponse = await fetch(url, { headers: { /* payment-signature */ } })
const receipt = parseReceipt(settledResponse)   // X402Receipt | null — null if no receipt header
if (receipt) {
  console.log(receipt.transaction, receipt.payer)
  // → { scheme, success: true, network, transaction, asset, amount, payer, payTo, verifiedAt }
}
```

`parseChallenge` is async because it may `await response.clone().json()` to fall back to a
JSON challenge body. `parseSignatureHeader` is what a hand-rolled server calls on the inbound
`payment-signature`; it returns `null` for anything that isn't a well-formed `onchain-proof`
proof (so an `exact` payment falls through — see below).

:::note
A returned value passed PipRail's structural checks (`x402Version === 2`, a non-empty
`accepts[]`, a `payload` with both `nonce` and `txHash`). That's a shape gate, not a payment
verification — the on-chain `verify()` is the only thing that proves a payment.
See [Verifying payments](/accepting-payments/verifying-payments/).
:::

## Selecting a rail — `pickAccept`

A 402 may offer several rails. `pickAccept` returns the first `onchain-proof` entry whose
network your predicate accepts, or `null`:

```ts
import { pickAccept, parseChallenge } from '@piprail/sdk'

const challenge = await parseChallenge(res)
if (!challenge) throw new Error('not a valid x402 402')

const rail = pickAccept(challenge, (network) => network === 'eip155:8453')
if (!rail) throw new Error('no rail I can pay')
// → an X402AcceptEntry on the matched network, or null
```

The predicate gets the raw CAIP-2 string, so you decide what "I can pay this" means — a single
chain, a family prefix (`network.startsWith('solana:')`), or a set you hold a wallet for. Only
`onchain-proof` rails are considered; `exact` rails are skipped.

## The wire types

The codecs are typed by a small set of interfaces, all exported as `type`s:

| Type | What it is |
| --- | --- |
| `X402Challenge` | the 402 body: `resource` + `accepts[]` |
| `X402AcceptEntry` | one `onchain-proof` rail in `accepts[]` |
| `X402AnyAccept` | `X402AcceptEntry \| X402ExactAcceptEntry \| X402UptoAcceptEntry` (a challenge entry of any rail — onchain-proof, exact, or upto) |
| `X402PaymentSignature` | the client's proof: `accepted` + `{ nonce, txHash }` |
| `X402Receipt` | the settled receipt on a 200 (the wire shape) |
| `X402ResourceObject` | the gated resource: `url`, optional `description` / `mimeType` |
| `Caip2` | a CAIP-2 network id, e.g. `eip155:8453` |
| `AssetId` | a chain-specific asset id, or `'native'` |
| `AddressId` | a chain-specific account id |

The wire receipt is `X402Receipt`. A gate's [`onPaid`](/accepting-payments/receipts-and-onpaid/#the-paidreceipt)
hook receives a **`PaidReceipt`** — the same fields plus `decimals` / `symbol` / `amountFormatted` /
`idempotencyKey` — but that enrichment never goes on the wire; the `payment-response` header stays `X402Receipt`.

`VerifyResult` and [`VerifyErrorCode`](/errors/verify-error-code/) — the shape every driver's
`verify()` returns — are exported here too. `VerifyResult` is the union
`{ ok: true; receipt } | { ok: false; error: VerifyErrorCode; detail: string }`.

```ts
import type {
  X402Challenge, X402AcceptEntry, X402PaymentSignature, X402Receipt, Caip2,
} from '@piprail/sdk'
```

## Version posture — strict v2 out, liberal in

PipRail **emits strict x402 v2** and **accepts both v2 and v1**. v2 replaced v1 on the wire
(the header moved `X-PAYMENT` → `payment-signature`, the challenge moved into the
`payment-required` header, networks became CAIP-2). The parsers still read v1 so that
agents and facilitators pinned to it keep working, which is why two legacy header constants
ship:

```ts
import { HEADER_SIGNATURE_V1, HEADER_RESPONSE_V1 } from '@piprail/sdk'
// 'x-payment'  and  'x-payment-response'
```

`parseReceipt` reads `payment-response`, falling back to the v1 `x-payment-response` a foreign
server may set.

## The `payment-identifier` extension (opt-in idempotency)

A gate built with `paymentIdentifier: true` advertises the x402 `payment-identifier` extension, and a
buyer can supply a stable idempotency `id` it can safely retry under. Two wire-level codecs back it
(both pure, both exported):

| Function / const | Role |
| --- | --- |
| `buildPaymentIdentifierAdvertisement()` | emit the advertisement block — `{ info: { required: false }, schema: { properties: { id: { type: 'string', minLength: 16, maxLength: 128 } } } }` under the `payment-identifier` extension key (a sibling of `extensions.piprail`) |
| `readPaymentIdentifier(payload)` | read the buyer's id off `payload.extensions["payment-identifier"].info.id` — returns the validated `string`, `null` (absent), or `{ invalid }` (present-but-malformed: non-string, not 16–128 chars, or outside `[A-Za-z0-9_-]`). Never throws. |
| `EXT_PAYMENT_IDENTIFIER` | the extension key string (`'payment-identifier'`) |

The gate dedupes the id on its existing used-proof set (keyed `pid:<id>`, case-sensitive). Full
behavior: [Replay protection → opt-in caller idempotency](/accepting-payments/replay-protection/).

## The standard `exact` rail (interop)

A PipRail gate can **dual-advertise** a standard x402 `exact` rail alongside its
`onchain-proof` rail, so any off-the-shelf x402 client can pay it. That rail has its own
codecs — they're advanced and live on the [exact low-level page](/reference/exact-lowlevel/);
here's the map:

| Function / type | Role |
| --- | --- |
| `X402ExactAcceptEntry` | an `exact` rail in `accepts[]`. `extra` and `extra.assetTransferMethod` are both **optional** — absent means the scheme default `'eip3009'`, so read it via `exactTransferMethod(rail)`, never bare ([why](/making-payments/exact-buyer/#the-transfer-method-is-optional--and-usually-absent)). Stated values are the six-value union `'eip3009'`/`'permit2'`/`'svm'`/`'algorand'`/`'aptos'`/`'near'`, plus the family-specific bits: the EVM EIP-712 domain, or the `feePayer` gas sponsor for Solana/Algorand/Aptos/NEAR, + the Solana `tokenProgram` |
| `buildExactSignatureHeader({ accepted, payload })` | frame an `exact` payment for the wire (buyer) — works for every method |
| `parseExactPaymentHeader(value)` | parse an inbound `exact` payment, normalised across v1/v2 (seller) |
| `ParsedExactPayment` | what `parseExactPaymentHeader` returns — a union discriminated on `method` (`'eip3009'` / `'permit2'` / `'svm'` / `'algorand'` / `'aptos'` / `'near'`) |
| `ExactPaymentPayload` / `ExactAuthorizationWire` | the EVM EIP-3009 `{ signature, authorization }` payload |
| `Permit2PaymentPayload` | the EVM Permit2 `{ signature, permit2Authorization }` payload |

`parseExactPaymentHeader` tolerates both the v2 `payment-signature` and the v1 `X-PAYMENT`
shapes, and discriminates each payload shape on `method` (`'eip3009'` → `authorization`,
`'permit2'` → `permit2Authorization`, `'svm'` → `transaction`, `'algorand'` → `paymentGroup`,
`'aptos'` → `transaction` + `senderAuth`, `'near'` → `signedDelegateAction`). The `network`/`asset` it returns are
the client's *claim*, used only to match an offered rail — the gate re-derives every verified field
from its own trusted rail. See [selling the exact rail](/accepting-payments/exact-rail-seller/) and
the [exact buyer path](/making-payments/exact-buyer/).

## Reading a foreign settle result — `parseSettleResponse`

When a PipRail buyer pays a *third-party* `exact` server, that server replies with a standard
SettleResponse rather than a PipRail receipt. `parseSettleResponse` reads it from
`payment-response` (or the v1 fallback) into a `SettleOutcome`:

```ts
import { parseSettleResponse, type SettleOutcome } from '@piprail/sdk'

const outcome: SettleOutcome | null = parseSettleResponse(response)
// → { success: boolean, transaction?, network?, payer?, errorReason? } | null

if (outcome && outcome.success === false) {
  // an explicit rejection — never record a spend on it
  throw new Error(`exact settle rejected: ${outcome.errorReason ?? 'unknown'}`)
}
```

The `success` flag is authoritative, and the distinction is load-bearing: `null` (no settle
body at all) means the server just served the resource — treat it as an affirmative 2xx
settlement. An explicit `success: false` is a real rejection — **never record a spend on it**.
Only a body with a boolean `success` is parsed; anything else returns `null`.

:::caution
`parseSettleResponse` returns the foreign server's *claimed* outcome, not a verified one. It's
how the buyer's exact path tells a real settlement from a phantom one; it does not re-check the
chain. PipRail's own gate proves payments with the on-chain
[`verify()`](/accepting-payments/verifying-payments/).
:::
