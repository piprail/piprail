# Testing the integrations

How to be sure each integration actually works before (and after) you ship it. There are **two
layers** — run the automated one always; do the manual one once per framework as the final sign-off.

| Framework | Automated test | Real-app run | Status |
|---|---|---|---|
| **OpenClaw** | [`piprail/verify.mjs`](./piprail/verify.mjs) | [§ Manual OpenClaw run](#manual-openclaw-run) | ✅ passing |
| _Vercel AI SDK · Mastra · ElizaOS_ | _add `verify.mjs` per folder_ | _per framework_ | planned |

> **Pattern (so this scales):** every integration keeps its own `verify.mjs` next to its code. Adding a
> framework = add `integrations/<framework>/verify.mjs` + a row above. Tests live with what they test.

---

## Layer 1 — the automated harness (run this always)

Each integration ships a **zero-dependency `verify.mjs`** that does *exactly what the framework does*:
it spawns the PipRail MCP server the way the framework's config spawns it (same `command`/`args`/clean
`env`) and drives the tools over the MCP wire protocol. **If it passes, every tool the framework
exposes works.**

```bash
cd integrations/openclaw/piprail

node verify.mjs                                    # offline: handshake + all 7 tools + read-only calls
node verify.mjs --live                             # + quote the LIVE demo + prove the spend cap
PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live   # test the local build instead of npm
```

What `--live` proves (no funds move — throwaway key, and it asserts a *refusal*):

1. **Protocol** — the server handshakes and serves the 7 `piprail_*` tools with valid JSON schemas.
2. **Live quote** — `piprail_quote_payment("https://piprail.com/x402/demo")` reads a **real 402** and
   returns the real price (0.01 USDC on Base).
3. **Budget enforcement** — with a cap *below* the price, `piprail_pay_request` is **refused by policy**
   before any on-chain send. This is the safety guarantee: the model **cannot** overspend.

**Honest scope:** the harness can't run the framework's own LLM loop (deciding *when* to call a tool —
that's the framework's job, and it's non-deterministic). It proves the half we own: the tools, the
wiring, the budget. The other half is Layer 2.

---

## Layer 2 — the real app run (final sign-off, once per framework)

<a id="manual-openclaw-run"></a>
### Manual OpenClaw run

1. **Install OpenClaw** (see [openclaw.ai](https://docs.openclaw.ai)). Confirm `openclaw --version`.
2. **Add PipRail as an MCP server.** Edit `~/.openclaw/openclaw.json` — OpenClaw nests servers under
   **`mcp.servers`** (see [`piprail/openclaw.json`](./piprail/openclaw.json)):

   ```json
   { "mcp": { "servers": { "piprail": {
     "command": "npx", "args": ["-y", "@piprail/mcp"],
     "env": { "PIPRAIL_PRIVATE_KEY": "0xYOUR_KEY", "PIPRAIL_CHAIN": "base", "PIPRAIL_MAX_TOTAL": "5.00", "PIPRAIL_TOKENS": "USDC" }
   } } } }
   ```

   (or `openclaw mcp set` / `clawhub install piprail`). Use a wallet with a **tiny** USDC +
   gas balance on Base for a real payment.
3. **Restart OpenClaw** and confirm the tools loaded — `openclaw mcp list` should show `piprail`, and
   the agent's tool list should include the seven `piprail_*` tools.
4. **Drive the agent** (the real test):
   - *"What's the price of `https://piprail.com/x402/demo`?"* → it calls `piprail_quote_payment` and
     reports **0.01 USDC on Base**.
   - *"Can I afford it?"* → `piprail_plan_payment` reports payable + remaining budget.
   - *"Pay for it and show me the result."* → `piprail_pay_request` settles on-chain and returns the
     200 body + a receipt (tx hash). Verify the tx on [basescan.org](https://basescan.org).
   - *"What's my budget?"* → `piprail_budget` shows the spend so far.
5. **Prove the cap in-app** — set `PIPRAIL_MAX_TOTAL` below the demo price, restart, and ask it to pay:
   it should refuse, no funds moved. (Layer 1 already proves this automatically.)

### Sign-off checklist

- [ ] `node verify.mjs --live` passes (protocol + live quote + budget refusal).
- [ ] OpenClaw lists the 7 tools after adding the `mcp.servers` entry.
- [ ] The agent quotes, plans, and **pays the live demo** end-to-end (real tx on Base).
- [ ] A below-price cap makes the agent refuse — no funds move.

---

*All of this runs locally with your own wallet and your own RPC — no backend, no facilitator, no fee.
The automated harness needs no funds; only the optional real on-chain payment in Layer 2 does.*
