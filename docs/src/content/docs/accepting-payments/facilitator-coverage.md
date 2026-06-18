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

The third-party x402 facilitators below were **probed live (2026-06-14 → 2026-06-17)** — each one's
`GET /supported` was read, and every row marked ✅ was then settled with a **real mainnet `exact` payment
through PipRail**, where the **buyer paid zero gas**. "Keyless" means it settles with **no API key**, so the
facilitator sponsors the network fee for the buyer *and* the merchant. You point a gate at any of them
with `exact: { settle: { facilitator: '<facilitator url>' } }` — see
[the exact rail seller guide](/accepting-payments/exact-rail-seller/). On a facilitator-sponsored
fee-payer rail the gate also **bounds the fee** a buyer can make the sponsor pay — see
[sponsor protection](/making-payments/gasless-payments/#sponsor-protection--the-fee-drain-guard).

| Facilitator | Keyless? | PipRail live-tested | Mainnet `exact` networks |
|---|---|---|---|
| **[PayAI](https://facilitator.payai.network/)** | ✅ keyless | ✅ **Base, Polygon, Arbitrum, Avalanche, Sei, Solana** | Base, Solana, Avalanche, Polygon, Arbitrum, Sei +24 |
| **[Ultravioleta DAO](https://facilitator.ultravioletadao.xyz/)** | ✅ keyless | ✅ **Ethereum, Polygon, Arbitrum, Optimism, Unichain, HyperEVM, Base, Monad** | HyperEVM, Base, Monad, Celo, Unichain, Optimism, Scroll, Ethereum, Arbitrum, Polygon, Avalanche, BNB + Solana, Stellar, Sui, Algorand, NEAR, XRPL (18 listed — but Celo/Scroll/Avalanche `contract_call_failed`; non-EVM advertise-only) |
| **[Dexter](https://x402.dexter.cash/)** | ✅ keyless | ✅ **Base, Polygon, Arbitrum, Optimism, Avalanche, BNB** | Base, BNB, Solana, Polygon, Arbitrum, Optimism, Avalanche *(BNB: FDUSD/USD1 only; ~$0.003 dynamic floor — sub-floor payments rejected)* |
| **[Corbits](https://corbits.dev/)** | ✅ keyless | ✅ **Solana, Base, Polygon, Monad** | Solana, Base, Polygon, Monad +38 |
| **[Polygon Labs](https://x402.polygon.technology/)** | ✅ keyless | ✅ **Polygon** | Polygon (the official Polygon facilitator) |
| **[GoPlausible](https://facilitator.goplausible.xyz/)** | ✅ keyless | ✅ **Algorand + Base** | **Algorand** (the only keyless Algorand facilitator), Base, Solana |
| **[Pieverse](https://facilitator.pieverse.io/)** | ✅ keyless | ✅ **Monad + BNB** | Monad, BNB, Base *(BNB: FDUSD/USD1)* |
| **[Cascade](https://facilitator.cascade.fyi/)** | ✅ keyless | ✅ **Base** | Base, Solana |
| **[Satoshi (bitcoinsapi)](https://facilitator.bitcoinsapi.com/)** | ✅ keyless | ✅ **Base** | Base, Solana |
| **[OpenFacilitator](https://www.openfacilitator.io/)** | ✅ keyless | ✅ Solana | Base, Solana, Stacks |
| **[xpay](https://www.xpay.sh/)** | ✅ zero-fee | ✅ Base | Base |
| **[Daydreams](https://daydreams.systems/)** | 🔑 API key | — | Ethereum, Base, Solana |
| **[Questflow](https://questflow.ai/)** | 🔑 API key | — | Base |
| **[Coinbase CDP](https://docs.cdp.coinbase.com/)** | 🔑 CDP auth | — | Base, Solana |
| **[Kora](https://github.com/solana-foundation/kora)** | self-host | — | Solana |

**Base URLs** (pass to `exact: { settle: { facilitator } }`) — the keyless ones, live-proven:
`https://facilitator.payai.network` · `https://facilitator.corbits.dev` · `https://pay.openfacilitator.io` · `https://facilitator.xpay.sh` · `https://facilitator.ultravioletadao.xyz` · `https://x402.dexter.cash` · `https://x402.polygon.technology` (Polygon) · `https://facilitator.goplausible.xyz` (Algorand) · `https://facilitator.pieverse.io` · `https://facilitator.cascade.fyi` · `https://facilitator.bitcoinsapi.com`.

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
[`0x2273d5…`](https://basescan.org/tx/0x2273d5855a180002c6999ddf9fd26b03f62ae9ee0214983efddaefc1d42125d3) ·
Corbits **Monad**
[`0x7797be…`](https://monadexplorer.com/tx/0x7797be27ce22c17f7433a0389bd22d46e338899b1faac505fffd068174428ae6) ·
Ultravioleta **HyperEVM**
[`0x56af81…`](https://hyperevmscan.io/tx/0x56af8148a92a291f0ce362e250919f7742074e5464ac0f315ad68abaec93bd0a).
The **2026-06-18 gasless-extension** added **17 more live proofs** across Ethereum, Polygon, Arbitrum,
Optimism, Avalanche, Sei, and Unichain (e.g. UVD Ethereum
[`0x7fcc3c…`](https://etherscan.io/tx/0x7fcc3cafdf43c52888f0117cde633eff35371f832dfb8dbd84e6fd7704ae5cfc) ·
PayAI Polygon
[`0xb37630…`](https://polygonscan.com/tx/0xb37630871504618c4db35e8ef0edd3c99deac102b143b7e5eb738c03fb13a619)) —
the full per-pair tx hash lives in each `KNOWN_FACILITATORS` entry, and every one was re-verified
on-chain to confirm a **third-party** (the facilitator) paid the gas, never the buyer or merchant.

You're never locked to any of them — keep one, swap it, or run your own (self-settle / Kora). See
[keep PayAI, or swap it](/making-payments/gasless-payments/#keep-payai-or-swap-it). **PipRail depends on
no facilitator.**

## `KNOWN_FACILITATORS` — the seed map

A `Record<Caip2, KnownFacilitator[]>` mapping a CAIP-2 network to the facilitators known to settle
`exact` there. It is **deliberately conservative** — only endpoint-verified entries — and grows only
after a live `/supported` read confirms a new pair.

```ts
import { KNOWN_FACILITATORS, knownFacilitatorsFor, firstKeylessFacilitator } from '@piprail/sdk'

knownFacilitatorsFor('eip155:8453') // Base — eight live-verified keyless facilitators (all settle eip3009)
// → [PayAI, xpay, Ultravioleta DAO, Dexter, Corbits, GoPlausible, Cascade, Satoshi]
//   (8 entries; each shaped { url, keyless: true, schemes: ['exact'], settles: ['eip3009'], note })

firstKeylessFacilitator('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'svm')?.url
// → 'https://facilitator.payai.network'  (first of PayAI · OpenFacilitator · Corbits)

firstKeylessFacilitator('eip155:999999') // unknown network
// → undefined
```

Each `KnownFacilitator` has a `url` (no trailing slash), a `keyless` boolean (true ⇒ no API key, the
facilitator sponsors gas), the `schemes` it settles (today `'exact'`), the exact transfer `settles`
methods (`'eip3009' | 'permit2' | 'svm' | 'algorand' | 'aptos' | 'near'`), and an optional `note`.

:::caution
**What's seeded, and what isn't.** The map carries only **live-confirmed keyless** entries — each
settled a real mainnet payment with no key, buyer paid zero gas (see
[Live-verified facilitators](#live-verified-facilitators)):

- **Base** (`eip155:8453`) → PayAI + xpay + **Ultravioleta DAO** + **Dexter** + **Corbits** + **GoPlausible** + **Cascade** + **Satoshi** (`eip3009`) — eight keyless facilitators *(UVD/Dexter/Corbits/GoPlausible 2026-06-17; Cascade/Satoshi 2026-06-18)*
- **Ethereum** (`eip155:1`) → **Ultravioleta DAO** (`eip3009`) — *live-settled 2026-06-18.* UVD 100%-sponsors L1 gas with no floor; the keyless Ethereum option (Primev rejects PipRail's `exact` as `unsupported_scheme`).
- **Polygon** (`eip155:137`) → **PayAI + Polygon Labs + Corbits + Ultravioleta DAO + Dexter** (`eip3009`) — *live-settled 2026-06-18.* Five keyless facilitators — the broadest coverage after Base.
- **Arbitrum** (`eip155:42161`) → **PayAI + Ultravioleta DAO + Dexter** (`eip3009`) *(live-settled 2026-06-18)*
- **Optimism** (`eip155:10`) → **Dexter + Ultravioleta DAO** (`eip3009`) *(live-settled 2026-06-18)*
- **Avalanche** (`eip155:43114`) → **PayAI + Dexter** (`eip3009`) *(live-settled 2026-06-18)*
- **Sei** (`eip155:1329`) → **PayAI** (`eip3009`) *(live-settled 2026-06-18)*
- **Unichain** (`eip155:130`) → **Ultravioleta DAO** (`eip3009`) *(live-settled 2026-06-18)*
- **BNB** (`eip155:56`) → **Dexter** + **Pieverse** (`eip3009`) — *live-settled 2026-06-17 with FDUSD.* BNB's USDC/USDT are Binance-Peg (Permit2, not facilitator-settleable), so keyless BNB works only for the **EIP-3009 tokens FDUSD/USD1**, and Dexter enforces a **~$0.003 dynamic floor**. This beats the BNB token-overlap wall — and Pieverse settles FDUSD too, so BNB now has two keyless facilitators.
- **Monad** (`eip155:143`) → Corbits + **Ultravioleta DAO** + **Pieverse** (`eip3009`) *(live-settled 2026-06-17)*
- **HyperEVM** (`eip155:999`) → Ultravioleta DAO (`eip3009`) *(live-settled 2026-06-17)*
- **Algorand** (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`) → **GoPlausible** (`algorand`) — *new, live-settled 2026-06-17.* Atomic-group fee pooling: GoPlausible's sponsor pools the whole group fee, so **both the buyer AND the merchant pay 0 ALGO**. The first non-EVM/non-Solana keyless chain.
- **Solana** → PayAI + OpenFacilitator + Corbits (`svm`)

So **`exact: true` is zero-config gasless on 13 chains today — Ethereum, Polygon, Arbitrum, Optimism, Avalanche, Sei, Unichain, Base, BNB, HyperEVM, Monad, Solana, and Algorand** (multiple keyless facilitators per chain = automatic failover). **Celo and Scroll are NOT seeded** — Ultravioleta DAO advertises them but its sponsor contract reverts there (`contract_call_failed`), proving again that a `/supported` listing isn't settlement. **Daydreams** and
**Questflow** are deliberately **omitted** — their `/supported` is public but `/verify` needs an API key.
`x402.org/facilitator` is **not** seeded either — it's a Base *Sepolia* testnet facilitator, not a
mainnet rail. **Aptos** has no keyless x402 facilitator on mainnet yet — use **self-settle** for
gasless Aptos (proven on mainnet). **Sui**'s ratified `exact` scheme is *interactive* (the buyer must
round-trip to a gas station to fill in gas objects before signing), so it isn't wired as a one-shot
keyless rail here yet. On a network not in the map, pass an explicit `exact: { settle: { facilitator } }`.
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

Each kind also carries two **optional** fields when the facilitator advertises them: `x402Version`
(the envelope version it reports per kind) and `assetTransferMethod` (`'eip3009' | 'permit2'`) — so a
reader can tell a v1 rail from a v2 rail, or a gasless EIP-3009 kind from a Permit2 one, straight from
`/supported`. Both are omitted entirely when absent (never a `undefined` key), so a facilitator that
reports neither parses exactly as before.

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
