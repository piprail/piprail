---
title: Framework adapters
description: Drive createPaymentGate by hand in Hono, Fastify, Cloudflare Workers, Next.js, Bun, or Deno — and the Express-like types that keep requirePayment dependency-free.
sidebar:
  order: 6
---

## Introduction

[`requirePayment`](/accepting-payments/require-payment-and-gate/) is Express/Connect
middleware. Everywhere else — Hono, Fastify, Cloudflare Workers, Next.js route handlers, Bun,
Deno, anything with `fetch` — you build a [`createPaymentGate`](/accepting-payments/require-payment-and-gate/)
once and drive it yourself. The gate is plain, framework-free logic; the adapter is the handful
of lines that read one header in and write three back out.

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet' })
// → PaymentGate: { challenge(url?), verify(header), verifyObject(payload), describe(url?), landingPage(challenge), selfTest() }
```

`createPaymentGate` returns a [`PaymentGate`](/accepting-payments/require-payment-and-gate/) — the
same object `requirePayment` wraps. Reuse one gate per gated route. Its in-memory used-proof set
is what stops a proof being redeemed twice; rebuilding it per request would lose that guard. (For
multi-instance deploys, share the set with `isUsed` / `markUsed` — see
[Replay protection](/accepting-payments/replay-protection/).)

## The one-liner — built-in adapters

There are only **two shapes** among `fetch` runtimes, so there are two adapters — and between them
they cover essentially everything request-in, response-out:

| Your runtime | Adapter |
| --- | --- |
| Next.js route handlers · Netlify Functions · `Bun.serve` · `Deno.serve` · Vercel Edge · Hono (`c.req.raw`) · AWS Lambda (Web adapter) · Fastly Compute | **`toFetchHandler`** — a universal `(request, …) => Response` you place anywhere |
| Cloudflare Workers · Service Workers · any `export default { fetch }` | **`toWorker`** — the `{ fetch }` export object |
| Express · Connect · Polka | [`requirePayment`](/accepting-payments/require-payment-and-gate/) (middleware) |
| Fastify & other Node-native `req`/`reply` frameworks | drive `gate.verify()` by hand (below) |

```ts
import { createPaywall, toFetchHandler, toWorker } from '@piprail/sdk'

const gate = createPaywall({ chain: 'base', amount: '0.05', payTo: '0xYourWallet' })

// Next.js / Netlify / Bun / Deno / Hono / Vercel / Lambda — anything request-in, response-out:
export const GET = toFetchHandler(gate, () => Response.json({ report: 'unlocked' }))

// Cloudflare Worker (the { fetch } export object):
export default toWorker(gate, () => Response.json({ report: 'unlocked' }))
```

Each takes the gate + a `serve` callback (what to return once payment is verified) and runs the
whole contract for you: reads `payment-signature` (and the legacy `x-payment`), returns a conformant
`402` on a missing/rejected proof, stamps the `payment-response` headers (v2 + v1) on success, and
returns `502` on a server-side `SettlementError` (never a `402`). **Any extra arguments the runtime
passes your handler — a Worker's `env`/`ctx`, a Next.js route `context` — are forwarded to `serve`**,
so a protected handler can reach them after payment is verified:

```ts
export default toWorker(gate, (request, env, ctx) => {
  // env (KV / D1 / R2 bindings) + ctx (waitUntil) are available here.
  return Response.json({ report: 'unlocked' })
})
```

Express keeps its dedicated [`requirePayment`](/accepting-payments/require-payment-and-gate/)
middleware. Prefer to wire it by hand — or on a non-`fetch` framework like Fastify? The exact
three-step contract every adapter implements is below.

## The contract every adapter implements

Every adapter does the same three things, regardless of framework:

1. Read the inbound proof header and pass it to `gate.verify()`.
2. Switch on the returned [`VerifyPaymentResult`](/accepting-payments/verifying-payments/) `kind`.
3. Set the matching response header and status.

| `kind` | Status | Response header | Body | Then |
| --- | --- | --- | --- | --- |
| `'paid'` | `200` | `payment-response: result.receiptHeader` | your resource | serve it |
| `'challenge'` | `402` | `payment-required: result.requiredHeader` | `result.challenge` | wait for a retry |
| `'invalid'` | `402` | `payment-required: result.requiredHeader` | `result.challenge` | wait for a retry |

```ts
const result = await gate.verify(headerValue)
// → { kind: 'paid', receipt, receiptHeader }
//   | { kind: 'challenge', challenge, requiredHeader, statusCode: 402 }
//   | { kind: 'invalid', error, detail, challenge, requiredHeader, statusCode: 402 }
```

`gate.verify()` accepts `string | string[] | undefined`, so hand it whatever your framework
gives you for the `payment-signature` header without massaging it first. A missing header is
not an error — it returns `kind: 'challenge'`, the first-request 402.

:::caution
On `'invalid'`, send back `result.challenge` — it carries the `accepts[]` a standard client
needs to retry. The legacy `toInvalidBody` helper omits `accepts[]` and is deprecated; a client
that receives it can't retry.
:::

## Hono / Workers / any `fetch` handler

The Fetch API shape — `Request` in, `Response` out — covers Cloudflare Workers, Bun, Deno, and
Hono in one form:

```ts
app.get('/report', async (c) => {
  const r = await gate.verify(c.req.header('payment-signature'))
  if (r.kind === 'paid') {
    return c.json({ report: 'unlocked' }, 200, { 'payment-response': r.receiptHeader })
  }
  return c.json(r.challenge, 402, { 'payment-required': r.requiredHeader })
})
```

`'challenge'` and `'invalid'` both return `r.challenge` with a `402`, so a single fall-through
branch handles both.

## Next.js route handler

A route handler is a `fetch` handler — same three branches, returning a `Response`:

```ts
export async function GET(req: Request) {
  const r = await gate.verify(req.headers.get('payment-signature') ?? undefined)
  if (r.kind === 'paid') {
    return Response.json({ report: 'unlocked' }, { headers: { 'payment-response': r.receiptHeader } })
  }
  return Response.json(r.challenge, { status: 402, headers: { 'payment-required': r.requiredHeader } })
}
```

Define the gate at module scope, not inside the handler, so the replay guard survives between
requests.

## Fastify

Fastify gives you `request` / `reply` rather than `fetch` primitives, but the gate is identical:

```ts
fastify.get('/report', async (request, reply) => {
  const r = await gate.verify(request.headers['payment-signature'])
  if (r.kind === 'paid') {
    reply.header('payment-response', r.receiptHeader)
    return { report: 'unlocked' }
  }
  reply.header('payment-required', r.requiredHeader).code(402)
  return r.challenge
})
```

## Header constants

The header names are exported so you never hard-code a typo. PipRail also reads and writes the
legacy v1 header names, which an older standard `exact` client may use:

```ts
import {
  HEADER_SIGNATURE,     // 'payment-signature'  (inbound proof)
  HEADER_REQUIRED,      // 'payment-required'   (outbound 402 challenge)
  HEADER_RESPONSE,      // 'payment-response'   (outbound receipt)
  HEADER_SIGNATURE_V1,  // 'x-payment'          (legacy inbound)
  HEADER_RESPONSE_V1,   // 'x-payment-response' (legacy outbound)
} from '@piprail/sdk'
```

To accept both header generations, read the v2 name and fall back to v1 — the built-in
`requirePayment` middleware does exactly this:

```ts
const r = await gate.verify(req.headers[HEADER_SIGNATURE] ?? req.headers[HEADER_SIGNATURE_V1])
```

When serving a `'paid'` result, set both response headers if you want either client generation
to read the receipt: `payment-response` and `x-payment-response`, both to `r.receiptHeader`.

## The Express-like types

`requirePayment` is typed against a minimal local interface, not `@types/express` — so the SDK
needs no Express dependency and the middleware drops into Connect, Polka, or any look-alike. The
shapes are exported if you wrap or adapt the middleware:

| Type | What it is |
| --- | --- |
| `ExpressLikeRequest` | `{ headers, originalUrl?, url? }` — just the fields the gate reads. |
| `ExpressLikeResponse` | `{ setHeader, status, json }` — the three methods it writes through. |
| `ExpressLikeNext` | `(err?: unknown) => void` — call to proceed on a paid request. |
| `ExpressLikeMiddleware` | `(req, res, next) => Promise<void> \| void` — the return type of `requirePayment`. |

```ts
import { requirePayment, type ExpressLikeMiddleware } from '@piprail/sdk'

const gated: ExpressLikeMiddleware = requirePayment({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
})
```

## Settlement errors are 5xx, not 402

This only applies when you opt into the standard [`exact` rail](/accepting-payments/exact-rail-seller/),
where the server settles the payment itself (own relayer or a chosen facilitator). If that
server-side settle fails — relayer out of gas, facilitator down — `gate.verify()` **throws** a
`SettlementError`. That's not the payer's fault: their signed authorization is still valid and
unused, so return a `5xx`, never a `402` (a `402` would tell them to pay again).

```ts
import { createPaymentGate, SettlementError, type VerifyPaymentResult } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.10', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { key: process.env.AGENT_KEY } },
})

export async function GET(req: Request) {
  let result: VerifyPaymentResult
  try {
    result = await gate.verify(req.headers.get('payment-signature') ?? undefined)
  } catch (err) {
    if (err instanceof SettlementError) {
      // err.code === 'SETTLEMENT_FAILED'. Payer's authorization is still valid + unused.
      return Response.json({ error: 'settlement_failed', detail: err.message }, { status: 502 })
    }
    throw err
  }
  if (result.kind === 'paid') {
    return Response.json({ report: 'unlocked' }, { headers: { 'payment-response': result.receiptHeader } })
  }
  return Response.json(result.challenge, { status: 402, headers: { 'payment-required': result.requiredHeader } })
}
```

The default `onchain-proof` rail never settles on the server (the payer already broadcast their
own transfer), so a gate without `exact` will never throw `SettlementError` from `verify()`.
