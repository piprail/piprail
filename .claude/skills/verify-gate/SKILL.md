---
name: verify-gate
description: >-
  Run PipRail's verification gate — the exact checks that must be green before
  any commit, merge, or release of the SDK/MCP. Use whenever the task is "run the
  checks/tests", "is this ready to commit/merge/ship", "typecheck", "did I break
  anything", or before tagging a release. Encodes the canonical gate from
  sdk/STANDARDS.md §6, including the lazy-chunk invariant most people forget.
---

# The verification gate

Nothing is "done" until this is green. It is a **superset** of what `prepublishOnly` runs, so a red
gate also fails CI and a release. One command, from the **repo root**:

```bash
npm run verify-gate          # everything, in dependency order
npm run verify-gate --quick  # skips the site + docs builds — NEVER for a release
```

| # | step | what it protects |
|---|---|---|
| 1 | `build:sdk` | **first** — the MCP resolves the SDK's built `dist` |
| 2 | `typecheck` | SDK + MCP **src** (`tsc --noEmit`) |
| 3 | `typecheck:test -w @piprail/sdk` | src + tests together |
| 4 | `typecheck:test -w @piprail/mcp` | the root typecheck does **not** cover MCP tests |
| 5 | `test:sdk` | the canonical contract |
| 6 | `test:mcp` | |
| 7 | `build:mcp` | after the SDK exists |
| 8 | **lazy-chunk invariant** | a pure-EVM install must never pull `@solana`/`@ton`/`@stellar` |
| 9 | **viem-free protocol layer** | the chain-agnostic core imports no chain SDK — the module list is read **out of `sdk/STANDARDS.md` §6**, so it cannot become a second copy that rots |
| 10 | **ops scripts parse** | `.claude/` + `scripts/` are gitignored; nothing else ever compiles them |
| 11 | **env-loader tests** | the credential parser's contract (quote-stripping, `export `, `#`) |
| 12 | **`npm run sync`** | 47 rules across 13 domains — every mirrored fact agrees |
| 13–14 | `build` site, `build:docs` | the site build re-runs the sync guard as `prebuild` |

Steps 8–11 exist **only here**: `prepublishOnly` does not run them, so skipping the gate skips them
entirely. Since 2026-08-28 `sdk.yml` also runs 8 and 12 on every push and PR, so drift is caught on
`main` rather than at the release tag.

Running a piece by hand is fine while iterating (`npm run test:sdk`), but **the release gate is the
one command** — the hand-run list used to drift out of date, which is how `RELEASING.md` came to
describe a 20-rule guard that had grown to 47.

## Why each step
- **`typecheck`** — the public API + internals type-check. The protocol layer must
  stay chain-agnostic (no `viem`/`@solana`/etc. in `server.ts`/`client.ts`/`x402.ts`).
- **`typecheck:test`** — a SEPARATE pass because tests are excluded from the build,
  so plain `typecheck` won't catch a type error in `test/`. Easy to forget; don't.
- **`test:sdk`** — Vitest is the canonical contract. Behaviour changed? The test
  changed first.
- **`build:sdk`** — the bundle actually builds (tsup).
- **Lazy-chunk grep** — the headline architectural guarantee: naming a non-EVM chain
  lazy-loads its libs, so a pure-EVM install never downloads `@solana`/`@ton`/etc.
  A stray static import silently breaks that — the grep is the tripwire. Expect
  **zero** matches in `sdk/dist/index.js`.

## When it's red
Fix it before moving on — never commit, merge, or tag with any step red. A failing
`typecheck:test` usually means a new `test/<family>/` file drifted from the contract;
a lazy-chunk match means a driver leaked a static import into the shared/EVM path
(move it behind the family's lazy `import()`).

> Full rules: [`sdk/STANDARDS.md`](../../../sdk/STANDARDS.md) §6. To cut a release once
> this is green, see the **`release`** skill.
