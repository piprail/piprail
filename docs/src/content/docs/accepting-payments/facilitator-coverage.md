---
title: Facilitator coverage
description: A shipped data map of which keyless x402 facilitators settle the exact scheme on which networks, plus a best-effort reader of a facilitator's live /supported — so you can pick a facilitator (or verify one) without a hosted registry.
sidebar:
  order: 8
---

## Introduction

When you offer a standard [`exact` rail](/accepting-payments/exact-rail-seller/) settled by a
third-party facilitator, you need to know **which facilitator settles `exact` on your chain** — and
ideally a *keyless* one, so neither you nor the buyer pays gas. PipRail ships that knowledge as plain
data (no hosted registry, no backend) plus a live reader, so you can choose or verify a facilitator up
front.

This is the honesty layer under the upcoming `exact: true` shorthand: it resolves a known keyless
facilitator for your gate's network from this map, or fails with a clear message when none is known.

## `KNOWN_FACILITATORS` — the seed map

A `Record<Caip2, KnownFacilitator[]>` mapping a CAIP-2 network to the facilitators known to settle
`exact` there. It is **deliberately conservative** — only endpoint-verified entries — and grows only
after a live `/supported` read confirms a new pair.

```ts
import { KNOWN_FACILITATORS, knownFacilitatorsFor, firstKeylessFacilitator } from '@piprail/sdk'

knownFacilitatorsFor('eip155:8453')
// → [{ url: 'https://facilitator.payai.network', keyless: true, schemes: ['exact'],
//      settles: ['eip3009'], note: 'PayAI — keyless, sponsors gas (Base USDC EIP-3009)' }]

firstKeylessFacilitator('eip155:8453', 'eip3009')?.url
// → 'https://facilitator.payai.network'

firstKeylessFacilitator('eip155:999999') // unknown network
// → undefined
```

Each `KnownFacilitator` has a `url` (no trailing slash), a `keyless` boolean (true ⇒ no API key, the
facilitator sponsors gas), the `schemes` it settles (today `'exact'`), the exact transfer `settles`
methods (`'eip3009' | 'permit2' | 'svm'`), and an optional `note`.

:::caution
**What's seeded, and what isn't.** PayAI (`https://facilitator.payai.network`) is seeded keyless for
Base (`eip3009`) and Solana (`svm`), verified against its live `/supported`. `x402.org/facilitator` is
**not** seeded — it is a Base *Sepolia* testnet facilitator, not a mainnet rail, so listing it would be
a false coverage claim. On a network not in the map, pass an explicit
`exact: { settle: { facilitator } }`.
:::

## Reading a facilitator's live `/supported`

`facilitatorCoverage(url)` fetches a facilitator's `GET /supported` and returns the `(scheme, network)`
kinds it advertises. It is best-effort and **never throws** — a dead or changed endpoint resolves to
`[]`, mirroring the SDK's other read-only methods.

```ts
import { facilitatorCoverage } from '@piprail/sdk'

await facilitatorCoverage('https://facilitator.payai.network')
// → [{ scheme: 'exact', network: 'eip155:8453' },
//    { scheme: 'exact', network: 'solana:5eykt4Us…', feePayer: 'Fee…' }]
```

`parseFacilitatorSupported(body)` is the pure parser behind it (useful in tests or when you already
hold the body):

```ts
import { parseFacilitatorSupported } from '@piprail/sdk'

parseFacilitatorSupported({ kinds: [{ scheme: 'exact', network: 'eip155:8453' }] })
// → [{ scheme: 'exact', network: 'eip155:8453' }]

parseFacilitatorSupported('garbage') // tolerant — never throws
// → []
```

Use these to verify a facilitator covers your CAIP-2 network *before* wiring a gate, or to generate a
coverage table from live reads. See the [exact rail seller guide](/accepting-payments/exact-rail-seller/)
for turning on the rail itself.
