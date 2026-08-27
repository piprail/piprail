---
title: Paying the upto (metered) rail
description: 'Opt the client into the ratified x402 `upto` scheme so it can pay usage-billed servers — sign a Permit2 authorization for a MAX once (zero gas.'
sidebar:
  order: 8.5
---

## Introduction

By default a [`PipRailClient`](/making-payments/piprail-client/) pays only PipRail's native
`onchain-proof` rail, and can [opt into the standard `exact` scheme](/making-payments/exact-buyer/) (a
*fixed* amount someone else broadcasts). The ratified **`upto`** scheme is the **metered** counterpart:
the server bills a *variable* amount up to a ceiling. You authorize the ceiling once; the merchant serves
the resource, meters the actual usage, and settles exactly that (`actual ≤ max`).

It's the rail behind usage-priced APIs — per-LLM-token billing, per-query data, pay-per-compute — where
the price isn't known until the work is done.

## Opting in

`upto` is **off by default**. Enable it on the constructor (or per call), exactly like `exact`:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'upto'],   // pay PipRail rails AND standard metered (upto) rails
})
```

:::note
`schemes` defaults to `['onchain-proof']`. The zero-config path is byte-identical to before this rail
existed — `upto` is strictly opt-in. `upto` is **EVM-Permit2 only**, so an `upto` rail is selected only
when the 402 names a network your bound EVM chain supports and recognises the token.
:::

What the buyer does: the client signs a **Permit2 authorization for the MAX once** — **zero gas**, and it
**broadcasts nothing**. (After a one-time `approve(Permit2)` the SDK does lazily the first time you pay a
token, every later payment is gasless.) The merchant then self-settles the **actual** it metered. You
sign; you never broadcast.

## Budget against the MAX (the headline)

**A `upto` payment is budgeted, planned, and policy-gated against the signed MAX — not the actual the
merchant later settles.** This is the one rule to internalise, and it is a deliberate **merchant-proof**
design, not an approximation.

The reason: the buyer signs an authorization that lets the merchant settle **anything up to the max**, so
the only amount the *buyer* can prove an upper bound on is the max itself. The merchant's claimed actual
is **untrusted** — a malicious merchant could settle the full max on-chain yet report a tiny settled
amount. So:

- **Per-payment policy** ([`maxAmount`, `tokens`, `chains`](/spend-controls/payment-policy/)) and
  [`planPayment`](/making-payments/plan-payment/) / [`canAfford`](/making-payments/plan-payment/) gate on
  the **MAX**. A `upto` rail is "payable" only when the **full ceiling** fits your leash and your token
  balance — the server *may* charge all of it. (Because the buyer signs and the merchant broadcasts, only
  the **token** balance gates payability — buyer gas is ~0, so an `INSUFFICIENT_GAS` blocker never
  applies on an `upto` rail.)
- **After settle, the cumulative caps debit the authorized MAX.** The lifetime
  [`maxTotal`](/spend-controls/total-budget/), the cross-token grand total
  [`maxTotalPerDenom`](/spend-controls/total-budget/), and the rolling
  [`windowTotal`](/spend-controls/time-envelope/) all advance by the **MAX**, so an **under-reporting
  merchant can never loosen the leash** past your real on-chain exposure.
- **The settled actual is surfaced for reconciliation only.** Each [`SpendRecord`](/spend-controls/spend-ledger/)
  carries `settledBase` / `settledFormatted` — the merchant-claimed actual, **clamped to `≤` the MAX** so
  even the informational figure can't be inflated. It equals the receipt's `amount`. It is **display-only**
  — it never affects a cap.

### Worked example

Sign a MAX of `0.50`; the server meters and settles `0.12`:

```ts
const client = new PipRailClient({
  chain: 'base', wallet: { key: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'upto'],
  policy: { maxTotal: '5.00' },   // lifetime cap, USDC
})

await client.fetch('https://api.example.com/complete')  // signs MAX 0.50; server settles 0.12

const summary = client.spent()
const usdc = summary.byAsset.find((a) => a.symbol === 'USDC')
console.log(usdc?.totalFormatted)        // → '0.50'   (the budget counts the MAX)

const last = summary.records.at(-1)!
console.log(last.amountFormatted)        // → '0.50'   (budgeted MAX — the cap-bearing figure)
console.log(last.settledFormatted)       // → '0.12'   (informational actual, clamped ≤ MAX)
```

After this one payment, `maxTotal` has `4.50` remaining — debited by the **MAX 0.50**, not the **0.12**
the merchant settled. The `0.12` is yours to reconcile against the chain, never to relax the budget.

## The dual-rail preference

When a gate offers **both** `onchain-proof` *and* `upto` and you have both enabled, the client prefers
**`onchain-proof`** — it gathers candidates `onchain-proof` first, then `exact`, then `upto`, and picks
the first one your policy allows, so the default selection is unchanged. To pay a gate over `upto`
specifically, **enable only `upto`** (drop `onchain-proof` from `schemes`):

```ts
// force the metered rail on a dual-rail gate:
await client.fetch(url, { schemes: ['upto'] })
```

(Unlike `exact`, there is no `autoRoute` shortcut that prefers `upto` — its budgeted cost is the *MAX*,
not ~0, so it doesn't automatically win a cheapest-rail race.)

## quote, plan, and pay

[`quote()`](/making-payments/quote/), [`planPayment()`](/making-payments/plan-payment/), and the
`fetch`/`get`/`post` pay path all honour the enabled schemes and analyse `upto` rails when `upto` is on.
On an `upto` rail every read is **against the MAX** (the amount, the policy check, the affordability
check). Paying is the same call as ever — the 402 is handled transparently:

```ts
const url = 'https://api.example.com/complete'

const plan = await client.planPayment(url)   // analyses the upto rail against the MAX
if (!plan) {
  await client.fetch(url)         // not gated — fetch it for free
} else if (plan.payable) {        // payable ⇒ the full MAX fits your leash + balance
  const res = await client.fetch(url, { schemes: ['upto'] })
  const data = await res.json()   // the gated response, paid for via upto
} else {
  console.log(plan.fundingHint)   // one-line: what to top up (sized to the MAX)
}
```

`planPayment()` returns `null` when the URL isn't payment-gated, so null-guard it before reading
`payable`.

### What you get back

`client.fetch` returns the merchant's normal `Response` once the payment settles. The settlement
[receipt](/making-payments/verifying-receipts/) has `scheme: 'upto'` and an **`amount` equal to the
ACTUAL** the merchant settled (a zero-charge settle has `transaction: ''`). The client records that
actual on the spend record's `settledBase` / `settledFormatted` (clamped `≤` MAX) — while the **budget**
already debited the MAX. Read the latest receipt with [`client.lastReceipt()`](/making-payments/verifying-receipts/).

## Failure modes

The `upto` pay path is the conservative sign-once path, like `exact`: the buyer signs **one** Permit2
authorization (a fresh nonce) and the **same** header is re-presented on every retry — it never re-signs
a fresh nonce.

- A **transport error or timeout** after the authorization is submitted throws
  [`PaymentTimeoutError`](/errors/error-hierarchy/) carrying the Permit2 **nonce** as `.ref` — the
  merchant may have already settled, so verify on-chain and **never re-pay**.
- A **definitive rejection** (`success: false`) throws
  [`MaxRetriesExceededError`](/errors/error-hierarchy/) — fix the cause, then re-present the **same**
  signed authorization (the same nonce), never a fresh one.
- A `5xx` is returned as-is: a server-side settle failure leaves your authorization valid and its nonce
  unused, so nothing is recorded as spent.

```ts
import { PipRailClient, PaymentTimeoutError, MaxRetriesExceededError } from '@piprail/sdk'

try {
  await client.fetch(url, { schemes: ['upto'] })
} catch (err) {
  if (err instanceof PaymentTimeoutError || err instanceof MaxRetriesExceededError) {
    // .ref is the Permit2 nonce — check it on-chain, re-present the SAME authorization, do NOT re-pay
    console.log('recover with this authorization nonce:', err.ref)
  } else {
    throw err
  }
}
```

If a 402 offers **only** an `upto` rail and your bound family can't pay it (a non-EVM family, a native
coin, or a contract / EIP-1271 / EIP-7702 signer), the client throws
[`UnsupportedSchemeError`](/errors/error-hierarchy/) rather than signing something that can't settle.

:::tip
To get *paid* via `upto`, see the [seller side](/accepting-payments/upto-rail-seller/). For the MCP
server, enable the rail with `PIPRAIL_SCHEMES=onchain-proof,upto` (see
[MCP configuration](/mcp/configuration/)).
:::

## See also

- [The upto rail — metered billing (seller)](/accepting-payments/upto-rail-seller/) — how the gate
  meters and settles the actual.
- [Spend controls — payment policy](/spend-controls/payment-policy/) and
  [total budget](/spend-controls/total-budget/) — the caps the MAX debits, and why that's merchant-proof.
- [PipRailClient](/making-payments/piprail-client/) — the client, `schemes`, and `spent()` / `budget()`.
