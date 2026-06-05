# PipRail — project guide

**Read this first in any new session.** What this repo is, how it's built, and the rules.
For the agent-facing command/rule summary, see also [`AGENTS.md`](AGENTS.md).

---

## What this is

PipRail is **three things, no server:**

1. **`@piprail/sdk`** — a TypeScript SDK for x402 "402 Payment Required" agent payments across
   any EVM chain, Solana, and eight more non-EVM families. `npm install`, name a chain, add a
   wallet, done. One parameter (`chain: 'base' | 'bnb' | 'solana' | …`) picks everything.
2. **`@piprail/mcp`** — a Model Context Protocol server that wraps the SDK, handing any MCP
   client (Claude Desktop, Cursor, Claude Code, Windsurf, VS Code, Cline) a budget-bound wallet
   to pay x402 URLs autonomously, capped by a spend policy the model cannot exceed.
3. **`site/`** — a static Astro 5 + Tailwind v4 landing page (piprail.com), $0/mo on Netlify.

No backend. No database. No auth. No dashboard. **No fee** — payments go straight to the
developer's wallet, verified locally against their own RPC. It's a tool you `npm install`, not
a platform you sign up for.

x402 v2 §7 explicitly blesses merchant-local verification ("resource servers MAY… host the
endpoints themselves") — so this backendless shape is spec-supported, not a workaround.

---

## Architecture (this is the whole product)

The key idea: **chain details are data the caller passes, not an allowlist the SDK ships.**
Built-in presets (each with canonical USDC pre-filled) are a convenience; any other EVM chain
works by passing a viem `Chain` or `{ id, rpcUrl }`. No gatekeeping.

It's built on a **PaymentDriver abstraction** — a Laravel-clean, plug-in design:

- **Protocol layer is chain-agnostic.** `server.ts` (`requirePayment` / `createPaymentGate`),
  `client.ts` (`PipRailClient`), and `x402.ts` (wire envelopes) depend **only** on the
  `PaymentDriver` contract in `drivers/types.ts` — zero `viem`, zero `@solana/web3.js`.
- **Each chain family is a self-contained driver** under `drivers/<family>/`, and the families
  **mirror each other** file-for-file (`chains · wallet · pay · verify · index`):

  ```
  drivers/evm/  solana/  ton/  stellar/  xrpl/  tron/  near/  sui/  aptos/  algorand/
  ```

  Adding a family = implement the same contract + `registerDriver`. `registry.ts` is the only
  place families meet; `familyForChain` routes a `chain` value to its driver synchronously.
- **Non-EVM families auto-mount.** Naming a non-EVM `chain` lazily imports that family's
  libraries on first use — no setup call — so pure-EVM installs never download them (verified:
  the built EVM bundle has zero static non-EVM imports, only lazy chunks). Drivers self-register
  via the loader map in `drivers/index.ts`.

**Proof binding — two templates.** A payment proof must be cryptographically bound to its
challenge so it can't be replayed or forged:

- **Template A — memo/nonce-bound** (Stellar, XRPL, NEAR NEP-141, Algorand, TON): the challenge
  nonce rides in a memo/note/comment, and `verify()` matches it on the merchant's own account.
- **Template B — digest-bound** (EVM, Solana, Tron, Sui, Aptos, and every native coin): the
  proof is the tx hash/digest, verified by reading the transaction + a recency window + a
  single-use proof set.

`verify()` always re-derives every checked field from the **trusted `accept`**, never the
client-supplied ref, so a forged echo can't redirect it. Per-family gotchas worth knowing:
TON settles asynchronously, so its proof ref is a self-contained locator, not a tx hash; XRPL
compares `delivered_amount` (not `Amount`) to defeat partial-payment tricks; Tron verifies on
the solidity/confirmed node; NEAR has no account-history RPC so it verifies by tx hash and
scans the trusted token contract's transfer logs (avoid Intents/solvers — they re-add a
facilitator).

**Gas estimate is part of the contract.** Every driver implements `estimateCost(accept, opts?)`
— a best-effort network-fee estimate in the chain's **native coin** (the gas token, distinct
from the payment token), shaped uniformly by `util/cost.ts`'s `nativeCost()` helper. The client
surfaces it as `client.estimateCost(url)` → `{ quote, cost }`, so an agent budgets payment **+**
gas before paying. It reads RPC where cheap (`basis: 'estimated'`), a typical-cost constant
otherwise (`'heuristic'`), and **never throws**.

**Affordability + readiness is part of the contract.** Two more never-throw, RPC-read-only
methods: `balanceOf(wallet, asset)` → `{ token, native }` (base units; `null` per field when a
read is unavailable — never a false 0) and `recipientReady(payTo, asset)` (the chain's receive
prerequisite: real probes on NEAR `storage_balance_of`, Stellar/XRPL trustline, Algorand ASA
opt-in; truthful `'n/a'` where there's no prerequisite). The client composes them into
**`client.planPayment(url)` → `PaymentPlan`** — the read-only completion of the trio
**`quote()` → `estimateCost()` → `planPayment()`**: for every rail a 402 offers on the client's
chain it returns `payable`/`best`, per-rail `blockers`
(`INSUFFICIENT_TOKEN`/`INSUFFICIENT_GAS`/`RECIPIENT_NOT_READY`/`OUTSIDE_POLICY`) + `warnings` +
`shortfall` + a one-line `fundingHint`. `client.canAfford(url)` is the boolean;
`fetch(url, { autoRoute: true })` (opt-in, default off) pays the cheapest *settleable* rail;
`planAcross(clients, url)` merges across chains.

**No database — verification is local:** on-chain via viem (EVM) / `@solana/web3.js` (Solana)
etc. against the caller's RPC, plus an in-memory used-proof set + recency window for replay
protection (pluggable via `isUsed` / `markUsed` for multi-instance deploys).

---

## Repo layout

```
piprail/
├── sdk/          # @piprail/sdk — the core product
│   ├── src/      # index/server/client/x402/errors (protocol, chain-agnostic) · util/ · drivers/
│   └── test/     # Vitest — the canonical contract
├── mcp/          # @piprail/mcp — the MCP server wrapping the SDK
├── site/         # piprail.com — Astro 5 + Tailwind v4 static landing (deploys to Netlify)
├── examples/     # runnable merchant/agent demos + a live Anvil end-to-end
└── .github/      # CI: build/test checks · npm publish on a sdk-v* / mcp-v* tag · site deploy
```

---

## Conventions (on top of the global guide)

- **No backend, no database, no auth, no dashboard, no fee.** If you're adding any of those,
  you're on the wrong project.
- **Keep it dead simple.** The whole pitch is immaculate simplicity — install, name a chain,
  add a wallet, get paid. Every change should make it easier, not heavier. When in doubt, the
  simpler option is right.
- **Adding a chain, family, or token is a strict procedure.** Classify the work; **verify every
  token address on-chain** (it must exist, with matching symbol + decimals); mirror the driver
  templates; provision a gitignored `.secrets/wallets/<family>-wallet.json` test wallet
  (chmod 600) and fund it for a live smoke test; **update the tests first**; and finish on the
  site (`site/src/pages/index.astro` + the logo SVG in `site/public/chains/`). A chain isn't
  done until it's on piprail.com. Mainnets only — no testnet presets.
- **Drivers mirror each other.** All ten family folders are file-for-file symmetric
  (`chains`/`wallet`/`pay`/`verify`/`index`); functions are family-suffixed (`payEvm` … `payAlgorand`,
  `verifyEvm` … `verifyAlgorand`). A new driver copies the pattern.
- **Protocol layer stays chain-agnostic.** `server.ts`/`client.ts`/`x402.ts`/`policy.ts`/`ledger.ts`/`agent.ts`
  touch only `drivers/types.ts` — never import `viem`, `@solana`, `@ton`, `@stellar`, `xrpl`,
  `tronweb`, `near-api-js`, `@mysten/sui`, `@aptos-labs/ts-sdk`, or `algosdk` there.
- **One build standard — `sdk/STANDARDS.md`.** Layering, opt-in-by-default (defaults never
  change), pure modules, drivers mirror, tests-as-contract, and the verification gate
  (`typecheck` + `typecheck:test` + `test` + `build` + the lazy-chunk grep). Read it before
  adding any feature.
- **One error standard — `sdk/ERRORS.md`.** Every module reports errors the same way: a thrown
  typed `PipRailError` (stable `.code`) or a returned `VerifyErrorCode`; affordability always
  maps to `InsufficientFundsError`. A new driver conforms to ERRORS.md §5.
- **SDK is pure TypeScript + a `viem` peer-dep.** Must run headless and in the browser. Non-EVM
  libs are optional peers, lazy-loaded.
- **Site is Astro 5 + Tailwind v4, static-first.** No Inertia, no React runtime, no SSR adapter
  without a real reason.
- **Tests are the canonical contract.** `sdk/test/` (Vitest). Behaviour changes? The test
  changes first. `examples/` has a live e2e against Anvil.
- **No marketplace, activity profile, service registry, or fee contract.** Deliberately absent —
  they'd need a backend or compete on territory we don't own.

---

## Key facts

- **Packages:** `@piprail/sdk` (the product) and `@piprail/mcp` (the MCP server). Publishing is
  via signed git tags (`sdk-v*` / `mcp-v*`) that trigger CI — never `npm publish` by hand. CI
  gotcha: build `@piprail/sdk` **before** `@piprail/mcp` (the MCP depends on the SDK's built `dist`).
- **Chains: 28 across 10 families** — 19 EVM mainnets + Solana, TON, Tron, NEAR, Sui, Aptos,
  Algorand, Stellar, and the XRP Ledger. Token coverage rule: **USDC almost everywhere**; USDT
  on most (omitted where the chain's "USDT" is a bridged LayerZero/USDT0 token rather than
  Tether-native); EURC on Stellar; RLUSD on XRPL; **native coin is a valid payment asset on
  every family**. Any other token works by address. The exhaustive per-chain list and the
  receive-prerequisite caveats live in [`sdk/README.md`](sdk/README.md) and
  [`sdk/CHAINS.md`](sdk/CHAINS.md). Every token address is verified on-chain before shipping.
- **Test wallets:** `.secrets/wallets/<family>-wallet.json` (gitignored, chmod 600), one per
  family, holding a payer + a recoverable `merchantAddress` as the test `payTo`; funded manually
  for live mainnet smoke tests with tiny amounts. The `.secrets/` directory is never committed.
- **Domain:** piprail.com — static site on Netlify.
- **Created:** 2026-06-01.

---

*Keep it a tool, not a platform. The simplicity is the product — protect it.*
