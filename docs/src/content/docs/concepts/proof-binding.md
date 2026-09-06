---
title: Proof binding
description: How a payment proof is cryptographically tied to the challenge that asked for it, so it can't be replayed or forged across chains.
sidebar:
  order: 3
---

## Introduction

A payment proof must be bound to the exact challenge that asked for it. Otherwise a stranger's
payment, or your own earlier one, could be replayed to unlock a resource it never paid for.
PipRail solves this two ways, and **every driver uses one of them**. Both end at the same bar:
the transfer exists, succeeded, is recent, and moved at least the required amount of the right
asset to `payTo`.

The cornerstone, in every family: `verify()` re-derives every checked field from the **trusted
`accept`** the server issued, never from the client-supplied ref. A forged echo has nothing to
redirect.

## Template A: memo/nonce-bound

For families where you can read an account's recent history (Stellar, XRPL, NEAR tokens,
Algorand, TON), the challenge nonce rides **inside the signed transaction**, in a memo, note, or
comment, and `verify()` finds the one transaction on the merchant account that carries it.

The nonce is part of the challenge the server issued. It lives on `accept.extra.nonce`, while
the recipient is the top-level `accept.payTo`:

```ts
// X402AcceptEntry the server signs; the client commits accept.extra.nonce into the tx.
accept.extra.nonce        // the per-challenge nonce (under `extra`, not top-level)
accept.payTo              // re-derived here: the account verify() reads, not the client's ref
```

On Stellar, the memo is `sha256(nonce)` as a `MEMO_HASH`; the verifier reads the merchant's
recent transactions and matches it, then confirms the payment op:

```ts
// drivers/stellar/verify.ts: bind to THIS challenge by memo, then confirm the payment
const tx = txs.find(
  (t) => t.memo_type === 'hash' && typeof t.memo === 'string' && wantMemo.includes(t.memo)
)
if (!tx) return notFound(nonce)
```

Because the nonce is committed inside a transaction the payer signed, a stranger's payment can't
satisfy a different challenge, and an old payment can't satisfy a new one. That binding, plus
the gate's single-use proof set, is the anti-replay guarantee.

## Template B: digest-bound

For families with a transaction hash you can look up directly, the proof **is** the tx
hash/digest. There's no nonce in the transaction; binding comes from reading that exact
transaction and holding it to three gates: recipient + amount + asset, a recency window, and the
gate's single-use proof set. This covers EVM, Solana, Tron, Sui and Aptos, **including their native
coins**, plus **native NEAR**.

On EVM, the verifier reads the receipt, checks confirmations, enforces the replay window, then
sums the ERC-20 `Transfer` logs to `payTo`:

```ts
// drivers/evm/verify.ts: `payTo` and `asset` come from accept, not the client ref
const transferred = sumTransfersTo(receipt.logs, asset, payTo)
if (transferred.total < requiredAmount) {
  return { ok: false, error: 'transfer_not_found', detail: `No ERC-20 Transfer of >= ${requiredAmount} (token ${asset}) to ${payTo} in ${txHash}.` }
}
```

The recency window is what stops a replay of an old, genuine payment to the same address.
`maxTimeoutSeconds` is top-level on the trusted `accept`:

```ts
const ageSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp)
if (ageSeconds > accept.maxTimeoutSeconds) {
  return { ok: false, error: 'payment_expired', detail: `Payment is ${ageSeconds}s old.` }
}
```

Recency **fails closed**: if the on-chain timestamp is missing or non-finite (`NaN`/`Infinity`, e.g.
a degraded RPC), `verify()` can't *bound* the age, so it returns `payment_expired` rather than
skipping the check. This holds uniformly across every digest- and memo-bound driver, because a window that
fails *open* would let an aged-out proof replay once the used-proof set evicts its entry.

Re-using the *same* tx hash twice is caught one level up by the payment gate's used-proof set;
see [Replay protection](/accepting-payments/replay-protection/).

## Which template each family uses

The native coin doesn't always follow the chain's token path: on Stellar, XRPL, Algorand, and
TON, the nonce rides in a memo/note/comment for the native coin too, so those stay memo-bound.
NEAR is the one family that uses **both**: its NEP-141 token path is memo-bound, while native
NEAR is digest-bound (by tx hash).

| Family | Template | What binds the proof |
| --- | --- | --- |
| EVM, Solana, Tron, Sui, Aptos | B, digest | tx hash + recipient + amount + recency window + single-use set (native coin included) |
| NEAR (native) | B, digest | tx hash + recipient + amount + recency |
| NEAR (tokens) | A, memo | `memo` in the `ft_transfer` event = nonce |
| Stellar | A, memo | `MEMO_HASH` = `sha256(nonce)` on the merchant account (XLM + issued assets) |
| XRPL | A, memo | nonce in a `Memo`, on a `Payment` to `payTo` (XRP + IOUs) |
| Algorand | A, memo | nonce in the transaction's note field (native ALGO + ASA alike) |
| TON | A, memo | nonce in the transfer comment (native Gram + jettons) |

## verify() always re-derives from the trusted accept

This is the rule that makes binding hold. The verifier reads `accept.payTo`, `accept.asset`,
`accept.amount`, and `accept.extra.nonce`, all from the challenge the server signed, and
matches the on-chain transaction against those. The client's ref only points at *which*
transaction to inspect; it can never change *what* is checked.

```ts
// Every driver: every checked field comes from `accept`, the trusted side.
const required = BigInt(accept.amount)   // base units, already scaled by decimals
const payTo    = accept.payTo            // top-level on X402AcceptEntry
const nonce    = accept.extra.nonce      // under `extra`. Template A families bind to it
```

A failed binding returns a typed [`VerifyErrorCode`](/errors/verify-error-code/):
`transfer_not_found`, `amount_too_low`, `wrong_recipient`, or `payment_expired`, never a
throw. (A transient RPC read maps to `tx_not_found` instead, so a node hiccup never reads as a
forged payment.)

## Per-family gotchas

A few families need a twist on the template. These are load-bearing details, not trivia.

**TON settles asynchronously.** Value moves across contracts, so there is no single tx hash that
"is" the payment. The proof ref is a self-contained locator (`ton:<jetton-wallet>|<nonce>`); the
verifier reads the merchant's **jetton wallet** (derived from the official jetton master, so a
look-alike jetton can't match) for the incoming `internal_transfer` carrying the nonce in its
forward comment. A jetton credit also only counts if that wallet **actually executed the transfer**:
`verify()` requires a successful `vm` compute phase, which rejects a forged `internal_transfer` body
sent to a *not-yet-deployed* jetton wallet (it lands without running and credits nothing). Native
TON is read from the incoming message's value + text comment to `payTo`: the same memo binding, no
jetton wallet, and exempt from the compute-success check (value moves on delivery).

**XRPL compares `delivered_amount`, not `Amount`.** A successful Payment using `tfPartialPayment`
can advertise a large `Amount` but actually deliver almost nothing, a known theft vector. The
verifier compares against what was *delivered*:

```ts
// drivers/xrpl/verify.ts: partial-payment guard
const paid = deliveredBaseUnits(tx.delivered_amount, wantAsset, accept.extra.decimals)
if (paid < required) {
  return { ok: false, error: 'amount_too_low', detail: `Delivered ${paid}, required ${required}.` }
}
```

**Tron verifies on the solidity (confirmed) node.** An unconfirmed or unknown tx reads as
not-found, so finality is the gate. `getTransactionInfo` only returns once the tx has
solidified.

**NEAR has no clean account-history RPC**, so it verifies by tx hash and scans the trusted token
contract's transfer logs. Only logs emitted by a receipt whose executor is the **trusted token
contract** (`accept.asset`) count, so a look-alike contract emitting a fake `EVENT_JSON` can't
satisfy the check, and the `memo` must equal the freshly-issued nonce.

```ts
// drivers/near/verify.ts: provenance + nonce binding
for (const r of tx.receipts) {
  if (r.executorId !== accept.asset) continue            // trusted contract only
  // …match new_owner_id === accept.payTo && memo === nonce
}
```

:::note
A transient RPC read failure is never reported as "no payment." It maps to `tx_not_found` (the
retryable bucket), so a node hiccup can't make a real payment look forged. The built-in client
retries every code with a short backoff to absorb RPC lag.
:::
