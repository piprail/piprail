---
title: paymentTools()
description: Turn a configured PipRailClient into framework-agnostic tool descriptors an LLM can call — with the spend policy baked in so the model can't overspend.
sidebar:
  order: 1
---

## Introduction

`paymentTools(client)` hands an LLM the ability to discover, quote, plan, and pay x402
resources. It returns an array of framework-agnostic [`AgentTool`](#the-agenttool-shape)
descriptors — each a `name` + `description` + JSON Schema `parameters` + an `invoke` function —
that adapt to MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling, LangChain, or
[elizaOS](/integrations/elizaos/) in a couple of lines.

The toolkit ships **zero dependencies**: it's plain data plus an `invoke` closure over the
[`PipRailClient`](/making-payments/piprail-client/) you pass in. Because the budget rides on
that client, the model can't bypass it — every payment goes through the same `policy` and
`onBeforePay` guard.

`paymentTools()` accepts any `PayingClient` — a single-chain `PipRailClient` **or** a
[`MultiChainPayer`](/making-payments/multi-chain/) (one wallet per chain, auto-routing to
whichever chain the 402 asks for). The tools are identical either way.

## Basic use

Build a client with a wallet and a [spend policy](/spend-controls/payment-policy/), then derive
the tools:

```ts
import { PipRailClient, paymentTools } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  schemes: ['onchain-proof', 'exact'], // pay standard x402 servers too — GASLESS for the buyer
  autoRoute: true,                      // and auto-prefer the cheapest settleable rail (the gasless one)
  policy: { maxTotal: '5.00' },
})
const tools = paymentTools(client) // → AgentTool[] of length 8
```

:::tip[Make the agent gasless]
`schemes: ['onchain-proof', 'exact']` lets the tools pay the ratified x402 `exact` rail — the buyer
**signs** and the server (or its facilitator, e.g. PayAI) broadcasts, so the agent spends **zero gas**
(EVM + Solana + Algorand + Aptos + NEAR). With `autoRoute: true` the tools then prefer that gasless rail automatically. Both are
opt-in; the zero-config default stays `onchain-proof`. See [Gasless payments](/making-payments/gasless-payments/).
:::

The tools, in order:

| Tool | What it does | Pays? |
| --- | --- | --- |
| `piprail_discover` | Find payable resources on the open x402 indexes ("what can I buy?"). | No |
| `piprail_quote_payment` | Price a gated URL and check it against policy. | No |
| `piprail_plan_payment` | Check you *can* pay — balance, gas, recipient readiness across every rail. | No |
| `piprail_pay_request` | Pay if needed and return the result. | **Yes** |
| `piprail_register` | List a resource you run on the open indexes. | No |
| `piprail_budget` | Read remaining budget + time leash (Mode A self-check). | No |
| `piprail_guide` | Read the agent contract — how to quote/plan/pay and read a refusal. | No |
| `piprail_verify_receipt` | Re-verify a verifiable receipt against the chain (wallet-free). | No |

Each tool is documented in detail on [The agent tools](/agent-toolkit/the-agent-tools/).

## Wiring into a framework

An `AgentTool` is deliberately shaped to map onto any runtime. The pattern is the same
everywhere: expose `name` + `description` + `parameters`, and route the runtime's call to
`invoke`.

```ts
// Vercel AI SDK (v5/v6 — note: AI SDK v4 used `parameters` instead of `inputSchema`)
import { tool, jsonSchema } from 'ai'

const aiTools = Object.fromEntries(
  paymentTools(client).map((t) => [
    t.name,
    tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.invoke }),
  ]),
)
```

For OpenAI/Anthropic function-calling, the `name`, `description`, and `parameters` go straight
into the `tools` array; dispatch the model's `tool_use` block to the matching `invoke`. The
[`@piprail/mcp`](/mcp/getting-started/) server wires these same descriptors into an MCP server —
see [Use as a library](/mcp/use-as-a-library/) if you want to host them yourself.

**Ready-made wiring:** [elizaOS](/integrations/elizaos/) (a native plugin built on these exact
descriptors), [OpenClaw](/integrations/openclaw/), and [Hermes](/integrations/hermes/) ship this
wiring pre-built — see the [Integrations](/integrations/) section.

## The AgentTool shape

```ts
interface AgentTool {
  name: string                              // snake_case, namespaced `piprail_…`
  description: string                       // written for an LLM to read
  parameters: Record<string, unknown>       // JSON Schema (draft-07 object)
  annotations?: ToolAnnotations             // advisory MCP-style hints
  outputSchema?: Record<string, unknown>    // result schema, on stable read-only tools
  invoke: (args: Record<string, unknown>) => Promise<unknown>
}
```

`invoke` always resolves to a JSON-serialisable value — it does not throw for a payment
failure. The pay tool funnels every SDK error into a structured object — `{ ok: false, code,
reason, explain, ref?, reasonCode?, declined? }` — so the model reasons about it instead of
crashing; see [Challenge triage](/agent-toolkit/challenge-triage/) and [Why payments
fail](/errors/why-payments-fail/).

`outputSchema` is declared only on the stable read-only tools (`quote`, `plan`, `budget`) and is
kept open — no `additionalProperties: false` — so additive result fields never break a strict
client that validates against it.

## Annotations

`annotations` mirror the MCP spec's `ToolAnnotations`: advisory hints that let a client reason
about a tool's *nature*. They are hints only — never make a security decision on them. The
[spend policy](/spend-controls/payment-policy/) is the real boundary.

```ts
interface ToolAnnotations {
  title?: string            // human-friendly tool title
  readOnlyHint?: boolean    // only reads — no state change, no funds moved
  destructiveHint?: boolean // may move value or do something not easily undone
  idempotentHint?: boolean  // repeating with the same args has no extra effect
  openWorldHint?: boolean   // reaches the open world — indexes, chains, arbitrary URLs
}
```

Two tools are `readOnlyHint: false`: `piprail_pay_request` and `piprail_register`. Only
`piprail_pay_request` is `destructiveHint: true` with `idempotentHint: false` (it moves value,
and paying twice means two payments); `piprail_register` is `destructiveHint: false` (it writes
a listing to an external index but moves no funds). The other six tools are `readOnlyHint: true`.

:::caution
`readOnlyHint`, `destructiveHint`, and friends are advisory. A client must never gate a payment
on an annotation alone — enforce spend limits through the client's policy, which the model
cannot reach.
:::

## The budget rides on the client

You configure spend limits once, on the client. The tools inherit them: `piprail_pay_request`
passes through `policy` and `onBeforePay`, and `piprail_budget` reads back what's left.

```ts
const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
  policy: { maxAmount: '1.00', maxTotal: '20.00' }, // per-payment + lifetime ceilings
  onBeforePay: async (q) => q.withinPolicy, // final auto-approval gate
})
const tools = paymentTools(client) // every pay goes through both guards
```

`onBeforePay` receives the [`PipRailQuote`](/making-payments/quote/) — `q.withinPolicy`,
`q.amountFormatted`, `q.symbol`, `q.network`, and so on — *after* the policy passes, so it's
your last word before any funds move. PipRail has no price oracle, so there is no USD figure to
branch on; gate on `q.withinPolicy` or `Number(q.amountFormatted)` against your own ceiling.

In a headless run (Mode A), have the model call `piprail_budget` before paying so it discovers
the leash by reading it, not by hitting a decline. See [Spend ledger](/spend-controls/spend-ledger/)
and [Evaluate policy](/spend-controls/evaluate-policy/).

:::note
The budget totals and time envelope are in-memory for the current process and reset on restart —
`piprail_budget` reports the live, in-process figures, not a persisted history.
:::

## Making the output legible

Three of the tools embed a one-line, model-readable rendering of their result alongside the
structured data: `piprail_plan_payment` includes a `summary` from [`summarizePlan()`](/agent-toolkit/renderers/),
`piprail_budget` includes a `report` from `formatSpendReport()`, and a declined payment carries
an `explain` from `explainDecline()`. These are pure helpers you can also call directly — see
[Renderers](/agent-toolkit/renderers/).
