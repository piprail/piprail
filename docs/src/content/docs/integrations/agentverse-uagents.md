---
title: Agentverse & uAgents
description: Give a Fetch.ai Agentverse uAgent a budget-bound x402 wallet with PipRail — earn over x402 behind a 402 gate and spend over x402 with a spend policy it cannot exceed. Includes the PipRail Pay reference agent, live-proven on mainnet.
sidebar:
  order: 2
---

PipRail turns a [Fetch.ai Agentverse](https://agentverse.ai) agent into a **self-funding** one: it
can **earn** (sell a service behind a PipRail 402 gate) and **spend** (pay other x402 endpoints with
a budget-bound wallet) — on-chain, in stablecoins, no backend, no custody. The reference agent,
**PipRail Pay**, does both and is live-proven on mainnet; its code is in
[`examples/agentverse-agent/`](https://github.com/piprail/piprail/tree/main/examples/agentverse-agent).

## The two halves

A uAgent is Python; `@piprail/sdk` is TypeScript. The clean split is to let PipRail (Node) own the
money and keep the agent's discovery surface in Python:

- **Earn** — front a PipRail gate ([`requirePayment`](/accepting-payments/require-payment-and-gate/))
  so callers pay a few cents in USDC to use the agent. Verified locally against your own RPC; settled
  straight to your wallet.
- **Spend** — give the agent a [`PipRailClient`](/making-payments/piprail-client/) with a
  [`policy`](/spend-controls/payment-policy/) (per-call + lifetime caps) it **cannot exceed**, so it
  can pay other x402 endpoints autonomously and safely.

Both are plain `@piprail/sdk`. For a Python-only agent, run the PipRail piece as a small Node sidecar
(the agent's webhook), or drive the language-agnostic [`@piprail/mcp`](/mcp/overview/) — the same
bridge as the [Fetch Agent Payment Protocol](/integrations/fetch-agent-payment-protocol/) integration.

## PipRail Pay — the reference agent

PipRail Pay is an **x402 payment concierge**: pay it a small fee and it pays any (allow-listed) x402
URL on your behalf, then relays the unlocked result. One process holds both PipRail sides:

```js
import { requirePayment, PipRailClient } from '@piprail/sdk'

// EARN — a DUAL-RAIL fee gate: payable by ANY x402 client (onchain-proof AND the
// standard `exact` rail), self-settled with the relay's own wallet (no facilitator);
// the method (EIP-3009 vs Permit2) is auto-selected per token.
const fee = requirePayment({
  chain: 'bnb', token: 'USDC', amount: '0.02', payTo: process.env.PAY_TO,
  exact: { settle: 'self', relayer: { privateKey: process.env.RELAY_PRIVATE_KEY } },
})

// SPEND — a budget-bound wallet it cannot overspend
const payer = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.RELAY_PRIVATE_KEY },
  policy: { maxAmount: '0.05', maxTotal: '5.00', tokens: ['USDC', 'USDT'] },
})

app.all('/pay', fee, async (req, res) => {
  const result = await payer.fetch(String(req.query.url), { autoRoute: true }) // pays the target
  res.json({ relayed: true, downstream: { status: result.status, body: await result.json() } })
})
```

Earn and spend can be on **different chains** (here: earn on BNB, spend on Base) — useful when a
caller holds USDC on one chain but the seller wants another. The dual-rail gate means the agent is
payable by the **whole** x402 ecosystem, not just PipRail-equipped clients.

### Proven live on mainnet

Every payment path settled on real chains, full earn → spend loop each time:

| Pay the relay via… | Method | Earn (BNB) | → Spend (Base) |
|---|---|---|---|
| `onchain-proof` | tx-proof | `0x7602a59abd…` | `0x70bd504d277b…` |
| `exact` — FDUSD | EIP-3009 (gasless buyer) | `0x54b324fc8a…` | `0xd9cde1bb5a…` |
| `exact` — USDC | Permit2 | `0x9ee00b58c5…` | `0x0d3031901b…` |

The demo's `{ paid: true, … }` content was relayed back through the agent every time — a self-funding
agent payable by any x402 client, end to end.

## Make it discoverable on Agentverse + ASI:One

Register the relay's public URL as a verified Agentverse identity (Python, the
[fetch.ai SDK](https://innovationlab.fetch.ai/resources/docs/agent-creation/sdk-creation)):

```python
from uagents_core.crypto import Identity
from fetchai.registration import register_with_agentverse

identity = Identity.from_seed(AGENT_SECRET_KEY, 0)   # seed in .secrets, never commit
register_with_agentverse(identity, RELAY_PUBLIC_URL + "/pay", AGENTVERSE_KEY, "PipRail Pay", README)
```

The `README` (markdown with badges, `<description>`, `<use_cases>`, `<payload_requirements>`) drives
ranking on the marketplace and ASI:One. The agent's resulting `agent1q…` **address** is what
[Agent Launch](https://agent-launch.ai) tokenizes — its `POST /api/agents/tokenize` takes that
`agentAddress` (authenticated by the **same** `AGENTVERSE_KEY`), plus a token `name` (≤32),
`symbol` (≤11), `description` (≤500), and `image` (a URL or `"auto"` to pull the Agentverse avatar).
So one key links both platforms; the rich README ranks the agent, and a concise token description is
set at tokenize. To make the agent answer in natural language, add the
[ASI:One chat protocol](https://uagents.fetch.ai/docs/examples/asi-1) (a thin front-end that forwards
to the relay — see `asi_chat_agent.py`).

:::note[Hosting]
Agentverse **Hosted Agents** run a limited Python stdlib and can't run Node, so deploy the PipRail
relay as an **External Agent** (your own host) and point the Agentverse registration at its URL.
:::

## Charter

This is an example agent built on the open SDK — exactly like any third party would build. **`@piprail/sdk`
stays token-free and fee-free**; the agent (and any token attached to it) lives on its own side of the
brand wall. The rail is neutral infrastructure; the agent is a customer of it.

## See also

- [requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/) — the earn side
- [PipRailClient](/making-payments/piprail-client/) + [Payment policy](/spend-controls/payment-policy/) — the spend side
- [Fetch Agent Payment Protocol](/integrations/fetch-agent-payment-protocol/) — PipRail as an APP `payment_method`
- [`@piprail/mcp`](/mcp/overview/) — the language-agnostic bridge for a Python-only agent
