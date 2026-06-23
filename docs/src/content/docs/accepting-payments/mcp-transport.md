---
title: MCP transport (seller)
description: Accept x402 payments over the Model Context Protocol's tool calls, not just HTTP — wrap a PipRail gate as a paid MCP tool with one handler, sharing the same replay set as your HTTP and A2A gates. Backendless, additive, x402-V2-conformant.
sidebar:
  order: 10
---

## Introduction

x402 is **transport-agnostic**: the same payment envelope rides over plain HTTP, over
[the Agent2Agent (A2A) protocol](/accepting-payments/a2a-transport/), **or** over the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/)'s **tool calls**. Over HTTP a 402
is a status code and a header; over MCP a payment is an ordinary **tool call** whose result carries
the x402 envelope in MCP's structured fields instead of base64 headers:

- a **402 challenge** is an `isError` tool result with the `X402Challenge` (the spec's
  `PaymentRequired`) in `structuredContent` **and** a byte-equal `content[0].text`;
- the **payment** rides in the call's `params._meta["x402/payment"]`;
- the **settlement** rides in the result's `_meta["x402/payment-response"]`.

This is the third official x402 transport, and the conspicuous missing twin of the A2A handler.

:::note[Which MCP package?]
MCP is an **open protocol** stewarded by Anthropic ([modelcontextprotocol.io](https://modelcontextprotocol.io/)).
PipRail's MCP transport types are **duck-typed** (zero `@modelcontextprotocol/sdk` dependency), so any
conformant MCP runtime — the official low-level `Server`, or a hand-rolled tool handler — satisfies them
structurally. The codec is written against the x402-foundation
[`specs/transports-v2/mcp.md`](https://github.com/x402-foundation/x402) binding; the `_meta` keys use a
**slash** (`x402/payment`), distinct from A2A's dotted `x402.payment.*` keys.

Don't confuse this with **[`@piprail/mcp`](/mcp/overview/)** — that's PipRail's standalone MCP *server*
that hands an agent a budget-bound wallet to *pay* x402 URLs (the buyer). This page is the **seller**:
turning your *own* MCP tool into one that charges for itself.
:::

PipRail gives you the MCP **seller** side as a thin adapter over the exact same
[`PaymentGate`](/accepting-payments/require-payment-and-gate/) you already use for HTTP and A2A — no
second verifier, no backend, no chain-specific code. It's a codec **above** the
[`PaymentDriver`](/concepts/payment-driver-architecture/) boundary, so every chain family works over
MCP for free, exactly as it works over HTTP.

```ts
import { createPaymentGate, createMcpPaymentTool } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

const paidTool = createMcpPaymentTool({
  gate, // ← the SAME gate your HTTP path uses (one shared replay set — see "Co-resident with HTTP")
  resourceUrl: 'mcp://my-server/forecast', // cosmetic — MCP tools have no inherent URL
  fulfill: async ({ receipt }) => [
    // `receipt` is the X402Receipt: `receipt.amount` is BASE units (e.g. "50000"), `receipt.asset`,
    // `receipt.transaction`, … — format with the token's decimals if you want a human amount.
    { type: 'text', text: `Settled (tx ${receipt.transaction}) — clear skies tomorrow.` },
  ],
})

// In your MCP tool handler:
const result = await paidTool.handleToolCall(params) // → an MCP tool result (402 or settled output)
```

`handleToolCall(params)` takes one inbound MCP tool call and returns the next MCP tool **result**:
a 402 challenge when there's no payment, the `fulfill` output (plus the settlement `_meta`) when a
proof verifies, or a fresh re-challenge when a proof is rejected. You wire that into your MCP server's
tool handler — see [Mount it in an MCP server](#mount-it-in-an-mcp-server).

:::note[Honest scope — seller-first, exactly like A2A]
This ships the **seller** (`createMcpPaymentTool`), the full pure codec, and the buyer-side
**read/frame** helpers (`fromMcpPaymentRequired` / `fromMcpPaymentResponse` / `buildMcpPaymentMeta`).
A fully-automatic **`McpPayer`** that drives the client pay path end-to-end is a documented
fast-follow — exactly as the A2A transport [shipped seller-first](/accepting-payments/a2a-transport/#where-the-buyers-payload-comes-from).
Today a buyer pays the challenge through the existing policy-gated
[client/gate machinery](/making-payments/piprail-client/) and frames the result with
`buildMcpPaymentMeta` (see [Where the buyer's payload comes from](#where-the-buyers-payload-comes-from)).
:::

## Mount it in an MCP server

`handleToolCall` returns a *complete* MCP tool result, so wiring it into the official
`@modelcontextprotocol/sdk` low-level `Server` is one line in your `CallToolRequest` handler — pass
the request `params` straight through and return what it gives you.

```bash
npm i @piprail/sdk @modelcontextprotocol/sdk
```

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createPaymentGate, createMcpPaymentTool } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })
const paidTool = createMcpPaymentTool({
  gate,
  resourceUrl: 'mcp://forecast-server/forecast',
  fulfill: async ({ params }) => [
    { type: 'text', text: `Forecast for ${params.arguments?.city ?? 'your city'}: clear skies.` },
  ],
})

const server = new Server({ name: 'forecast-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'forecast', description: 'A pay-gated forecast (x402 over MCP).', inputSchema: { type: 'object' } }],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'forecast') {
    // The whole seller: one inbound tool call → the next tool result (402 challenge or settled output).
    return paidTool.handleToolCall(req.params)
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

await server.connect(new StdioServerTransport())
```

That's the whole seller: the first call (no `_meta` payment) returns an `isError` 402 challenge the
client reads with [`fromMcpPaymentRequired`](#the-buyer-side-helpers); the client pays and retries the
same call with the proof under `params._meta["x402/payment"]`; the retry verifies, settles, and
returns your `fulfill` output with the settlement under `_meta["x402/payment-response"]`.

## The tool-call lifecycle

`handleToolCall` mirrors `gate.verify()`'s [`VerifyPaymentResult`](/accepting-payments/verifying-payments/)
exactly, then dresses the verdict in an MCP tool result:

| Inbound | What PipRail returns | `isError` | Carries |
|---|---|---|---|
| No `_meta["x402/payment"]` | a fresh challenge (`toMcpPaymentRequired`) | `true` | `structuredContent` = the `X402Challenge`, byte-equal `content[0].text` |
| A payment, **verified + settled** (`kind: 'paid'`) | your `fulfill` content | *(unset)* | `_meta["x402/payment-response"]` = `{ success, transaction, network, payer }` |
| Settled, but your `fulfill` **threw** | a settled response + an error note in `content` | *(unset)* | the **success** `_meta["x402/payment-response"]` — never a re-challenge |
| A payment, **rejected** (`kind: 'invalid'`) | a FRESH re-challenge — **retryable** | `true` | a new `PaymentRequired`, byte-identical shape to the first |
| A payment, **malformed/empty** (`kind: 'challenge'`) | a fresh challenge | `true` | a new `PaymentRequired` |
| `SettlementError` thrown (relayer/facilitator failed) | a "settlement failed" tool error | `true` | a text note with the [error code](/errors/error-model/) + an onchain-proof-fallback hint |

A rejected or malformed proof returns the **same** `isError` + `PaymentRequired` shape as the first
challenge — so a buyer retries on the identical seam, exactly as HTTP re-challenges with another 402.

:::caution[At-most-once: a `fulfill` failure never re-charges the buyer]
By the time the handler runs your `fulfill`, the proof has **already** settled (the funds moved and
the proof is consumed in the replay set). If your `fulfill` then throws — a disk-full, a downstream
500 — the handler **still** returns a settled `_meta["x402/payment-response"]` (success) with an
error note in `content`. It does **not** re-challenge or let the throw escape, because either would
tell the buyer to pay again for a proof that already settled. Make `fulfill` idempotent and your
served work regenerable (the buyer can re-request with the same settled proof); see
[Replay protection](/accepting-payments/replay-protection/). The only `isError` throw the handler
maps is a pre-settlement `SettlementError` (the merchant's own relayer failing on the
[`exact` rail](/accepting-payments/exact-rail-seller/)); any other unexpected throw bubbles to the
host so you never silently swallow a bug.
:::

:::note[The settlement projection]
A success result projects the rich [`X402Receipt`](/accepting-payments/receipts-and-onpaid/) down to
**exactly** the spec's four fields — `{ success, transaction, network, payer }` — under
`_meta["x402/payment-response"]`. The full receipt (with `scheme` / `asset` / `payTo` / `verifiedAt`)
is never leaked verbatim onto the wire; it's still what your `fulfill` callback receives.
:::

## `gate.verifyObject(payload)` — the shared verify seam

The HTTP path verifies a **base64** `payment-signature` header; MCP carries the payment as a raw
JSON object under `params._meta["x402/payment"]`. `createMcpPaymentTool` hands that object straight to
**`gate.verifyObject(rawObject)`** — the [same object-level seam A2A uses](/accepting-payments/a2a-transport/#gateverifyobjectpayload--the-raw-json-verify-seam).
It runs the identical dispatch (upto → exact → onchain-proof), reads `sig.payload.nonce` off the
object, and re-derives every trusted field (`payTo` / `amount` / `asset` / `network`) from **your own
config** — never the client-supplied echo. The MCP transport writes **no** crypto and touches **no**
driver: every family rides MCP for free.

Two properties matter, and `createMcpPaymentTool` relies on both:

- **Shared replay set.** Pass the *same* gate instance to `createMcpPaymentTool` (and to your HTTP /
  A2A adapters), and all transports share **one** used-proof set. A proof settled over HTTP can't be
  replayed over MCP, or vice-versa — the nonce is claimed once, in one set, regardless of transport.
- **Never throws on malformed input.** A garbage, empty, or `null` payment object doesn't crash — it
  yields `kind: 'challenge'`, a fresh 402. (The *only* throw is a `SettlementError` on the `exact`
  rail, which the handler catches and maps to an `isError` tool result.)

## The buyer-side helpers

Until the automatic `McpPayer` ships, a buyer reads and frames payments with the pure codec helpers.
A buyer **calls** the tool, inspects the result, pays the challenge through its normal client, then
retries the call with the framed proof:

```ts
import {
  isMcpPaymentRequired, fromMcpPaymentRequired, fromMcpPaymentResponse, buildMcpPaymentMeta,
} from '@piprail/sdk'

// 1. Call the tool; if it's a 402, read the challenge:
const first = await callTool('forecast', { city: 'NYC' })
if (isMcpPaymentRequired(first)) {
  const challenge = fromMcpPaymentRequired(first) // → the X402Challenge (PaymentRequired)

  // 2. Pay it through the existing policy-gated machinery — the buyer signs/broadcasts here, NOT in
  //    the codec. (`accepted` is the chosen accepts[] entry; `payload` is the scheme payload.)
  const { accepted, payload } = await payTheChallenge(challenge) // your PipRailClient flow

  // 3. Frame the proof into the retry call's _meta and call again:
  const meta = buildMcpPaymentMeta({ accepted, payload, resource: { url: 'mcp://forecast-server/forecast' } })
  const settled = await callTool('forecast', { city: 'NYC' }, { _meta: meta })

  // 4. Record the spend on success:
  const response = fromMcpPaymentResponse(settled) // → SettleOutcome | null; record only on success:true
}
```

`buildMcpPaymentMeta` is a **pure codec** — it mints no signature and grants no spend authority. The
buyer signs and broadcasts through the existing [`PipRailClient`](/making-payments/piprail-client/)
(policy-gated, budget-bound), then frames the already-produced proof for the MCP carrier.

## Where the buyer's payload comes from

MCP carries the buyer's payment as the *same* `{ accepted, payload }` object the HTTP path base64-encodes
into the `payment-signature` header. Until the `McpPayer` buyer ships, the simplest way to produce one is
to pay an HTTP 402 with a [`PipRailClient`](/making-payments/piprail-client/) and decode the
`payment-signature` it sends — identical to the
[A2A pattern](/accepting-payments/a2a-transport/#where-the-buyers-payload-comes-from):

```ts
import { decodeBase64Json, HEADER_SIGNATURE } from '@piprail/sdk'

// The decoded payment-signature is `{ x402Version, accepted, payload }` — exactly the pieces
// buildMcpPaymentMeta wants:
const { accepted, payload } = decodeBase64Json(req.headers[HEADER_SIGNATURE])
```

## Co-resident with HTTP and A2A — one gate, one replay set

If you accept payments over HTTP, A2A **and** MCP, build **one** gate and pass it to all three adapters.
A proof settled on any transport is then un-replayable on the others:

```ts
import { requirePayment, createA2APaymentHandler, createMcpPaymentTool, createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xMerchant…' })

app.use('/api', requirePayment({ gate }))                          // HTTP
const a2a = createA2APaymentHandler({ gate })                      // A2A — SAME gate, SAME replay set
const mcp = createMcpPaymentTool({ gate, fulfill: async () => [] }) // MCP — SAME gate, SAME replay set
```

:::caution[The trap: two gates]
If you instead pass **inline options** (`createMcpPaymentTool({ chain, token, amount, payTo, fulfill })`),
the handler builds its **own** gate with its **own** replay set — and a proof could be settled once over
each transport. If you must build separate gates, give them a shared `isUsed` / `markUsed` store (Redis,
etc.). Passing the single shared `gate` avoids the trap entirely — prefer it. See
[Replay protection](/accepting-payments/replay-protection/).
:::

## The `_meta` keys and codec exports

The payment state rides in two namespaced `_meta` keys, exported as constants so you never hard-code a
typo. A standard MCP reader ignores them, and they coexist with any other `_meta`.

| Constant | String value | Carries |
|---|---|---|
| `MCP_PAYMENT_META_KEY` | `x402/payment` | the raw payment payload object the buyer submits (fed to `verifyObject`), on a call's `params._meta` |
| `MCP_PAYMENT_RESPONSE_META_KEY` | `x402/payment-response` | the `{ success, transaction, network, payer }` settlement, on a result's `_meta` |

For hand-built adapters, the low-level codec is exported too — all pure, all chain-agnostic:

| Function | Side | Purpose |
|---|---|---|
| `toMcpPaymentRequired(challenge)` | seller | build the `isError` 402 tool result from an `X402Challenge` |
| `toMcpPaymentResponse(content, receipt)` | seller | attach the settlement `_meta` to your tool output |
| `fromMcpPayment(params)` | seller | read the raw payment object out of `params._meta["x402/payment"]` (or `null`) |
| `fromMcpPaymentRequired(result)` | buyer | read the `X402Challenge` back out of an `isError` result (or `null`) |
| `isMcpPaymentRequired(result)` | buyer | is this result a 402 challenge? |
| `fromMcpPaymentResponse(result)` | buyer | read the `SettleOutcome` back out (record spend on `success: true`) |
| `buildMcpPaymentMeta({ accepted, payload, resource? })` | buyer | frame a produced proof into the retry call's `_meta` |

```ts
import {
  createMcpPaymentTool, toMcpPaymentRequired, toMcpPaymentResponse,
  fromMcpPayment, fromMcpPaymentRequired, fromMcpPaymentResponse,
  isMcpPaymentRequired, buildMcpPaymentMeta,
  MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY,
} from '@piprail/sdk'
```

## Options

```ts
createMcpPaymentTool({
  gate,                          // the shared PaymentGate (RECOMMENDED — one replay set across transports)
  fulfill: async (ctx) => [],    // ({ receipt, params }) → McpContentBlock[] — your tool's real output
  resourceUrl: 'mcp://…',        // optional, cosmetic — stamped into the challenge's resource
  // …or, instead of `gate`, any inline RequirePaymentOptions to build a fresh gate (see the trap above).
})
```

| Option | Type | Purpose |
|---|---|---|
| `gate` | `PaymentGate` | **The primary form.** Pass the SAME gate your HTTP / A2A paths use → one shared replay set. |
| `fulfill` | `(ctx: { receipt: X402Receipt; params: McpToolCallParams }) => McpContentBlock[] \| Promise<McpContentBlock[]>` | **Required.** Produce the tool's real output after a verified settle — the merchant's own work. |
| `resourceUrl` | `string` | Optional cosmetic URL stamped into the challenge (MCP tools have no inherent URL). |

The returned handler is `{ handleToolCall, gate }`. The `gate` is re-exposed as an escape hatch for
advanced flows (`gate.describe()`, `gate.landingPage()`).

## See also

- [`@piprail/mcp` (the buyer server)](/mcp/overview/) — the standalone MCP server that hands an agent a
  budget-bound wallet to *pay* x402 URLs. The mirror image of this page.
- [A2A transport (seller)](/accepting-payments/a2a-transport/) — the same gate over A2A's JSON-RPC; this
  page mirrors it for MCP.
- [Verifying payments (HTTP)](/accepting-payments/verifying-payments/) — `gate.verify`, the base64
  sibling of the `verifyObject` seam both transports share.
- [Replay protection](/accepting-payments/replay-protection/) — the shared used-proof set every
  transport keys off, and the `isUsed` / `markUsed` hooks for multi-instance deploys.
- [`requirePayment` / `createPaymentGate`](/accepting-payments/require-payment-and-gate/) — the gate this
  handler wraps.
