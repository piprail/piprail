# Agent — auto-pay a 402

Two tiny scripts showing how an agent pays for what it fetches.

## Run

```bash
npm install
AGENT_KEY=0x… URL=https://api.example.com/report npm run pay
```

(`AGENT_KEY` is a funded **Base** key — USDC for the payment, a little ETH for gas.)

## `pay.mjs` — zero ceremony

Create a `PipRailClient`, call `client.fetch(url)`. On a `402` the client reads the challenge, pays on-chain, waits for confirmation, and retries with proof — you just get the `200` back.

## `pay-with-policy.mjs` — safe by default

Add a `policy` (`maxAmount`, `maxTotal`, `tokens`, `hosts`) and an `onBeforePay` hook. The client checks them **before any on-chain send** — an over-budget 402 throws `PaymentDeclinedError` and **no funds move**. `client.spent()` shows the running ledger.

> The guardrails live in code, not in a prompt — an LLM can't talk its way past them.

## Next

- [`../mcp`](../mcp) — expose these as tools to Claude / GPT / any MCP client
- [`../CONCEPTS.md`](../CONCEPTS.md) · [SDK docs](../../sdk/README.md)
