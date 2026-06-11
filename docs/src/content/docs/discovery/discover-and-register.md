---
title: Discover & register
description: Find payable x402 resources on the open indexes, and list one you run — both free, with no PipRail-hosted registry in the loop.
sidebar:
  order: 1
---

## Introduction

Discovery is two read/write moves against the **open** x402 directories that already exist —
PipRail hosts none of them. `client.discover({ query })` reads them to find payable resources;
`client.register(url)` lists a resource you run. Both are $0, move no funds, and never throw
for a read/transport problem — a dead or changed index simply contributes nothing.

:::note
There is no PipRail registry. `discover()` reads **CDP Bazaar** + **402 Index** (both free);
`register()` writes to **402 Index** (no auth) by default. PipRail is the transport and the
normalizer, not a directory.
:::

## Discover — find payable resources

`discover()` reads the open indexes, merges and dedupes them by resource URL, and by default
returns only resources payable on **this client's chain**. Each result is a
`DiscoveredResource` carrying its advertised `rails[]`, so a chosen `resource` feeds straight
into the read-only trio.

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
})

const found = await client.discover({ query: 'weather' })
// → DiscoveredResource[] — [] if every index is down or empty (never throws)

for (const r of found) {
  // priceUsd is the index's advertised figure when it reports one — often absent
  console.log(r.resource, r.priceUsd ?? '(no advertised price)', r.source)
  // feed r.resource into quote() / planPayment() to confirm + pay
}
```

Then pipe a result into [`quote()`](/making-payments/quote/) →
[`planPayment()`](/making-payments/plan-payment/) → [`fetch()`](/making-payments/fetch-and-autoroute/)
to actually pay it.

### DiscoverOptions

| Option | Default | Purpose |
| --- | --- | --- |
| `query` | — | Free-text, matched against name / description / resource URL. |
| `network` | `'self'` | `'self'` (this client's chain), `'any'` (every chain), or a CAIP-2 id / chain slug like `'base'`. |
| `maxPrice` | — | Drop results whose advertised price exceeds this number. Results with no advertised price pass through. |
| `sources` | `['bazaar', '402index']` | Which open indexes to read. |
| `limit` | `20` | Max results per source before merge. |

`network: 'self'` is the useful default: it returns only what this wallet can actually pay,
matched via the bound driver's own `supports()` so it works on every family, including custom
chains. A rail whose network can't be resolved is kept rather than hidden — discovery is never
silently empty on an unmapped chain.

```ts
// Look across all chains, then decide later with planAcross()
const all = await client.discover({ query: 'image', network: 'any', maxPrice: 1 })
// → DiscoveredResource[] across every chain (filter/plan locally)
```

### A DiscoveredResource

```ts
interface DiscoveredResource {
  resource: string          // the gated URL — quote/pay this
  source: DiscoverySource   // which index surfaced it ('bazaar' | '402index' from discover())
  name?: string
  description?: string
  category?: string
  priceUsd?: number         // advertised price, when the index reports one (402 Index)
  rails: DiscoveredRail[]   // the advertised payment options (cross-scheme)
}
```

:::caution
Results are **cross-scheme** — the open indexes mostly carry the mainstream `exact` scheme, not
PipRail's `onchain-proof`. `fetch()` pays `onchain-proof` rails by default; to pay a standard
`exact` rail (EVM + EIP-3009 — USDC/EURC) opt in with `schemes: ['onchain-proof', 'exact']`. The
advertised `priceUsd` is a coarse pre-filter; always re-confirm with `quote()` before paying.
:::

## Register — list a resource you run

`register()` lists a resource on the open registries so agents can find it. The default target is
**402 Index** — one POST, no auth, no signature, no payment. It returns one `RegisterOutcome` per
target; a target the chain can't satisfy comes back `{ ok: false, detail }`, never a throw.

:::caution[Advertise an `exact` rail before you list]
Index payers are **overwhelmingly standard `exact` clients**. A default `onchain-proof`-only gate
gets *listed* but those clients **cannot pay it** — a discoverable dead end. Before you register,
turn on a standard [`exact` rail](/accepting-payments/exact-rail-seller/) on the gate
(`requirePayment({ exact: … })`) so the whole index audience can actually pay you, and set
`discovery: true` (x402scan requires an input schema). See
[Running in production §6](/getting-started/running-in-production/#6-be-discoverable-and-payable).
:::

```ts
const [outcome] = await client.register('https://api.example.com/report', {
  name: 'Daily report',
  priceUsd: 0.1,   // advertised metadata only — no oracle reads this
  asset: 'USDC',
})

console.log(outcome.ok, outcome.visibility, outcome.note)
// → true 'pending-review' '402 Index probes your URL on submit, then lists it as PENDING REVIEW … retry discover() later.'
```

### RegisterOptions

| Option | Default | Purpose |
| --- | --- | --- |
| `name` | the URL's host | Display name for the listing. |
| `description` | — | Listing description. |
| `priceUsd` | — | Advertised price (metadata only — no oracle reads it). |
| `asset` | — | Payment asset symbol, e.g. `'USDC'`. |
| `network` | the client's `chain` | Payment network slug, e.g. `'base'`. |
| `method` | `'GET'` | HTTP method the resource answers on. |
| `targets` | `['402index']` | Which indexes to list on. Add `'x402scan'` for the SIWX path. |
| `attribution` | `false` | Opt-in `via: '@piprail/sdk'` tag on the listing. |

### A RegisterOutcome

Listing is **asynchronous**, so each outcome carries a `visibility` and a one-line `note` — don't
read `ok: true` as "searchable now."

```ts
interface RegisterOutcome {
  source: DiscoverySource
  ok: boolean
  status?: number          // HTTP status, when a request was made
  detail?: string          // success summary or the reason it didn't list
  listingUrl?: string
  visibility?: ListingVisibility  // 'live' | 'pending-review' | 'not-listable'
  note?: string            // agent-readable caveat for this source
}
```

| `visibility` | Meaning |
| --- | --- |
| `'live'` | Findable now — search it immediately. |
| `'pending-review'` | Accepted, but reviewed/propagated before it's publicly findable; retry `discover()` later. |
| `'not-listable'` | It didn't list — a failure, or this index structurally can't list a PipRail resource. |

:::note
402 Index **probes your URL on submit** and lists it as `pending-review` — a self-registered
resource is not searchable until approved. Verify your domain for instant approval; see
[Domain verification](/discovery/domain-verification/). 402 Index rejects (422) any endpoint that
doesn't actually return a 402, and `detail` carries its reason.
:::

## Branch on a directory before you call

The per-source lifecycle facts live in `DIRECTORY_INFO` (importable), so an agent can reason about
an index — auth, chains, whether `discover()` reads it — without embedding directory knowledge.
`getDirectoryInfo(source)` returns one `DirectoryInfo`:

```ts
import { getDirectoryInfo } from '@piprail/sdk'

const info = getDirectoryInfo('402index')
info.auth            // 'none'
info.readByDiscover  // true  — discover() reads 402 Index
info.onSuccess       // 'pending-review'
info.review          // 'probe-sync' — a synchronous URL probe (not facilitator-coupled)
```

| Source | Read by `discover()` | Write auth | Notes |
| --- | --- | --- | --- |
| `bazaar` | yes | — (facilitator-only) | Free to read. Can't be written to — Bazaar catalogs only what its own facilitator settles, and PipRail uses none. |
| `402index` | yes | none | The primary register target: one POST, no auth. Lists `pending-review` until your domain is verified. |
| `x402scan` | **no** | SIWX | Base/Solana only; needs one wallet signature and a resolvable input schema. A live listing here won't appear in `discover()`. |

:::caution
`discover()` reads `bazaar` + `402index` only — **not `x402scan`** (its reads are paid). A resource
you registered on x402scan is live on x402scan.com but won't show up in `discover()` results;
don't read that absence as failure.
:::

## Register on x402scan (SIWX)

Adding `'x402scan'` to `targets` lists via Sign-In-With-X — one wallet signature, facilitator-free,
but **Base/Solana-only** and EVM signing today. It needs a `discoverySigner` (the EVM families
have one); a chain family without one returns `{ ok: false, detail }` rather than throwing.

```ts
const outcomes = await client.register('https://api.example.com/report', {
  targets: ['402index', 'x402scan'],  // x402scan needs an EVM signer + a Base/Solana rail
})
// → RegisterOutcome[] — one per target, in target order
for (const o of outcomes) {
  console.log(o.source, o.ok, o.visibility)  // e.g. 'x402scan' true 'live'
}
```

The open SIWX handshake is a moving convention — validate against x402scan before relying on it.
x402scan also requires a resolvable input schema, which you supply by [emitting](/discovery/emitters/)
an `/openapi.json` or the `extensions.bazaar` block in your 402 body.

:::note
`client.discover()` / `client.register()` are thin wrappers over the lower-level
`searchOpenIndexes(opts: SearchOpenIndexesOptions)` and `register402Index(input: RegisterInput)`
exports, which take the same fields. Reach for those only if you need discovery without binding a
client; the client methods add the `'self'`-chain filter, the `priceUsd` cap, and the
`visibility`/`note` decoration for you.
:::
