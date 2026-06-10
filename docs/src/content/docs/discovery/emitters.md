---
title: Discovery emitters
description: Pure functions that turn a gate's payment options into the static artifacts a crawler reads — an OpenAPI doc, a well-known file, a DNS line, and the bazaar block x402scan needs.
sidebar:
  order: 3
---

## Introduction

The emitters are pure, deterministic functions that turn what your gate already knows — its
payment rails — into the open-standard files a crawler or index reads. They do **no network
I/O** and import no chain library: you feed them metadata, they hand back JSON or a string,
and you serve it as a static asset on your own origin. Nothing is PipRail-hosted.

You get the metadata from [`gate.describe()`](/accepting-payments/require-payment-and-gate/),
which returns a `ResourceDescription` — your gate's resolved rails, nonce-free (discovery
metadata is long-lived, so it mints no challenge nonce).

```ts
import { createPaymentGate } from '@piprail/sdk'

const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.10',
  payTo: '0xYourWallet',
})
const resource = await gate.describe('https://api.example.com/report')
// → ResourceDescription:
//   { url: 'https://api.example.com/report', accepts: [ { scheme: 'onchain-proof',
//     network: 'eip155:8453', asset: '0x833…2913', payTo: '0xYourWallet',
//     amount: '100000', amountFormatted: '0.10', decimals: 6, symbol: 'USDC',
//     maxTimeoutSeconds: 600 } ] }
```

A `ResourceDescription` has `url`, an optional `method`/`description`, and an `accepts: PaymentRail[]`.
Each `PaymentRail` is the static, nonce-free shape of one payment option — `scheme`
(`'onchain-proof'` or `'exact'`), `network` (CAIP-2), `asset`, `payTo`, `amount` (base units),
`amountFormatted` (e.g. `'0.10'`), `decimals`, an optional `symbol`, and `maxTimeoutSeconds`.
The emitters below consume `ResourceDescription[]` and never invent anything not already in it.

:::note
There is no single ratified discovery standard yet — OpenAPI-first is an emerging multi-vendor
convention. Emit it, but treat it as a moving target. See [Discover &
register](/discovery/discover-and-register/) for the runtime side (searching and registering on
the open indexes).
:::

## `buildOpenApi` — the primary doc

`buildOpenApi(input)` returns an `OpenApiDocument` — a minimal, valid OpenAPI 3.1 document with
an `x-payment-info` block per paid operation. This is the doc the live open indexes parse today
(x402scan via `@agentcash/discovery`). Serve the result at `https://<origin>/openapi.json`.

```ts
import { buildOpenApi } from '@piprail/sdk'

const doc = buildOpenApi({
  origin: 'https://api.example.com',
  resources: [await gate.describe('https://api.example.com/report')],
})
// → OpenApiDocument:
//   { openapi: '3.1.0', info: { title: 'PipRail x402 resources', version: '1.0.0' },
//     servers: [{ url: 'https://api.example.com' }],
//     paths: { '/report': { get: { responses: {…}, 'x-payment-info': {
//       x402Version: 2, accepts: [ /* the resource's rails */ ] } } } },
//     'x-generator': '@piprail/sdk · https://piprail.com' }
// → serve as /openapi.json
```

Resources are grouped by pathname and keyed by method, so several operations on one path
collapse into a single entry. Each paid op carries `x-payment-info` with `x402Version: 2` and
the resource's `accepts[]` (a `PaymentRail[]`).

Each per-method operation object inside the document is typed as `OpenApiOperation` (exported
from `@piprail/sdk`) — the `{ responses, 'x-payment-info' }` value under a path's `get`/`post`
key. You rarely reference it directly; it's there for typing a hand-built document.

### The `x-generator` stamp

By default the document is stamped with `x-generator` — an unobtrusive "built with" marker (à
la Swagger or Hugo) that rides along wherever an index crawls your `/openapi.json`. It is
metadata only and changes nothing about how the resource is paid or listed. Set
`attribution: false` to omit it.

```ts
import { GENERATOR } from '@piprail/sdk'

console.log(GENERATOR)
// → '@piprail/sdk · https://piprail.com'
```

## `ManifestInput` — the shared input

`buildOpenApi` and `buildWellKnownX402` take the same `ManifestInput`:

| Field | Purpose |
| --- | --- |
| `origin` | The origin you control, e.g. `https://api.example.com` (no path). |
| `resources` | The discoverable `ResourceDescription[]`, one per `gate.describe()`. |
| `ownershipProofs` | Optional eip191 signatures of the bare origin string by a `payTo` key — a trust badge on indexes that verify them. Never required to be listed. |
| `title` | OpenAPI `info.title`. Default `'PipRail x402 resources'`. |
| `version` | OpenAPI `info.version`. Default `'1.0.0'`. |
| `attribution` | Stamp `x-generator`. Default `true`; set `false` to omit. |

When you pass `ownershipProofs`, `buildOpenApi` adds them at `x-agentcash-provenance` — the
provenance block the open indexes read. Produce one with the driver's `signMessage(wallet,
origin)` (via [`client.discoverySigner()`](/making-payments/piprail-client/)); see [Domain
verification](/discovery/domain-verification/).

## `buildWellKnownX402` — the compatibility breadcrumb

`buildWellKnownX402(input)` returns a `WellKnownX402` — x402scan's legacy origin file: the list
of resource URLs plus optional ownership proofs. `/openapi.json` is the primary doc; this is a
fallback for crawlers that read the older format. Serve it at `https://<origin>/.well-known/x402`.

```ts
import { buildWellKnownX402 } from '@piprail/sdk'

const wellKnown = buildWellKnownX402({
  origin: 'https://api.example.com',
  resources: [await gate.describe('https://api.example.com/report')],
})
// → WellKnownX402: { version: 1, resources: ['https://api.example.com/report'] }
```

## `buildX402DnsTxt` — the DNS pointer

`buildX402DnsTxt(input)` returns an `X402DnsRecord` — the experimental `_x402` TXT record that
points at a discovery doc. It hands back the record `name` and `value` to paste into your zone —
PipRail never touches DNS. `host` is the exact host the agent talks to (no inheritance), and
`discoveryUrl` is typically your `/openapi.json`.

```ts
import { buildX402DnsTxt } from '@piprail/sdk'

const txt = buildX402DnsTxt({
  host: 'api.example.com',
  discoveryUrl: 'https://api.example.com/openapi.json',
})
// → X402DnsRecord:
//   { name: '_x402.api.example.com', type: 'TXT',
//     value: 'v=x4021;url=https://api.example.com/openapi.json' }
```

Pass an optional `descriptor` string to prepend a `descriptor=…;` segment to the value.

## `buildBazaarExtension` — the input schema x402scan requires

x402scan rejects a listing without an input schema. `buildBazaarExtension(descriptor)` takes a
`DiscoveryDescriptor` and returns a `BazaarExtension` — the `extensions.bazaar` block that
satisfies that check: `info.input` describes the request and `schema` is its JSON Schema. With
no argument it defaults to a no-input GET, the minimal shape a live listing accepts.

```ts
import { buildBazaarExtension } from '@piprail/sdk'

const bazaar = buildBazaarExtension({
  method: 'GET',
  queryParams: { city: { type: 'string' } },
})
// → BazaarExtension:
//   { info: { input: { type: 'http', method: 'GET', queryParams: { city: { type: 'string' } } },
//             output: { type: 'json' } },
//     schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', … } }
```

You usually don't call this directly: pass a `DiscoveryDescriptor` to a gate's `discovery`
option and the block is emitted in the 402 challenge for you. Build it directly only when you
assemble the discovery payload yourself.

The `DiscoveryDescriptor` fields:

| Field | Purpose |
| --- | --- |
| `method` | HTTP method the resource answers. Default `'GET'`. |
| `queryParams` | Query params as a JSON-Schema `properties` object (name → schema). Default `{}`. |
| `output` | Optional output hint (`type` / `example`) for a richer listing. |

## A note on schemes

PipRail's own rails advertise `scheme: 'onchain-proof'`. A merchant who wants to be *usefully*
listed on the open indexes should additionally offer a standard `exact` USDC rail on
Base/Solana — the emitters carry whichever rails `gate.describe()` returns, so dual-advertising
flows through automatically. See the [exact rail seller
guide](/accepting-payments/exact-rail-seller/) for how to turn it on.
