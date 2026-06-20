---
title: The upto rail — metered billing (seller)
description: Charge a variable amount up to a signed maximum — the buyer authorizes a ceiling, you serve, meter the actual usage, and self-settle exactly what was used. EVM-Permit2, backendless, no fee.
sidebar:
  order: 8
---

## Introduction

PipRail gates default to the `onchain-proof` scheme (the client pays first, then proves it) and can
[dual-advertise the ratified `exact` scheme](/accepting-payments/exact-rail-seller/) (the client signs
a *fixed* amount, someone else broadcasts). The ratified x402 **`upto`** scheme is the metered third
option: the buyer signs an authorization for a **maximum**, you serve the resource and measure the
*actual* usage, then settle exactly that (`actual ≤ max`) — billing what was consumed, not a flat
price.

That makes it the right rail for **usage-based** APIs where you don't know the price until you've done
the work:

- **per-token LLM billing** — sign a ceiling covering the worst-case completion, settle on the tokens
  actually generated;
- **per-call / per-query metering** — a data API that charges by rows returned or bytes served;
- **pay-per-compute** — a render/transcode/inference endpoint priced on the resources a job consumes.

The model is **"sign a MAX, settle the actual."** The buyer signs **once** (a Permit2 authorization for
the ceiling — **zero gas**, broadcasts nothing); you serve + meter; then you **self-settle** the metered
actual through the canonical on-chain `x402UptoPermit2Proxy` **from your own relayer** (which is the bound
`witness.facilitator` — no third-party facilitator). Backendless, no fee, no custody: the funds land at
your `payTo`, verified against your own RPC.

:::note[EVM-Permit2 only]
`upto` is **EVM-Permit2 only** — the spec bans EIP-3009 (it fixes the amount at sign time) and has no
non-EVM variant. It works on any ERC-20 on a chain where the `x402UptoPermit2Proxy` is deployed
(Ethereum, Base, Arbitrum, Optimism, Polygon, BNB), **never** a native coin or a non-EVM family. It is
**self-settle only** in v1 (no facilitator mode — your relayer settles). Omitting `upto` leaves the
challenge byte-identical to before.
:::

## Configuring the gate

You opt in by passing an `upto` block to [`createPaymentGate`](/accepting-payments/require-payment-and-gate/).
The top-level `amount` becomes the **MAXIMUM ceiling** the buyer authorizes; `upto.settleAmount` is the
callback that picks the actual charge after serving.

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.50',                          // ← the MAXIMUM the buyer signs for
  payTo: '0xYourWallet',
  upto: {
    relayer: { key: process.env.RELAYER_KEY }, // your gas key = the bound facilitator
    settleAmount: (ctx) => meterUsage() * PRICE_PER_UNIT, // the ACTUAL, after serving
  },
})
```

The `relayer` is **your gas-paying key**, and it is the **bound facilitator**: the buyer signs your
relayer's address into `witness.facilitator`, and the on-chain proxy enforces `msg.sender ==
witness.facilitator` — so **only your relayer can settle** this authorization (any other sender reverts
`UnauthorizedFacilitator`). That is what keeps it backendless: no third party is involved, you broadcast
the settle yourself. Pass `{ key }` (a `0x…` private key) or bring your own viem signer with
`{ walletClient }`.

:::caution[Use `{ key }`, never `{ privateKey }`]
The relayer wallet uses the **unified `key` field** (`{ key: '0x…' }`). A pre-v2 field name like
`{ privateKey }` (or `secretKey` / `seed` / `mnemonic`) throws
[`WrongFamilyError`](/errors/error-hierarchy/) with a message pointing you at `{ key }`. Unlike the
exact rail, the relayer here **may equal `payTo`** — the proxy binds `witness.to` (the recipient)
separately from `witness.facilitator` (the settler), so one account can both receive and settle.
:::

## The metering callback — `settleAmount(ctx)`

`settleAmount` is called **after** the buyer's authorization is verified against the signed MAX, with the
metered context, and returns the actual charge:

```ts
settleAmount: (ctx: {
  maxAmount: bigint   // the signed ceiling, base units (e.g. 500000n for 0.50 USDC @ 6dp)
  asset: string       // the token contract address (or 'native' — but native never carries upto)
  network: Caip2      // the CAIP-2 network id, e.g. 'eip155:8453'
  decimals: number    // the token's decimals (6 for USDC)
  request?: unknown   // the raw decoded payment payload, when present (A2A / verifyObject path)
}) => bigint | string | Promise<bigint | string>
```

It may be **sync or async**, and you can return the actual in any of these forms — the gate normalises
each to base units, **clamps to `≤ maxAmount`**, and rejects an over-max return defensively
(`upto_settle_exceeds_max`):

| Return | Meaning | Example (USDC, 6dp, max `0.50`) |
| --- | --- | --- |
| `bigint` | raw base units, used verbatim | `120000n` → settle 0.12 |
| `"NN%"` | that **percent of the max**, **FLOORED** | `"50%"` → 0.25 · `"33.333333%"` floors to 33.3333% |
| `"$X"` | a fiat-style decimal at the token's decimals | `"$0.02"` → 0.02 |
| plain integer string | raw atomic units (same as a `bigint`) | `"1858"` → 0.001858 |
| plain decimal string | scaled by the token's decimals | `"0.12"` → 0.12 |
| `0n` / `"0"` | **zero-charge** — a synthetic receipt with **no on-chain tx**, no gas | nothing settles |

A return the gate can't parse (NaN, a malformed string, a negative `bigint`) is treated as a **merchant
bug**: the gate releases the Permit2 nonce and rejects with `upto_settle_exceeds_max` so the buyer's
still-valid authorization can be re-presented after you fix the callback — it is **not** raised as a
settlement (5xx) failure.

### Worked example — per-token LLM billing

Sign a ceiling that covers the worst-case completion, then bill the tokens actually generated:

```ts
const PRICE_PER_1K_TOKENS = 200n // base units (USDC, 6dp) per 1000 output tokens → $0.0002/1k

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.50', payTo: '0xYourWallet', // MAX = 0.50 USDC
  upto: {
    relayer: { key: process.env.RELAYER_KEY },
    settleAmount: () => (tokensGenerated() * PRICE_PER_1K_TOKENS) / 1000n, // a bigint, base units
  },
})
```

### Worked example — percentage of the ceiling

When the work is naturally a fraction of a quota (e.g. "you used 30% of the batch you reserved"):

```ts
upto: {
  relayer: { key: process.env.RELAYER_KEY },
  settleAmount: ({ maxAmount }) => `${usedFraction() * 100}%`, // e.g. "30%" → 30% of MAX, floored
}
// maxAmount is in scope if you'd rather compute the bigint yourself: maxAmount * 30n / 100n
```

## The lifecycle

```
challenge ─► buyer signs the MAX ─► you serve + meter ─► gate.verify() settles the actual ─► receipt
(amount = MAX)   (zero gas, no       (compute usage)      (your relayer broadcasts the         (amount =
                 broadcast)                                proxy settle, actual ≤ MAX)          ACTUAL)
```

1. **Challenge.** The gate dual-advertises the `upto` rail beside `onchain-proof`. The `upto` accept
   carries `amount` = the MAX ceiling (base units) and `extra.facilitatorAddress` = your relayer's
   address (the value the buyer signs into `witness.facilitator`).
2. **Buyer signs the MAX.** The buyer signs a Permit2 `PermitWitnessTransferFrom` over `amount` as the
   maximum — **zero gas, broadcasts nothing.** (One-time `approve(Permit2)` aside, the same as the
   exact-Permit2 rail.)
3. **You serve + meter.** You do the work and figure out the usage.
4. **`gate.verify()` settles the actual.** The gate verifies the signature against the signed MAX, calls
   your `settleAmount`, then **self-settles the actual (`≤ max`)** by broadcasting the proxy's
   `settle(permit, amount, owner, witness, signature)` from your relayer — `amount` is the metered
   actual, `permit.permitted.amount` stays the MAX.
5. **Receipt.** A receipt whose `scheme` is `'upto'` and whose **`amount` is the ACTUAL settled amount**
   (the buyer reads this back to record metered spend). A zero-charge settle has `transaction: ''`.

## The supported shape — call `gate.verify()` directly and meter inside `settleAmount`

Because settlement happens **after** you know the usage, `upto` inverts PipRail's usual
verify → settle → serve order. The supported handler shape is: receive the request → serve/compute
enough to know the usage → `await gate.verify(header)` whose **`settleAmount` callback returns the
metered actual** → write the body. You compute usage **inside** the callback.

```ts
// any framework — a minimal Node HTTP handler:
async function handle(req, res) {
  const header = req.headers['payment-signature']

  // No proof yet → return the 402 challenge (dual-advertises upto + onchain-proof).
  if (!header) {
    const { challenge, requiredHeader } = await gate.challenge(req.url)
    res.writeHead(402, { 'payment-required': requiredHeader, 'content-type': 'application/json' })
    return res.end(JSON.stringify(challenge))
  }

  // Serve/compute FIRST so the metered usage is known…
  const completion = await generate(req)

  // …then verify + settle. settleAmount() runs HERE, billing the actual usage.
  const result = await gate.verify(header)
  if (result.kind === 'paid') {
    res.writeHead(200, { 'payment-response': result.receiptHeader, 'content-type': 'application/json' })
    return res.end(JSON.stringify(completion))
  }
  // 'challenge' (no/garbage proof) or 'invalid' (rejected proof) both carry a fresh re-challenge.
  res.writeHead(402, { 'payment-required': result.requiredHeader, 'content-type': 'application/json' })
  res.end(JSON.stringify(result.challenge))
}
```

The `settleAmount` callback is where you read the metered usage on this direct path — it's just the
arbitrary merchant code that runs inside `gate.verify()`.

:::caution[`requirePayment` (the Express middleware) does NOT support `upto`]
[`requirePayment`](/accepting-payments/require-payment-and-gate/) calls `gate.verify()` and *then* hands
off to your route handler with `next()` — so settlement would happen **before** the handler serves, when
the metered usage isn't known yet. There is no post-serve hook (a `res.on('finish')` settle fires after
the body is flushed — too late to influence it). So constructing `requirePayment({ upto })` **throws at
construction** with an actionable [`UnsupportedSchemeError`](/errors/error-hierarchy/)
(`.code === 'UNSUPPORTED_SCHEME'`). Use `createPaymentGate` + `gate.verify()` directly and meter inside
`settleAmount`, as above. (Onchain-proof and exact gates are unaffected.)
:::

## Guarantees and security

- **The actual never exceeds the signed MAX.** The gate rejects a `settleAmount > permitted.amount`
  **before** broadcast (`upto_settle_exceeds_max`), and the on-chain proxy enforces `amount <=
  permit.permitted.amount` as a redundant second guard (`AmountExceedsPermitted`).
- **Strict `permitted === max` at verify time.** The buyer must sign **exactly** the advertised ceiling.
  The gate rejects a permit **below** the max (`amount_too_low`) *and* a permit **above** it
  (`upto_settle_exceeds_max`). (The spec's settle step uses `<=`, but its verify step requires
  `permitted.amount` to *equal* the requirement — so an over-permit can't sneak the exposure above what
  the buyer was shown. PipRail's own buyer signs `accept.amount` verbatim, so an honest flow never
  trips this.)
- **The signature is always re-verified against the signed MAX**, never the metered `settleAmount` —
  verifying against the actual would reject every partial settle.
- **Only your relayer can settle, only to your `payTo`.** The gate checks `witness.facilitator ===
  relayer.address` and `witness.to === payTo` against its **trusted rail** (never the client's echo)
  before broadcasting; the proxy enforces both on-chain.
- **Replay is single-use.** The buyer's Permit2 **nonce is claimed before metering**, so even a
  zero-charge burns it. A **settle failure releases the nonce** (the buyer's still-valid authorization
  can be re-presented); a **settle success burns it** (at-most-once). A re-present of a settled nonce
  returns `tx_already_used`. Multi-instance deploys share state through the same
  [`isUsed` / `markUsed`](/accepting-payments/replay-protection/) hooks as `onchain-proof`.
- **No sponsor-fee-drain cap needed.** Unlike the non-EVM fee-payer rails, the EVM relayer **broadcasts**
  the settle and **sets the gas at broadcast time** — the buyer's signed witness carries no fee field, so
  there's nothing a buyer could inflate to drain the relayer. (Contrast the
  [exact rail's fee-drain guard](/accepting-payments/exact-rail-seller/#sponsor-protection--the-fee-drain-guard)
  on Solana/Algorand/Aptos/NEAR.)
- **A genuine broadcast failure is a 5xx.** If your relayer can't broadcast or confirm, the gate throws a
  [`SettlementError`](/errors/error-hierarchy/) (return 5xx in your adapter) — the buyer's authorization
  stays valid and its nonce unused, so they can retry once you fund/fix the relayer. A merchant-callback
  error (a thrown or unparseable `settleAmount`) instead releases the nonce and rejects so the buyer can
  re-present.

## Supported chains and the proxy

The `upto` scheme can settle only where **both** the canonical Permit2 **and** the
`x402UptoPermit2Proxy` are deployed. As of writing that is **Ethereum, Base, Arbitrum, Optimism,
Polygon, and BNB** (`UPTO_PROXY_CHAIN_IDS` = `{1, 8453, 42161, 10, 137, 56}`; the proxy is a
permissionless CREATE2 deploy, so the set grows as it lands on more chains). The proxy is the **same
CREATE2 address on every chain** it's deployed to:

```
x402UptoPermit2Proxy = 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002
```

(Note `…0002`, vs the exact-Permit2 proxy's `…0001`.) Requesting `upto` on a chain without the proxy
— or on a native coin / non-EVM family — **throws** at gate construction (an explicit opt-in that can't
be honoured is a config error), naming the offered rails it tried.

## See also

- [Pay the upto rail (buyer)](/making-payments/upto-buyer/) — the client side: opt in, sign the MAX,
  and budget against it.
- [`requirePayment` & `createPaymentGate`](/accepting-payments/require-payment-and-gate/) — the gate API
  and why `requirePayment` can't carry `upto`.
- [The exact rail (seller)](/accepting-payments/exact-rail-seller/) — the *fixed*-amount sibling, and the
  fee-drain guard on the non-EVM fee-payer rails.
- [Verifiable receipts (seller)](/accepting-payments/verifiable-receipts/) — emit a re-verifiable receipt
  on every settled `upto` payment.
