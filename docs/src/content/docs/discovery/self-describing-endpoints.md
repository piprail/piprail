---
title: Self-describing endpoints
description: 'Every PipRail 402 announces what it is and how to pay it, to humans, AI agents, and crawlers alike, so an endpoint is never invisible.'
sidebar:
  order: 0
---

## Introduction

A bare HTTP `402 Payment Required` is a dead end: a human who opens it sees nothing useful, and a
generic x402 client that doesn't speak PipRail's default `onchain-proof` scheme throws
`Unsupported scheme` and gives up. **PipRail makes every 402 self-describing instead**, so the instant
anyone lands on a gated endpoint they learn *what it is* (a PipRail x402 payment endpoint), *what to
pay* (the amount, token, chain, and recipient), and *how to pay it programmatically* (`npm i
@piprail/sdk` or the MCP, with a paste-ready snippet), plus where the discovery docs live.

This is **on by default** and **purely additive**: it lives in the x402 v2 `extensions` bag, which the
spec treats as opaque, so a standard client ignores it. The block rides in the **response body** only, so
the base64 `payment-required` **header stays slim** (just `accepts[]` + a small `bazaar`/rejection block),
so it never bloats past a proxy's header limit on a many-rail gate. The pay path, `accepts[]`, the
`payment-required` header, and status are byte-identical to a gate without it. You can prove that by
turning it off (below).

:::note
The point is reach: even an `onchain-proof`-only endpoint that stock tooling *cannot pay* is no longer
invisible: the block tells the caller to install `@piprail/sdk` and pay. For the non-EVM families that
have no standard `exact` rail at all (XRPL, TON, Stellar, Tron, Sui), this block
is the *entire* interop story.
:::

## The `extensions.piprail` block

Every challenge a gate builds carries an `extensions.piprail` self-description, derived from the rails
the gate already resolved (no new data):

```jsonc
{
  "name": "PipRail",
  "protocol": "x402",
  "version": "2",
  "what": "This is an x402 \"402 Payment Required\" endpoint. Pay one of the offered rails to access it.",
  "pay": [
    {
      "scheme": "onchain-proof",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xYourWallet",
      "amount": "10000",
      "amountFormatted": "0.01",
      "symbol": "USDC",
      "how": "Pay this amount on-chain to payTo, then resubmit with a payment-signature header carrying the proof ref + nonce. Easiest with @piprail/sdk (see sdk.install)."
    }
  ],
  "sdk": { "install": "npm i @piprail/sdk", "snippet": "import { PipRailClient } from '@piprail/sdk'\nconst client = new PipRailClient({ chain: '<your-chain>', wallet })\nawait client.fetch('<this-url>')" },
  "mcp": { "run": "npx -y @piprail/mcp", "tool": "piprail_pay_request" },
  "docs": { "home": "https://piprail.com", "agents": "https://docs.piprail.com", "pay": "https://docs.piprail.com/paying" },
  "discovery": { "openapi": "/openapi.json", "wellKnown": "/.well-known/x402" },
  "instruction": "PipRail x402 payment endpoint. Pay 0.01 USDC on eip155:8453 to 0xYourWallet. Programmatic: npm i @piprail/sdk then client.fetch(url). Docs: https://piprail.com."
}
```

When a gate dual-advertises a standard [`exact`](/accepting-payments/exact-rail-seller/) or metered
[`upto`](/accepting-payments/upto-rail-seller/) rail, `pay[]` carries that rail too, with a `how`
that tells a stock client it can pay it directly.

When the gate offers [verifiable receipts](/accepting-payments/verifiable-receipts/)
(`receipts: true`), the block also carries **`verifiableReceipts: true`**, so an agent knows, from
the 402 alone, that a successful `200` will return a self-verifiable receipt it can re-check on-chain.

### `endpoint`: what the resource *does* (agent-readable)

The block above answers *"how do I pay?"* The optional **`endpoint`** sub-block answers the other
half, *"what does this endpoint do, what does it take, and what comes back?"*, so an AI agent can
decide whether a resource is worth paying for **from the 402 alone, with no paid call**:

```jsonc
{
  // … the extensions.piprail block above …
  "endpoint": {
    "summary": "Current USD price for any crypto ticker.",
    "method": "GET",
    "mimeType": "application/json",
    "input": { "ticker": { "type": "string", "description": "e.g. BTC" } },
    "output": { "type": "object", "example": { "ticker": "BTC", "usd": 64210.5 } }
  }
}
```

It's **present only when the merchant described the resource**, via the gate's `description` /
`mimeType`, or a [`discovery` descriptor](#one-descriptor-lights-up-both-blocks). On a zero-config
gate it's **absent entirely**, so the default 402 stays byte-identical (prove it by [turning
self-describe off](#turning-it-off), but `endpoint` simply never appears unless you describe
something). The `example` matters: a concrete sample grounds an LLM far better than a bare schema,
so it can reason about the response shape before spending.

To populate it, describe the gate:

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.01',
  payTo: '0xYourWallet',
  description: 'Current USD price for any crypto ticker.', // → endpoint.summary
  mimeType: 'application/json',                            // → resource.mimeType + endpoint.mimeType
})
```

### `resource.mimeType`, at the v2 root too

The gate also stamps the response content-type on the v2 `resource` object in the 402 body, so the
standard ResourceInfo shape carries it for any client that reads the root rather than the extension:

```jsonc
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/price",
    "description": "Current USD price for any crypto ticker.", // from the gate `description`
    "mimeType": "application/json"                             // from the gate `mimeType`
  },
  "accepts": [ /* … */ ]
}
```

Both `resource.description` and `resource.mimeType` are present only when you set them on the gate
(see below). Omit them and the `resource` object is just `{ url }`, byte-identical to before.

### One descriptor lights up both blocks

If you're already emitting the index-facing [`extensions.bazaar`](/discovery/emitters/) block by
passing a `discovery` [`DiscoveryDescriptor`](/discovery/discover-and-register/), that **same
descriptor** now populates the human/agent-facing `endpoint` too: one description, two audiences
(the open indexes *and* any agent reading the live 402). The descriptor gained a `summary` field
for exactly this:

```ts
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.01',
  payTo: '0xYourWallet',
  discovery: {
    summary: 'Current USD price for any crypto ticker.',  // → endpoint.summary (one human sentence)
    method: 'GET',
    queryParams: { ticker: { type: 'string', description: 'e.g. BTC' } }, // → endpoint.input
    output: { type: 'object', example: { ticker: 'BTC', usd: 64210.5 } }, // → endpoint.output
  },
})
// the descriptor feeds BOTH extensions.bazaar (for indexes) AND extensions.piprail.endpoint (for agents)
```

A descriptor `summary` **wins over** the gate `description` for the endpoint's one-line "what it
does"; `queryParams` becomes `endpoint.input`; `output` carries straight through.

### Turning it off

It's on by default. Pass `selfDescribe: false` to restore the literal byte-identical 402:

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.01',
  payTo: '0xYourWallet',
  selfDescribe: false, // omit the extensions.piprail block entirely
})
```

### Coexistence with rejections and discovery

On a *rejected* proof the gate already stamps `extensions.piprail.{code,detail}` (the machine-readable
reason a client reads to retry). The self-describe fields are merged in as **siblings**, so the rejection
`code`/`detail` always win on collision, and an opt-in [`extensions.bazaar`](/discovery/emitters/)
discovery block is left untouched. So a rejection response is *both* actionable (it says why) *and*
self-describing (it says what PipRail is + how to pay correctly).

## `buildSelfDescription`: the pure builder

The gate wires this for you; call it directly only when you assemble a challenge yourself. It's pure,
it imports no chain library and does no I/O.

```ts
import { buildSelfDescription, buildEndpointInfo } from '@piprail/sdk'

const block = buildSelfDescription({
  accepts: challenge.accepts, // the rails your 402 offers
  instruction: 'optional one-line human summary',
  // optional: the `endpoint` sub-block. Assemble it from what you know with buildEndpointInfo
  // (pure; returns undefined when nothing was described, so the block stays byte-identical):
  endpoint: buildEndpointInfo({
    description: 'Current USD price for any crypto ticker.',
    mimeType: 'application/json',
  }),
})
// → the extensions.piprail object above (with the endpoint sub-block when described)
```

`buildEndpointInfo({ description?, mimeType?, descriptor? })` → `SelfDescribeEndpoint | undefined`
is the same pure helper the gate uses; the `descriptor` is a `DiscoveryDescriptor`-shaped
`{ summary?, method?, queryParams?, output? }` whose `summary` wins over `description`.

## `describeChallenge`: the one-line summary

`describeChallenge(challenge)` renders a single model- and human-readable line from a challenge,
used as the block's `instruction` and as a landing page's headline.

```ts
import { describeChallenge } from '@piprail/sdk'

describeChallenge(challenge)
// → 'PipRail x402 payment endpoint. Pay 0.01 USDC on eip155:8453 to 0xYourWallet.
//    Programmatic: npm i @piprail/sdk then client.fetch(url). Docs: https://piprail.com.'
```

It degrades gracefully (a foreign challenge with no PipRail `extra`, or an empty `accepts[]`, never
throws).

## The human landing page

Agents and crawlers want the JSON 402; a **human** who opens the URL in a browser wants a readable
page. `gate.landingPage(challenge)` returns a tiny, self-contained HTML document. It leads with the
primary action, **how to pay** (the install + snippet + MCP command), and a prominent **caution**:
payment must go through an x402 client, so the address is shown only as *"what the client pays, NOT a
manual-send address"*. That matters because a human who sends funds straight to the address from an
ordinary wallet would reach the merchant but **not** unlock the resource or get matched to their request
(there's no custody and no manual-payment desk), and the page makes that unmistakable. The
SDK never serves the page; you opt in by branching on the request's `Accept` header:

```ts
const { challenge, requiredHeader } = await gate.challenge(url)

if (req.headers.get('accept')?.includes('text/html')) {
  return new Response(gate.landingPage(challenge), {
    status: 402,
    headers: { 'content-type': 'text/html', 'payment-required': requiredHeader },
  })
}
// otherwise serve the JSON 402 as usual
```

Every interpolated value is HTML-escaped. `renderLandingPage(selfDescription)` is the underlying pure
function if you build the `SelfDescription` yourself.

## HTTP discovery pointers

`discoveryHeaders()` returns a header bag to spread into **every** response (the 402 *and* the 200) so
crawlers/agents find your discovery docs and a payer learns what served them. The 200's
`x-powered-by` is how a settlement "self-advertises" without touching the `X402Receipt` body:

```ts
import { discoveryHeaders, POWERED_BY } from '@piprail/sdk'

discoveryHeaders()
// → {
//     link: '</openapi.json>; rel="service-desc", </.well-known/x402>; rel="x402-discovery"',
//     'x-powered-by': 'PipRail x402 | https://piprail.com',
//   }

discoveryHeaders({ attribution: false }) // omit x-powered-by, keep the Link pointers
```

If a response already carries a `Link` header, comma-merge the two values rather than
object-spreading `discoveryHeaders()` over your existing headers, because an object spread silently
replaces your existing `Link` with PipRail's discovery pointers.

`POWERED_BY` is the response-side twin of the `/openapi.json` [`GENERATOR`](/discovery/emitters/) stamp.

## How an AI agent uses it

The cold-start loop the [agent guide](/agent-toolkit/agent-guide/) teaches:

1. The agent fetches a gated URL and gets a 402 it can't pay with stock tooling.
2. It reads `challenge.extensions.piprail` → identity, per-rail `how`, `sdk.install`, `docs`,
   and, when the merchant described the resource, `endpoint.{summary,input,output}` so it knows
   **what the endpoint does and returns before paying a cent**.
3. It installs `@piprail/sdk` (or runs `npx -y @piprail/mcp`) and pays via the
   [payment tools](/agent-toolkit/the-agent-tools/).

Because the agent guide is exposed over the MCP (as a prompt and the `piprail://guide` resource), an
MCP-connected agent already knows to read this block.

## Brand strings: one source of truth

`BRAND` is the single source for the install command, the snippet, and the docs links that the block,
the landing page, and the agent guide all reuse, so they can never drift:

```ts
import { BRAND } from '@piprail/sdk'

BRAND.sdkInstall // 'npm i @piprail/sdk'
BRAND.mcpRun     // 'npx -y @piprail/mcp'
```
