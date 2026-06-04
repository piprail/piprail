# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. PipRail is an **open, backendless, no-fee** SDK for x402 "402 Payment Required" crypto payments across 27 chains, plus a static marketing site.

## Commands

```bash
npm install              # install workspaces (sdk, site)
npm run build:sdk        # build the SDK
npm run test:sdk         # SDK test suite (Vitest)
npm run typecheck        # typecheck the SDK
npm run dev              # run the site locally → http://localhost:4321
npm run build            # build the static site
```

Per-example (each is standalone): `cd examples/<name> && npm install && npm start`.

## Project structure

```
sdk/        @piprail/sdk — the product (the only npm-published package)
  src/index.ts          public API surface
  src/server.ts         requirePayment / createPaymentGate (accept side)
  src/client.ts         PipRailClient (pay side)
  src/agent.ts          paymentTools (agent side)
  src/x402.ts           wire protocol (challenges, receipts) — chain-agnostic
  src/policy.ts ledger.ts errors.ts util/
  src/drivers/          one folder per chain family: evm solana ton stellar xrpl tron near sui
    types.ts            the PaymentDriver contract (the only thing the protocol layer sees)
  test/                 Vitest — the contract
  README.md ERRORS.md STANDARDS.md
examples/   teaching code (standalone): express/ next-app-router/ agent/ mcp/ + README.md + CONCEPTS.md
site/       piprail.com — Astro 5 + Tailwind v4 (deploys to Netlify)
```

## API ground truth (get these right)

- **Accept, Express/Connect only:** `requirePayment({ chain, token, amount, payTo })` → middleware. `token` is **required**; there is no default.
- **Accept, every other framework:** `createPaymentGate({ chain, token, amount, payTo })` → `gate.verify(headerValue)` returns `{ kind: 'paid' | 'challenge' | 'invalid', … }`. Use `toInvalidBody(result)` for the invalid 402 body.
- **Multi-chain:** `{ accept: [{ chain, token, amount, payTo? }, …] }` instead of the single-chain fields.
- **Pay:** `new PipRailClient({ chain, wallet, policy? })` → `client.fetch(url)` auto-pays a 402; `quote(url)`, `estimateCost(url)`, `spent()`.
- **Agents:** `paymentTools(client)` → tool descriptors whose `parameters` are **JSON Schema** (use the low-level MCP `Server`, not Zod-based `McpServer`).
- Chains by name (`'base'`, `'bnb'`, `'solana'`, `'ton'`, …) or a viem `Chain` / `{ id, rpcUrl }`. Tokens: `'USDC'`, `'USDT'`, `'native'`, or custom by address/mint/issuer/contractId/coinType.

Confirm any signature against `sdk/src/index.ts` before using it.

## Always

- Keep the **protocol layer chain-agnostic** — `server.ts` / `client.ts` / `x402.ts` / `policy.ts` / `ledger.ts` / `agent.ts` import **only** `drivers/types.ts`. Never `viem`, `@solana/*`, `@ton/*`, `xrpl`, etc. outside their driver folder.
- **Drivers mirror each other** — every family is `chains · wallet · pay · verify · index`, with family-suffixed functions (`payEvm`, `verifySui`, …). Copy the pattern to add one.
- **Verify every token address on-chain** before shipping it (symbol + decimals). A wrong decimal count breaks amount math and replay protection.
- Keep `npm run test:sdk`, `npm run typecheck`, and `npm run build:sdk` green before you finish.
- Keep examples **dead simple** and standalone (they `npm install @piprail/sdk` from npm).

## Ask first

- **Publishing to npm** — `@piprail/sdk` is published manually; publish only when asked.
- **Changing the public API** — anything exported from `sdk/src/index.ts`.
- **Removing a chain or token** — it breaks existing merchants; deprecate instead.

## Never

- Add a **backend, database, auth, or fee**, or take custody of funds. That's the whole pitch — a tool you install, not a platform.
- Commit secrets or real private keys (local test wallets live in a gitignored `.secrets/`, chmod 600).
- Route NEAR payments through **Intents / solvers** — a plain `ft_transfer` is what binds and verifies.
- Ship **testnet** presets — mainnet only; test live with tiny amounts or against a local Anvil.
- **Default or infer the token** — every gate states exactly what it accepts.
- Market the Sui transfer path as "gasless."

## Key files

- [`sdk/README.md`](sdk/README.md) — full API, all 27 chains, wallet formats, custom tokens.
- [`sdk/ERRORS.md`](sdk/ERRORS.md) — the error standard (thrown vs. returned codes).
- [`sdk/STANDARDS.md`](sdk/STANDARDS.md) — how anything in the SDK is built + the verification gate.
- [`examples/CONCEPTS.md`](examples/CONCEPTS.md) — the 402 loop, decision tree, replay model.
