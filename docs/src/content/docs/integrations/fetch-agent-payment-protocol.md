---
title: Fetch Agent Payment Protocol
description: Use PipRail as the stablecoin settlement engine under Fetch.ai's Agent Payment Protocol (APP) for uAgents — a backendless, multi-chain x402 payment_method. On BNB, agent-to-agent payments are gasless for both sides.
sidebar:
  order: 1
---

[Fetch.ai's Agent Payment Protocol](https://uagents.fetch.ai/docs/guides/agent-payment-protocol) (APP)
is a [uAgents](https://fetch.ai/docs) message spec: a payee asks for payment, a payer commits, the payer
completes with proof. It standardizes the **negotiation** between agents and delegates **settlement** to a
`payment_method`. Fetch ships `skyfire` and `fet_direct` — there is **no native stablecoin pay-per-call
rail**. PipRail fills that slot with **`x402`** (a.k.a. `piprail`): backendless, multi-chain, no-fee,
settled straight to the payee's wallet and verified locally against their own RPC.

> **Fetch keeps owning the negotiation. PipRail becomes the settlement it delegates to** — for the whole
> Agentverse agent population, with no backend and no facilitator required.

The runnable adapter lives in [`examples/fetch-app/`](https://github.com/piprail/piprail/tree/main/examples/fetch-app).

## x402 is the rail; APP is the wrapper

You don't bolt a new settlement protocol onto APP — you point APP at an x402 resource and let the existing
PipRail round-trip do the work. The payee gates a resource with PipRail; the payer settles it; the payee's
**own gate verifies the proof locally and serves the result**. Nothing verifies a proof out-of-band.

```text
Payee agent →  RequestPayment{ amount, currency: "FDUSD", payment_method: "x402",
                               reference: <PipRail-gated resource URL> }
Payer agent →  piprail_pay_request(url=reference)  via @piprail/mcp   (budget-bound; cannot overspend)
            →  the payee's PipRail gate verifies LOCALLY + serves the result in the 402 body
            →  CompletePayment{ reference, proof: <x402 receipt> }
Payee agent →  its gate already settled → done. (CompletePayment is the receipt of record.)
```

| APP field | Maps to |
|---|---|
| `payment_method: "x402"` | settle over PipRail / x402 |
| `currency` | the token symbol — `USDC` · `USDT` · `EURC` · `FDUSD` · `USD1` · … |
| `reference` | the URL of a PipRail-gated resource (`requirePayment`/`createPaymentGate`) |
| `CompletePayment.proof` | PipRail's x402 receipt — `{ transaction, network, asset, amount, payer, payTo, verifiedAt }` |

## Two pieces, no SDK change

The bridge is an **adapter + example**, not a change to `@piprail/sdk`. The SDK stays a pure TypeScript
library; the bridge to Python uAgents rides two things you already have:

- **Payer side — [`@piprail/mcp`](/mcp/overview/).** The MCP is a language-agnostic, budget-bound wallet.
  The payer agent drives it over stdio and calls `piprail_pay_request(url)` to settle. The spend policy
  (`PIPRAIL_MAX_AMOUNT` / `PIPRAIL_MAX_TOTAL` / the token + chain allowlist) is enforced before any send —
  the agent literally cannot overspend. See [Use the MCP as a settlement engine](/mcp/use-as-a-library/).
- **Payee side — [`@piprail/sdk`](/accepting-payments/require-payment-and-gate/).** The payee fronts a normal PipRail gate
  (`requirePayment`). Verification is local, against its own RPC — there is **no `piprail_verify` tool and
  no facilitator** in the loop for the default rail.

A small stdlib-only Python bridge (`piprail_bridge.py`) speaks MCP JSON-RPC to `@piprail/mcp`; the two demo
uAgents (`payer_agent.py`, `payee_agent.py`) use it.

## Why BNB makes this compelling: gasless agent-to-agent

PipRail is fully native on **BNB Chain** (where Agent Launch / Fetch tokens live), with three rails — and
one makes the whole exchange **gasless for both sides**:

| Rail | BNB tokens | Buyer gas | Seller gas |
|---|---|---|---|
| `onchain-proof` | USDC · USDT · FDUSD · USD1 · native BNB | buyer broadcasts | none |
| `exact` (Permit2) | USDC · USDT *(Binance-Peg — no EIP-3009)* | none (signs) | seller **or facilitator** |
| `exact` (EIP-3009) | **FDUSD · USD1** | none (signs) | seller **or facilitator** |

On **FDUSD / USD1** the buyer signs an EIP-3009 `transferWithAuthorization` — no gas, **no Permit2
approve** — and a facilitator broadcasts it, so neither agent pays gas. That is exactly the "agents can't
manage gas and billing keys" problem the BNB Agent Survival Pack named. See
[Permit2 & BNB Chain](/making-payments/permit2-and-bnb/) for the full mechanics.

## Run it

Two halves run today with no uAgents and no funds — they prove the wiring end to end:

```bash
# 1) the settlement bridge handshakes with the real @piprail/mcp and finds the pay tool
python3 piprail_bridge.py
#   → ✓ bridge handshake OK — piprail_pay_request is callable

# 2) the payee gate serves a real 402 on BNB with FDUSD
npm install
PIPRAIL_CHAIN=bnb MERCHANT_TOKEN=FDUSD PAY_TO=0xYourWallet… npm run merchant
curl -i http://127.0.0.1:4021/service   # → 402 + payment challenge (FDUSD, eip155:56)
```

The full APP round-trip (the two uAgents) needs `pip install uagents` and a funded payer key — that's the
[demo agent in Phase 4](https://github.com/piprail/piprail/tree/main/examples/fetch-app). Settlement itself
(the Permit2 / EIP-3009 rails on BNB) is live-proven on mainnet — see the SDK `1.16.0` changelog.

## Notes & limits

- **Hosted Agents** that can't spawn a child process: run `@piprail/mcp` as an external sidecar the agent
  reaches over a local socket.
- **Custom `payment_method`:** confirm whether Fetch accepts `x402` as-is or needs to allow-list it — part
  of the upstream proposal.
- **Mapping B** (the result rides uAgents and PipRail pays a bare inline `accept`) is possible but heavier;
  lead with the resource-bound mapping above.

## See also

- [`@piprail/mcp` overview](/mcp/overview/) · [Use as a library / settlement engine](/mcp/use-as-a-library/)
- [Permit2 & BNB Chain](/making-payments/permit2-and-bnb/) — the gasless mechanics
- [requirePayment & createPaymentGate](/accepting-payments/require-payment-and-gate/) — the payee gate
