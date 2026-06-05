# @piprail/mcp changelog

## [Unreleased]

- **Docs:** `PIPRAIL_TOKENS` now documents the chain-agnostic `native` alias (allow the chain's
  coin on any family without naming its ticker) across the README, `.env.example`, `server.json`,
  and the `Config` JSDoc — it's a passthrough to `@piprail/sdk`'s `policy.tokens` (SDK ≥ 1.6.0).

## 0.1.0 — 2026-06-05

Initial release. A Model Context Protocol server wrapping [`@piprail/sdk`](https://www.npmjs.com/package/@piprail/sdk).

- Exposes the SDK's three agent tools over stdio: `piprail_quote_payment`, `piprail_plan_payment`, `piprail_pay_request` (JSON Schema passed straight through the low-level MCP `Server` — no Zod).
- Env-configured (`PIPRAIL_*`, with `AGENT_KEY` alias), validated fail-fast.
- Budget-bound by the SDK spend policy (`maxAmount` / `maxTotal` / `tokens` / `hosts`), enforced before any on-chain send.
- Per-family wallet mapping — one secret env var works on EVM, Solana, TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, and XRPL.
- Chain-aware default token: `USDC` everywhere, but `USDT` on Tron & TON (native USDC doesn't exist there) — overridable via `PIPRAIL_TOKENS`.
- Startup `⚠ notes:` for chains that need a keyed RPC (TON effectively required, Tron recommended) — keys fold into `PIPRAIL_RPC_URL` (the SDK has no separate key field).
- `npx -y @piprail/mcp`; ESM; Node ≥ 20. Stderr-only logging (stdout is the protocol channel).
