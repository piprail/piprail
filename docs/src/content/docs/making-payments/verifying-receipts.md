---
title: Verifying receipts (anyone)
description: Capture the receipt from a paid fetch (lastReceipt) and re-verify ANY PipRail receipt against the chain — static, wallet-free, never trusting the receipt's claims. Plus the optional EIP-712 attestation check, with a worked end-to-end and a forged-receipt example.
sidebar:
  order: 11
---

## Introduction

A [verifiable receipt](/accepting-payments/verifiable-receipts/) is a small, self-contained
`PipRailReceipt` the buyer keeps after a paid request. Its defining property: **anyone** can
re-verify it against the chain with only an RPC — no key, no backend, no PipRail account, and *no
trust in whoever handed it over*. `verifyReceipt` re-reads the settlement transaction and re-derives
the recipient, asset, and payer itself; the receipt's own claims are never believed.

This page is the read side of the [seller's emit side](/accepting-payments/verifiable-receipts/):
capture the receipt, re-verify its Tier-1 chain grounding, and (optionally) check its Tier-2
delivery attestation.

## Capture — `client.lastReceipt()`

After a paid `fetch`, the buyer's client holds the receipt the gate emitted:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.AGENT_KEY! } })

const res = await client.fetch('https://api.example.com/report')
const receipt = client.lastReceipt() // PipRailReceipt | null
// `null` when the last settled fetch carried no receipt (the gate's `receipts` option was off),
// or no payment has settled yet. Keep it — it's a portable, third-party-verifiable proof of purchase.
```

`lastReceipt()` is **pure** — no chain read. The client captures the receipt from the
`PAYMENT-RESPONSE` header and stamps `resource.url` with the URL it actually fetched (authoritative
over the gate's default `''`). The shape is the self-contained bundle:

```ts
interface PipRailReceipt {
  piprail: '1'                  // receipt-format version (distinct from x402Version)
  receipt: X402Receipt          // the verified settlement (carries the challenge `nonce`)
  resource: { url: string }     // what was paid for
  decimals?: number             // the asset's on-chain decimals (Stellar/XRPL/TON re-scale by it)
  attestation?: SignedReceipt   // the OPTIONAL Tier-2 attestation — present only if the merchant signed
}
```

Everything a third party needs to rebuild the trusted accept and re-run the driver's `verify()` is in
that one object — which is the whole point: it travels.

## Re-verify Tier-1 — `PipRailClient.verifyReceipt()`

The anyone-can-run primitive. **Static** (called on the class, not an instance) and **wallet-free** —
a third party verifies with only a chain + RPC, no PipRail account, no key:

```ts
const v = await PipRailClient.verifyReceipt(receipt)           // default RPC for the receipt's chain
// or, with a custom endpoint:
const v2 = await PipRailClient.verifyReceipt(receipt, { rpcUrl: 'https://my-base-rpc…' })
```

It re-reads `receipt.receipt.transaction` through the receipt's *own* network driver (resolved from
the CAIP-2 `network`, auto-mounted) and re-derives the on-chain fields, **ignoring the receipt's
claims**. Internally it rebuilds a synthetic trusted `accept` from the receipt and runs the exact
same `verify()` the gate ran — so the chain, not the receipt, is the authority. The return is a
`ReceiptVerification`:

```ts
interface ReceiptVerification {
  ok: boolean                    // the chain confirms the settlement (≥ amount of asset moved to payTo)
  onChain: { payTo: string; asset: string; amount: string; payer: string } // re-derived from the tx
  matchesClaims: boolean         // does the re-derived on-chain payer equal the receipt's claimed payer?
  ageSeconds: number             // informational age since verifiedAt — NOT a validity gate
  error?: VerifyErrorCode        // the closed code when ok is false
}
```

What each field means:

- **`ok`** — the chain's confirmation that the settlement is real: at least `amount` of `asset`
  genuinely moved to `payTo`. A forged `payTo`/`asset`, or an `amount` claimed *above* what actually
  moved, makes the driver's `verify()` fail → `ok: false`.
- **`onChain.payer`** — the one field **genuinely re-derived from the tx** (the rest are pinned by
  the synthetic accept the chain validated against). A forged claimed `payer` surfaces as
  `matchesClaims: false` even while `ok` stays `true` — the payment is real, but it didn't come from
  who the receipt claims.
- **`onChain.amount`** — a **verified lower bound**, not a re-derived exact figure. Drivers
  threshold-check `paid >= required`, then echo the accept amount, so `ok: true` means *at least* this
  much moved.
- **`ageSeconds`** — informational only. It is **never** a validity gate (verifyReceipt uses a
  ~100-year synthetic window precisely so a driver's `payment_expired` branch can't fire on a
  legitimately old receipt).
- **`error`** — a closed [`VerifyErrorCode`](/errors/verify-error-code/) (e.g. `tx_not_found`,
  `transfer_not_found`, `amount_too_low`) when `ok` is false.

`verifyReceipt` **never throws**. An RPC error, an unknown network, an unmounted driver, or a
malformed/foreign receipt all return a structured `{ ok: false, error }` — so a verifier can call it
on untrusted input without a `try/catch`.

:::note[The nonce matters for memo-bound families]
The five **Template-A** families — **Stellar, XRPL, NEAR, Algorand, TON** — bind the payment to the
challenge **nonce** carried in an on-chain memo/note/comment, not in the tx digest. To re-verify,
`verifyReceipt` re-scans the merchant account for that exact nonce — so it reads it from
`receipt.receipt.nonce`, which the gate stamps onto the receipt automatically. A Template-A receipt
that *lost* its nonce can't be re-verified. The five **Template-B** families (EVM, Solana, Tron, Sui,
Aptos, and native coins) verify on the `transaction` alone, so the nonce is informational there.
(NEAR's verify decodes a `<payer>:<transaction>` ref; `verifyReceipt` reconstructs that composite
from the receipt's payer + tx automatically — you pass nothing.)
:::

:::caution[Durability is family-split]
Re-verification is **durable** for digest-bound (Template-B) families — EVM, Solana, Tron, Sui,
Aptos, native coins: the driver reads the tx by hash/digest, so a months-old receipt re-verifies for
as long as the chain/RPC serves the tx. It is **recency-bounded / best-effort** for the four
**account-watch** families — **Stellar, XRPL, Algorand, TON**: their drivers scan only the merchant
account's most-recent transactions, so a receipt older than that scan window returns
`transfer_not_found` even though it once settled.
:::

### Catching a forgery

`ok` and `matchesClaims` separate two different lies, and you usually want **both**:

```ts
const v = await PipRailClient.verifyReceipt(receipt)

if (!v.ok) {
  // The chain does NOT confirm this settlement — a fabricated tx, a forged payTo/asset,
  // or an over-stated amount. Reject it.
  console.warn(`receipt does not verify on-chain: ${v.error}`)
} else if (!v.matchesClaims) {
  // A REAL payment moved (ok), but its on-chain payer is NOT the one the receipt claims —
  // e.g. someone re-labelled another buyer's settlement as their own.
  console.warn(`payment is real, but payer is ${v.onChain.payer}, not the claimed payer`)
} else {
  console.log(`verified: ${v.onChain.amount} of ${v.onChain.asset} → ${v.onChain.payTo} from ${v.onChain.payer}`)
}
```

A forged `payer` keeps `ok: true` (the payment is genuine) but flips `matchesClaims` to `false`. A
forged `payTo`, `asset`, or inflated `amount` fails the on-chain `verify()` outright → `ok: false`.
Either way, nothing throws.

## Re-verify Tier-2 — `PipRailClient.verifyAttestation()`

If the merchant signed a [Tier-2 service-delivery attestation](/accepting-payments/verifiable-receipts/#tier-2--service-delivery-attestation-evm-only)
(EVM), check it separately — it proves the one thing the chain can't: that the resource was *served*.

```ts
const a = await PipRailClient.verifyAttestation(receipt)
// { ok: boolean; signer?: string; reason?: string }
```

It recovers the EIP-712 signer from the signature over the official `offer-receipt` typed data
(domain `{ name: 'x402 receipt', version: '1', chainId: 1 }`) and checks `recover === receipt.payTo`.
This is the classic EIP-712 footgun handled for you: `recoverTypedDataAddress` never throws on a bad
signature — it returns a *wrong* address — so the **equality** is the real verification. A tampered
attestation recovers some other address → `{ ok: false }`, never an exception.

What you get back:

- **`ok: true`** with **`signer`** — the recovered address equals `payTo`; delivery is attested by the
  key that received the money.
- **`ok: false`** with a **`reason`** — and it never throws:
  - `no-attestation` — the receipt carries no Tier-2 signature (it's Tier-1 only).
  - `signer-mismatch` (with the recovered `signer`) — a tampered or wrong-key signature.
  - `jws-not-loaded` — the attestation is the reserved JWS format (R3, not yet implemented).
  - `invalid-signature` / `verify-failed` — a malformed signature or recovery fault.

Like `verifyReceipt`, it's **static**, **wallet-free**, and viem stays in a lazily-imported EVM
driver chunk (the protocol layer pulls no chain libs).

## Anyone can verify — a third party with only an RPC

Neither method needs the payer, a key, or a PipRail account. Hand a serialized `PipRailReceipt` to a
reviewer, an auditor, or a reputation system, and they verify it cold:

```ts
import { PipRailClient } from '@piprail/sdk'

// `handedReceipt` arrived over email / an attestation feed / a dispute filing — we never paid it.
const v = await PipRailClient.verifyReceipt(handedReceipt, { rpcUrl: process.env.MY_RPC })
const a = await PipRailClient.verifyAttestation(handedReceipt)

const trustworthy = v.ok && v.matchesClaims && a.ok  // settled to payTo, by the claimed payer, served
```

The receipt is the only input; the chain (via the verifier's own RPC) is the only authority.

## Worked end-to-end — capture → verify → attest → catch a forgery

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'base', wallet: { key: process.env.AGENT_KEY! } })

// 1) Pay, then capture the receipt the gate emitted.
await client.fetch('https://api.example.com/report')
const receipt = client.lastReceipt()
if (!receipt) throw new Error('the gate emitted no verifiable receipt (receipts option off)')

// 2) Re-verify Tier-1 against the chain — re-derives, never trusts the claims.
const v = await PipRailClient.verifyReceipt(receipt)
console.log(v.ok, v.matchesClaims)             // true true  — settled to payTo, by us
console.log(v.onChain)                         // { payTo, asset, amount, payer } re-read from the tx

// 3) If the merchant attested delivery (Tier-2), check the signature → payTo.
const a = await PipRailClient.verifyAttestation(receipt)
console.log(a.ok, a.signer)                    // true, 0xMerchant…   (or { ok:false, reason:'no-attestation' } for Tier-1)

// 4) A forged receipt is caught — tamper with the claimed payer.
const forged = { ...receipt, receipt: { ...receipt.receipt, payer: '0xAttacker…' } }
const f = await PipRailClient.verifyReceipt(forged)
console.log(f.ok, f.matchesClaims)             // true  false  — the payment is real, but not from 0xAttacker…
```

## From an agent — `piprail_verify_receipt`

The [MCP server](/mcp/) exposes the same primitive as a read-only, key-less tool: hand it a
`PipRailReceipt` (from a prior `piprail_pay_request` result, or any third party) and it returns the
chain-recovered verdict — no wallet required.

## See also

- [Verifiable receipts (seller)](/accepting-payments/verifiable-receipts/) — the emit side: turn
  receipts on, the two tiers, and the wire shape.
- [PipRailClient](/making-payments/piprail-client/) — the client these methods hang off.
