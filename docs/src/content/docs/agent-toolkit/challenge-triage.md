---
title: Challenge triage
description: classifyChallenge() reads a 402 and tells you why it might be unpayable — wrong chain, a scheme you haven't enabled, or actually payable.
sidebar:
  order: 5
---

## Introduction

When a 402 can't be paid, *why* matters: "you're on the wrong chain" and "this rail uses a
scheme you haven't turned on" need different fixes, yet a single `NO_COMPATIBLE_ACCEPT` hides
both. `classifyChallenge` triages an x402 challenge into one of four plain verdicts so an agent
(or a human reading its logs) knows which lever to pull.

It is a **pure, never-throwing read** — no chain libraries, no I/O. You feed it a challenge you
already parsed plus your client's bound network and enabled schemes, and it buckets the offered
rails.

## Basic use

Parse the 402 with [`parseChallenge`](/reference/wire-codecs/), then classify it against the
chain and schemes you can settle. `parseChallenge` returns `X402Challenge | null` (`null` when
the response wasn't a readable x402 challenge), so null-guard it before classifying:

```ts
import { parseChallenge, classifyChallenge } from '@piprail/sdk'

const res = await fetch('https://api.example.com/report')   // a 402
const challenge = await parseChallenge(res)
if (!challenge) return        // not an x402 challenge — nothing to triage

const triage = classifyChallenge(challenge, {
  network: 'eip155:8453',          // your bound chain, CAIP-2
  schemes: ['onchain-proof'],      // the schemes you've enabled
})

console.log(triage.verdict)        // → 'WRONG_CHAIN'
// → { onClientChain, payableScheme, offeredSchemes, offeredNetworks, verdict }
```

## The four verdicts

`triage.verdict` is one word — branch on it:

| Verdict | Meaning |
| --- | --- |
| `PAYABLE_RAIL` | At least one rail is on your chain **and** uses a scheme you've enabled. |
| `UNPAYABLE_SCHEME` | A rail is on your chain, but only via a scheme you haven't enabled. |
| `WRONG_CHAIN` | Rails exist, but none on your chain. |
| `NO_RAIL` | The challenge offers no rails at all. |

The fix follows directly from the verdict: `UNPAYABLE_SCHEME` means enable the scheme (for
example, add `'exact'` — see the [exact buyer](/making-payments/exact-buyer/) page);
`WRONG_CHAIN` means pay from a client on one of the offered networks; `NO_RAIL` means the
endpoint isn't asking for payment in a form you can read.

## The ChallengeTriage

The verdict is the headline; the rest of the struct is the evidence behind it.

```ts
interface ChallengeTriage {
  onClientChain: boolean       // any offered rail on your network?
  payableScheme: boolean       // any rail on your network using an enabled scheme?
  offeredSchemes: PaymentScheme[]   // distinct schemes the challenge offers
  offeredNetworks: Caip2[]          // distinct networks the challenge offers
  verdict: ChallengeVerdict
}
```

`offeredSchemes` and `offeredNetworks` are the most useful for messaging — they tell the agent
*what the endpoint actually wants*, which you can surface to the user or relay to a model:

```ts
if (triage.verdict === 'WRONG_CHAIN') {
  console.log(`This endpoint takes: ${triage.offeredNetworks.join(', ')}`)
}
```

## Options

```ts
classifyChallenge(challenge, { network, schemes })
```

| Option | Type | Purpose |
| --- | --- | --- |
| `network` | `Caip2` | The chain your client is bound to, e.g. `'eip155:8453'` or `'solana:…'`. |
| `schemes` | `readonly PaymentScheme[]` | The schemes you've enabled — `'onchain-proof'` and/or `'exact'`. |

The `schemes` you pass should match the schemes your
[`PipRailClient`](/making-payments/piprail-client/) is configured with. The default is
`['onchain-proof']`; pass `['onchain-proof', 'exact']` if your client also enables the standard
[`exact`](/making-payments/exact-buyer/) rail.

:::note
`classifyChallenge` only inspects scheme and network — it does **not** check balance, gas, or
recipient readiness. A `PAYABLE_RAIL` verdict means a rail is *eligible*, not that your wallet
can fund it. For the full settleability check, use
[`planPayment()`](/making-payments/plan-payment/).
:::

## Triage before planning

The two reads compose: `classifyChallenge` is the cheap, offline first pass that explains *why a
rail is or isn't a candidate*; [`planPayment()`](/making-payments/plan-payment/) is the on-chain
follow-up that says *whether you can actually fund the candidate*.

```ts
import { PipRailClient, parseChallenge, classifyChallenge } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY! },
})

const url = 'https://api.example.com/report'
const res = await fetch(url)              // a 402

const challenge = await parseChallenge(res)
if (!challenge) return                    // not an x402 challenge — nothing to triage

const triage = classifyChallenge(challenge, {
  network: 'eip155:8453',
  schemes: ['onchain-proof'],
})

if (triage.verdict !== 'PAYABLE_RAIL') {
  return triage.verdict          // wrong chain / scheme — no point reading the chain
}

const plan = await client.planPayment(url)
// only now do we touch RPC for balances, gas, recipient readiness
// → PaymentPlan | null
```

This ordering keeps the expensive, network-touching call off the path when the challenge was
never payable in the first place.
