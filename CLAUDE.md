# PipRail — project guide

**Read this first in any new session.** What this repo is, how it's built, and the rules.
For the agent-facing command/rule summary, see also [`AGENTS.md`](AGENTS.md).

---

## 🗺️ START HERE ON EVERY REQUEST — check the map before you touch anything

**Before beginning ANY task — a feature, a fix, a docs edit, a version bump, a new chain —
open the surface map first.** PipRail states the same fact in many places, and the whole point
of the map is that you find out *up front* what a change will drag along with it, not after.

```bash
npm run sync -- --touched <the file you are about to change>   # ⬅️ DO THIS FIRST
npm run sync -- --graph                                        # the whole source → mirror map
npm run sync                                                   # is anything out of sync right now?
```

`--touched` prints the exact mirrors your change now owes — read from the same rule definitions
that run the check, so it can never rot the way a written checklist does. **The human map is
[`.claude/SURFACES.md`](.claude/SURFACES.md).**

**Then finish with `npm run verify-gate`** (typecheck + tests + builds + the lazy-chunk invariant
+ the sync guard, in one command; `--quick` skips the site/docs builds). **`npm run sync` alone** It is the site's `prebuild`
and runs in the release CI, so drift fails the build — better to find it now.

Why this is non-negotiable: the SDK, the docs site, the marketing site, the examples and the
five integrations all restate each other. Change the SDK and the docs, the site, the examples
**and** the integrations may all need to follow. We have already shipped the failure this
prevents — the facilitator registry was corrected in the SDK while the docs, the website data
and a live mainnet example probe kept advertising two dead hosts.

---

## What this is

PipRail is **three things, no server:**

1. **`@piprail/sdk`** — a TypeScript SDK for x402 "402 Payment Required" agent payments across
   any EVM chain, Solana, and a range of other non-EVM families. `npm install`, name a chain,
   add a wallet, done. One parameter (`chain: 'base' | 'bnb' | 'solana' | …`) picks everything.
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
  drivers/evm/  solana/  ton/  stellar/  xrpl/  tron/  near/  sui/  aptos/  algorand/  …
  ```

  (one folder per family — `drivers/` is the source of truth for the current set.) Adding a
  family = implement the same contract + `registerDriver`. `registry.ts` is the only place
  families meet; `familyForChain` routes a `chain` value to its driver synchronously.
- **Non-EVM families auto-mount.** Naming a non-EVM `chain` lazily imports that family's
  libraries on first use — no setup call — so pure-EVM installs never download them (verified:
  the built EVM bundle has zero static non-EVM imports, only lazy chunks). Drivers self-register
  via the loader map in `drivers/index.ts`.

**Proof binding — two templates.** A payment proof must be cryptographically bound to its
challenge so it can't be replayed or forged:

- **Template A — memo/nonce-bound** (e.g. Stellar, XRPL, NEAR NEP-141, Algorand, TON): the
  challenge nonce rides in a memo/note/comment, and `verify()` matches it on the merchant's own
  account.
- **Template B — digest-bound** (e.g. EVM, Solana, Tron, Sui, Aptos, and every native coin):
  the proof is the tx hash/digest, verified by reading the transaction + a recency window + a
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
- **Drivers mirror each other.** Every family folder is file-for-file symmetric
  (`chains`/`wallet`/`pay`/`verify`/`index`); functions are family-suffixed (`payEvm`,
  `paySolana`, …; `verifyEvm`, `verifySolana`, …). A new driver copies the pattern.
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
- **🔄 Never let a fact drift — see [🗺️ START HERE](#-start-here-on-every-request--check-the-map-before-you-touch-anything) at the top.**
  `npm run sync` is both the map and the guard: **51 rules across 13 domains** (chains · packages ·
  mcp · facilitators · discovery · site · docs · api · errors · ci · security · seo · skills). Rules live in
  `scripts/sync/rules.mjs`, each declaring the fact's OWNER and every file that mirrors it.
  **One owner per fact** — if you are hand-maintaining a second copy, that is the bug: make it
  generated, derived, or guarded, then add a rule so the next one is caught. Playbook: the
  **`docs-sync`** skill.

- **🔑 Every credential lives in `.env` — `.env.example` is the map.** One file, one parser
  (`scripts/load-env.mjs`), one place to look. Import `loadEnv()` / `requireEnv('NAME')` rather
  than reading `.env` by hand — five hand-rolled parsers used to disagree about quoting, which
  is how `RPC_TON='https://…'` reached the SDK quotes-and-all and threw `TypeError: Invalid URL`.
  **Adding a credential? Add it to `.env.example` too** (name, purpose, where to get it) — the
  `env-example-documents-secrets` rule fails the build otherwise, and a real value committed
  there fails it as well. Two stores stay outside `.env` **by design** and are named in the
  example: `.secrets/wallets/<family>-wallet.json` (structured per-chain test wallets) and
  `~/.config/gcp/*-oauth.json` (Google OAuth for GSC/GA4).

- **🔗 Record every URL — `.claude/URLS.md` is the address book.** The moment we interact with
  *any* URL, endpoint, dashboard, admin console, or API — ours or a third party's — **it gets a
  row in [`.claude/URLS.md`](.claude/URLS.md) the same day**, with what it's for and when it was
  last verified. Never leave a URL only in chat, a commit message, or memory: if you had to hunt
  for it once, the next session will hunt for it again. This covers live endpoints, sitemaps,
  npm/registry APIs, listing pages, submission forms, login-gated consoles (mark those **John-only**),
  and any third-party URL an inbound issue points at. `DISTRIBUTION-LEDGER.md` holds the *narrative*
  (what's pending and why); `URLS.md` holds the flat, clickable *addresses*.

---

## Key facts

- **Packages:** `@piprail/sdk` (the product) and `@piprail/mcp` (the MCP server). Publishing is
  via signed git tags (`sdk-v*` / `mcp-v*`) that trigger CI — never `npm publish` by hand. CI
  gotcha: build `@piprail/sdk` **before** `@piprail/mcp` (the MCP depends on the SDK's built `dist`).
- **Chains:** every major EVM chain plus Solana, TON, Tron, NEAR, Sui, Aptos, Algorand,
  Stellar, and the XRP Ledger — many families, one `chain:` parameter. Token coverage rule:
  **USDC almost everywhere**; USDT on most (omitted where the chain's "USDT" is a bridged
  LayerZero/USDT0 token rather than Tether-native); EURC where Circle issues it (Stellar +
  Ethereum/Base/Avalanche — all EIP-3009, so exact-payable); RLUSD on XRPL; **native
  coin is a valid payment asset on every family**. Any other token works by address. The
  authoritative, always-current chain list (and the receive-prerequisite caveats) lives in the
  code (`sdk/src/drivers/`) and the docs ([docs.piprail.com/chains](https://docs.piprail.com/chains/overview/));
  `sdk/CHAINS.md` is now a stub pointing there — don't duplicate counts here. Every token address
  is verified on-chain before shipping.
- **Test wallets:** `.secrets/wallets/<family>-wallet.json` (gitignored, chmod 600), one per
  family, holding a payer + a recoverable `merchantAddress` as the test `payTo`; funded manually
  for live mainnet smoke tests with tiny amounts. The `.secrets/` directory is never committed.
- **`main` is protected** by a GitHub *ruleset* (`protect-main`), managed as code. Canonical spec:
  [`.claude/skills/branch-protection/protect-main.json`](.claude/skills/branch-protection/protect-main.json);
  runbook: the **`branch-protection`** skill. **Practical effect: you can't push directly to `main`** —
  branch, open a PR, merge it (solo is fine; 0 approvals required). Force-pushes and deletions of `main`
  are blocked and every commit must be signed. Change protection *only* via the skill's guarded Apply
  (backs up first, verifies after, refuses to drop your admin bypass or disable enforcement) — never
  click-edit the ruleset in the UI, that's drift. An outsider forking the repo or filing an issue
  **cannot** touch `main`; that's normal OSS activity, not a threat.
- **Domain:** piprail.com — static site on Netlify.
- **Created:** 2026-06-01.

---

## ⏳ Pending: Hermes integration distribution — CHECK MERGE/STATUS (added 2026-06-14)

The Hermes integration shipped (`integrations/hermes/piprail/`, live on piprail.com + docs, proven on
Base mainnet). These **external submissions are open and out of our hands** — periodically check whether
they merged/landed. *(Manual reminder; nothing is scheduled. Delete an entry once it lands.)*

- **MCP catalog (primary)** → [NousResearch/hermes-agent#45962](https://github.com/NousResearch/hermes-agent/pull/45962) — when merged, **`hermes mcp install piprail`** works natively for every Hermes user. ⏳ **still open, STALE** — our 3 sweeper fixes landed 2026-07-14 (50 tests green); **zero maintainer response since**, re-verified 2026-08-27. **When it lands, swap the site install chips** (`hermes mcp add piprail --command npx --args -y @piprail/mcp`, in `site/src/pages/index.astro` + `mcp.astro`) to the cleaner `hermes mcp install piprail`, and tighten the docs Setup `hermes.md`.
- **Awesome list** → [SamurAIGPT/awesome-hermes-agent#61](https://github.com/SamurAIGPT/awesome-hermes-agent/pull/61). ✅ merged 2026-06-14 (listed `[production]`; install via `npx -y @piprail/mcp` = always-latest, no version to sync)
- **Hermes Atlas** (hermesatlas.com) → [ksimback/hermes-ecosystem#374](https://github.com/ksimback/hermes-ecosystem/issues/374). ✅ **LANDED 2026-07-16** — their validator passed it and auto-merged PR #551; issue closed as completed. Listed on the ecosystem map.
- **Skills tap** → [github.com/piprail/skills](https://github.com/piprail/skills) — `hermes skills tap add piprail/skills`. ✅ live (ours)
- **Follow-up (not done):** publish to skills.sh / officialskills.sh, then PR [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (~25K★) for the bigger Skills-Hub reach.

Quick status check: `gh pr view 45962 --repo NousResearch/hermes-agent --json state,mergedAt` (also PR
`#61` on SamurAIGPT/awesome-hermes-agent and issue `#374` on ksimback/hermes-ecosystem). Full record +
re-test recipe: `.claude/plans/framework-integrations/04-hermes.md` + `07-hermes-test-log.md`.

---

*Keep it a tool, not a platform. The simplicity is the product — protect it.*

*Positioning north-star: **the open, self-custody, any-chain rail — the tool you own, not the platform
you join.** Stand in the open lane with conviction, never by attacking. Full statement +
voice: [`.claude/skills/content-studio/BRAND.md`](.claude/skills/content-studio/BRAND.md).*
