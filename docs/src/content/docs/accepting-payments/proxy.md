---
title: Gate an existing API (proxy)
description: Put an x402 paywall in front of an API you already have — in any language — without touching it. A deployable edge proxy that forwards only paid requests to your origin.
sidebar:
  order: 7
---

## The idea

Already have an API — in Python, Go, Rails, anything? You don't have to rewrite it to charge for it.
`proxyTo(origin)` is a ready-made handler that **forwards a paid request to your existing backend,
untouched** — and rejects unpaid ones before they ever reach it. Deploy it on the edge in front of
your API; the API never changes and never sees an unpaid request.

```ts
import { createPaywall, toWorker, proxyTo } from '@piprail/sdk'

const gate = createPaywall({ chain: 'base', amount: '0.01', payTo: '0xYourWallet' })

// A Cloudflare Worker that charges 0.01 USDC per request to https://api.example.com:
export default toWorker(gate, proxyTo('https://api.example.com'))
```

`proxyTo` preserves the method, path, query, body, and headers; it strips the x402 proof headers so
they don't leak upstream. The origin only ever receives requests that have already paid — an unpaid
request gets a `402` and **never reaches your backend**.

## Scaffold it

The fastest way is the scaffolder's `proxy` mode — it generates a complete, mainnet-default edge proxy:

```sh
npm create piprail -- my-gateway \
  --sell proxy \
  --origin https://api.example.com \
  --host cloudflare \
  --pay-to 0xYourPublicAddress \
  --amount 0.01
```

The generated worker forwards paid traffic to your origin and serves `/.well-known/x402` so AI agents
can discover and price it. → [Scaffold a merchant](/getting-started/scaffolder/)

## How it compares

Cloudflare ships an `x402-proxy` template too — but it defaults to **testnet** and routes settlement
through a facilitator. PipRail's proxy is **mainnet-default** and **facilitator-free**: it verifies
each payment locally against your own RPC, and receiving needs only your public address — no key, no
account, no middleman.

## Notes

- The proxy is **edge-only** (Cloudflare Workers / Vercel Edge Functions) — that's where a low-latency
  forward belongs. For a Node/Express app you own, gate the route directly with
  [`requirePayment`](/accepting-payments/require-payment-and-gate/) instead.
- It gates **every path**. Carve out free routes by checking `new URL(request.url).pathname` before
  the gate — exactly like the scaffolded `/.well-known/x402` route does.
- `proxyTo` composes with both [framework adapters](/accepting-payments/framework-adapters/):
  `toWorker(gate, proxyTo(origin))` for the `{ fetch }` export, or
  `toFetchHandler(gate, proxyTo(origin))` for a bare handler.
