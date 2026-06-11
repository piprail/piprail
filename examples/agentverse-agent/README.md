# PipRail Pay — a self-funding x402 agent for Agentverse

**A verified Agentverse agent that earns over x402 and spends over x402** — the "face" of the
PipRail rail (and the subject of the Agent Launch token in Phase 5). It's an x402 **payment
concierge**: you pay it a small USDC fee, it pays any x402 URL on your behalf with a budget-bound
wallet, and relays the unlocked result back.

> Earn + spend, both x402, no backend, no custody. The only thing the market rewards is an agent
> that *actually does something* — this one funds itself.

## Proven live on mainnet

The full earn → spend loop, settled on real chains (tiny amounts, funds stay in the test wallets):

- **EARN** — a caller paid the relay's fee gate, **0.02 USDC on BNB** → tx `0x7602a59abd180204e974345a3c4e4576641590ed52afe8d4e124b0d6b50d9333`
- **SPEND** — the relay then paid the live [piprail.com/x402/demo](https://piprail.com/x402/demo), **0.01 USDC on Base** → tx `0x70bd504d277bb12197003a92b8059c40a3c178666a288c3db90b8aac0ed3308c`
- The demo's `{ paid: true, … }` content was relayed back through the agent. ✅

(Reproduce with the gitignored `agentverse-live.local.mjs` against your own funded wallet.)

## How it works

```
caller ──pay fee (USDC)──▶  PipRail Pay /pay gate   (EARN — requirePayment, verified locally)
                                  │
                                  ├─ budget-bound PipRailClient pays the target x402 URL  (SPEND)
                                  │
caller ◀── unlocked result ──────┘
```

The relay (`relay.mjs`) holds both PipRail sides. The fee gate **earns**; a `PipRailClient` with a
spend `policy` it cannot exceed **spends**. An allow-list keeps it from being an open relay. Earn
and spend can be on different chains (here: earn on BNB, spend on Base).

## Files

| File | Role |
|---|---|
| [`relay.mjs`](./relay.mjs) | the paid x402 relay — the agent's engine (Node + `@piprail/sdk`) |
| [`agent_readme.md`](./agent_readme.md) | the Agentverse discovery profile (ranks the agent; the Phase 5 token is created against the agent's `agent1q…` address) |
| [`register.py`](./register.py) | registers the relay's public URL on Agentverse (`fetchai` SDK) |
| [`asi_chat_agent.py`](./asi_chat_agent.py) | optional ASI:One chat front-end (natural language → the relay) |

## Run the relay (the part that works today)

```bash
npm install
PAY_TO=0xYourFeeWallet RELAY_PRIVATE_KEY=0xYourSpendKey \
  RELAY_GATE_CHAIN=bnb RELAY_PAYER_CHAIN=base RELAY_ALLOW_HOSTS=piprail.com \
  npm run relay

curl http://127.0.0.1:4031/agent                                  # free agent card
curl -i "http://127.0.0.1:4031/pay?url=https://piprail.com/x402/demo"   # 402 fee challenge
```

## Go live on Agentverse (the human steps)

These need an account + a public deploy — they can't be scripted here:

1. **Agentverse account** → copy your `AGENTVERSE_KEY` (the same key links Agent Launch in Phase 5).
2. **Deploy `relay.mjs`** somewhere public (its URL = `RELAY_PUBLIC_URL`); fund the spend wallet
   with a little USDC + gas, and set `PAY_TO` to your fee wallet.
3. **Register:** `pip install -r requirements.txt`, set `AGENT_SECRET_KEY` (a random seed, keep it
   in `.secrets`) + `AGENTVERSE_KEY`, then `python3 register.py`.
4. **(Optional) ASI:One chat:** `python3 asi_chat_agent.py` to make it talk in natural language.
5. Confirm it's discoverable on the [Agentverse marketplace](https://agentverse.ai) + ASI:One, and
   accruing real uptime/request stats — those feed the Phase 5 token card.

## Notes

- **Charter:** this is an *example agent built on the open SDK*, exactly like any third party would
  — `@piprail/sdk` stays token-free and fee-free. The agent (and any future token) lives on its own
  side of the brand wall.
- **Hosting:** Agentverse Hosted Agents run a limited Python stdlib and can't run Node, so deploy
  `relay.mjs` as an **External Agent** (your host) — the registration points Agentverse at its URL.

→ Full guide: **[docs.piprail.com/integrations/agentverse-uagents](https://docs.piprail.com/integrations/agentverse-uagents/)**
