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

Nothing is "done" until this is green. It's the same gate `prepublishOnly` runs in
CI, so a red gate also fails a release. Run it from the **repo root**:

```bash
npm run typecheck                       # SDK + MCP src type-check (tsc --noEmit)
npm run typecheck:test -w @piprail/sdk  # src + TESTS type-check together
npm run test:sdk                        # vitest run — the canonical contract
npm run build:sdk                       # tsup build succeeds
# Lazy-chunk invariant — the EVM bundle must pull in NO non-EVM chain lib:
grep -E "from ?['\"]@(solana|ton|stellar)" sdk/dist/index.js   # → expect NO matches
```

If you touched the **MCP**, also: `npm run test:mcp` and `npm run build:mcp`
(and remember the MCP needs the SDK built first — `build:sdk` before `build:mcp`).

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
