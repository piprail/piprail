---
title: Swapping tokens
description: 'An optional helper for when you hold the wrong token. Uses the chain own DEX on Stellar and the XRP Ledger, never runs by itself, and is safe to ignore entirely.'
sidebar:
  order: 11
---

## Introduction

A 402 names a token. Your wallet holds what it holds. Sooner or later those disagree:
you have XLM and the invoice wants USDC, so [`planPayment()`](/making-payments/plan-payment/)
reports `INSUFFICIENT_TOKEN` and stops.

This page documents an **optional helper** for that moment. It is a convenience, not a
feature of paying, and the most important thing to understand about it is what it does
**not** do.

:::tip[The short version]
Nothing swaps unless you explicitly ask it to. Paying never swaps. Planning never swaps.
There is no `autoSwap` setting. If you never call `quoteSwap()`, this feature does not
exist for you, and that is a supported way to use PipRail.
:::

## It is an addition, not a change

Converting one asset into another is a priced, irreversible act. A payment library should
not do that on your behalf because it noticed you were short, so PipRail does not.

This follows the SDK build standard, quoted here because it is the actual rule and not a
promise invented for this page:

> **Opt-in, defaults unchanged.** New capability is a new optional field or method.
> Omitting it leaves behaviour byte-identical.
> <cite>[`sdk/STANDARDS.md`](https://github.com/piprail/piprail/blob/main/sdk/STANDARDS.md) §0</cite>

That is enforced by a test, not by good intentions. `sdk/test/swap.test.ts` asserts that a
driver with no swap support answers `quoteSwap()` with `null`, that `swap()` fails with a
clear message rather than a crash, and that the whole read-only surface behaves identically
whether or not swapping is available.

**If you would rather bridge somewhere else, use an exchange, or top the wallet up by hand,
those are all perfectly good answers.** This helper exists so that doing it inside the SDK
is *possible*, not so that it is expected.

## 🔴 Two safety facts, before anything else

**1. Your spend policy does not govern swaps.** Every cap in
[spend controls](/spend-controls/payment-policy/) (per-payment, per-network-and-asset, the
grand total, the payment count, the time envelope) applies to **paying a merchant**. A swap
converts your own funds between denominations instead, so it sits outside all of them.

**2. There is deliberately no MCP tool and no agent tool for swapping.** It follows directly
from the first fact: an autonomous agent able to swap could burn a wallet down through fees
and slippage without ever tripping a budget check. So `quoteSwap()` and `swap()` are for a
**developer writing code**, who can see and bound what they are doing.

If you want an agent to be able to swap, you must wire that yourself, deliberately, with
your own limits around it. PipRail will not hand it to a model by default, and
[`PIPRAIL_AGENT_GUIDE`](/agent-toolkit/agent-guide/) tells the model plainly that the tool
does not exist so it does not go looking for one.

## Where it works, and where it does not

PipRail implements swapping **only where an open, keyless route exists**: one that needs no
API key, no account and no signup, and that never takes possession of your funds. That is a
deliberately narrow rule, and it is what keeps the feature free of gatekeepers.

There are **two tiers**, and the difference matters more than the coverage count: on some
chains the ledger itself swaps and no third party exists at all, while on the rest a named
venue routes it. Never blur the two.

### Tier 1: the ledger does the swap (no third party at all)

| Family | Route | How | Third party |
|---|---|---|---|
| **Stellar** | **Stellar SDEX** | `PathPaymentStrictReceive` to your own account, across the order books and liquidity pools | **none** |
| **XRP Ledger** | **XRPL DEX + AMM** | Cross-currency `Payment` to your own address, across the order books and AMM pools, auto-bridged through XRP | **none** |

No API key, no extra dependency, no integrator fee, and nothing to trust beyond the chain
you are already using. The trade happens inside one transaction you sign.

### Tier 2: a third-party aggregator routes it (named openly)

Most chains have no protocol-level swap, so a router is unavoidable. Where we use one, it
is named, and it had to be **open and keyless** to qualify.

| Family | Provider | Keyless | Fee taken by the provider |
|---|---|---|---|
| **Solana** | [Jupiter](https://jup.ag) | ✅ verified | none (`platformFee: null`) |
| **EVM** (9 chains) | [KyberSwap](https://kyberswap.com) | ✅ verified | no integrator fee |
| **Sui** | [Aftermath](https://aftermath.finance) | ✅ verified | none added; pool fee only |
| **NEAR** | [Ref Finance](https://app.ref.finance) | ✅ verified | none; pool fee only |
| **Algorand** | [Vestige](https://vestige.fi) | ✅ verified | none; pool fee only |
| **Aptos** | [Hyperion](https://hyperion.xyz) | ✅ no API at all | none; pool fee only |
| **TON** | [STON.fi](https://ston.fi) | ✅ verified | none; pool fee only |
| **Tron** | [SunSwap V2](https://sunswap.com) | ✅ no API at all | none; pool fee only |

The 9 EVM chains are Ethereum, Base, BNB Chain, Polygon, Arbitrum, Optimism, Avalanche,
Linea and Robinhood Chain. Each was probed live with a real stablecoin route before being
listed.

**Celo and Scroll are deliberately absent.** KyberSwap answers on both but returns no route
even for the most liquid pair, so listing them would advertise a swap that cannot execute.
`quoteSwap()` returns `null` there, which is the honest answer.

**PipRail takes nothing on top, ever.** We never set an integrator or platform fee field,
on any provider.

:::caution[Tier 2 is a different trust question, and we will not blur it]
On Stellar and XRPL you trust the ledger. On Solana and EVM you also trust a third-party
router contract and its routing API. That is a real difference, and if you are not
comfortable with it, do not use those rails. Nothing in PipRail makes you.
:::

### Three of these need no API at all

**Aptos and Tron are called contract-to-contract.** There is no service in the middle: the
quote is an on-chain read and the swap is a contract call your own key signs. Nothing to
rate-limit, no key to rotate, no host to go down. On Tron that was a deliberate choice, because
SunSwap's own front end talks to an undocumented, obfuscated hostname that a payments SDK
should not depend on.

### Exact output, where the chain offers it

Most routers are exact-**input**: you say what you will spend and find out what arrives. An
x402 invoice is the other way round, so those routes are sized from a probe and then checked
to clear the invoice. **Three routes take the invoice amount directly** and cap the input
on-chain instead, which is strictly better:

| Family | How | What it means |
|---|---|---|
| **Aptos** | `exact_output_swap_entry` | You ask for 0.05 USDT and receive **exactly** 0.05 USDT |
| **Tron** | `swapETHForExactTokens` and siblings | Same, with the input ceiling a contract argument (or `callValue` when selling native TRX) |
| **TON** | `reverse_swap` simulation | Fixes the ask side; PipRail pads the request so the on-chain floor is **at least** the invoice (slightly more is possible, less is refused by the router) |

### Tron ships without a proof, and says so

Every other route on this page carries transaction hashes. **Tron does not, and we would
rather say that plainly than quietly show an empty table.**

The route is real, and everything about it that can be checked without spending has been.
Both directions quote live through the SDK, and the approve and the router call each execute
cleanly in a constant-call simulation against the real contracts.

It has not been broadcast because **Tron charges about 230,629 ENERGY per swap**, which
without staked energy is roughly **23 TRX (about $7.79) regardless of trade size**. Selling a
TRC-20 rather than native TRX adds an approve, measured at about 99,800 more energy the first
time, taking that direction to roughly **33 TRX**. The project's test wallets hold 8.1 TRX. A
user with energy can swap today; we simply have not paid to prove it.

The quote says so before you commit: `quote.source.note` names the energy charge, and names
the extra approve when you are selling a token. (`estimateCost()` will not tell you this. It
prices a *payment*, not a swap.)

## The rate is never ours

PipRail does not run a price oracle, and a swap rate is a price. So **every quote names who
produced it**:

```ts
const quote = await client.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.50' })

quote.source
// { kind: 'protocol',
//   name: 'Stellar SDEX',
//   note: 'Rate from the ledger own order books and liquidity pools, read live from Horizon…' }
```

`kind: 'protocol'` means the chain's own market priced it and no company was involved.
A future third-party provider would carry `kind: 'provider'`, so the difference stays
visible in the type system rather than buried in a changelog.

Read `source` before you trust a number, exactly as you would check which
[facilitator](/accepting-payments/facilitator-coverage/) settled a payment.

## The two calls

The shape mirrors `quote()` then `pay()`, which the
[agent guide](/agent-toolkit/agent-guide/) already teaches: **look first, then commit.**

### `quoteSwap()` reads, and only reads

```ts
import { PipRailClient, summarizeSwap } from '@piprail/sdk'

const client = new PipRailClient({ chain: 'stellar', wallet: { key: process.env.STELLAR_KEY } })

// "I need 0.50 USDC. What would that cost me in XLM?"
const quote = await client.quoteSwap({
  from: 'native',      // what you hold
  to: 'USDC',          // what the invoice wants
  wantAmount: '0.50',  // exact output, because that is the shape of an invoice
})

if (!quote) {
  // No route, no liquidity, a read failed, or this chain has no swap support.
  // `null` means "no quote". It never means "no funds".
  return
}

console.log(summarizeSwap(quote))
// Swap ~2.6417 XLM → 0.50 USDC (at most 2.6549 XLM, 0.5% slippage). Rate from Stellar SDEX.
```

`quoteSwap()` **never throws for a read problem**. No route, no liquidity, a dead node, a
hostile response: every one of them returns `null`, matching
[`estimateCost()`](/making-payments/estimate-cost/) and `balanceOf()`. The one thing that does
throw is a malformed `slippageBps` (a `RangeError`, before any read happens), because that is a
bug in your code rather than a market condition, and hiding it behind `null` would help nobody.

### `swap()` signs, once, on purpose

```ts
const receipt = await client.swap(quote)
console.log(receipt.transaction) // the tx hash, verifiable on any public explorer
```

Pass the quote back **unmodified**. Re-quote rather than reusing an old one: a stale route
is how you get a worse price than the one you were shown.

## Slippage is enforced by the chain, not by us

`quoteSwap()` returns `maxSpend`: the most you can possibly spend. That number is written
**into the transaction**, so the chain enforces it, not this library: Stellar `sendMax`, XRPL
`SendMax`, `amountInMax` on EVM and Tron, `amount_in_max` on Aptos, and on TON the mirror image,
a `min_ask_units` floor on what must arrive.

If the market moves past your tolerance, **the transaction fails and nothing is swapped.** On
chains that charge for a reverted transaction (EVM, Aptos, Tron) the gas is still taken; on the
others nothing at all is spent. Either way it is the guard working correctly, and it surfaces as
an `InsufficientFundsError` whose message says exactly that rather than leaving you to guess.

The default tolerance is **0.5%** (`DEFAULT_SLIPPAGE_BPS = 50`), and the ceiling is 10%.

```ts
await client.quoteSwap({ from: 'native', to: 'USDC', wantAmount: '0.50', slippageBps: 100 }) // 1%
```

The maths rounds **up**, so the cap is never tighter than you asked for, and it is pure
integer arithmetic. No floating point goes anywhere near money.

Three pure helpers are exported so you can reason about slippage without a client:

| Export | What it does |
|---|---|
| `DEFAULT_SLIPPAGE_BPS` | The default tolerance, `50` (0.5%). Applied when you pass no `slippageBps`. |
| `MAX_SLIPPAGE_BPS` | The ceiling, `1000` (10%). Past this, a swap is a donation to an arbitrageur. |
| `resolveSlippageBps(bps?)` | Validates and defaults a tolerance. Throws `RangeError` on a negative, fractional, or out-of-range value, because that is a bug in your code rather than a payment condition. |
| `applySlippage(amount, bps)` | Applies a tolerance to a `bigint` base amount, rounding up. Pure. |

```ts
import { applySlippage, resolveSlippageBps, MAX_SLIPPAGE_BPS } from '@piprail/sdk'

resolveSlippageBps(undefined)      // 50
applySlippage(1_000_000n, 50)      // 1_005_000n
resolveSlippageBps(MAX_SLIPPAGE_BPS + 1) // throws RangeError
```

## One prerequisite worth knowing

On both chains, holding an issued asset requires a **trustline** for it first. Swapping
*into* USDC needs your own account to trust USDC.

PipRail already probes exactly this through
[`recipientReady()`](/making-payments/plan-payment/), and a missing trustline surfaces as
`RecipientNotReadyError` with a message naming the fix. On Stellar a trustline costs a
refundable 0.5 XLM reserve; on the XRP Ledger, 0.2 XRP.

## The coverage map is data you can read

The table below is not hand-maintained prose. It is generated from `SWAP_PROVIDERS` in the
SDK, which you can import and read yourself:

```ts
import { SWAP_PROVIDERS, canSwapOn, swapProvidersFor, swappableNetworks } from '@piprail/sdk'

canSwapOn('eip155:8453')        // true
swappableNetworks()             // every network with a proven route
swapProvidersFor('stellar:pubnet')[0].proofs[0].tx  // a real, checkable hash
```

It is the same shape, and the same admission rule, as
[`KNOWN_FACILITATORS`](/accepting-payments/facilitator-coverage/): **an entry earns its place
only after a real mainnet transaction settled through it.** Never from a documentation page.
A quote proves routing; only a transaction proves settlement.

That rule is not theoretical caution. The facilitator registry grew from capability reads,
nothing ever re-checked an entry, and two of eleven turned out to be dead hosts the SDK was
still handing to callers. Same failure mode, so the same guard.

## Proof: real mainnet swaps

**Sixteen swaps, eight chains, both tiers, both directions on every chain that has two.**
Each was executed with real money and verified by reading the transaction back from a public
node. The last one was run straight from [the committed example](https://github.com/piprail/piprail/tree/main/examples/basics/swap), so the documented flow is proven, not just the library. This is evidence, not a claim: every hash below is checkable right now.

### Tier 1: the ledger swaps (no third party)

| Chain | Swap | Transaction |
|---|---|---|
| Stellar | 0.2652 XLM → 0.05 USDC | [`f7b784d4…`](https://stellar.expert/explorer/public/tx/f7b784d4758ea83a022921c7202051b4643fefb4fa61530a49010a4a9348a0aa) |
| Stellar | 0.1591 XLM → 0.03 USDC | [`1c1bbaaa…`](https://stellar.expert/explorer/public/tx/1c1bbaaa299d22754dee1bdbb9537da30d3a53cbbe72187d23297ab2c4a213cd) |
| Stellar | **USDC → 0.2 XLM** (reverse) | [`3aa2ca9e…`](https://stellar.expert/explorer/public/tx/3aa2ca9e35ff7d7c3d0aaff3b24d53b4d2ea009067debf058c30ed8cad445f03) |
| Stellar | 0.1064 XLM → 0.02 USDC, **run from the committed example** | [`27f50b2c…`](https://stellar.expert/explorer/public/tx/27f50b2c2c57a64a8b50c1b14f310ec99b4ccbbb4bc72c479a5f6f9f1180e385) |
| XRP Ledger | 0.072 XRP → 0.1 RLUSD | [`F703B271…`](https://xrpscan.com/tx/F703B271E35BD3C2408DB64F693461513DD5166C15EC61DBAB0B2A9F726ED97E) |
| XRP Ledger | 0.0357 XRP → 0.05 RLUSD | [`F124BAA0…`](https://xrpscan.com/tx/F124BAA032C6BA06DA05D66AD9FDA6F964EE32AD7273DFC34FBCF6BAEF54F150) |
| XRP Ledger | **RLUSD → 0.02 XRP** (reverse) | [`24EC9DDD…`](https://xrpscan.com/tx/24EC9DDD2B5D00FD7CD56882999FCF59ABC274AA32E35119EADE397B335EEB63) |

The Stellar operations record as `path_payment_strict_receive` with **source and destination
the same account**, which is what makes them self-swaps. The XRPL ones report
`delivered_amount` exactly equal to the amount asked for, with `SendMax` honoured.

### Tier 2: a named third-party router

| Chain | Swap | Provider | Transaction |
|---|---|---|---|
| Solana | 0.1031 USDC → 0.001 SOL | Jupiter | [`2rXpQYVe…`](https://solscan.io/tx/2rXpQYVerRzrwUfmXMYcm6ijkm8x7LHU91onSZjrng34kr1nfcxZj1A8Ek7inSw7ZBzk3phAaYnvHwdSJTKxJ4rq) |
| Solana | **0.000485 SOL → 0.05 USDC** (reverse) | Jupiter | [`UEeXBp3s…`](https://solscan.io/tx/UEeXBp3sPZgEHmahMasAbFhbTootXGCcpoNh7bN1sWsjoPDc1QE7uGaHjivT3iTroxLVJeWGVp2jZT63d2BVTk5) |
| Solana | 0.0823 USDC → 0.0008 SOL | Jupiter | [`5kPFYdAY…`](https://solscan.io/tx/5kPFYdAYUxtEwmSCQSS84TmfbKcihwFL81HsTVQEjk6y5oSBZsZFPyYVED9VV3wj5gaVrrL5ZCu5WSPwxSbBjrqG) |
| BNB Chain | 0.0101 USDT → USDC | KyberSwap | [`0x1748b6b2…`](https://bscscan.com/tx/0x1748b6b27b1920aafd1d2730d250378b08cd4c0851a29e5e785dea960e0c8d4d) |
| BNB Chain | 0.0505 USD1 → USDT | KyberSwap | [`0xb3608208…`](https://bscscan.com/tx/0xb360820833941bbf7626970cb03c68168c415c71738222a3b1856cbffe60c61f) |
| BNB Chain | **native BNB → 0.02 USDC** (no approval path) | KyberSwap | [`0xe27f957b…`](https://bscscan.com/tx/0xe27f957b40285acf0b846aea23808d49cc6a44fccd755aa88656abf31204fb00) |
| Robinhood Chain | **native ETH → 0.360518 USDG** | KyberSwap | [`0x424299e6…`](https://robinhoodchain.blockscout.com/tx/0x424299e67be623313c679e659fbfe9fb8707800fe145cddf7fac5a9bdbb78f10) |
| Aptos | 0.049997 USDC → **exactly 0.05 USDT** | Hyperion | [`0x927293cf…`](https://explorer.aptoslabs.com/txn/0x927293cf8584320f1e265c564ab3096262b675a61996e0da955a2b3c27af1adc) |
| Aptos | 0.040012 USDT → **exactly 0.04 USDC** (reverse) | Hyperion | [`0xae849e03…`](https://explorer.aptoslabs.com/txn/0xae849e031cb50a660f8c9f286c1f3a9caeff08b427efd9428154d884f1e3059e) |
| Aptos | 0.0459 APT → **exactly 0.03 USDC** (native in) | Hyperion | [`0x7921118d…`](https://explorer.aptoslabs.com/txn/0x7921118d64ce1e4ebe7911ed22fef2222597e1b9e20caf0fd4f89bce07c07981) |
| Aptos | 0.012842 USDC → **exactly 0.02 APT** (native out) | Hyperion | [`0x640bce4b…`](https://explorer.aptoslabs.com/txn/0x640bce4b1e5f688d4494d0c343247b2951d22bc26d371b81f7d2c04655a7a707) |
| TON | 0.035528 TON → **0.05 USDT** | STON.fi | [`1f6d58d0…`](https://tonviewer.com/transaction/1f6d58d073bd988b47272658297ebabc4748725ca919a4a9c863f28cef8eeb3f) |
| TON | 0.028171 USDT → **0.02 TON** (reverse, different router version) | STON.fi | [`f76ae97e…`](https://tonviewer.com/transaction/f76ae97e107b7852ea105d3b3b0caf095ec77bd2541f40417303c08566a87947) |
| Base | 0.00117 USDC → EURC | KyberSwap | [`0xb28b802f…`](https://basescan.org/tx/0xb28b802f530945eba1ea1662890792bfa1dfba64f5094caa58297f9693604032) |
| Base | **EURC → USDC** (reverse) | KyberSwap | [`0x99a0842c…`](https://basescan.org/tx/0x99a0842cd6c3fb33ddc03ddf776c2981c629debcd8ac47678a2e5e29e4496242) |
| Sui | 0.0657 SUI → 0.0505 USDC | Aftermath | [`GtykrnLx…`](https://suiscan.xyz/mainnet/tx/GtykrnLxejyrjmTL8oKVoEtTAiP9eY69CGne7Djw3Cha) |
| NEAR | 0.0505 USDT → 0.05 USDC | Ref Finance | [`FAb28z1t…`](https://nearblocks.io/txns/FAb28z1tCcecd2teFTxJGkgaLMr1mpctuiFhUeCKjszT) |
| Algorand | 0.5094 ALGO → 0.05 USDC | Vestige | [`5UV7SWSJ…`](https://allo.info/tx/5UV7SWSJODHJDGMXODTOMBNXMK4YGZIZKR4VOM6XHML7JS7A32UA) |

Two different EVM chains share one implementation, which is what the 8-chain claim rests on,
and both the ERC-20 path (which needs an approval) and the native-in path (which does not)
are proven. The Sui transaction's on-chain balance changes match its quote exactly; the NEAR
swap settled across 14 receipts; the Algorand one is a four-transaction atomic group in which
every signer is the sender.

### Twelve real bugs that only live testing could find

Every one of these passed a typechecker and a unit suite first.

1. **Some tokens revert on a non-zero to non-zero ERC-20 `approve`.** A stale allowance then
   poisons every retry, surfacing far away as `TRANSFER_FROM_FAILED` inside the swap, which
   reads like a balance problem and is not one. The allowance is now zeroed first.
2. **XRPL path steps could not always be encoded.** `ripple_path_find` returns steps carrying
   extra `type`/`type_hex` fields that xrpl.js sometimes rejects with
   `Cannot construct UInt32 from given value`. Paths are now stripped to what the encoder
   accepts.
3. **XRPL public path finding is intermittent.** The identical request returns a route, then
   nothing a second later, with no error, while the route exists throughout. A single empty
   answer is not evidence of no route, so it is now tried twice.
4. **XRPL float precision silently discarded valid routes.** Issued amounts carry up to 16
   significant digits while our base-unit convention is fixed, so a real quote of
   `0.02789866666666666` RLUSD threw and the whole direction looked unsupported. It is now
   parsed with a ceiling, rounding up so the cap always covers the spend.
5. **A malformed Stellar issuer threw out of a never-throw method**, and one unparseable
   Horizon candidate sitting first in the list poisoned an otherwise valid quote. Both found
   by adversarial tests, both fixed.
6. **Setting `accept-encoding` by hand broke NEAR entirely.** Ref's indexer serves gzip, and
   the fetch runtime decompresses automatically only when it owns that header. Setting it
   manually returned a still-compressed body, `JSON.parse` threw, and the whole family
   reported "no swap support" while its pools quoted fine by hand.
7. **NEAR pool ids are strings in the indexer and numbers on the contract.** Passing `"6416"`
   through unconverted made every `get_return` call error, which again looked exactly like
   "this chain cannot swap".
8. **Vestige returns `amount_out: 0` for a dust probe** rather than an error. A fixed probe
   size of 0.01 ALGO therefore reported no route on a pair that routes perfectly at 0.1 ALGO.
   The probe now escalates until the aggregator gives a real answer.
9. **Sui's public JSON-RPC is being deprecated**, so the obvious verification endpoint
   returns "Method not found". The SDK already routes around this with a third-party RPC;
   the finding is that any tooling still pointing at `fullnode.mainnet.sui.io` will break.
10. **A mined transaction was being read as a successful swap.** On EVM a reverted swap still
    produces a receipt, and on Solana a submitted signature is not a confirmed one, so both
    drivers returned a `SwapReceipt` for a swap that moved nothing and only burned gas. Both
    now assert the chain's own outcome, and [`ERRORS.md`](https://github.com/piprail/piprail/blob/main/sdk/ERRORS.md)
    makes it part of the driver contract.
11. **Two shipped TON proofs pointed at the wrong transaction.** STON.fi refunds unused
    forward gas to the same wallet a second after the swap, and the driver reported whichever
    transaction was newest, so the recorded reference was an *incoming* refund with no
    outgoing message. The swaps were real; the evidence pointed at the wrong leg. The driver
    now takes the transaction the wallet itself signed, and `npm run verify:proofs` rejects a
    reference of the wrong shape.
12. **Tron could not have swapped a token at all.** SunSwap V2's router moves the input with
    `transferFrom` and there was no approve step, so selling native TRX worked while every
    TRC-20 direction would have failed on allowance. Nothing caught it because that route
    ships without a mainnet proof. Adding the approve then surfaced a second one: a fresh
    allowance slot measured 99,764 energy, which at 100 sun is 9.98 TRX, and the ceiling had
    been set to 10 TRX because "an approve is cheap".

Four of those twelve made an entire chain family look unsupported when it was not, and three
reported success for something that had not happened. None would have been caught by a
typechecker or a unit suite.

### A known failure, recorded rather than hidden

**FDUSD to USDC on BNB Chain reverts** with `TRANSFER_FROM_FAILED`, and we have not found out
why. Balance and allowance were both confirmed sufficient by direct on-chain reads, and
neither zeroing the allowance nor re-approving the build step's router fixed it. Every other
pair on the same chain and code path works.

It is listed because a table showing only successes is marketing, not evidence. If you hit
this pair the SDK fails cleanly: nothing is swapped, and only the gas for the reverted transaction is lost.

## What we deliberately did not build

We surveyed the cross-chain bridge and swap aggregators, including thirdweb Bridge, LI.FI,
Squid, Relay, deBridge, Across and Rango. None is bundled, and none is a default.

Every candidate was probed live from a plain server request on 2026-09-08, with no key and
no browser headers, because documentation is not evidence:

| Aggregator | Result | Verdict |
|---|---|---|
| KyberSwap | HTTP 200 | ✅ **adopted** |
| Jupiter | HTTP 200, `platformFee: null` | ✅ **adopted** |
| Cetus (Sui) | HTTP 200 | candidate, not yet implemented |
| 0x | HTTP 401 `No API key found in request` | rejected |
| 1inch | HTTP 401 `Unauthorized` | rejected |
| Odos | HTTP 530 (Cloudflare 1033) | rejected |
| OpenOcean | HTTP 403 (Cloudflare challenge) | rejected |
| Squid | HTTP 400 `x-integrator-id header is missing` | rejected |
| Rango | HTTP 401 | rejected |
| thirdweb Bridge | HTTP 401 | rejected |

An endpoint that bot-blocks a plain server request is not a headless integration target,
however good its documentation is.

Taking thirdweb Bridge as the worked example, since it is the most frequently suggested:

- **An API key is required at the type level.** Its client cannot be constructed without
  one, and an unauthenticated request returns `401`. Free is not the same as keyless, and a
  signup is an account relationship, which is precisely what PipRail exists to avoid.
- **A 0.30% protocol fee applies** and an integrator cannot switch it off.
- **It is EVM-only for cross-chain routing.** Its own API types chain identifiers as
  integers, so nine of the ten families PipRail supports cannot even be expressed.

None of that makes it a bad product. It makes it the wrong shape for a zero-fee, keyless,
self-custody SDK.

The `quoteSwap`/`swap` contract is deliberately provider-shaped, so a third party **can** be
added later. If one ever is, it will arrive the way facilitators did: named openly, marked
`kind: 'provider'`, opt-in, and listed with what has actually been proven rather than what
is advertised.

## Related

- **[Swap coverage on piprail.com](https://piprail.com/swaps)** is the same registry as a
  browsable directory: every route indexed by chain as well as by venue, with all 21 transaction
  hashes. Generated from `SWAP_PROVIDERS`, so it cannot disagree with the table above.
- [Plan a payment](/making-payments/plan-payment/) shows *why* a payment is not payable.
- [Multi-chain buying](/making-payments/multi-chain/) pays from whichever chain you already
  hold funds on, which often removes the need to swap at all.
- [Facilitator coverage](/accepting-payments/facilitator-coverage/) is the same
  opt-in-third-party pattern applied to settlement.
