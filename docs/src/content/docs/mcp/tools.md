---
title: "Tools reference"
description: The seven MCP tools the PipRail server exposes — what each takes, what it returns, which one moves funds, and the guide prompt and resources that ride alongside them.
sidebar:
  order: 5
---

## Introduction

The PipRail MCP server advertises **seven tools**, built by the SDK's
[`paymentTools(client)`](/agent-toolkit/payment-tools/) and dropped straight onto the wire — the
SDK descriptors carry draft-07 JSON Schema, so the server forwards them untouched. Six are
read-only; exactly one moves funds. Every result is emitted **both** as a text block and as
`structuredContent`, so a client that ignores structured output still reads the text.

```jsonc
// every tool, in advertised order
"piprail_discover" · "piprail_quote_payment" · "piprail_plan_payment" ·
"piprail_pay_request" · "piprail_register" · "piprail_budget" · "piprail_guide"
```

Each tool carries advisory [MCP annotations](/agent-toolkit/the-7-tools/) (`readOnlyHint`,
`destructiveHint`, `openWorldHint`, …). They are hints only — the real boundary is the
[spend policy](/spend-controls/payment-policy/), enforced before any send.

## piprail_discover

Find x402 payment-gated resources on the open indexes — a phone book of payable APIs — **without
paying**. Use it to answer "what can I buy?", then quote and pay a chosen one. All arguments are
optional.

| Argument | Type | Meaning |
| --- | --- | --- |
| `query` | string | Free-text topic to search for. |
| `network` | string | CAIP-2 id, `'self'` (your chain — default), or `'any'` (all chains). |
| `maxPrice` | number | Drop results whose **index-advertised** price is above this number. |
| `limit` | number | Max results per index (default 20). |

Returns `{ count, resources[] }`, each resource carrying `resource`, `name`, `description`,
`source`, `priceUsd`, and the distinct `networks` it offers. `priceUsd` and `maxPrice` are the
index's own advertised metadata — PipRail has no price oracle, so always
`piprail_quote_payment` the chosen resource for the live, true price before paying. It is
read-only and open-world.

:::tip
Discovery results are cross-scheme. Always call `piprail_quote_payment` on a chosen resource — it
re-checks the live price — before `piprail_pay_request`. See [Discover and
register](/discovery/discover-and-register/).
:::

## piprail_quote_payment

Price a gated URL **without paying**. Call it first to decide whether a resource is worth buying.

| Argument | Type | Meaning |
| --- | --- | --- |
| `url` | string (required) | Full URL of the gated resource. |

Returns the [quote](/making-payments/quote/) (`gated: true` plus amount, token, chain, recipient,
and whether it sits within your spend policy), or `{ gated: false, url }` when the URL needs no
payment. Carries an open `outputSchema` so a strict client can validate `structuredContent`.

```jsonc
{ "gated": true,
  "amountFormatted": "0.10", "symbol": "USDC", "asset": "0x…",
  "network": "eip155:8453", "payTo": "0xYourWallet",
  "withinPolicy": true }
```

## piprail_plan_payment

Check whether you **can** pay before committing — reads your wallet balance, native gas, and
recipient readiness across every rail the URL offers on your chain. Call it before
`piprail_pay_request` so you never start a payment you can't finish.

| Argument | Type | Meaning |
| --- | --- | --- |
| `url` | string (required) | Full URL of the gated resource. |

Returns `{ gated, payable, status, fundingHint, summary, best, options[] }` (and `session` when a
time policy is set). `summary` is one model-readable line distilling the whole
[plan](/making-payments/plan-payment/); each `options[]` entry carries `state`, `blockers`,
`warnings`, and `recipientReady`.

```jsonc
{ "gated": true, "payable": false, "status": "blocked",
  "fundingHint": "Can't settle on Base: top up 0.04 USDC (to pay 0.10 USDC).",
  "summary": "NOT payable: Can't settle on Base: top up 0.04 USDC (to pay 0.10 USDC).",
  "best": null,
  "options": [
    { "network": "eip155:8453", "symbol": "USDC", "amount": "0.10",
      "state": "blocked", "blockers": ["INSUFFICIENT_TOKEN"],
      "warnings": [], "recipientReady": "n/a" }
  ] }
```

The `summary` line comes verbatim from the SDK's `summarizePlan()` — a payable plan instead reads
`"Payable: 0.10 USDC on eip155:8453 (gas ~0.00002 ETH). 1 other rail(s) not settleable."` Gas is
shown in the native coin only; there is no fiat figure.

:::caution
`payable: false` means **do not attempt** the payment; `fundingHint` says exactly what to top up.
:::

## piprail_pay_request

**The one tool that moves funds.** It fetches the URL and makes the required payment if needed,
subject to the spend policy and the [approval hook](/mcp/modes/). It pays whichever rail the
client is configured for — PipRail's backendless on-chain rail, or the standard
[`exact` rail](/making-payments/exact-buyer/) when enabled. Its annotations mark it
`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`.

| Argument | Type | Meaning |
| --- | --- | --- |
| `url` | string (required) | Full URL to fetch. |
| `method` | string | HTTP method, default `GET`. |
| `body` | object \| string | Request body for POST/PUT (a JSON object is serialised to JSON). |

On success it returns `{ status, ok, body, receipt }`, where `receipt` is the parsed payment
[receipt](/accepting-payments/receipts-and-onpaid/) if one settled.

```jsonc
{ "status": 200, "ok": true,
  "body": { "...": "the resource you paid for" },
  "receipt": { "transaction": "0x…", "network": "eip155:8453", "payer": "0xYourWallet" } }
```

### Every failure is structured — never a crash

This tool is the single funnel where **every** [`PipRailError`](/errors/error-model/) reaches the
model as a structured object instead of a thrown error, so the agent reasons about it rather than
crashing. The fields are **mutually contextual** — they're populated by the kind of failure, so
you'll never see all of them on one object at once (a clean decline has no `ref`; a timeout has no
`declined`):

```jsonc
{ "ok": false, "code": "INSUFFICIENT_FUNDS",
  "reason": "…", "explain": "…",
  "ref": "0x…",          // only on PAYMENT_TIMEOUT / MAX_RETRIES_EXCEEDED — the broadcast proof
  "reasonCode": "POLICY", // only on a decline
  "declined": true }      // only on a policy/approval refusal
```

| Field | When present | Meaning |
| --- | --- | --- |
| `code` | always | The stable [`PipRailError` code](/errors/error-hierarchy/) — branch on this. |
| `reason` | always | The error message. |
| `explain` | always | A one-line human explanation (`explainDecline`). |
| `declined` | policy / approval refusal | `true` — **no funds moved**. |
| `reasonCode` | a [decline](/errors/why-payments-fail/) | `SESSION_EXPIRED`, `APPROVAL`, `OUTSIDE_WINDOW`, `POLICY`, `BUDGET` — some are terminal. |
| `ref` | `PAYMENT_TIMEOUT` / `MAX_RETRIES_EXCEEDED` | The on-chain proof of a broadcast-but-unconfirmed tx. |

:::danger
On `PAYMENT_TIMEOUT`, `MAX_RETRIES_EXCEEDED`, or `CONFIRMATION_TIMEOUT`, the payment **may already
be on-chain** — never re-pay, or you double-spend. The first two carry the broadcast proof on
`.ref`; `CONFIRMATION_TIMEOUT` does **not** carry `.ref`, so re-check the proof ref you already
hold. The [agent guide](/agent-toolkit/agent-guide/) spells out every recovery case.
:::

A genuine, non-SDK bug is the only thing that still surfaces as an MCP `isError` result.

## piprail_register

List an x402 resource **you run** on the open indexes so other agents can find it. The default
target is 402 Index — no auth, no signature, no payment. Moves no funds; nothing is PipRail-hosted.

| Argument | Type | Meaning |
| --- | --- | --- |
| `url` | string (required) | Full URL of the resource to list. |
| `name` | string | Display name (defaults to the host). |
| `description` | string | What the resource offers. |
| `priceUsd` | number | Advertised price (metadata). |

Returns `{ outcomes[] }` — one `{ source, ok, detail, visibility, note }` per index; a step the
chain can't satisfy comes back `ok: false` with the reason.

:::note
Index and agent payers are overwhelmingly standard `exact` clients. A default onchain-proof-only
gate gets listed but they can't pay it — add an [`exact` rail](/accepting-payments/exact-rail-seller/)
(and set the gate's `discovery` option, required for x402scan) to be both discoverable and payable.
:::

## piprail_budget

Read how much of your spend budget and time leash is left — per `(network, asset)` remaining, the
session time envelope, and your spend so far. Use it in Mode A (headless) to self-check **before**
paying, so you never discover the leash by hitting a decline. Read-only and idempotent; takes no
arguments.

Returns `{ spent, remaining, session, report }`, where `report` is a formatted line of the
[spend ledger](/spend-controls/spend-ledger/).

:::note
Totals and the time envelope are in-memory for **this** process and reset on restart — a
convenience, not a durable ledger.
:::

## piprail_guide

Read the PipRail agent contract — the quote → plan → pay loop, how to read a refusal (and which
declines are terminal), the never-re-pay rule, and Mode A vs Mode B. Read-only and idempotent;
takes no arguments. Returns `{ guide }`, the full `PIPRAIL_AGENT_GUIDE` string. Call it once if
you're unsure how to use these tools.

## The guide prompt and resources

When the server is built with `guide` on (the default — `PIPRAIL_GUIDE` off only suppresses it),
two extra MCP surfaces are exposed alongside the tools. They are purely additive: with `guide`
off, the tools path is byte-identical.

| Surface | Kind | Content |
| --- | --- | --- |
| `piprail_agent_guide` | prompt | The full agent contract — how to pay, reading a refusal, Mode A vs B. |
| `piprail://guide` | resource (`text/markdown`) | The same `PIPRAIL_AGENT_GUIDE` text. |
| `piprail://budget` | resource (`application/json`) | The live spend leash: `{ spent, remaining, session }`. |

The `piprail://budget` resource mirrors the running client's budget, so a client can poll the
remaining leash as a resource read rather than a tool call. See [Modes](/mcp/modes/) for how the
guide and the confirm hook fit together.
