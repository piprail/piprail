---
title: The open indexes
description: The three open x402 directories PipRail reads from and writes to, their auth, chains, and lifecycle facts, and the low-level functions that talk to them.
sidebar:
  order: 2
---

## Introduction

PipRail hosts no directory of its own. To be found, and to find others, it reads from and writes
to the **open x402 directories that already exist**. There are three, and they behave
differently: different auth, different chains, different timing before a listing is searchable.

This page is the per-index reference. The high-level
[`client.discover()` / `client.register()`](/discovery/discover-and-register/) wrap these
functions; reach for the low-level ones when you want to read a single index, register without a
client, or branch on an index's behaviour before you call it.

The three sources, named by the exported `DiscoverySource` union (`'bazaar' | '402index' | 'x402scan'`):

| Source | Reads | Writes |
| --- | --- | --- |
| `bazaar` | CDP Bazaar, a free, keyless read of the facilitator catalog | none (settle-coupled; see below) |
| `402index` | 402 Index, a free read | no-auth POST (the primary register target) |
| `x402scan` | not read by `discover()` | one wallet signature (SIWX), Base/Solana only |

## The lifecycle facts: `DIRECTORY_INFO`

`DIRECTORY_INFO` is the single source of truth for how each index behaves: a static map an agent
can branch on without embedding directory knowledge in its own code. `getDirectoryInfo(source)`
takes a `DiscoverySource` and returns one `DirectoryInfo` entry.

```ts
import { getDirectoryInfo } from '@piprail/sdk'

const info = getDirectoryInfo('402index')
// → DirectoryInfo { source, review, auth, chains, onSuccess, readByDiscover, caveat }
info.auth            // 'none'
info.readByDiscover  // true: discover() reads this index
info.onSuccess       // 'pending-review': a fresh listing isn't searchable yet
```

Each `DirectoryInfo` carries these fields:

| Field | Meaning |
| --- | --- |
| `source` | The `DiscoverySource` this describes. |
| `review` | How a listing is gated: `'probe-sync'` (the index fetches your URL on submit) or `'settle-coupled'` (cataloged only when a facilitator settles a payment). |
| `auth` | Auth to write a listing: `'none'`, `'siwx'`, or `'facilitator-only'`. |
| `chains` | CAIP-2 chains this index will list, or `null` for any chain the resource advertises. |
| `onSuccess` | The visibility a successful listing reaches: `'live'`, `'pending-review'`, or `'not-listable'`. |
| `readByDiscover` | Whether this SDK's `discover()` reads this index. |
| `caveat` | A one-line, agent-readable note: why a register might fail, or what to expect after. |

Branch on the facts rather than guessing. The map, as PipRail ships it:

| | `bazaar` | `402index` | `x402scan` |
| --- | --- | --- | --- |
| `review` | `settle-coupled` | `probe-sync` | `probe-sync` |
| `auth` | `facilitator-only` | `none` | `siwx` |
| `chains` | `null` (any) | `null` (any) | Base + Solana only |
| `onSuccess` | `not-listable` | `pending-review` | `live` |
| `readByDiscover` | yes | yes | **no** |

:::note
`discover()` reads `bazaar` + `402index`, **not** `x402scan`. A live x402scan listing won't
appear in your `discover()` results. That absence is by design, not a failure. The
`readByDiscover` flag tells you so before you call.
:::

## Searching with `searchOpenIndexes`

`searchOpenIndexes()` takes a `SearchOpenIndexesOptions` and returns `DiscoveredResource[]`. It
reads the open indexes in parallel and merges the hits, deduped by resource URL (the first source
in `sources` wins). It defaults to the two free indexes.

```ts
import { searchOpenIndexes } from '@piprail/sdk'

const hits = await searchOpenIndexes({ query: 'weather' })
// → DiscoveredResource[], each: { resource, source, rails, name?, description?, category?, priceUsd? }
```

It **never throws.** Any index that errors, times out, or changes shape simply contributes `[]`,
so a dead index never breaks the rest of your search (no try/catch needed):

```ts
const hits = await searchOpenIndexes({ sources: ['bazaar', '402index'], limit: 50 })
// → DiscoveredResource[]. If 402index is down, you still get bazaar's results (never an empty throw)
```

:::note[Why a query needs more than a raw index search]
The two indexes search badly, in opposite ways, so `searchOpenIndexes` (and `client.discover()`)
compensate:

- **402 Index** search is **literal and AND-tokenized**. `?q=` matches only listings whose text
  contains **every** word verbatim, so a multi-word query like `'crypto price feed'` misses an
  obviously-relevant "BTC/USD oracle" listing. To beat this, a multi-word query **fans out**: one
  request per word (plus the full phrase), capped at 5, unioned, and the merged set is **ranked
  client-side by relevance** (weighted name > category/tags > URL > description, with a bonus when
  every token matches).
- **Bazaar's** keyless search is effectively unusable, so its catalog is fetched and then
  **filtered + ranked client-side** against your query.

Net: a natural-language, multi-word query that returned nothing against the raw indexes now lands
on the right resource.
:::

The options object is the exported `SearchOpenIndexesOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `query` | none | Free-text. Tokenized + matched across name / description / category / URL; fans out per-word on 402 Index, filters Bazaar client-side, then ranks the merged set by relevance. |
| `category` | none | Keep only this category (prefix match). Strict, so uncategorized results are dropped; pushed to 402 Index server-side. |
| `asset` | none | Keep only resources paying in this token symbol; keeps results whose asset the index didn't report. |
| `maxPrice` | none | Drop results advertised above this USD price (no-price results pass). |
| `minReliability` | none | Drop results scored below this (0 to 100); unscored results pass. |
| `verified` | none | Prefer verified listings (402 Index server-side; not re-filtered client-side). |
| `paymentValid` | none | Restrict to 402-Index-confirmed-payable listings. |
| `sort` | `'relevance'`\* | `DiscoverySort`: `'relevance'` \| `'reliability'` \| `'price'` \| `'uptime'` \| `'name'`. \*Relevance by default with a query, else first-seen order. |
| `order` | `'desc'` | Direction for a non-relevance `sort`. |
| `sources` | `['bazaar', '402index']` | Which indexes to read (both free). |
| `limit` | `20` | Max results to fetch per index request; the fan-out can issue several, so the merged total before dedupe can exceed it. |
| `signal` | none | An `AbortSignal` to cancel the reads. |

Each `DiscoveredResource` is normalized to one shape across sources. Its `rails` are
**cross-scheme and best-effort**, because indexes mostly carry the standard `exact` scheme, so a
`DiscoveredRail` is looser than a live `accepts[]` entry: a required `scheme` / `network`, plus
optional `asset` / `amount` / `payTo` / `symbol`. Feed a chosen `resource` straight into
[`quote()`](/making-payments/quote/) to get the authoritative offer.

:::note
`x402scan` reads are paid, so `searchOpenIndexes` returns `[]` for it even when you list it in
`sources`. Use `bazaar` and `402index` to read.
:::

## Registering on 402 Index with `register402Index`

402 Index is the friction-free write path: a single POST, **no auth, no signature, no payment.**
It takes a `RegisterInput` and returns a `RegisterOutcome`.

```ts
import { register402Index } from '@piprail/sdk'

const outcome = await register402Index({
  url: 'https://api.example.com/report',
  description: 'Daily market report',
  priceUsd: 0.1,   // advertised-price METADATA (402 Index field), not a PipRail-computed price
  asset: 'USDC',
  network: 'base',
})
// → RegisterOutcome { source: '402index', ok: true, status: 200, detail: '…' }
//   (BARE: visibility/note unset until decorateOutcome runs; see below)
```

It returns a `RegisterOutcome` and **never throws** for an HTTP or transport problem. Failures
come back as `{ ok: false, detail }`, so branch on `outcome.ok` rather than wrapping it in a
try/catch. 402 Index *probes your URL on submit*, so an endpoint that doesn't actually return a
402 is rejected (the reason is surfaced in `detail`).

```ts
if (!outcome.ok) console.error(outcome.detail)  // the index's own reason
```

The `RegisterInput` fields:

| Field | Notes |
| --- | --- |
| `url` | Required. The gated resource. |
| `name` | Defaults to the URL's hostname. |
| `category` | **The field that moves the needle.** Most of the catalog is `uncategorized`, so a real category (`'ai'`, `'finance'`, …) makes a listing rank + filter. |
| `tags` | Keywords, folded into the description as a `· Keywords: …` tail (search is literal) **and** sent as a `tags` field. |
| `description` / `priceUsd` | Listing metadata. The description is the one field an index displays. |
| `asset` / `network` | Payment symbol (e.g. `'USDC'`) and network slug (e.g. `'base'`). |
| `method` | HTTP method the resource answers on. Defaults to `GET`. |
| `provider` / `contactEmail` | Who runs the resource, and a contact email (also used by the domain claim). |
| `probeBody` | A JSON body the index sends when health-checking a **POST/PUT** resource, so probes pass and the reliability score stays high. |
| `attribution` | **Default on** (opt out with `false`). Attributes the listing to PipRail via a `via: '@piprail/sdk'` field + a tasteful `· Built with @piprail/sdk` description suffix. Metadata only. |

A self-registered listing comes back **pending review** (`onSuccess: 'pending-review'`), probed on
submit, then searchable once it passes 402 Index's automated health + payment checks (no domain
verification required, as proven by the live demo). To go live **instantly** instead, and to
flip every pending listing on the domain to live with a verified badge, verify your domain; see
[Domain verification](/discovery/domain-verification/).

:::note
The outcome `register402Index` returns is **bare**: its `visibility` and `note` are not filled
in. `client.register()` projects those from `DIRECTORY_INFO` automatically; if you call the
low-level function directly, run the result through `decorateOutcome()` to get them.
:::

## Registering on x402scan with `registerX402Scan`

x402scan needs **one wallet signature** (Sign-In-With-X / SIWX): the function POSTs your URL,
receives an EIP-4361 challenge, signs it with your key, and resends. It's facilitator-free, but
**Base/Solana only** and EVM-signing today. It returns a `RegisterOutcome`.

```ts
import { PipRailClient, registerX402Scan } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY! },
})

// A DiscoverySigner = { address, signMessage }. The bound EVM wallet exposes one.
const signer = await client.discoverySigner()
if (!signer) throw new Error('x402scan SIWX needs an EVM signer; this chain has none.')

const outcome = await registerX402Scan(
  { url: 'https://api.example.com/report' },
  signer,
)
// → RegisterOutcome { source: 'x402scan', ok: true, status: 200, detail: 'Listed on x402scan (SIWX).' }
```

The `signer` is a `DiscoverySigner`: an `address` plus a `signMessage(message)` that returns the
signature. Like the others, it **never throws**; a failed handshake returns `{ ok: false }` with
the index's reason in `detail`.

x402scan also needs a resolvable input schema for your resource, emitted from
[`/openapi.json` or the bazaar extension](/discovery/emitters/) so the listing validates. On
success it goes **live immediately** on x402scan.com.

:::caution
The open SIWX handshake is a moving convention, so `registerX402Scan` is experimental. Validate
against x402scan before relying on it. And remember: `discover()` doesn't read x402scan, so a
live listing there won't appear in your discovery results.
:::

## Why Bazaar can't be written to

CDP Bazaar has **no register endpoint** (`auth: 'facilitator-only'`, `review:
'settle-coupled'`). It catalogs a resource only when *its own facilitator settles a payment* for
it. PipRail [verifies locally with no facilitator](/concepts/payment-driver-architecture/), so a
PipRail resource structurally can't be listed there, so `onSuccess` is `'not-listable'`. You can
still **read** Bazaar to find others; to be found, list on 402 Index or x402scan.

This is exactly the kind of fact you don't want to hard-code. Branch on `DIRECTORY_INFO`
instead:

```ts
import { getDirectoryInfo } from '@piprail/sdk'

if (getDirectoryInfo('bazaar').onSuccess === 'not-listable') {
  // skip bazaar as a register target, because it can't list a backendless resource
}
```
