---
title: Gasless payments
description: How gasless x402 payments work in PipRail — the two rails (onchain-proof vs the gasless exact rail), the exact rail's three auto-selected methods (EIP-3009, Permit2, SVM), and a clear table of exactly which chains and tokens are gasless and which aren't.
sidebar:
  order: 9
---

This is the one page for **gasless payments**: what "gasless" means here, how PipRail does it, and a
clear table of **which chains and tokens are gasless** — and which aren't. If the EIP-3009 / Permit2 /
SVM / exact-rail terms have been confusing, read this top to bottom and they'll click.

## The whole model in 30 seconds

The terms aren't a flat list of options — they're a small **hierarchy**. Get this and everything else
falls out:

- **Gas** is the on-chain **network fee**, paid in the chain's native coin (ETH, SOL, …). It's a *cost*,
  not a payment method. "Gasless" means *you* don't pay it — someone else does.
- A 402 is paid over one of **two rails**:
  - **`onchain-proof`** — PipRail's **default**. *You* broadcast the transfer, so **you pay the gas**.
    Works on every chain. (The "with-gas" path.)
  - **`exact`** — the ratified x402 rail (**opt-in**). You only **sign**; someone else broadcasts, so
    **you pay zero gas**. This is the gasless rail.
- **`exact` has three *methods*** — *how* the signature is shaped, **auto-selected** per chain + token.
  These are children of `exact`, **not** alternatives to it:
  - **EIP-3009** — EVM tokens with `transferWithAuthorization` (USDC, EURC). The clean path.
  - **Permit2** — EVM tokens *without* EIP-3009 (e.g. Binance-Peg USDC on BNB). Self-settle only.
  - **SVM** — Solana, any SPL token.

So it's **not** "gas vs permit vs exact." It's: **`onchain-proof` (with-gas) vs `exact` (gasless)**, and
**`exact` happens to be implemented three ways** (EIP-3009 / Permit2 / SVM) that the SDK picks for you.
You never name a method by hand.

```text
  a 402 payment
  ├── onchain-proof   ← default · you broadcast · YOU PAY GAS · every chain
  └── exact           ← opt-in  · you only sign · ZERO gas for you · EVM + Solana
        ├── EIP-3009   (EVM: USDC, EURC)         ┐ picked
        ├── Permit2    (EVM: other ERC-20s)      │ automatically
        └── SVM        (Solana: any SPL token)   ┘ per chain+token
```

## What "gasless" means

In an ordinary on-chain payment the buyer **broadcasts** the transfer and **pays the gas**. PipRail's
standard x402 **`exact` rail is gasless _for the buyer_**: the buyer only **signs** the transfer
(zero gas, no native coin needed), and someone else broadcasts it — the merchant's own **relayer**
(self-settle) or a **facilitator**. On EVM the buyer signs an off-chain authorization; on **Solana**
the buyer partial-signs the transfer transaction and a **fee payer** completes + broadcasts it. Either
way the buyer needs only the *token*, never the gas coin.

**Who pays the gas, then?** Whoever settles. With **self-settle** the merchant's relayer pays the
(tiny) fee to receive. With a **facilitator** (e.g. PayAI), the **facilitator pays the gas — so
neither the buyer nor the merchant pays anything**. PipRail itself never pays and hosts nothing.

## Two rails: `onchain-proof` vs `exact`

PipRail offers up to two rails on a single 402; the agent picks one.

| | `onchain-proof` (default) | **`exact`** (gasless buyer) |
|---|---|---|
| Who broadcasts | the **buyer** | the merchant's relayer / a facilitator |
| Buyer pays gas? | **yes** (a normal transfer) | **no** — just signs |
| Where it works | **every** chain + token PipRail supports | **EVM** + **Solana** (below) |
| Opt-in | default | `schemes: ['onchain-proof', 'exact']` |

`onchain-proof` is PipRail's backendless default — universal, but the buyer holds the gas token.
`exact` is the gasless upgrade, and it's what the wider x402 ecosystem (Coinbase, Binance, Solana, …)
speaks.

### Is gasless automatic?

**Once you opt in, yes — it just works; you never wire up the gasless mechanics by hand.** The opt-in
itself is deliberate (and tiny), for two reasons: PipRail's zero-config default is the backendless
`onchain-proof` rail and **defaults never change**, and PipRail can't pick a **facilitator** *for* you —
which one to trust is your call (some need an API key). After that one flag, everything is automatic:

- **Buyer** — add `'exact'` to `schemes`. The client then signs (never broadcasts), so it spends **zero
  gas** on any `exact` rail. To make it *prefer* the gasless rail when a gate offers both, turn on
  [`autoRoute`](/making-payments/fetch-and-autoroute/) — it pays the **cheapest settleable** rail, which is the
  gasless one. (Without `autoRoute`, a dual-rail PipRail gate defaults to `onchain-proof`; a foreign
  `exact`-only server is paid over `exact` automatically either way.)
- **Seller** — set `exact: { settle: { facilitator } }`. The gate discovers everything it needs (on
  Solana, the facilitator's fee payer from `GET /supported`) and routes settlement to it — **neither
  buyer nor merchant pays gas**. No relayer key, no manual fee-payer plumbing.

**And when a rail _can't_ be gasless, PipRail falls back automatically** — it never advertises a rail it
can't settle. A native coin, an EVM token that's neither EIP-3009 nor facilitator-settleable, or a
family with no `exact` scheme is simply served over `onchain-proof` (the with-gas rail). You don't have
to detect any of this; the gate does.

## Three `exact` methods: EIP-3009, Permit2, and SVM

The `exact` rail works one of three ways, depending on the chain + token. **PipRail auto-selects**
(`method: 'auto'`), so you rarely choose by hand — Solana always uses SVM; EVM picks EIP-3009 or Permit2.

| | **EIP-3009** (EVM, gold path) | **Permit2** (EVM) | **SVM** (Solana) |
|---|---|---|---|
| Works on | tokens with `transferWithAuthorization` | **any** ERC-20 | **any** SPL token |
| Examples (built-in presets) | Circle **USDC** & **EURC**, **FDUSD**, **USD1** | Binance-Peg USDC/USDT on BNB | Solana **USDC** & **USDT** |
| What the buyer signs | an EIP-3009 authorization (off-chain) | a Permit2 witness transfer (off-chain) | the SPL `TransferChecked` **transaction** (partial-sign) |
| Who broadcasts | merchant relayer / **facilitator** | merchant relayer (**self-settle only**) | relayer / **facilitator** (the **fee payer**) |
| Extra contract needed | **none** | the canonical **Permit2** + the **x402ExactPermit2Proxy** | **none** |
| One-time setup | **none** | one `approve(Permit2)` per token (~46k gas) | **none** |
| Per-payment buyer gas | **~0** | **~0** (after that approval) | **0** (only the fee-payer pays SOL) |

**EIP-3009 is the cleanest EVM path** — no approval, no extra contract, the buyer needs only the
stablecoin. **Permit2 covers the EVM gap** — tokens that *don't* implement EIP-3009 (most notably the
Binance-Peg USDC/USDT on BNB), at the cost of one approval and a proxy.

:::note[Permit2 is self-settle only]
A third-party **facilitator** settles the *standard* `exact` schemes — **EIP-3009** (EVM) and **SVM**
(Solana). It does **not** settle Permit2, which uses PipRail's own `x402ExactPermit2Proxy` (a payload no
generic facilitator understands). So a Permit2 token can only be settled by **your own relayer**
(`settle: 'self'`). PipRail enforces this: a *forced* `method: 'permit2'` with `settle: { facilitator }`
is refused at config time, and an *auto*-selected Permit2 simply isn't offered over a facilitator (the
token falls back to `onchain-proof` there). To go fully gasless via a facilitator, use an **EIP-3009**
token (USDC / EURC) on EVM, or **any SPL token** on Solana.
:::

**SVM is the Solana path, and it's the simplest of the three:** there is *no per-token requirement* at
all. Gasless-ness on Solana comes from the transaction's **fee payer** being the merchant — not from a
token feature — so it works for **any SPL token equally** (USDC and USDT alike). The buyer compiles the
`TransferChecked` with the merchant's public key as the fee payer, signs only its own slot, and hands
the partially-signed transaction to the gate, which co-signs as fee payer and broadcasts. (See the
[architecture note](#solana--how-svm-gasless-works) below for the fee-payer safety rules.)

## ⭐ Which chains & tokens are gasless?

Read this as: *"on chain X, token Y is gasless via Z."* Anything not listed pays via `onchain-proof`
(buyer broadcasts; fees are tiny on most chains but not zero).

### Gasless via EIP-3009 — no approval, no proxy

| Token | Gasless on |
|---|---|
| **USDC** (native Circle) | Ethereum · Base · Arbitrum · Optimism · Polygon · Avalanche · **Sonic · Linea · Celo · Unichain · World Chain · Sei · HyperEVM · Monad · zkSync Era · Injective** |
| **EURC** | Ethereum · Base · Avalanche |
| **FDUSD**, **USD1** | BNB Chain |

*(**17 EIP-3009-gasless chains (the 16 native-USDC chains above plus BNB via FDUSD/USD1), and counting.** Every native Circle USDC is the same Circle FiatToken contract that
implements EIP-3009 — so naming the chain is all it takes, no proxy and no approval. Each chain above
was verified on-chain before shipping: `authorizationState` present, EIP-712 domain `version` 2, and the
chain's real `eth_chainId` matched. The list grows as Circle issues native USDC on more chains.)*

### Gasless via Permit2 — one-time approval, needs the proxy

| Token | Gasless on |
|---|---|
| **USDC**, **USDT** (Binance-Peg) | BNB Chain |
| any ERC-20 | any chain with the x402 Permit2 proxy deployed (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB, Celo, World Chain, Sei, HyperEVM, Monad) |

### Gasless via SVM — Solana, any SPL token, no per-token setup

| Token | Gasless on |
|---|---|
| **USDC** (native Circle) · **USDT** · **any SPL token** | Solana |

*(On Solana the gasless mechanism is the transaction **fee payer**, not a token feature — so **USDC and
USDT are equally gasless**, with no EIP-3009 equivalent, no Permit2 proxy, and no per-token approval.
This is the key difference from EVM, where Tether's USDT needs Permit2. With a **facilitator** (PayAI)
the fee payer is the facilitator → **neither buyer nor merchant pays gas**; with **self-settle** the
merchant's relayer pays the sub-cent fee. Requirements: the fee-payer key must be **distinct from
`payTo`**, and the recipient's **token account must already exist** — the exact rail won't create it
(a brand-new recipient can be paid on `onchain-proof`, which does).)*

### NOT gasless → `onchain-proof` (the buyer broadcasts)

- **Native coins** (ETH, BNB, SOL, MATIC, …) — nothing to authorize / no fee-payer split.
- **The other non-EVM families** — TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL. (Fees there are
  sub-cent, but the buyer signs *and* broadcasts.) **Solana is the exception** — it's gasless via SVM (above).
- **USDT** on EVM chains where it isn't EIP-3009 **and** has no Permit2 proxy (Tether implements no
  EIP-3009 anywhere) — and bridged USDC (e.g. Mantle, Scroll), which isn't the Circle FiatToken.

> PipRail never advertises a rail it can't settle: if an EVM token isn't EIP-3009 **and** the chain has
> no Permit2 proxy, the gate simply offers `onchain-proof`, not a broken `exact` rail.

## Turn it on

**Buyer** — opt into `exact`; everything else is the same `fetch`/`quote`/`planPayment`:

```ts
import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY }, // needs the stablecoin; ~no gas for exact
  schemes: ['onchain-proof', 'exact'],           // exact is opt-in
})
await client.fetch('https://any-x402-endpoint/api/data') // pays the cheapest settleable rail
```

**Seller** — advertise `exact` beside `onchain-proof`; the method auto-selects per token. Settle with
your own relayer (you pay the settle gas) or, on EVM, a facilitator (they do):

```ts
import { requirePayment } from '@piprail/sdk'

requirePayment({
  chain: 'base', token: 'USDC', amount: '0.05', payTo: '0xYourWallet',
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAYER_KEY } }, // or { settle: { facilitator } }
})
```

**Seller on Solana — fully gasless via a facilitator** (recommended; **neither buyer nor merchant pays
gas** — the facilitator does). No relayer key, no SOL:

```ts
requirePayment({
  chain: 'solana', token: 'USDC', amount: '0.05', payTo: 'YourReceiveAddress…',
  // USDT works identically — any SPL token is gasless on Solana.
  exact: { settle: { facilitator: 'https://facilitator.payai.network' } }, // PayAI: no API key, pays the gas
})
```

The gate reads the facilitator's fee-payer pubkey from its `GET /supported` automatically (or set
`settle: { facilitator, feePayer }` to pin it). **Or self-settle** with your own relayer (a Solana
keypair, distinct from `payTo`) if you'd rather not use a third party — then your relayer pays the
sub-cent SOL fee:

```ts
exact: { settle: 'self', relayer: { secretKey: process.env.SOLANA_RELAYER_KEY } } // fee payer ≠ payTo
```

With a **facilitator** (EVM EIP-3009, or Solana), **neither side pays gas**. See the full how-tos:
[the exact rail (buyer)](/making-payments/exact-buyer/) · [the exact rail (seller)](/accepting-payments/exact-rail-seller/).

## BNB Chain — a worked example of both methods

BNB is the instructive case because it uses *both* methods at once. Circle has not issued native USDC
on BNB, so its USDC/USDT are **Binance-Peg** (18-decimal) wrappers that **aren't EIP-3009** → they go
via **Permit2**. But **FDUSD** and **USD1** (both in the `bnb` preset) **are** EIP-3009 → they go the
clean gasless path, **no approval at all**. PipRail auto-selects: USDC/USDT → Permit2, FDUSD/USD1 →
EIP-3009. All four are live-proven on BNB mainnet.

A wrinkle PipRail handles for you: FDUSD and USD1 hardcode their EIP-712 domain version (`"1"`) and
don't expose `version()`, so [`readExactDomain`](/reference/exact-lowlevel/) **derives the version from
the on-chain `DOMAIN_SEPARATOR`** — making any `version()`-less EIP-3009 token first-class with no config.

## Solana — how SVM gasless works

Solana's `exact` rail (the ratified x402 `scheme_exact_svm`) is gasless by a different mechanism than
EVM — and a simpler one:

1. The **buyer** compiles the canonical SVM transaction — `[setComputeUnitLimit, setComputeUnitPrice,
   TransferChecked]` (USDC, USDT, any SPL) — whose **fee payer** is whoever will sponsor it (the rail
   advertises a `feePayer` pubkey: the facilitator's, or the merchant's relayer). It signs **only its
   own** slot — leaving the fee-payer slot empty — and sends the partially-signed, base64 transaction.
   The buyer never broadcasts and pays **no** SOL.
2. The **sponsor** completes + broadcasts it:
   - **Facilitator mode** (recommended) — the gate forwards the signed transaction to the facilitator's
     `/verify` + `/settle`; the **facilitator co-signs as fee payer and broadcasts, paying the gas**. So
     **neither buyer nor merchant pays SOL**. PipRail hosts nothing — it's two HTTP POSTs.
   - **Self-settle mode** — the gate verifies the transaction against its own trusted rail (re-deriving
     the recipient ATA, amount, and mint — never trusting the client), **co-signs as the fee payer**, and
     broadcasts against your own RPC. The merchant's relayer pays the sub-cent fee.

This is why **any SPL token is gasless on Solana**: the fee abstraction lives in the transaction, not
the token. The scheme's **fee-payer safety rules** ensure the sponsor only ever pays the network fee —
the fee payer must never appear in any instruction, never be invoked as a program, and never be the
source of funds (and it must differ from `payTo`). The recipient's token account must already exist (the
exact rail never creates it — that keeps the transaction to the strict canonical form; a brand-new
recipient is payable on `onchain-proof`, which creates the account). Replay is bounded by the gate's
used-proof set plus Solana's own duplicate-signature rejection. Native **SOL** is *not* exact-payable
(the scheme is defined over SPL `TransferChecked`) — it stays on `onchain-proof`.

### Solana facilitators (who can sponsor the gas)

These three are **keyless and live-proven with PipRail** — a real Solana payment settled with no API key,
buyer paid zero SOL (txs on the [coverage page](/accepting-payments/facilitator-coverage/#live-verified-facilitators)):

| Facilitator | Keyless? | Notes |
|---|---|---|
| **[PayAI](https://facilitator.payai.network/)** | ✅ none | Solana-first + ~30 EVM rails; the gate auto-discovers its fee payer from `GET /supported`. The zero-config default. |
| **[Corbits](https://corbits.dev/)** | ✅ none | Solana-first (42 rails, also Base · Polygon · Monad). |
| **[OpenFacilitator](https://www.openfacilitator.io/)** | ✅ none *(no signup)* | Base · Solana · Stacks. |
| **[Coinbase CDP](https://docs.cdp.coinbase.com/)** | 🔑 CDP auth | Fee-free settlement on Base + Solana; pass `authHeaders`. Also the path onto Coinbase's Bazaar. |
| **[Kora](https://github.com/solana-foundation/kora)** | *self-host* | The Solana Foundation's relayer/paymaster — run your own node (you sponsor the gas). |

You choose the facilitator (PipRail depends on none). PayAI is the zero-config default for a fully-gasless
Solana gate; point `settle.facilitator` at whichever you trust. For the **full cross-chain list** — Base-only
options like **[xpay](https://www.xpay.sh/)**, and which providers need an API key (Daydreams, Questflow) — see
[Facilitator coverage → live-verified facilitators](/accepting-payments/facilitator-coverage/#live-verified-facilitators).

## Who pays — and is any of this a fee?

There are three separate things here, and only one of them is ever a real cost:

| Layer | Cost | Who pays |
|---|---|---|
| **PipRail** (the SDK + the rail) | **always $0** | nobody. PipRail is open-source, takes **no cut**, runs **no server**, and holds **no key** — it's a library you `npm install`. See [piprail.com](https://piprail.com). |
| **The payment** | the token amount (e.g. `0.01` USDC) | the **buyer** |
| **The network gas** | sub-cent | on the gasless `exact` rail, **whoever settles**: a **facilitator** (e.g. PayAI) or, in self-settle, **your own relayer**. **Never the buyer.** |

So "gasless" isn't PipRail absorbing a cost — it's the **settler** paying the tiny network fee instead of the
buyer. With a keyless facilitator like **[PayAI](https://facilitator.payai.network/)** the facilitator pays
it, so **neither the buyer nor the merchant pays gas**.

**Is PayAI itself free?** PayAI advertises a **Free Forever ($0), keyless tier** — and that keyless tier is
exactly what the SDK uses (no API key). It sponsors the gas to grow x402 adoption. The free tier has **rate
limits** (settlement volume / requests-per-second); only very high volume moves you onto PayAI's paid plans —
and that is **your relationship with PayAI**, never a per-payment gas charge and never anything paid to
PipRail. Check [facilitator.payai.network](https://facilitator.payai.network/) for current tiers.

### What the SDK actually does

When a gate is configured with `settle: { facilitator }`, the SDK does just two things over plain HTTP — it
**hosts nothing**:

1. **Discovers the sponsor** — reads the facilitator's `GET /supported` to learn its **fee-payer pubkey**
   (Solana) and advertises it on the `exact` rail, so the buyer builds the transaction against it.
2. **Settles** — POSTs the buyer's signed authorization to the facilitator's `/verify`, then `/settle`; the
   facilitator co-signs as fee payer, broadcasts, and **pays the gas**. The receipt returns with the
   on-chain `transaction` id.

Every checked field (amount, recipient, mint) is re-derived from the gate's **own trusted rail**, never the
client echo — the facilitator only broadcasts; it never gets to redefine the payment. You can verify any
facilitator's coverage yourself with `facilitatorCoverage(url)` — see
[Facilitator coverage](/accepting-payments/facilitator-coverage/).

## Keep PayAI, or swap it

PayAI is a **default, not a dependency** — the SDK depends on no facilitator, so swapping is one config line
and nothing else changes. Pick whichever fits:

| You want… | Use | Who pays the gas | Config |
|---|---|---|---|
| **Fully gasless, zero setup** (keep the default) | **PayAI** (keyless) | PayAI | `exact: { settle: { facilitator: 'https://facilitator.payai.network' } }` |
| **No third party at all** | **Self-settle** with your own relayer | your relayer (sub-cent) | `exact: { settle: 'self', relayer: { secretKey: … } }` — fee payer ≠ `payTo` |
| **A different facilitator** | **Coinbase CDP** (Base + Solana) / **Kora** (self-host) | them / you | `exact: { settle: { facilitator, authHeaders } }` (CDP passes auth) |
| **No gasless rail** | the **`onchain-proof` default** | the buyer (tiny) | omit `exact` entirely — works on every chain |

Swapping is intentionally trivial: keep the buyer side identical, change only the seller's `settle`. If PayAI
is ever down the gate **degrades gracefully** (it never turns a facilitator outage into a bogus "re-pay" 402
— see below), and you can pin `settle: { facilitator, feePayer }` to drop even the `/supported` lookup. Full
seller walkthrough: [the exact rail (seller)](/accepting-payments/exact-rail-seller/).

## When the facilitator fails

A facilitator is a network dependency, so PipRail treats its failures the same disciplined way it treats
its own relayer — **a server-side fault is never turned into a "re-pay" 402**, and a buyer-fixable fault
never turns into a 5xx. There are three distinct failure points:

| When | What failed | Buyer/agent sees | Gate behaviour |
|---|---|---|---|
| **At challenge time** (Solana only) | The gate couldn't read the facilitator's fee payer from `GET /supported` (it's down, or doesn't sponsor this network) | — | The `exact` rail is **dropped** for that chain (the gate serves `onchain-proof`); if it was the *only* exact rail, the gate throws a clear error naming the cause. **Fix:** pin `settle: { facilitator, feePayer }` to remove the runtime dependency, or use `settle: 'self'`. |
| **At settle — transport/auth** | `/verify` or `/settle` returned a non-200, or the request itself failed (facilitator down, bad/expired auth header) | **HTTP 502** `settlement_failed` — *not* a 402 | The gate throws [`SettlementError`](/errors/error-hierarchy/); the buyer's signed authorization stays **valid + unused**, the replay claim is **released**, and the payment can be re-presented once the facilitator recovers. The buyer is told to **verify on-chain, never re-pay**. |
| **At settle — facilitator rejection** | `/verify` returned `isValid:false`, or `/settle` returned `success:false` (insufficient funds, bad signature, expired, …) | **HTTP 402** with the mapped reason | A conformant re-challenge — the agent reads the reason (`errorReason`), fixes it, and re-presents the **same** authorization (never a fresh signature). No spend is recorded. |

The split is the whole point: **"the facilitator is down" (502) and "your payment was rejected" (402)
are different problems with different fixes**, and PipRail never blurs them. Pinning
`settle: { facilitator, feePayer }` (Solana) removes the only *challenge-time* dependency on the
facilitator, so a `/supported` blip can't even affect serving the challenge. Self-settle has the exact
same error contract — substitute "your relayer" for "the facilitator".

## If every facilitator fails — the onchain-proof floor

The single most important guarantee: **`onchain-proof` needs no facilitator, works on every chain, and
is always offered alongside `exact`.** It is the floor under everything — if every facilitator on earth
went down, an agent can still pay (it broadcasts the transfer itself and pays the sub-cent gas). Gasless
is an *upgrade*, never a single point of failure.

Here is **every failure mode**, what the caller sees, and what to do. Each row is **live-verified on
Solana mainnet** (and the contract is identical on EVM):

| What fails | Behaviour | What the caller gets | Fallback / fix |
|---|---|---|---|
| A facilitator is down **at challenge time** — *multi-rail* gate | The exact rail for that chain is **dropped**; the gate still serves `onchain-proof` (+ any working rails) | — *(challenge still succeeds)* | **Automatic** — the buyer pays `onchain-proof`. |
| The **only** exact rail's facilitator is unreachable at challenge — *single-rail* gate, no pinned fee payer | The gate **fails loud** — it won't silently downgrade your stated gasless intent | `requirePayment: exact was requested but none of the offered rails support it … couldn't read a fee payer from (…/supported) … Set exact.settle.feePayer, switch to settle:'self', or retry.` | Pin `settle:{facilitator,feePayer}`, use `settle:'self'`, add a 2nd rail, or drop `exact` (the `onchain-proof` default always works). |
| The facilitator **errors at settle** (down / 401 / timeout) | The signed authorization stays **valid + unused** — no double-spend | **HTTP 502** `SettlementError: exact settle (facilitator …): /verify returned HTTP 401 (transport/auth error)` | Re-present the **same** payment when it recovers, **or** pay `onchain-proof` on the same endpoint *(verified: 502 → onchain-proof → 200)*. |
| The facilitator **rejects** the payment (bad sig / expired / insufficient) | A conformant re-challenge — **no spend recorded** | **HTTP 402** + a mapped `VerifyErrorCode` and `Facilitator rejected the payment: <reason>` | The agent reads the reason, fixes it, re-presents the **same** authorization. |
| **Everything** — facilitator down **and** the buyer can't afford `onchain-proof` either (no token / no gas / recipient not ready / outside policy) | The client **refuses before sending anything** — no signature, no broadcast, nothing spent | `PaymentDeclinedError: Can't settle on solana: top up 0.001 USDC (to pay 0.001 USDC).` + per-rail `planPayment()` blockers (`INSUFFICIENT_TOKEN`, `INSUFFICIENT_GAS`, `RECIPIENT_NOT_READY`, `OUTSIDE_POLICY`) | Read `planPayment(url).fundingHint`, top up the named amount, retry. `canAfford(url)` is the boolean. |

So *"what if they all fail?"* is answered in layers, and **no layer ever loses money**:

1. **Prefer gasless** — once you opt in, the SDK pays the cheapest *settleable* rail, which is the gasless `exact` one.
2. **Fall back to `onchain-proof`** — needs no facilitator; the buyer broadcasts and pays sub-cent gas. Always available, every chain.
3. **If even that can't settle** — the client **refuses up front** with a typed `PaymentDeclinedError` and an exact funding hint, having spent **nothing**.

Every failure is a **typed error** — a [`PipRailError`](/errors/error-hierarchy/) subclass with a stable
`.code`, or a [`VerifyErrorCode`](/errors/verify-error-code/) — with a message written for an agent *and* a
human (see [Why payments fail](/errors/why-payments-fail/)). The golden rule on any facilitator/relayer
fault: **verify on-chain, never blindly re-pay** — a 502 means "settlement is unconfirmed", not "it failed".

## How the Permit2 method stays safe

The buyer signs a `PermitWitnessTransferFrom` whose `spender` is the canonical **x402ExactPermit2Proxy**
and whose `witness.to` binds the recipient. The proxy enforces `transferDetails.to == witness.to`, so a
relayer can only push the signed funds to the signed `payTo` — the same no-redirect guarantee EIP-3009's
`to`-binding gives. Verification re-derives every checked field from the merchant's **trusted** rail
(never the client echo); the Permit2 nonce is single-use (replay protection). Canonical addresses are
exported for advanced use: `PERMIT2_ADDRESS`, `X402_EXACT_PERMIT2_PROXY`, `PERMIT2_WITNESS_TYPES`,
`PERMIT2_PROXY_CHAIN_IDS`, `isPermit2ProxyChain` from `@piprail/sdk`.

## See also

- [The exact rail (buyer)](/making-payments/exact-buyer/) — pay any x402 server
- [The exact rail (seller)](/accepting-payments/exact-rail-seller/) — get paid over exact
- [Low-level exact codecs](/reference/exact-lowlevel/) — hand-rolled signing
- [Chains](/chains/overview/) — every chain's tokens + receive prerequisites
