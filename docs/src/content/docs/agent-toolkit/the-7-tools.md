---
title: The agent tools
description: The tools paymentTools() hands an LLM — what each one does, its arguments, and which of them moves funds.
sidebar:
  order: 2
---

## Introduction

`paymentTools(client)` returns the [`AgentTool`](/agent-toolkit/payment-tools/) descriptors
wrapping a configured [`PipRailClient`](/making-payments/piprail-client/). Together they give
a model the full loop: **find** a payable resource, **price** it, **check** it can pay, then
**pay** it — plus list a resource of its own, read its remaining budget, read the agent
contract, and re-verify a receipt it (or anyone) holds.

Only one of the eight moves funds; the other seven are read-only or write to an external index —
none of them can spend. The model can't bypass the spend policy either — every payment routes
through the same `policy` / `onBeforePay` guard on the client these tools wrap.

```ts
import { PipRailClient, paymentTools } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

const tools = paymentTools(client) // → the AgentTool descriptors, ready to register
```

## The tools at a glance

| Tool | Purpose | Moves funds? |
| --- | --- | --- |
| `piprail_discover` | Find payable x402 resources on the open indexes (the phone book). | No — read-only |
| `piprail_quote_payment` | Price a gated URL without paying. | No — read-only |
| `piprail_plan_payment` | Check you *can* pay — balance, gas, recipient readiness — across every rail. | No — read-only |
| `piprail_pay_request` | Fetch a gated URL, paying if needed. | **Yes — the only value-moving tool** |
| `piprail_register` | List a resource *you* run on the open indexes. | No — writes a listing |
| `piprail_budget` | Read remaining budget + time leash. | No — read-only |
| `piprail_guide` | Read the agent contract (how to quote / plan / pay). | No — read-only |
| `piprail_verify_receipt` | Re-verify a verifiable receipt against the chain (wallet-free). | No — read-only |

The first five are byte-identical in name and order to earlier versions; the read-only tools
(`piprail_budget`, `piprail_guide`, and `piprail_verify_receipt`) are appended last.

## piprail_discover — find what's payable

Searches the open x402 indexes for payment-gated resources, *without paying*. This answers the
agent's "what can I buy?" question. By default it returns only resources payable on the
wallet's own chain.

| Arg | Type | Purpose |
| --- | --- | --- |
| `query` | string | Free-text topic to search for (optional). |
| `network` | string | CAIP-2 id, `'self'` (your chain — default), or `'any'` (all chains). |
| `category` | string | Keep **only** this category (strict — uncategorized results are dropped). |
| `asset` | string | Keep only resources paying in this token symbol, e.g. `'USDC'`. |
| `maxPrice` | number | Drop results advertised above this USD price. |
| `minReliability` | number | Drop results below this health score (0–100); unscored results pass through. |
| `verified` | boolean | Prefer verified listings. |
| `sort` | string | `'relevance'` \| `'reliability'` \| `'price'` \| `'uptime'` \| `'name'`. |
| `limit` | number | Max results per index (default 20). |

Read-only, open-world (it reaches external indexes). The result is
`{ count, resources }`, where each resource carries `resource`, `name`, `description`, `source`,
`priceUsd`, `category`, `reliabilityScore`, `health`, `verified`, and `networks`. Results are
cross-scheme, so always `piprail_quote_payment` a chosen
resource — which re-checks the live price — before paying. See
[Discover & register](/discovery/discover-and-register/).

## piprail_quote_payment — price it

Gets the price of a gated URL without paying: amount, token, chain, recipient, and whether it's
within the spend policy. Returns `{ gated: false }` when the URL needs no payment.

```jsonc
// piprail_quote_payment({ url })
{ "url": "https://api.example.com/report" }
// → { gated: true, amountFormatted: "0.10", symbol: "USDC", network: "eip155:8453", payTo: "0xYourWallet", withinPolicy: true, … }
```

The result spreads the full [`PipRailQuote`](/making-payments/quote/) over `{ gated: true, … }`,
so read `amountFormatted` (the human amount, e.g. `"0.10"`) rather than `amount` (base units).
Takes a single required `url`. Read-only and open-world (it fetches the URL to read the 402
challenge). Backed by [`quote()`](/making-payments/quote/).

## piprail_plan_payment — check you can pay

Reads wallet balance, native gas, and recipient readiness across every rail the URL offers on
your chain, and returns `{ gated, payable, status, fundingHint, summary, best, options }`.
`payable: false` means do **not** attempt the payment; `fundingHint` says exactly what to top up.

```jsonc
// piprail_plan_payment({ url })
{ "url": "https://api.example.com/report" }
// → {
//     gated: true,
//     payable: true,
//     status: "ready",                // 'ready' | 'blocked' | 'unknown'
//     fundingHint: null,              // a sentence when NOT payable
//     summary: "Payable: 0.10 USDC on eip155:8453 (gas ~0.00002 ETH). 1 other rail(s) not settleable.",
//     best: { network, symbol, amount, gasCoin, gas },
//     options: [ … ]
//   }
```

Takes a single required `url`. Read-only and open-world (it fetches the URL and reads chain
state). The result includes a `summary` line distilling the whole plan for the model — the exact
string [`summarizePlan()`](/agent-toolkit/renderers/) produces, gas in the chain's native coin
(never fiat — PipRail has no price oracle). The `session` time leash is added only when a time
policy is configured. Call it before `piprail_pay_request` so you never commit to a payment you
can't finish. Backed by [`planPayment()`](/making-payments/plan-payment/).

## piprail_pay_request — the one tool that pays

Fetches a gated URL and makes the required payment if needed, subject to the spend policy and
the `onBeforePay` approval hook. It pays whichever rail(s) the client is configured for:
`onchain-proof` (PipRail's backendless default — the buyer broadcasts and pays gas), or — when the
operator enables it (`schemes: ['onchain-proof', 'exact']`) — the ratified
[`exact`](/making-payments/exact-buyer/) rail, where the buyer only **signs** and the server/facilitator
broadcasts, so the buyer pays **zero gas** (on EVM + Solana + Algorand + Aptos + NEAR; the method — EIP-3009/Permit2/SVM/Algorand/Aptos/NEAR — is
auto-selected). With [`autoRoute`](/making-payments/fetch-and-autoroute/) on, it pays the cheapest settleable
rail, which is the gasless `exact` one. Returns the HTTP status, the response body, and a payment
receipt if one settled. The agent doesn't choose the rail or method — the client does.

| Arg | Type | Purpose |
| --- | --- | --- |
| `url` | string | Full URL to fetch (required). |
| `method` | string | HTTP method, default `'GET'`. |
| `body` | object \| string | Optional request body for POST/PUT — a JSON object or a string. |

```jsonc
// piprail_pay_request({ url, method, body })
{ "url": "https://api.example.com/jobs", "method": "POST", "body": { "topic": "weather" } }
// → { status: 200, ok: true, body: {…}, receipt: { network, transaction, payTo, … } | null }
//   receipt is the parsed X402Receipt, or null when nothing settled (e.g. the URL wasn't gated)
```

:::danger
This is the **only** tool that moves value. Its annotations declare `readOnlyHint: false`,
`destructiveHint: true`, and `idempotentHint: false` — a payment is value-moving and not
reversible, and paying twice means two payments.
:::

Every SDK failure comes back as a **structured object**, never a thrown crash, so the model can
reason about it. A policy or approval refusal returns `{ ok: false, declined: true, code,
reason, explain, reasonCode? }` with no funds moved; common failures arrive with a `code` and a
one-line `explain`. When a broadcast-but-unconfirmed payment times out
(`code: 'PAYMENT_TIMEOUT'` / `'MAX_RETRIES_EXCEEDED'` / `'CONFIRMATION_TIMEOUT'`), the result
carries a `ref` — the never-re-pay rule in [the agent guide](/agent-toolkit/agent-guide/) tells
the model to recover via that ref rather than pay again.

## piprail_register — list a resource you run

Lists a payment-gated resource *you* run on the open indexes so other agents can discover it.
The default target is 402 Index — no auth, no signature, no payment. Returns
`{ outcomes }` — one outcome per index (`{ source, ok, detail, visibility, note }`); a step a
chain can't satisfy comes back `ok: false` with the reason.

| Arg | Type | Purpose |
| --- | --- | --- |
| `url` | string | Full URL of the resource to list (required). |
| `name` | string | Display name (defaults to the host). |
| `description` | string | What the resource offers. |
| `category` | string | **The top findability lever** — most listings have none. A real category (`'ai'`, `'finance'`, …) makes a listing rank + filter. |
| `tags` | string[] | Keywords — folded into the description for search **and** sent as a `tags` field. |
| `priceUsd` | number | Advertised price in USD (metadata). |
| `network` | string | Network slug to advertise, e.g. `'base'` (defaults to the paying chain) — set it when registering from a multi-chain wallet so the listing names the right chain. |
| `asset` | string | Payment asset symbol, e.g. `'USDC'` (metadata). |
| `provider` | string | Who runs the resource (provider/org name). |
| `contactEmail` | string | Contact email for the listing (also used by the domain claim). |

Writes a listing to an external index but moves no funds and hosts nothing on PipRail's side
(`destructiveHint: false`).

:::note
Index and agent payers are overwhelmingly standard `exact` clients. A default onchain-proof-only
gate gets listed but they can't pay it — add an [`exact` rail](/accepting-payments/exact-rail-seller/)
(and set the gate's `discovery` option, required for x402scan) to be both discoverable *and*
payable.
:::

## piprail_budget — read the leash

Reads how much spend budget and time leash is left: per-`(network, asset)` remaining, the
session time envelope, and your spend so far. Use it in [Mode A (headless)](/mcp/modes/) to
self-check *before* paying, rather than discovering the leash by hitting a decline.

```jsonc
// piprail_budget()   — no arguments
// → { spent, remaining, session, report }
```

`remaining` is the per-`(network, asset)` budget; `report` is a one-line spend summary from
[`formatSpendReport()`](/agent-toolkit/renderers/). Takes no arguments. Read-only and idempotent.
Backed by the client's spend ledger; see [Spend ledger](/spend-controls/spend-ledger/) and
[Payment policy](/spend-controls/payment-policy/).

:::caution
Totals and the time envelope are in-memory for **this** process and reset on restart.
:::

## piprail_guide — read the contract

Returns the PipRail agent contract: the quote → plan → pay loop, how to read a refusal (and
which declines are terminal), the never-re-pay rule for broadcast-but-unconfirmed payments, and
[Mode A vs Mode B](/mcp/modes/).

```jsonc
// piprail_guide()   — no arguments
// → { guide: "…the full agent contract as text…" }
```

Takes no arguments. Read-only and idempotent. Call it once if unsure how to use these tools.
The full text also has its own page: [the agent guide](/agent-toolkit/agent-guide/).

## piprail_verify_receipt — re-verify a receipt

Re-verifies a PipRail **verifiable receipt** against the chain — confirms a payment *really*
settled (the funds provably moved to `payTo` for **at least** the stated amount) **without**
trusting whoever handed over the receipt. Read-only and **wallet-free**: it takes a
`PipRailReceipt` JSON — the `verifiableReceipt` a prior `piprail_pay_request` returned, or a
receipt handed over by any third party.

| Arg | Type | Purpose |
| --- | --- | --- |
| `receipt` | object | The `PipRailReceipt` JSON (`{ piprail, receipt, resource, decimals? }`) to re-verify (required). |
| `rpcUrl` | string | Optional RPC URL for the receipt's chain — required for chains outside the common presets. |

```jsonc
// piprail_verify_receipt({ receipt })
// → {
//     ok: true,                               // the chain confirms the settlement
//     onChain: { payTo, asset, amount, payer }, // payer is RE-DERIVED from the tx
//     matchesClaims: true,                    // false ⇒ the receipt forged the payer
//     ageSeconds: 42,
//     error: null                             // a chain/RPC problem comes back HERE, never thrown
//   }
```

`onChain.amount` is a verified **lower bound**, and `matchesClaims: false` flags a forged payer.
Read-only and open-world (it reads the on-chain tx via RPC). Unlike the other tools it **never
throws** — there's no wallet and no payment, so a chain or RPC failure is reported in `error`
rather than raised. It wraps the static
[`PipRailClient.verifyReceipt`](/making-payments/verifying-receipts/), so the same anyone-verifiable
check is available in code; see [Verifying receipts](/making-payments/verifying-receipts/) and
[Verifiable receipts](/accepting-payments/verifiable-receipts/).
