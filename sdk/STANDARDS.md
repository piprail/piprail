# PipRail SDK — the build standard

How we build *anything* in `@piprail/sdk`. This is the repeatable procedure so every
feature lands the same way and the SDK stays the simplest, clearest agent-payments SDK on
the market. Companion docs: **[ERRORS.md](./ERRORS.md)** (the error standard) and the
**`add-chain-integration`** skill (adding a chain/token/family). When those apply, they win
for their topic; this doc covers everything else.

---

## 0. The prime directive — simplicity is the product

Every change must make the SDK *easier*, never heavier. Before adding anything, ask: does the
zero-config path still read in one line? If a feature can't be opt-in, reconsider it.

- **Opt-in, defaults unchanged.** New capability is a new optional field/method. Omitting it
  leaves behaviour byte-identical. (`policy`, `onBeforePay`, `accept[]`, `quote()` all obey this.)
- **No backend, no database, no auth, no dashboard, no fee, no PipRail-hosted facilitator.** Ever. If
  a feature needs one of those, it's the wrong feature for this SDK. (The opt-in standard `exact` rail
  is consistent with this: settlement is either **merchant-self-hosted** — the merchant's own relayer
  key broadcasts in-process, which x402 v2 §7 explicitly blesses — or **delegated to a third-party
  facilitator the merchant chooses**. PipRail still hosts nothing.)
- **One obvious way.** Prefer one clear API over flags. `token` is required so a gate is never
  ambiguous; `chain` is one word. Don't add a second way to do the same thing.

---

## 1. The layering (never violate)

```
protocol layer   index · server · merchant · adapters · client · x402 · policy · ledger · agent · discovery · indexes · errors · util/*
   (chain-agnostic — ZERO viem / @solana / @ton / @stellar imports)
        │  depends only on …
        ▼
driver contract  drivers/types.ts  (PaymentDriver / ResolvedNetwork)
        ▲  implemented by …
        │
chain drivers    drivers/<family>/  chains · wallet · pay · verify · index   (family-symmetric)
   registry.ts (routes a chain → family)   index.ts (eager EVM + lazy auto-mount of the rest)
```

- **The protocol layer is chain-agnostic.** `server`/`client`/`x402`/`policy`/`ledger`/`agent`/
  `discovery`/`indexes` import only `drivers/types.ts` + pure utils — never a chain library.
  Verified by the lazy-chunk invariant (below).
- **Drivers mirror each other** file-for-file (`chains`/`wallet`/`pay`/`verify`/`index`),
  functions family-suffixed (`payEvm`/`verifyStellar`). A new contract method is implemented in
  **all** families.
- **Pure logic is a pure module.** Anything decidable without I/O (amount math, policy, ledger
  aggregation) lives in its own dependency-free, unit-testable file. `policy.ts`/`ledger.ts`
  import no driver; `util/units.ts` imports nothing.
- **Lazy-chunk invariant.** The built EVM entry must contain **zero static** `@solana`/`@ton`/
  `@stellar` imports (they load on first use). New optional-peer code goes under `drivers/<family>/`
  and is reached only via the dynamic loader in `drivers/index.ts`.

---

## 2. Errors — one standard

Follow **[ERRORS.md](./ERRORS.md)** exactly. Two channels only: a **thrown** `PipRailError`
subclass with a stable `SCREAMING_SNAKE` `.code` (config/flow/wallet/registry/affordability), or
a **returned** `VerifyResult` with a closed `VerifyErrorCode` (proof verification). A new thrown
error gets a row in ERRORS.md §2 and is exported from the root. Never leak a raw chain-library
error for a condition the SDK recognises. Observability hooks (`onEvent`, `onPaid`,
`onBeforePay`) never abort the flow on a throw — isolate them.

---

## 3. Adding a feature — the procedure

1. **Write the plan first** under `.claude/plans/<feature>/` (one README + numbered phases,
   referencing the exact files/lines). Tests-as-contract: the test changes *before* the behaviour.
2. **Put it in the right layer** (§1). Pure logic → its own module. Chain-specific → the driver
   (add to the contract + all families if it's cross-family).
3. **Make it opt-in** (§0). Add an optional option/method; default leaves today's behaviour.
4. **Type it precisely**, export the public types from `index.ts`, and keep internals private.
5. **Document everywhere** (§5).
6. **Test every spectrum** (§4) and pass the gate (§6).

## 4. The test contract

`test/` (Vitest) **is** the spec. For every feature:

- **Unit (pure):** truth tables for pure modules (`policy`, `ledger`, `units`), deterministic
  vectors for crypto (`exact` via signature recovery). No I/O.
- **Flow (fake driver + stubbed `fetch`):** register a fake `ResolvedNetwork`; stub `globalThis.fetch`.
  Assert the happy path **and** that refusals happen **before** side effects (e.g. a `send` spy
  stays at 0 when policy declines).
- **Adversarial — try to break it:** a hostile/buggy server (lies about decimals/symbol, forged
  `accepted`, malformed 402), boundary inputs (excess precision, ports in hosts, zero/huge amounts),
  concurrency (parallel payments), and replay. Whatever breaks, fix — then keep the test.
- **Symmetry:** a cross-family test that exercises the same behaviour on every driver
  (e.g. `describe-asset.test.ts`).

## 5. Documentation (a feature isn't done until all are updated)

- **`README.md`** — a section + the API table.
- **`site/src/pages/index.astro`** — a landing block in the existing visual language, if it's
  user-facing.
- **`ERRORS.md`** — any new error code.
- **`CHANGELOG.md`** — an `Unreleased` entry.
- **`examples/`** — a runnable example if it changes how an agent/merchant integrates.

## 6. The verification gate (must be green before "done")

**Run it as one command — `npm run verify-gate`** (`scripts/verify-gate.mjs`). It runs everything
below in dependency order, plus three checks that exist nowhere else: the **ops-script parse**, the
**env-loader tests**, and **`npm run sync`** (the 47-rule surface map). `prepublishOnly` runs only
build + test + the two typechecks, so skipping the gate skips the rest.

The list below stays here because it is the **specification** — the runner reads the viem-free
module list straight out of this section, so this file remains the owner of that fact.

```bash
npm run typecheck        # src type-checks
npm run typecheck:test   # src + tests type-check together (tests are excluded from the build)
npm test                 # full Vitest suite
npm run build            # tsup build succeeds
# lazy-chunk invariant — the EVM bundle pulls in no non-EVM chain lib:
grep -E "from ?['\"]@(solana|ton|stellar)" dist/index.js   # → expect NO matches
# viem-free protocol layer — the chain-agnostic core never imports a chain SDK
# (includes the pure agent-ergonomics modules render/classify/agentGuide/selfdescribe;
#  VALUE imports of chain-agnostic modules — errors.ts, render.ts's BRAND from
#  selfdescribe.ts — are allowed; the grep targets viem):
grep -lE "from ['\"]viem" src/client.ts src/payer.ts src/x402.ts src/policy.ts src/ledger.ts src/server.ts src/merchant.ts src/adapters.ts src/agent.ts src/render.ts src/classify.ts src/agentGuide.ts src/selfdescribe.ts src/facilitators.ts src/discovery.ts src/landing.ts src/transports/a2a.ts src/transports/a2a-types.ts src/transports/mcp.ts src/transports/mcp-types.ts  # → expect NO matches
```

`prepublishOnly` runs build + test + both typechecks. Never ship with any of these red.

### Anything touching the money path also runs the fuzz sweep across seeds

`test/fuzz-payment-paths.test.ts` runs in the normal suite on one fixed seed. When a change
touches verification, the replay set, unit conversion or the wire envelopes, run it across
several seeds — one seed proves very little:

```bash
for s in 1 42 1337 20260828 2654435769; do FUZZ_SEED=$s npm test -- fuzz; done
```

It asserts properties, not examples: the gate never throws an untyped error and never answers
`paid` for garbage; a forged client echo never reaches the driver in place of the server's own
accept; a redeemed proof stays redeemed under any dressing of the envelope; and unit
conversion round-trips exactly at every precision. It has already found a whitespace-padding
replay bypass and two ERRORS.md §1 violations — all three fixed in the Unreleased changelog.

**A failing seed is a bug until proven otherwise.** Reproduce with `FUZZ_SEED=<n>`, shrink it
to a named example test next to the contract it broke, then fix. Never "fix" it by narrowing
the generator.

---

## 7. Known, intentional limitations (document; don't silently fix with complexity)

- **`policy.maxTotal` under high concurrency is best-effort.** It's checked against spend recorded
  *so far*; many payments in flight at once could race past it. Agents that need a hard concurrent
  cap should serialise (the common case is sequential `await`ed calls). We don't add a reservation
  system — it would cost more simplicity than it's worth. State limits like this; never hide them.
  The cross-token grand total (`maxTotalPerDenom`) and the payment-count caps share this property.
- **`policy.maxTotalPerDenom` is a unit-of-account sum, NOT a price oracle.** It adds up only tokens
  the caller grouped as one unit (the static `BUILTIN_DENOMS` labels + `denomFor`), each counted 1:1;
  it never reads a market and never prices a volatile coin (native coins have no denomination and are
  never in a bucket). This keeps the charter's "no price oracle / backendless" rule intact while still
  giving "$X total across every stablecoin and chain". A token finer than `DENOM_PRECISION` (24dp) is
  excluded from the grand total rather than mis-counted.
- **The spend ledger is in-memory unless a `spendStore` is supplied.** Like the gate's replay set
  (`isUsed`/`markUsed`), durability is a *caller-supplied* store, never a PipRail-hosted DB — the SDK
  ships only the interface + a local `fileSpendStore`. The session time envelope stays process-scoped
  regardless.
- **`policy.chains` string entries match the configured selector form.** A `'base'` entry matches a
  client configured with `'base'`; an `{ id }` entry matches by resolved network. Use the same form
  you configured the client with (the pure policy layer can't resolve a name → id without the EVM table).
