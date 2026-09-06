---
title: Mocking the driver
description: Test the protocol layer with no chain at all. Register a fake PaymentDriver via the SPI so the gate and client run against an in-memory network.
sidebar:
  order: 3
---

## Introduction

The whole point of the [PaymentDriver architecture](/concepts/payment-driver-architecture/)
is that `server.ts`, `client.ts`, and `x402.ts` depend **only** on the `PaymentDriver`
contract in `drivers/types.ts`, with zero `viem` and zero `@solana/web3.js`. So to test that protocol
layer you don't need a chain, an RPC, or a wallet: you register a **fake driver** that returns
whatever you want, and drive the gate or client against it.

This is exactly how PipRail's own test suite works: register a fake `ResolvedNetwork`, stub
`globalThis.fetch`, and assert the 402 flow without ever broadcasting. The driver SPI you use
here is the same one documented on the [Driver SPI reference](/reference/driver-spi/).

## Register a fake network

`registerDriver` is a public export. A `PaymentDriver` is just `{ family, resolve() }`, and
`resolve()` hands back a `ResolvedNetwork`, so the minimal fake is one object whose methods
return canned values:

```ts
import { registerDriver, type ResolvedNetwork } from '@piprail/sdk'

const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: 'stellar:pubnet',
  supports: (n) => n === 'stellar:pubnet',
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => 'fake-proof-ref',
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 100000000n, native: 100000000n }),
  recipientReady: async () => ({ ready: 'n/a' }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: '' }),
}

registerDriver({ family: 'stellar', resolve: () => fakeNet })
```

:::note
`detail` is **required** on every `VerifyResult`; `{ ok: false, error }` alone won't type-check.
Use `detail: ''` (or a human string) on the failure branch.
:::

Registering a driver for a family **pre-empts the lazy real one** for that family, so naming
`chain: 'stellar'` now resolves to your fake instead of auto-mounting `@stellar/stellar-sdk`.
The client and gate never know the difference.

:::tip
Pick a family you aren't otherwise testing (here, `stellar`) so the fake can't collide with the
eagerly-registered real EVM driver. Each test runner that isolates the module registry per file
(Vitest does) gets a clean slate, so the registration doesn't leak between files.
:::

## The methods you'll actually stub

You only have to make the methods your test exercises return something sensible. The rest can
stay trivial. These are the ones the protocol layer calls:

| Method | Returns | Used by |
| --- | --- | --- |
| `verify(ref, accept)` | a `VerifyResult`: `{ ok: true, receipt }` or `{ ok: false, error, detail }` | the gate, on the paid retry |
| `send(wallet, accept)` | the proof ref (tx hash / signature) | the client, when it pays |
| `confirm(ref, n)` | `{ height }` once confirmed | the client, after `send` |
| `resolveToken` | the asset's `{ asset, decimals, symbol? }` | budget + symbol checks |
| `describeAsset` | `{ symbol?, decimals } \| null` (null = the SDK doesn't recognise the asset) | budget + symbol checks |
| `balanceOf` / `recipientReady` / `estimateCost` | balances, readiness, gas | [`planPayment()`](/making-payments/plan-payment/) |

`verify` **returns** a `VerifyResult` and never throws for a transient read. So to simulate a
bad proof, return `{ ok: false, error: 'transfer_not_found', detail: '' }`; to simulate a paid
request, return `{ ok: true, receipt }` (a full [`X402Receipt`](/accepting-payments/receipts-and-onpaid/)).
See the [VerifyErrorCode](/errors/verify-error-code/) list for the error strings.

## Drive the gate against it

With the fake registered, a [`createPaymentGate`](/accepting-payments/require-payment-and-gate/)
on that family runs entirely in memory. The gate **parses the proof header first**, so you can't
just hand it an arbitrary string and expect `kind: 'paid'`; an unparseable ref re-issues a fresh
challenge. Build a real proof header from the challenge's own `accepts[]` nonce via
[`buildSignatureHeader`](/reference/wire-codecs/), and point the fake's `verify` at `ok: true`:

```ts
import {
  createPaymentGate,
  registerDriver,
  buildSignatureHeader,
  type ResolvedNetwork,
  type X402Receipt,
} from '@piprail/sdk'
import { expect } from 'vitest'

// A fake that ACCEPTS the proof. Echo the gate's own accept into the receipt.
const okNet: ResolvedNetwork = {
  ...fakeNet,
  verify: async (ref, accept): Promise<{ ok: true; receipt: X402Receipt }> => ({
    ok: true,
    receipt: {
      scheme: 'onchain-proof',
      success: true,
      network: accept.network,
      transaction: ref,
      asset: accept.asset,
      amount: accept.amount,
      payer: 'GPAYER',
      payTo: accept.payTo,
      verifiedAt: new Date().toISOString(),
    },
  }),
}
registerDriver({ family: 'stellar', resolve: () => okNet })

const gate = createPaymentGate({ chain: 'stellar', token: 'native', amount: '0.10', payTo: 'G…' })

// no proof yet → a challenge
const first = await gate.verify(undefined)
expect(first.kind).toBe('challenge')

// build a REAL proof header from the challenge's onchain-proof accept
const { challenge } = await gate.challenge()
const accepted = challenge.accepts.find((a) => a.scheme === 'onchain-proof')!
const header = buildSignatureHeader({
  x402Version: 2,
  accepted,
  payload: { nonce: accepted.extra.nonce, txHash: `0x${'a'.repeat(64)}` },
})

// fake verify returns ok:true → paid
const paid = await gate.verify(header)
expect(paid.kind).toBe('paid')
// → { kind: 'paid', receipt: { scheme: 'onchain-proof', success: true, … }, receiptHeader: '…' }
```

Because the protocol layer re-derives every checked field from the trusted `accept`, you can
also point the fake at a *hostile* server response and assert the gate still refuses. The same
[proof-binding](/concepts/proof-binding/) guarantees hold against a mock.

## Spy on side effects

A fake method is an ordinary function, so wrap it in a spy to assert that a refusal happens
**before** any broadcast, e.g. that the client never calls `send` when a
[payment policy](/spend-controls/payment-policy/) declines:

```ts
import { vi } from 'vitest'

const send = vi.fn(async () => 'fake-proof-ref')
const net: ResolvedNetwork = { ...fakeNet, send }
registerDriver({ family: 'stellar', resolve: () => net })

// ... drive a client whose policy should reject this payment ...
expect(send).not.toHaveBeenCalled()   // refusal beat the side effect
```

## Stub `fetch` for client flows

The client talks HTTP, so a full client test pairs the fake driver with a stubbed
`globalThis.fetch` that returns a `402` carrying your `accepts[]`, then a `200` on the retry.
The fake driver covers the chain side; the fetch stub covers the wire side:

```ts
import { buildChallengeHeader, type X402Challenge } from '@piprail/sdk'

const challengeBody: X402Challenge = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/report' },
  accepts: [
    {
      scheme: 'onchain-proof',
      network: 'stellar:pubnet',
      amount: '1000000', // 0.10 at 7 decimals
      asset: 'native',
      payTo: 'G…',
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.10', symbol: 'XLM' },
    },
  ],
}

globalThis.fetch = vi.fn()
  .mockResolvedValueOnce(
    new Response(JSON.stringify(challengeBody), {
      status: 402,
      headers: { 'payment-required': buildChallengeHeader(challengeBody) },
    })
  )
  .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
```

This is the pattern behind PipRail's [local verification](/testing/local-verification/) tests.
When you want to prove the *real* chain path end to end instead, drop the mock and run a
[live smoke test](/testing/live-smoke-test/).

## Implementing a real driver

The same SPI is how you'd add a genuine new chain family rather than a fake one: implement every
required `ResolvedNetwork` method for your chain, return it from a `PaymentDriver.resolve()`, and
call `registerDriver`. There are six optional methods, all of which may be omitted:
`resolveExactRail`, `payExact`, `settleExactSelf`, `exactDomain`, `exactPermit2Supported`, and
`discoverySigner`. The exact-rail methods (`resolveExactRail` / `payExact` / `settleExactSelf`)
are implemented by EVM, Solana, Algorand, Aptos, NEAR and XRPL today (`exactPayableAsset` by XRPL alone), while `exactDomain` / `exactPermit2Supported` are
EVM-specific. The full contract, every method's error behaviour and which are optional, is the
[Driver SPI reference](/reference/driver-spi/).
