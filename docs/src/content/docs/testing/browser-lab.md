---
title: The browser lab
description: 'Run the whole SDK in a browser tab at piprail.com/demo: 30 tests covering every public call, what each one needs, and the handful that will not fire.'
sidebar:
  order: 4
---

## Introduction

[piprail.com/demo](https://piprail.com/demo) loads the published `@piprail/sdk` from a CDN and
runs it in your tab. No key, no signup, nothing installed. It mints a real 402, signs a real
gasless authorization, verifies a real Base payment against the chain, prices a real swap route,
and searches the open indexes, all from a page you did not have to set up.

It is a bench rather than a brochure, so the claim it makes about itself is checked. The lab
declares which SDK symbols each test calls, and `npm run lab:coverage` reads the built package
and fails when a public symbol is exercised by no test and has no stated reason. At the time of
writing that is **236 of 242 public symbols across 30 tests**, with six deliberately left off.

## What runs where

Almost everything works in a browser exactly as it works in Node. Three things do not, and the
page says so in the panel rather than leaving you to guess.

| Test | Runs in a browser | What it needs |
|---|---|---|
| Everything under Setup, Merchant, Interop | yes | nothing |
| Quote, gas, plan, classify, policy, budget | yes | a public RPC for the live ones |
| Sign a gasless payment | yes | nothing, which is the point |
| Try to pay it | yes, to the refusal | a funded wallet to succeed |
| Swap its own funds | quote yes, swap to the refusal | a funded wallet and a swap policy |
| Search the market | yes | a same-origin forwarder |
| Prove you own the domain | no | a server-side runtime |
| Facilitators | registry yes, live probe no | a server-side runtime |

### The forwarder

The open x402 indexes send no usable CORS header. 402 Index and CDP Bazaar send none, and
Circle sends `Access-Control-Allow-Origin` twice, which browsers reject. CORS is enforced by the
browser, so no library option changes it.

The SDK ships its own forwarder for that case. Mount it on any route your app already serves:

```ts
import { indexProxyHandler, INDEX_PROXY_PATH } from '@piprail/sdk'

export default indexProxyHandler()
export const config = { path: '/api/x402-index' }   // INDEX_PROXY_PATH
```

There is nothing to set on the client. In a browser the SDK probes that conventional path once,
uses it when something answers, and reads the indexes directly when nothing does. Outside a
browser it never probes at all, so a server issues no request it did not issue before.

PipRail hosts none of this. Pointing the default at a proxy we run would have been easier and is
exactly the shape this project exists to avoid: it would put us in the path of every user's
searches, and make a rail that works without us depend on us.

### Calls that need a server

Two calls make a cross-origin POST to a host that answers no preflight, so a page cannot complete
them:

- `verify402IndexDomain()` and `client.verifyDomain()`
- `facilitatorCoverage()`

Neither throws. They return a verdict with a reason, the same as every other discovery call, so
an agent that loses a directory keeps running rather than crashing on somebody else's outage.
Run the identical line in Node and it answers.

## The six calls the lab will not make

Needing a wallet is not a reason to skip a test. An empty wallet still runs the whole path, and
the refusal it gets is worth seeing: it is exactly what a freshly created agent sees before
anyone funds it. These six are different, because a stranger clicking them would write into
somebody else's system:

| Call | Why not |
|---|---|
| `register402Index()`, `registerX402Scan()`, `client.register()` | Posts a listing into a public directory people search |
| `claim402IndexDomain()`, `client.claimDomain()` | Writes an ownership claim on a domain you would then have to prove |
| `settleViaFacilitator()` | Submits a payment to a third party for settlement, with real money |

The lab builds the exact payload each one would send and shows it, then stops.

## Running it against your own build

The lab pins an exact SDK version, read from the package itself. `@3` resolves to whatever the
CDN last cached, which is how a page ends up demonstrating features on a build that predates
them with no sign anything is wrong.

To exercise a change before it is published, run the site locally and add `?sdk=local`:

```bash
npm run build:sdk
cp -r sdk/dist site/public/_localsdk
npm run dev
open 'http://localhost:4321/demo/?sdk=local'
```

`npm run dev` also serves the forwarder, using the same handler the deployed function mounts, so
discovery behaves in development the way it behaves in production.

## Keeping it honest

```bash
npm run lab:coverage            # the summary, and anything unclaimed
npm run lab:coverage -- --list  # every public symbol and the test that calls it
```

It reads the **built** SDK on purpose. Reading `sdk/src` would measure a surface the published
page cannot reach, and would go green while the lab was broken. It also checks the test ids
against the runner keys in both directions, because those two are joined by a string at runtime:
an id with no runner is a button that throws when a visitor clicks it, and a runner with no id is
code nobody can reach. Neither shows up in a type check.
