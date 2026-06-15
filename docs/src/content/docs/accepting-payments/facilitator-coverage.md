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

## Live-verified facilitators

The third-party x402 facilitators below were **probed live on 2026-06-15** — each one's `GET /supported`
was read, and every row marked ✅ was then settled with a **real mainnet `exact` payment through
PipRail**, where the **buyer paid zero gas**. "Keyless" means it settles with **no API key**, so the
facilitator sponsors the network fee for the buyer *and* the merchant. You point a gate at any of them
with `exact: { settle: { facilitator: '<facilitator url>' } }` — see
[the exact rail seller guide](/accepting-payments/exact-rail-seller/).

| Facilitator | Keyless? | PipRail live-tested | Mainnet `exact` networks |
|---|---|---|---|
| **[PayAI](https://facilitator.payai.network/)** | ✅ keyless | ✅ Solana + Base | Base, Solana, Avalanche, Polygon, Arbitrum, Sei +24 |
| **[Corbits](https://corbits.dev/)** | ✅ keyless | ✅ Solana | Solana, Base, Polygon, Monad +38 |
| **[OpenFacilitator](https://www.openfacilitator.io/)** | ✅ keyless | ✅ Solana | Base, Solana, Stacks |
| **[xpay](https://www.xpay.sh/)** | ✅ zero-fee | ✅ Base | Base |
| **[Daydreams](https://daydreams.systems/)** | 🔑 API key | — | Ethereum, Base, Solana |
| **[Questflow](https://questflow.ai/)** | 🔑 API key | — | Base |
| **[Coinbase CDP](https://docs.cdp.coinbase.com/)** | 🔑 CDP auth | — | Base, Solana |
| **[Kora](https://github.com/solana-foundation/kora)** | self-host | — | Solana |

**Base URLs** (pass to `exact: { settle: { facilitator } }`) — the keyless ones, live-proven:
`https://facilitator.payai.network` · `https://facilitator.corbits.dev` · `https://pay.openfacilitator.io` · `https://facilitator.xpay.sh`.

:::caution[A public `/supported` is NOT proof of keyless settlement]
Daydreams and Questflow both expose a public `GET /supported`, but their `/verify` returns **401 — an
API key is required** — so they are **not** keyless for *settlement*. We mark a facilitator "keyless ✅"
only after a real payment settled with **no key**. That's exactly why PipRail's `KNOWN_FACILITATORS`
seed map (below) lists **only the live-confirmed keyless** ones.
:::

Live settlement proofs (real mainnet, sub-cent amounts): PayAI Solana
[`4dL8jRKH…`](https://solscan.io/tx/4dL8jRKHfGdt2zCD8CXLFuNxwTcJjyftAb3GbAffCG5YUX5LUfdH5VQy4itcfmWMXhAtNhpPaZwwM7YqjdWJNwXm) ·
OpenFacilitator Solana
[`5BabDtX…`](https://solscan.io/tx/5BabDtXnzk4o6hkCix1iF5SreWjJ62Yzfe57ANwhRVTmxv1MDdCJj2UqssiZcAVrBmVP7PBL6cwFy8RhvgLhGnpM) ·
Corbits Solana
[`BCreYer…`](https://solscan.io/tx/BCreYerDkQQykiZ1qLbvo9P4cGwhh2Gestc8sft8X7cmcQHdxi1SUDz6vcxu1vcKKhvprCjsgX5rfgbtEhrXHdU) ·
xpay Base
[`0x2273d5…`](https://basescan.org/tx/0x2273d5855a180002c6999ddf9fd26b03f62ae9ee0214983efddaefc1d42125d3).

You're never locked to any of them — keep one, swap it, or run your own (self-settle / Kora). See
[keep PayAI, or swap it](/making-payments/gasless-payments/#keep-payai-or-swap-it). **PipRail depends on
no facilitator.**

## `KNOWN_FACILITATORS` — the seed map

A `Record<Caip2, KnownFacilitator[]>` mapping a CAIP-2 network to the facilitators known to settle
`exact` there. It is **deliberately conservative** — only endpoint-verified entries — and grows only
after a live `/supported` read confirms a new pair.

```ts
import { KNOWN_FACILITATORS, knownFacilitatorsFor, firstKeylessFacilitator } from '@piprail/sdk'

knownFacilitatorsFor('eip155:8453') // Base — both live-verified keyless on 2026-06-15
// → [{ url: 'https://facilitator.payai.network', keyless: true, settles: ['eip3009'], … },
//    { url: 'https://facilitator.xpay.sh',       keyless: true, settles: ['eip3009'], … }]

firstKeylessFacilitator('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'svm')?.url
// → 'https://facilitator.payai.network'  (first of PayAI · OpenFacilitator · Corbits)

firstKeylessFacilitator('eip155:999999') // unknown network
// → undefined
```

Each `KnownFacilitator` has a `url` (no trailing slash), a `keyless` boolean (true ⇒ no API key, the
facilitator sponsors gas), the `schemes` it settles (today `'exact'`), the exact transfer `settles`
methods (`'eip3009' | 'permit2' | 'svm'`), and an optional `note`.

:::caution
**What's seeded, and what isn't.** The map carries only **live-confirmed keyless** entries: **Base** →
PayAI + xpay (`eip3009`); **Solana** → PayAI + OpenFacilitator + Corbits (`svm`) — each settled a real
payment with no key (see [Live-verified facilitators](#live-verified-facilitators)). **Daydreams** and
**Questflow** are deliberately **omitted** — their `/supported` is public but `/verify` needs an API key.
`x402.org/facilitator` is **not** seeded either — it's a Base *Sepolia* testnet facilitator, not a
mainnet rail. On a network not in the map, pass an explicit `exact: { settle: { facilitator } }`.
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
