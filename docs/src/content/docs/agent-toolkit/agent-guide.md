---
title: The agent guide
description: PIPRAIL_AGENT_GUIDE — the full agent payment contract distilled into one string you can drop into an LLM system prompt.
sidebar:
  order: 4
---

## Introduction

`PIPRAIL_AGENT_GUIDE` is the PipRail contract written *for the model*: one tight Markdown
string an LLM reads once and then drives the [payment tools](/agent-toolkit/payment-tools/)
correctly with near-zero other docs. It covers the quote → plan → pay loop, how to read a
refusal without crashing or double-spending, and the difference between the two operating modes.

It's a pure static constant — no imports, no I/O — so you can prepend it to any agent's system
prompt, MCP or not.

```ts
import { PIPRAIL_AGENT_GUIDE } from '@piprail/sdk'

const systemPrompt = `${PIPRAIL_AGENT_GUIDE}\n\n${yourTaskInstructions}`
```

`agentGuide()` is a function that returns the same string, for callers that prefer a call over a
constant:

```ts
import { agentGuide } from '@piprail/sdk'

const guide = agentGuide()
// → '# Paying with PipRail — the agent contract\n…' (identical to PIPRAIL_AGENT_GUIDE)
```

## The loop it teaches: quote → plan → pay

The guide tells the model to always run three steps in order so it never commits to a payment it
can't finish:

| Step | Tool | What it does |
| --- | --- | --- |
| 1. Price it | `piprail_quote_payment(url)` | Returns amount, token, chain, and whether it's within policy (wraps [`quote()`](/making-payments/quote/)). No funds move. |
| 2. Can I afford it now? | `piprail_plan_payment(url)` | Reads balance, gas, and recipient readiness across rails (wraps [`planPayment()`](/making-payments/plan-payment/)) → `{ payable, best, fundingHint, session? }`. |
| 3. Pay | `piprail_pay_request(url, method?, body?)` | Pays — but **only if the plan was payable** — and returns the result. |

The rule it states plainly: *always plan before you pay.* If `payable` is `false`, the model is
told not to attempt the payment — `fundingHint` says exactly what to fix.

## Reading a refusal — never crash, never double-spend

The guide drills the single most important agent behaviour: a failed pay returns a **structured
object**, never a thrown error. The model branches on `code` (always reliable) and on
`reasonCode` when `declined` is true.

```jsonc
{ "ok": false, "code": "...", "reason": "...", "explain": "...", "ref": "...", "reasonCode": "...", "declined": true }
```

The guide enumerates how the model should respond to each case:

| `code` / `reasonCode` | What the model is told to do |
| --- | --- |
| `declined` + `SESSION_EXPIRED` | **Terminal.** Time budget over. Stop — retry no payment this process. |
| `declined` + `APPROVAL` | A human or hook declined. Terminal for this pay; do not auto-retry. |
| `declined` + `OUTSIDE_WINDOW` | Rolling rate-limit exhausted. Wait for it to free, then retry — don't raise the amount. |
| `declined` + `POLICY` / `BUDGET` | A spend cap or allowlist refused it. Pick a cheaper/allowed resource. |
| `INSUFFICIENT_FUNDS` | Top up the wallet (token and/or native gas), then retry. |
| `PAYMENT_TIMEOUT` / `MAX_RETRIES_EXCEEDED` / `CONFIRMATION_TIMEOUT` | The payment may already be on-chain — **never re-pay** (it would double-spend). |
| `NO_COMPATIBLE_ACCEPT` / `UNSUPPORTED_SCHEME` | Not payable on this chain/scheme; `explain` says which. |

:::danger
The never-re-pay rule. On a timeout (`PAYMENT_TIMEOUT`, `MAX_RETRIES_EXCEEDED`,
`CONFIRMATION_TIMEOUT`) the payment **may already be on-chain**. The guide instructs the model to
recover the proof — re-verify or re-submit it — and **never re-pay**, because a fresh payment
would double-spend.

The proof rides on `ref` when the SDK has one to hand back. In a thrown error, that's exactly two
classes: `PaymentTimeoutError` and `MaxRetriesExceededError` (each carries `.ref`); narrow on those
before reading it. `ConfirmationTimeoutError` carries **no** `.ref` — there the recovery is to
re-check the proof ref you already hold (the one your `onEvent` `payment-broadcast` /
`payment-unconfirmed` callback logged). In the structured tool result the `ref` field is simply
present or absent, so a model reads it without instanceof checks.
:::

## Knowing its leash — `piprail_budget`

The guide points the model at `piprail_budget` to self-check before paying: it reports how much
budget and time are left per `(network, asset)`, plus spend so far. Read-only — it moves no
funds. See [the agent tools](/agent-toolkit/the-agent-tools/) for the full tool surface.

## Two modes

The contract spells out the two ways an agent runs, so the model knows whether the policy is the
consent or whether a human is in the loop:

- **Mode A (headless, default):** the agent runs free inside a pre-set budget + [time
  envelope](/spend-controls/time-envelope/). The [policy](/spend-controls/payment-policy/) *is*
  the consent — there is no per-payment prompt. `piprail_budget` shows what's left.
- **Mode B (supervised):** the host may ask a human to approve each payment. A
  decline/cancel/timeout comes back as `declined: true` with `reasonCode: 'APPROVAL'` — the model
  is told **not** to retry it as if it were a transient error.

See [Modes](/mcp/modes/) for how the MCP server selects A or B.

## Hard facts it pins

The guide closes with two facts the model must not get wrong:

- **Spend caps are per `(network, asset)`.** There is no single cross-token dollar cap — budgets
  aren't summed across tokens, because there's no price oracle.
- **Spend totals and the time envelope live in-memory for this process** — they reset on restart.
  It's a convenience, not a durable [ledger](/spend-controls/spend-ledger/).

## How the MCP server serves it

When you run [`@piprail/mcp`](/mcp/getting-started/) with the guide enabled (default on), the guide
string is exposed two ways — as a prompt and a resource — alongside a live-budget resource, so any
MCP client can pull them into context:

| Surface | Identifier |
| --- | --- |
| Prompt | `piprail_agent_guide` |
| Resource | `piprail://guide` (`text/markdown`) |
| Resource | `piprail://budget` (`application/json`) — also gated behind the `guide`/`PIPRAIL_GUIDE` flag, serving the live spend budget. |

A headless, non-MCP agent doesn't need either — import `PIPRAIL_AGENT_GUIDE` directly and prepend
it to the system prompt.
