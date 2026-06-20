---
title: Verifying receipts (anyone)
description: Capture the receipt from a paid fetch (lastReceipt) and re-verify ANY PipRail receipt against the chain — static, wallet-free, never trusting the receipt's claims. Plus the optional EIP-712 attestation check.
sidebar:
  order: 11
---

## Introduction

A [verifiable receipt](/accepting-payments/verifiable-receipts/) is a self-contained
`PipRailReceipt` the buyer keeps and **anyone** re-verifies against the chain — with only an
RPC. It never trusts the issuer: `verifyReceipt` re-reads the settlement transaction and
re-derives the recipient, asset, and payer itself.

## Capture — `client.lastReceipt()`

After a paid `fetch`, the buyer's client holds the receipt the gate emitted:

```ts
const res = await client.fetch('https://api.example.com/report')
const receipt = client.lastReceipt() // PipRailReceipt | null (null if the gate emitted none)
// keep it: it's a portable, third-party-verifiable proof of purchase
```

The client stamps the receipt's `resource.url` with the URL it actually fetched (authoritative
over the gate's default). It's pure — no chain read.

## Re-verify — `PipRailClient.verifyReceipt()`

The anyone-can-run primitive. **Static** and **wallet-free** — a third party verifies with only
a chain + RPC, no PipRail account:

```ts
import { PipRailClient } from '@piprail/sdk'

const v = await PipRailClient.verifyReceipt(receipt) // or { rpcUrl } for a custom chain
// { ok, onChain: { payTo, asset, amount, payer }, matchesClaims, ageSeconds, error? }
```

It re-reads `receipt.transaction` through the receipt's own network driver and re-derives the
on-chain fields, **ignoring the receipt's claims**:

- **`ok`** — the chain confirms the settlement (at least `amount` of `asset` moved to `payTo`).
  A forged `payTo`/`asset`, or an `amount` claimed *above* what actually moved, makes `ok` false.
- **`onChain.payer`** — genuinely **re-derived from the tx**. A forged claimed `payer` surfaces as
  `matchesClaims: false` even when `ok` is true.
- **`onChain.amount`** — a **verified lower bound**: the chain confirms *at least* this much moved
  (drivers threshold-check `paid >= required`, then echo the accept amount). It is not a re-derived
  exact settled figure.
- **`error`** — a closed [`VerifyErrorCode`](/reference/api/) when `ok` is false.

`verifyReceipt` **never throws** — an RPC error, an unknown network, or a malformed receipt all
return `{ ok: false }`.

:::note[The nonce matters for memo-bound families]
The five **Template-A** families — **Stellar, XRPL, NEAR, Algorand, TON** — bind the payment to
the challenge **nonce** carried in a memo/note/comment. A receipt from those chains carries that
`nonce` so `verifyReceipt` can re-run the memo match off-chain; a receipt that lost its `nonce`
can't be re-verified on those families. The five **Template-B** families (EVM, Solana, Tron, Sui,
Aptos, and native coins) verify on the `transaction` alone. (NEAR's ref is reconstructed as
`<payer>:<transaction>` automatically.)
:::

:::caution[Durability is family-split]
Re-verification is **durable** for digest-bound (Template-B) families — EVM, Solana, Tron, Sui,
Aptos, native coins: the driver reads the tx by hash/digest, so a months-old receipt re-verifies
for as long as the chain/RPC serves the tx. It is **recency-bounded / best-effort** for the four
**account-watch** families — **Stellar, XRPL, Algorand, TON**: their drivers scan only the
merchant account's most-recent transactions, so a receipt older than that scan window returns
`transfer_not_found` even though it once settled. `ageSeconds` is reported for information; it is
never itself a validity gate.
:::

## The Tier-2 attestation — `PipRailClient.verifyAttestation()`

If the merchant signed a Tier-2 delivery attestation (EVM), check it separately:

```ts
const a = await PipRailClient.verifyAttestation(receipt)
// { ok: boolean, signer?: string, reason?: string }
```

It recovers the EIP-712 signer and checks `recover === payTo`. This is the classic EIP-712 footgun
handled for you: recovery never throws on a bad signature (it returns a *wrong* address), so the
real check is the equality — a tampered attestation returns `{ ok: false }`, never an exception.

## From an agent — `piprail_verify_receipt`

The [MCP server](/mcp/) exposes the same primitive as a read-only, key-less tool: hand it a
`PipRailReceipt` (from a prior `piprail_pay_request` result, or any third party) and it returns the
chain-recovered verdict — no wallet required.
