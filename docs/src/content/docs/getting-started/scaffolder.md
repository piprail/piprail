---
title: Scaffold a merchant (create-piprail)
description: One command scaffolds a self-hosted x402 merchant — accept stablecoin payments from humans and AI agents, straight to your wallet. Paste a public address; no key, no account, no backend.
sidebar:
  order: 2
---

## One command

`create-piprail` is the **seller's** zero-code on-ramp — the mirror of the buyer's
[`npx -y @piprail/mcp`](/mcp/getting-started/). It scaffolds a complete, runnable, **mainnet-by-default**
x402 merchant you host yourself:

```sh
npm create piprail@latest
```

It asks **what you're selling**, **which chain + token**, and **your public wallet address**, then
writes a ready-to-run app. Receiving needs only that **public address** — no private key, no account,
no backend, no fee.

## Non-interactive (CI / scripts)

```sh
npm create piprail -- my-shop \
  --sell api \           # api (paywall) | tip (tip jar) | proxy (gate an existing API — add --origin)
  --chain base \         # any mainnet chain @piprail/sdk supports
  --token USDC \
  --pay-to 0xYourPublicAddress \
  --amount 0.05 \        # the price (api) — or --min for a tip jar
  --host cloudflare \    # node | cloudflare | vercel
  --yes
```

## What it generates

```
my-shop/
├── package.json          # depends ONLY on @piprail/sdk (+ express for the node host)
├── src/gate.mjs          # the one bit of PipRail code — createPaywall / createTipJar, config baked in
├── src/verify.mjs        # `npm run verify` → gate.selfTest(), a no-sign config check
├── src/server.mjs        # node  ·  OR  src/worker.mjs + wrangler.toml (Cloudflare)  ·  OR  api/x402.js + vercel.json (Vercel)
└── README.md
```

The gate is the whole integration — built on the [presets](/accepting-payments/merchant-presets/) and,
on the worker, a [framework adapter](/accepting-payments/framework-adapters/):

```js
import { createPaywall } from '@piprail/sdk'

export const gate = createPaywall({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo: '0xYourPublicAddress',
})
```

It also serves `/.well-known/x402` so AI agents can **discover and price** your endpoint. Open the URL
in a browser and you get a **friendly landing page** (for humans), while an agent or `curl` gets the
machine-readable `402` (for machines). To gate an API you **already have** (any language), use
`--sell proxy --origin <url>` → [Gate an existing API](/accepting-payments/proxy/).

## Verify, then run

Every generated app ships a `verify` script — a read-only
[`gate.selfTest()`](/accepting-payments/merchant-presets/#gateselftest--did-i-wire-this-right) that
checks your config without signing or sending:

```sh
npm install
npm run verify
# ✅ Configured to accept:
#    0.05 USDC on eip155:8453 -> 0xYourPublicAddress  [onchain-proof]
npm start          # node host  (or: npm run dev / npm run deploy on Cloudflare)
```

## Mainnet by default

Unlike the common x402 reference templates, `create-piprail` **never** emits a testnet config — the
chain and your address are baked into `src/gate.mjs`, so your endpoint takes **real** payments on first
deploy. (There's no testnet template; you paste a mainnet chain + address.)

## Deploy in one click

The **Cloudflare** and **Vercel** hosts include a **Deploy** button in the generated README. Push your
app to a public GitHub repo, click the button, and it deploys to **your own** Cloudflare / Vercel
account — your public address is already baked in, with nothing else to configure and no secret to
set. (The node host runs anywhere with `npm start` — a VPS, PM2, a container.)

## Why it's safe to paste your address

A receiving address is **public** — PipRail verifies each payment locally against your own RPC, so
there's no key in the project, no custody, and no account. See
[How it works](/getting-started/how-it-works/).
