# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. PipRail is an **open, backendless, no-fee** SDK for x402 "402 Payment Required" crypto payments across 29 chains, plus a static marketing site.

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
  src/drivers/          one folder per chain family: evm solana ton stellar xrpl tron near sui aptos algorand
    types.ts            the PaymentDriver contract (the only thing the protocol layer sees)
  test/                 Vitest — the contract
  README.md ERRORS.md STANDARDS.md
examples/   teaching code (standalone): express/ next-app-router/ agent/ mcp/ + README.md + CONCEPTS.md
integrations/ first-party framework integrations (one folder per framework, standalone + publishable): openclaw/piprail/ (ClawHub skill @piprail) + hermes/piprail/ (Hermes MCP catalog manifest + Skills Hub skill) + elizaos/piprail/ (@piprail/elizaos-plugin) + n8n/piprail/ (@piprail/n8n-nodes-piprail) + mastra/piprail/ (MCPClient example); MCP-based ones ship verify.mjs; + README.md + TESTING.md
site/       piprail.com — Astro 5 + Tailwind v4 (deploys to Netlify)
```

## API ground truth (get these right)

- **Accept, Express/Connect only:** `requirePayment({ chain, token, amount, payTo })` → middleware. `token` is **required**; there is no default.
- **Accept, every other framework:** `createPaymentGate({ chain, token, amount, payTo })` → `gate.verify(headerValue)` returns `{ kind: 'paid' | 'challenge' | 'invalid', … }`. Use `toInvalidBody(result)` for the invalid 402 body.
- **Receipts:** `onPaid(receipt)` fires on a settled payment with an enriched **`PaidReceipt`** (`X402Receipt` + `decimals`/`symbol`/`amountFormatted`/`idempotencyKey`). It's **sync or async and fully isolated** (a throw OR a rejected promise → `onPaidError`, never crashes); fire-and-forget unless `awaitOnPaid: true`. Delivery is **at-least-once** — dedupe on `idempotencyKey`. `deliverReceipt(receipt, { url, secret })` is a never-throws, signed+retried POST to **your** webhook (PipRail hosts nothing).
- **Multi-chain:** `{ accept: [{ chain, token, amount, payTo? }, …] }` instead of the single-chain fields.
- **Pay:** `new PipRailClient({ chain, wallet, policy? })` → `client.fetch(url)` auto-pays a 402; `quote(url)`, `estimateCost(url)`, **`planPayment(url)`** (affordability + recipient-readiness preflight → `PaymentPlan`; `canAfford(url)`; `fetch(url, { autoRoute: true })` pays the cheapest settleable rail), `spent()` / `budget()` / `policy()`. Module-level `planAcross(clients, url)` plans across chains.
- **Spend controls (`policy`):** per-call `maxAmount` + per-(network,asset) `maxTotal`; opt-in **cross-token grand total** `maxTotalPerDenom: { USD: '20.00' }` (a unit-of-account sum across every stablecoin + chain — NOT a price oracle; native coins excluded), **count caps** `maxPayments`/`maxPaymentsPerWindow`, a time envelope (`ttlSeconds`/`expiresAt`/`windowTotal`), and `warnAtFraction` (→ `budget-threshold` event). Durable across restarts via `spendStore` (`fileSpendStore` from `@piprail/sdk/node`); `MultiChainPayer.fromWallets` shares ONE ledger so the grand total + counts span chains. Observe via `onEvent` (`payment-declined`/`budget-threshold`) + `onSpend(record, budget)`.
- **Schemes (pay side):** default pays only PipRail's `onchain-proof`. Opt in with `schemes: ['onchain-proof', 'exact']` (or per-call `fetch(url, { schemes })`) to also pay standard x402 `exact` rails — **EVM ERC-20**: EIP-3009 (USDC/EURC) or Permit2 (any other ERC-20, e.g. Binance-Peg USDC on BNB), **Solana SVM** (partial-signed SPL TransferChecked), **and the non-EVM self-settle rails: Algorand, Aptos, NEAR** (buyer signs a fee-payer/meta-tx the merchant relayer broadcasts) — i.e. `exact` is payable on **5 families** today (EVM · Solana · Algorand · Aptos · NEAR); ignored on the other non-EVM families (TON/Tron/Stellar/XRPL/Sui) / native. Buyer signs, the server/facilitator broadcasts (buyer ~0 gas); `policy`/`onBeforePay` still gate it. Default `['onchain-proof']` keeps the zero-config path byte-identical. `@piprail/mcp`: `PIPRAIL_SCHEMES`.
- **Discovery (opt-in, $0, nothing hosted):** `client.discover(opts?)` reads the OPEN indexes (CDP Bazaar + 402 Index, free) → `DiscoveredResource[]`; `client.register(url, opts?)` lists a resource on them (402 Index no-auth by default; x402scan SIWX optional) → `RegisterOutcome[]`. Emit static artifacts with `buildOpenApi` / `buildWellKnownX402` / `buildX402DnsTxt` (pure), fed by `gate.describe()`. We build on open infra and host nothing — never add our own registry/DB. Caveats: open indexes assume the `exact` scheme; x402scan is Base/Solana-only; no single ratified discovery standard yet.
  - **Pinpoint search:** `discover()` filters (`category`/`asset`/`minReliability`/`verified`/`paymentValid`/`sort`/`order`) + a multi-word query fans out per-word over 402 Index (its `?q=` is AND-tokenized) and is relevance-ranked client-side (`rankResources`/`scoreResource`); `DiscoveredResource` gained `tags`/`reliabilityScore`/`health`/`verified`/`score`.
  - **Findability:** `register()` — lead with `category` (most of 402 Index is `uncategorized`); `tags` are folded into the description (`appendKeywords`, search is literal) + sent as `tags`; plus `provider`/`contactEmail`/`probeBody`.
  - **Self-describing 402 (default-ON):** the gate emits `extensions.piprail` (+ `endpoint` when the merchant set `description`/`mimeType` or a `discovery` descriptor with `summary`) so an agent learns what an endpoint does/returns WITHOUT paying; `selfDescribe:false` restores the byte-identical 402. The gate's `mimeType` also lands on the v2 root `resource`. One `DiscoveryDescriptor` feeds both `extensions.bazaar` and `extensions.piprail.endpoint`. Helpers: `buildEndpointInfo`, `buildSelfDescription`.
- **Agents:** `paymentTools(client)` → **eight** tool descriptors (`piprail_discover` · `piprail_quote_payment` · `piprail_plan_payment` · `piprail_pay_request` · `piprail_register` · `piprail_budget` · `piprail_guide` · `piprail_verify_receipt`) whose `parameters` are **JSON Schema** (use the low-level MCP `Server`, not Zod-based `McpServer`). They pass through `@piprail/mcp` automatically. Only `piprail_pay_request` moves money; `piprail_register` writes to an external index; the other six are read-only.
- Chains by name (`'base'`, `'bnb'`, `'solana'`, `'ton'`, …) or a viem `Chain` / `{ id, rpcUrl }`. Tokens: `'USDC'`, `'USDT'`, `'native'`, or custom by address/mint/issuer/contractId/coinType.

Confirm any signature against `sdk/src/index.ts` before using it.

## Always

- Keep the **protocol layer chain-agnostic** — `server.ts` / `client.ts` / `x402.ts` / `policy.ts` / `ledger.ts` / `agent.ts` import **only** `drivers/types.ts`. Never `viem`, `@solana/*`, `@ton/*`, `xrpl`, etc. outside their driver folder.
- **Drivers mirror each other** — every family is `chains · wallet · pay · verify · index`, with family-suffixed functions (`payEvm`, `verifySui`, …). Copy the pattern to add one.
- **Verify every token address on-chain** before shipping it (symbol + decimals). A wrong decimal count breaks amount math and replay protection.
- Keep `npm run test:sdk`, `npm run typecheck`, and `npm run build:sdk` green before you finish.
- **Run text for `site/src/` or `docs/src/` through the `humanizer` skill before it ships** — house voice in `.claude/skills/humanizer/PIPRAIL.md` (technically correct, simple, **no em dashes**). `npm run prose` is the gate, and it runs inside `npm run verify-gate`.
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

- **[docs.piprail.com](https://docs.piprail.com)** — the **source of truth** for all user-facing documentation (every function, chain, example, the MCP server, the error model). Built from the `docs/` Starlight workspace. The package READMEs are brief signposts that link here; don't re-expand them into full manuals.
- [`sdk/src/index.ts`](sdk/src/index.ts) — the public API surface. **Confirm any signature here before using it.**
- [`sdk/ERRORS.md`](sdk/ERRORS.md) — the error standard (thrown vs. returned codes) — a build contract.
- [`sdk/STANDARDS.md`](sdk/STANDARDS.md) — how anything in the SDK is built + the verification gate.
- [`docs/`](docs/) — the docs site (Astro Starlight). Behaviour changes → update the relevant docs page in the same PR (see the `docs-sync` skill).
- [`examples/CONCEPTS.md`](examples/CONCEPTS.md) — the 402 loop, decision tree, replay model.
