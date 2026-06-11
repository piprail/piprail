# PipRail × Fetch Agent Payment Protocol (APP)

**PipRail as the stablecoin settlement engine under Fetch's own agent-to-agent payment protocol.**

Fetch's [Agent Payment Protocol](https://uagents.fetch.ai/docs/guides/agent-payment-protocol) (APP) is a
uAgents *message* spec — a payee asks for payment, a payer commits, the payer completes with proof. It
standardizes the **negotiation** and delegates **settlement** to a `payment_method`. Fetch ships `skyfire`
and `fet_direct`; **there is no native stablecoin pay-per-call rail.** This example adds one: **`x402`**
(a.k.a. `piprail`) — backendless, multi-chain, no-fee, settled straight to the payee's wallet and verified
locally against their own RPC.

> **Fetch keeps owning the negotiation. PipRail becomes the settlement it delegates to.**

---

## Why this matters on BNB (the gasless headline)

PipRail is fully native on **BNB Chain** (the chain Agent Launch / Fetch tokens live on), with **three**
rails — and one makes agent-to-agent payments **gasless for both sides**:

| Rail | BNB tokens | Buyer gas | Seller gas |
|---|---|---|---|
| `onchain-proof` | USDC · USDT · FDUSD · USD1 · native BNB | buyer broadcasts | none |
| `exact` (Permit2) | USDC · USDT *(Binance-Peg, no EIP-3009)* | **none** (signs) | seller **or facilitator** |
| `exact` (EIP-3009) | **FDUSD · USD1** | **none** (signs) | seller **or facilitator** |

So a Fetch agent can pay another Fetch agent in **FDUSD/USD1 on BNB where neither side pays gas** — the
buyer signs an EIP-3009 authorization (free, no Permit2 approve) and a facilitator broadcasts it. That's
exactly the "agents can't manage gas/billing" pain the BNB Agent Survival Pack named — solved.

---

## The mapping (APP ⇄ x402)

x402 **is** the rail; APP is the negotiation wrapper around it. The payee gates a resource with PipRail; the
payer settles it; the payee's own gate verifies the proof locally and serves the result. No facilitator
required for the default rail, no out-of-band verify.

```
Payee agent →  RequestPayment{ amount, currency: "FDUSD", payment_method: "x402",
                               reference: <PipRail-gated resource URL> }
Payer agent →  piprail_pay_request(url=reference)  via @piprail/mcp   (budget-bound; cannot overspend)
            →  the payee's PipRail gate verifies LOCALLY + serves the result in the 402 body
            →  CompletePayment{ reference, proof: <x402 receipt {transaction, network, asset, amount, payTo}> }
Payee agent →  its gate already settled → done. (CompletePayment is the receipt of record.)
```

The bridge to settlement is the **`@piprail/mcp`** server on the payer side (it has the budget-bound wallet
+ the `piprail_pay_request` tool) and **`@piprail/sdk`**'s own gate on the payee side. **No change to
`@piprail/sdk` — this is an adapter + example.**

---

## Files

| File | Role | Runtime |
|---|---|---|
| [`protocol.py`](./protocol.py) | the APP message models + `payment_method = "x402"` | uAgents |
| [`piprail_bridge.py`](./piprail_bridge.py) | **the bridge** — stdlib MCP stdio client → `piprail_pay_request` | **stdlib only** |
| [`merchant.mjs`](./merchant.mjs) | the payee's PipRail gate (the x402 resource) | Node + `@piprail/sdk` |
| [`payer_agent.py`](./payer_agent.py) | payer uAgent — settles via the bridge | uAgents |
| [`payee_agent.py`](./payee_agent.py) | payee uAgent — fronts the gate, finalizes | uAgents |

---

## Run it

### 1. Verify the two PipRail halves first (no uAgents, no funds needed)

These two are **fully runnable today** and prove the wiring before any Agentverse setup:

```bash
# (a) the settlement bridge handshakes with the real @piprail/mcp and finds the pay tool
python3 piprail_bridge.py
#   → ✓ bridge handshake OK — piprail_pay_request is callable

# (b) the payee gate serves a real 402 on BNB with FDUSD
npm install
PIPRAIL_CHAIN=bnb MERCHANT_TOKEN=FDUSD PAY_TO=0xYourWallet… npm run merchant
curl http://127.0.0.1:4021/offer     # → the RequestPayment fields
curl -i http://127.0.0.1:4021/service  # → 402 + payment challenge (FDUSD, eip155:56)
```

### 2. The full APP round-trip (needs `uagents` + funds)

```bash
cp .env.example .env          # set PIPRAIL_PRIVATE_KEY (funded), PAY_TO, etc.
pip install -r requirements.txt

# terminal 1 — the payee's PipRail gate:
PIPRAIL_CHAIN=bnb MERCHANT_TOKEN=FDUSD PAY_TO=0xYourPayee… npm run merchant

# terminal 2 — the payer agent (prints its address on startup):
PIPRAIL_PRIVATE_KEY=0x… PIPRAIL_CHAIN=bnb python3 payer_agent.py

# terminal 3 — the payee agent (paste the payer's address):
PAYER_ADDRESS=agent1q… python3 payee_agent.py
```

The payee requests `0.05 FDUSD`; the payer settles it over x402 (gasless EIP-3009 signature on BNB); the
gate verifies locally and serves the result; the payer returns `CompletePayment` with the tx proof.

> **What's verified in this repo:** the bridge handshake (a) and the live BNB 402 (b) above. The full
> Agentverse round-trip (step 2) needs `pip install uagents` and a registered agent — that's the demo agent
> in [Phase 4](../../.claude/plans/agent-launch/04-agentverse-demo-agent.md). Settlement itself (the
> `exact`/Permit2/EIP-3009 rails on BNB) is live-proven on mainnet — see the SDK CHANGELOG `1.16.0`.

---

## Upstream proposal

The co-marketing hook is a short proposal to Fetch to recognize `x402` (a.k.a. `piprail`) as an APP
`payment_method` — **led by the BNB gasless-FDUSD/USD1 story**. Coordinate via the deal contact. See
[`.claude/plans/agent-launch/03-fetch-app-payment-method.md`](../../.claude/plans/agent-launch/03-fetch-app-payment-method.md).

## Notes & limits

- **Security:** keys live in `env` only; the bridge never logs a key and only `piprail_pay_request` moves
  money, capped by the MCP's spend policy.
- **Hosted Agents** that can't spawn a child process: run `@piprail/mcp` as an external sidecar the agent
  reaches over a local socket (see Phase 4).
- **Mapping B** (the service result rides uAgents instead of the x402 body, with PipRail paying a bare
  inline `accept`) is possible but heavier — lead with the resource-bound mapping above.

→ Full docs: **[docs.piprail.com/integrations/fetch-agent-payment-protocol](https://docs.piprail.com/integrations/fetch-agent-payment-protocol/)**
