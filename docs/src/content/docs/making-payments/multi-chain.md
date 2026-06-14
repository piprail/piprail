---
title: Multi-chain buying
description: Pay a 402 on whichever chain it asks for — give a MultiChainPayer one wallet per chain and it auto-routes to the first funded chain that can settle, no manual routing, no backend, no oracle.
sidebar:
  order: 10
---

## Introduction

A [`PipRailClient`](/making-payments/piprail-client/) is bound to **one chain and one
wallet** — and that's deliberate: keys are chain-family-specific, so an EVM private key
can't sign a Solana transaction and an XRPL seed can't sign on Base (pass the wrong shape
and you get a [`WrongFamilyError`](/making-payments/wallets-by-family/)). So how does a
buyer pay a merchant that demands **whatever chain it happens to offer** — Base today,
Solana tomorrow, a multi-rail 402 that lists both?

You give the buyer **one wallet per chain** and let `MultiChainPayer` route. It builds one
single-chain client per chain, surveys every chain you hold a key for when it hits a 402,
and pays the **first funded chain (in the order you listed them) that can actually settle** —
through each client's own spend policy, approval hook, retries, and replay-protection.
**No price oracle, no backend, no custody** — it's a thin, chain-agnostic composition over
primitives you can already call by hand.

## Mental model

```text
                 ┌──────────────────────────────────────────────┐
   one 402  ───▶ │  MultiChainPayer                             │
                 │   ├─ PipRailClient(base)    ← { privateKey }  │
                 │   ├─ PipRailClient(solana)  ← { secretKey  }  │
                 │   └─ PipRailClient(xrpl)    ← { seed       }  │
                 └──────────────────────────────────────────────┘
                        │  plan on every client in parallel
                        ▼
              merge rails → pick the FIRST funded chain that can settle
                        │  (within that chain: cheapest-gas rail)
                        ▼
              pay on its owning client (its policy / approval / retry / replay)
```

One payer, many single-chain clients, one shared budget. Each client is exactly the
client you'd build yourself — `MultiChainPayer` only decides *which one* handles a given
402 and aggregates their reads. It adds **no new payment logic**.

## `MultiChainPayer.fromWallets`

The ergonomic path: a `{ chain → wallet }` map plus one shared policy.

```ts
import { MultiChainPayer } from '@piprail/sdk'

const payer = MultiChainPayer.fromWallets({
  wallets: {
    base:    { privateKey: process.env.EVM_KEY },    // one EVM key works on every EVM chain
    polygon: { privateKey: process.env.EVM_KEY },
    solana:  { secretKey:  process.env.SOLANA_KEY },
    xrpl:    { seed:       process.env.XRPL_SEED },
  },
  // ONE spend policy guards every chain — the buyer can never exceed it, whatever chain it pays on.
  policy: { maxAmount: '1.00', maxTotal: '10.00', tokens: ['USDC', 'USDT'] },
})

// Read-only: survey every chain, ranked payable-first. Moves nothing.
const plan = await payer.planPayment('https://api.example.com/report')

// Pay: settles on the first funded chain that can afford it, on its own chain.
const res = await payer.get('https://api.example.com/report')
```

The wallet **value** is the same shape each chain's client expects (see
[Wallets by family](/making-payments/wallets-by-family/)):

| Families | Wallet shape |
|---|---|
| EVM (`base`, `bnb`, `polygon`, …), `tron`, `sui`, `aptos` | `{ privateKey }` |
| `solana` | `{ secretKey }` |
| `ton`, `algorand` | `{ mnemonic }` |
| `stellar` | `{ secret }` |
| `xrpl` | `{ seed }` |
| `near` | `{ accountId, privateKey }` |

**One key per family** — this map is just how a single buyer carries the keys for every
chain it's willing to pay on. (A single EVM key is reused across every EVM chain; it's the
same address on all of them.)

The **iteration order** of `wallets` is your **chain preference**: when more than one chain
can settle, the *first one you listed* wins. There's no oracle to compare gas across
different native coins, so the SDK never guesses which is "cheaper" in dollars — you decide
by ordering. List your preferred chain first, or fund only it.

For a custom EVM chain configured by a viem `Chain` object, build the client yourself and
use the array form: `new MultiChainPayer([clientA, clientB, …])` (order = preference).

## How a rail is chosen — the exact rule

This is the one thing to internalise, because it's *not* "cheapest across chains":

1. **Plan every funded chain in parallel.** Each client reads its own balance, gas, and
   recipient-readiness for the rails the 402 offers on *its* chain, and ranks them
   payable-first / cheapest-gas-first **within that chain** (its own native coin — a valid
   comparison).
2. **Merge across chains by state only, preserving your listed order.** Payable rails come
   before unknown, unknown before blocked — but rails are **never fee-compared across
   chains**. Base-unit gas magnitudes aren't comparable between different native coins
   (0.0001 ETH vs 0.5 SOL vs 2 XRP say nothing about dollar cost without an oracle, and
   there is no oracle).
3. **`best` = the first chain you listed that can settle.** Within that one chain, the
   cheapest-gas rail.

So with `wallets: { base, polygon, solana }`, a 402 payable on all three settles on
**Base** — not because Base is cheapest, but because you listed it first. Reorder to
`{ polygon, base, solana }` and Polygon wins. This keeps routing **predictable and
oracle-free**, in line with PipRail's no-backend design.

## When nothing can settle — the decline message

If no funded chain can pay, the failure is made **explicit and actionable** — for an AI agent
parsing fields *and* for a human reading the sentence. `planPayment` returns `payable: false`
with a merged `fundingHint` that names **every funded chain's own blocker** (not just the
first), and `fetch`/`get`/`post` throw [`PaymentDeclinedError`](/errors/error-model/) carrying
the same sentence — **before any on-chain send**:

```text
Can't settle on base: top up 0.05 USDC (to pay 0.05 USDC). · Can't settle on polygon: top
up 0.05 USDC and add ~0.018 POL for gas (to pay 0.05 USDC). · Can't settle on arbitrum: add
~0.0000013 ETH for gas (to pay 0.05 USDC).
```

Each rail also carries a machine-readable `blockers` array so an agent can branch
programmatically instead of parsing prose:

| Blocker | Meaning | The fix |
|---|---|---|
| `INSUFFICIENT_TOKEN` | Not enough of the payment token | Top up that token on that chain (`shortfall.token`) |
| `INSUFFICIENT_GAS` | Not enough native coin for gas | Add native coin on that chain (`shortfall.native`) |
| `RECIPIENT_NOT_READY` | The recipient can't receive yet | A recipient-side fix (trustline / opt-in / activation) — not your balance |
| `OUTSIDE_POLICY` | Refused by your spend policy | Raise the cap or allow the token; the amount/asset exceeded your `policy` |
| `OUTSIDE_WINDOW` | Budget window or session exhausted | Wait for the window, raise `windowTotal`, or restart the session |

The "noise" notes (a chain the 402 *didn't* offer at all) are dropped when at least one chain
is actually close, so the message stays focused on what you can actually act on. If the 402
offers **only** chains you don't hold, the hint instead tells you which chains it *is* payable
on. A single chain whose RPC is merely throttled comes back as `state: 'unknown'` (not a false
"blocked"), so a transient hiccup never reads as "you can't pay."

## The methods

`MultiChainPayer` mirrors the single-chain client, but across all your chains. It satisfies
the same `PayingClient` interface, so anything that takes a `PipRailClient` takes this too.

| Method | What it does |
|---|---|
| `planPayment(url, init?)` | Survey every funded chain; return one merged [`PaymentPlan`](/making-payments/plan-payment/) (`best` = first funded chain that can settle). `null` if the URL needs no payment. Throws only on a **total** outage (every chain unreachable). |
| `canAfford(url, init?)` | `true` if **any** funded chain can settle it now (a free resource is trivially affordable). |
| `quote(url, init?)` | The chosen chain's [quote](/making-payments/quote/) (price + recipient + policy verdict); falls back to the first offered rail's quote, else surfaces the same informative `NoCompatibleAcceptError` a single client would. |
| `fetch` / `get` / `post` | Pay on the chosen chain and return the unlocked response. `post` accepts a string/`FormData`/`URLSearchParams`/`ArrayBuffer`/`Blob` (sent as-is) or a plain object (JSON), exactly like `PipRailClient.post`. |
| `discover(opts?)` | Find payable resources across every funded chain, deduped by URL (a network-scoped query is chain-independent, so one client answers it). |
| `register(url, opts?)` | List a resource you run (goes through your first chain; pass `opts.network` to advertise a specific chain). |
| `spent()` / `budget()` | Aggregated across all chains — per-(network, asset) rows concatenated (never a cross-token sum); `budget()` reports the soonest-expiring session window. |
| `clients` | The underlying single-chain clients, in preference order, for chain-specific reads (`estimateCost`, per-chain `budget()`, `discoverySigner`) that don't make sense merged. |

Because it implements the same `PayingClient` interface a `PipRailClient` does, the
[agent toolkit](/agent-toolkit/payment-tools/) (`paymentTools`) and the
[MCP server](/mcp/overview/) wrap it **unchanged** — point an LLM at one wallet or at a whole
bundle and the 7 tools are identical.

## Gasless `exact` works across chains

The optional [`exact` scheme](/making-payments/exact-buyer/) — the standard x402 rail that lets
the buyer pay **gaslessly** (sign an EIP-3009 / Permit2 authorization; the merchant or a
facilitator submits and pays the gas) — is applied to **every** chain in the bundle. Pass
`schemes` once and it propagates to each chain's client:

```ts
const payer = MultiChainPayer.fromWallets({
  wallets: { base: { privateKey: EVM_KEY }, bnb: { privateKey: EVM_KEY } },
  schemes: ['onchain-proof', 'exact'], // every chain may now settle the gasless exact rail
  policy: { maxAmount: '1.00', tokens: ['USDC'] },
})
```

When a 402 offers both rails on a chain, the gasless `exact` rail is preferred *within that
chain* (it costs the buyer no gas, so it's the cheaper rail). The cross-chain rule is
unchanged — the first funded chain you listed that can settle still wins. In the MCP server,
set `PIPRAIL_SCHEMES=onchain-proof,exact` and it applies to every chain in `PIPRAIL_CHAINS`.
See [Gasless payments](/making-payments/gasless-payments/) for which chains/tokens support it.

## What a plan looks like

Three EVM chains funded with one key, hitting a 402 that offers USDC on each
(`wallets: { base, arbitrum, polygon }`, in that order):

```text
PLAN: READY
  rail (network · token)               state      gas              amount
  ────────────────────────────────────────────────────────────────────────
  eip155:8453 · USDC                   payable    0.000021 ETH     0.05 USDC  ◀ best
  eip155:42161 · USDC                  payable    0.000004 ETH     0.05 USDC
  eip155:137 · USDC                    payable    0.012 POL        0.05 USDC
```

All three are payable, so **Base wins because it's listed first** — even though Arbitrum's
gas is numerically smaller (the SDK won't compare ETH-gas against POL-gas without an
oracle). `get()` then settles **only** that rail. To prefer Arbitrum, list it first. See the
runnable [`examples/multi-chain`](https://github.com/piprail/piprail/tree/main/examples/multi-chain).

## The primitives underneath

`MultiChainPayer` is a thin composition over two exported functions, for when you already
hold an array of single-chain clients and want to skip the wrapper:

- **`planAcross(clients, url, init?)`** — run each client's `planPayment` in parallel and
  merge the rails into one plan, ranked payable-first in client order. Returns `null` only
  if the URL isn't gated for any client; throws only if **every** client fails to reach the
  resource (a single chain being down just drops that chain).
- **`fetchAcross(clients, url, init?)`** — the execution counterpart: plan across the
  clients, then pay on the owning client of the rail `planAcross` names as `best`. Throws
  [`PaymentDeclinedError`](/errors/error-model/) with a merged, per-chain funding hint when
  no chain can settle — **before any on-chain send**.

```ts
import { PipRailClient, planAcross, fetchAcross } from '@piprail/sdk'

const clients = [
  new PipRailClient({ chain: 'base', wallet: { privateKey: EVM_KEY } }),
  new PipRailClient({ chain: 'solana', wallet: { secretKey: SOLANA_KEY } }),
]
const plan = await planAcross(clients, url) // read-only survey (Base preferred — listed first)
const res = await fetchAcross(clients, url) // pay the winner on its owning client
```

`fetchAcross` is **best-effort** at pay time: the owning client re-reads its balances and
gas when it actually pays (via `autoRoute`), so if balances shift between plan and pay it
can pick another settleable rail *on the same chain*, or decline — its spend policy and
`onBeforePay` still gate whatever is paid.

## Notes & limits

- **One budget, per-chain ledgers.** The shared `policy` applies to every chain, but each
  client keeps its own per-(network, asset) spend ledger — `maxTotal` is enforced per token
  (there's no price oracle to sum USDC-on-Base against SOL). Because the cap is per
  (network, asset), the **same token across N chains gets N independent caps** —
  `maxTotal: '20'` with USDC on Base *and* Polygon allows 20 USDC on each. `payer.spent()` /
  `payer.budget()` give the merged view.
- **Caps are in the paid token's units, not dollars.** `maxAmount`/`maxTotal` are scaled by
  the token's *true on-chain decimals* (decimal-spoof-proof) — so `'1.00'` is ~\$1 for
  USDC/USDT (≈\$1 stablecoins) but **1.0 of a native coin** on a `native` rail (~\$1000s for
  ETH), since there's no oracle. If you include `'native'` in `tokens`, set the cap with that
  in mind — or keep `tokens` to stablecoins for a ~dollar cap.
- **Which chain is chosen — your order, not the cheapest.** Across different native coins
  there's **no price oracle**, so chains are **not** fee-compared against each other: it pays
  the **first chain you list** that can settle. Within a single chain it still prefers the
  cheapest-gas rail. List your preferred chain first (or fund only it).
- **Read-only chains are fine.** A client with no wallet contributes nothing to paying (it
  can still plan/quote/discover). The payer pays on whichever funded chain wins.
- **Total outage propagates; one chain down doesn't.** If a single chain's RPC is
  unreachable it's dropped from the plan; if *every* chain is unreachable, `planPayment` /
  `canAfford` throw rather than falsely reporting "free" or "affordable".
- **No 402 → straight through.** A free resource is returned verbatim; nothing moves.
- **At most one client per chain.** Two clients on the same network would double-count in
  `spent()`/`budget()` — `fromWallets` can't produce that (its keys are unique chains); only
  the array constructor can, so don't.

## Zero-code: the MCP equivalent

The [`@piprail/mcp`](/mcp/configuration/) server does this for any AI client — list several
chains and give each its own key:

```jsonc
"env": {
  "PIPRAIL_CHAINS": "base,polygon,solana",
  "PIPRAIL_BASE_KEY": "0x…", "PIPRAIL_POLYGON_KEY": "0x…", "PIPRAIL_SOLANA_KEY": "<base58-secret>",
  "PIPRAIL_MAX_AMOUNT": "1.00"
}
```

The model's `piprail_pay_request` then pays whichever chain a 402 asks for — preferring the
first chain you listed — under one shared budget across every chain you funded. Full setup in
[Configuration → pay on several chains](/mcp/configuration/#pay-on-several-chains-from-one-server).
