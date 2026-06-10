---
title: Domain claim & verify
description: Prove you own a domain on 402 Index so your self-registered listings flip from pending review to searchable — a two-step, no-auth, no-funds handshake.
sidebar:
  order: 4
---

## Introduction

When you [register](/discovery/discover-and-register/) a resource on 402 Index, it lands as
`pending-review` — accepted, but not searchable until 402 Index approves it. Verifying your
domain is the instant-approval path: prove you control the host, and **every** pending listing
on that domain becomes findable at once.

It's two steps, no auth, no signature, no payment. You `claimDomain` a host (402 Index issues a
token), serve a small proof file, then `verifyDomain` so 402 Index re-fetches and approves. Both
calls move no funds and **never throw** — a transport or HTTP error comes back as
`{ ok: false, detail }`.

## Step 1 — claim the domain

`client.claimDomain(urlOrDomain)` claims the host of whatever you pass — a full resource URL or
a bare domain both resolve to the hostname. On success it returns the proof to serve.

```ts
const claim = await client.claimDomain('https://api.example.com/report')
// → {
//     ok: true,
//     domain: 'api.example.com',
//     verificationHash: '…',  // serve THIS as the entire body of verificationUrl
//     verificationToken: '…',
//     verificationUrl: 'https://api.example.com/.well-known/402index-verify.txt',
//   }

if (!claim.ok) {
  console.error('Claim failed:', claim.detail) // never throws — read detail
} else {
  // serve claim.verificationHash at claim.verificationUrl, then call verifyDomain
}
```

The standalone function is also exported if you don't have a client:

```ts
import { claim402IndexDomain } from '@piprail/sdk'

const claim = await claim402IndexDomain('api.example.com', { contactEmail: 'you@example.com' })
// → { ok: true, domain: 'api.example.com', verificationHash: '…', verificationUrl: '…', … }
```

### The DomainClaim

```ts
interface DomainClaim {
  ok: boolean
  domain: string             // the host that was claimed
  verificationHash?: string  // serve THIS as the entire body of verificationUrl
  verificationToken?: string // the raw token (preimage of the hash)
  verificationUrl?: string   // where to serve it: /.well-known/402index-verify.txt
  instructions?: string      // 402 Index's own human instructions
  httpStatus?: number
  detail?: string            // failure reason when ok:false
}
```

Serve `verificationHash` as the **entire body** of the response at `verificationUrl` — it is the
SHA-256 of the issued token, and 402 Index fetches that one file to confirm you control the host.

:::note
`verificationHash` is always populated on success: it's read from the response, or computed as
`sha256(verificationToken)` if the API returns only the token. Either way, serve the hash, not
the token.
:::

## Step 2 — verify

Once the file is live, call `client.verifyDomain(urlOrDomain)` (or the standalone
`verify402IndexDomain`). 402 Index re-fetches the proof and, on a match, approves the domain.

```ts
const res = await client.verifyDomain('api.example.com')
// → { ok: true, status: 'verified', servicesCount: 3 }
```

### The DomainVerification

```ts
interface DomainVerification {
  ok: boolean
  domain: string
  status?: string        // 402 Index's status string, e.g. 'verified'
  servicesCount?: number // how many pending listings the verification approved
  httpStatus?: number
  detail?: string        // failure reason when ok:false
}
```

`servicesCount` is the payoff: it tells you how many of your pending listings on that domain just
went searchable. A subsequent [`discover()`](/discovery/discover-and-register/) will find them.

## Verified domains register live

Once a domain is verified, you don't have to re-verify per listing. A
[`register()`](/discovery/discover-and-register/) from a verified domain comes back **live**
rather than `pending-review` — the `RegisterOutcome` reports `visibility: 'live'` directly, with
no review delay.

## Standalone functions

If you're working below the client — a build script, a server-side tool — both steps are plain
exported functions:

| Function | Returns | Notes |
| --- | --- | --- |
| `claim402IndexDomain(domainOrUrl, opts?)` | `DomainClaim` | `opts.contactEmail` is optional 402 Index metadata. |
| `verify402IndexDomain(domainOrUrl)` | `DomainVerification` | Call after the proof file is live. |

The client methods `client.claimDomain()` / `client.verifyDomain()` are thin wrappers over these
— use whichever fits.

## Reading the network field

Index payloads name chains by slug (`base`) or CAIP-2 (`eip155:8453`). `normalizeNetwork(network)`
folds a recognised slug to its CAIP-2 form and passes a value that's already CAIP-2 through
unchanged. An unknown slug is returned as-is — treat that as "unresolved", not a confident
mismatch.

```ts
import { normalizeNetwork } from '@piprail/sdk'

normalizeNetwork('base')         // → 'eip155:8453'
normalizeNetwork('eip155:8453')  // → 'eip155:8453' (unchanged)
normalizeNetwork('madeupchain')  // → 'madeupchain' (unresolved, not dropped)
```

## Decorating a bare outcome

The low-level register functions return a **bare** [`RegisterOutcome`](/discovery/discover-and-register/)
— no `visibility`, no `note`. `decorateOutcome(outcome)` projects the static directory lifecycle
facts onto it, so an agent gets `visibility` + `note` without a second lookup. It's idempotent,
and respects a `visibility` the adapter already set (e.g. a verified-domain register that came
back `'live'`).

```ts
import { register402Index, decorateOutcome } from '@piprail/sdk'

const outcome = decorateOutcome(await register402Index({ url: 'https://api.example.com/report' }))
// outcome.visibility → 'pending-review' (or 'live' from a verified domain)
// outcome.note       → one-line caveat for this index
```

:::tip
`client.register()` already calls `decorateOutcome` for you — you only need it when you call the
register functions directly. See [Open indexes](/discovery/open-indexes/) for the full lifecycle
facts each outcome is projected from.
:::
