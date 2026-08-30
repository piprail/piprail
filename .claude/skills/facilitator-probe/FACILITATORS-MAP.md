# Facilitator surface map — every place facilitator data lives

**Read this before changing anything about facilitators.** One fact — "who settles x402 on
which chain" — is restated in **nine** places. The registry being right is not enough; on
2026-08-28 the SDK was fixed and three other surfaces went on advertising two dead
facilitators for the rest of the day.

> **The rule:** `sdk/src/facilitators.ts` is the **only** source of truth. Everything below
> either derives from it automatically, or is prose that a test now holds to it. Nothing is
> allowed to be a hand-maintained second copy.

---

## The map

| # | Location | Holds | Kept honest by |
|---|---|---|---|
| **1** | **`sdk/src/facilitators.ts`** — `KNOWN_FACILITATORS` | ⭐ **THE SOURCE.** url · keyless · schemes · settles · note (date + tx hash) | you, by hand, after a live settle |
| 2 | `sdk/src/facilitators.ts` — the `REMOVED` comment block | why entries were deleted, so they can't drift back in | code review |
| 3 | `sdk/test/facilitators.test.ts` | `KNOWN_DEAD` never listed / never first / every network keeps ≥1 | `npm run test:sdk` |
| 4 | `sdk/test/facilitators-surface.test.ts` | **the cross-surface guard** — 5–9 below can't drift | `npm run test:sdk` |
| 5 | `site/src/data/facilitators.ts` | **GENERATED** — never hand-edit | `node site/scripts/gen-facilitators.mjs` + test 4 |
| 6 | `site/src/pages/facilitators.astro` | the public page; every count derived from 5 | test 4 |
| 7 | `docs/…/accepting-payments/facilitator-coverage.md` | the coverage table, the copy-paste URL list, the seed-map bullets | test 4 (URL list is set-compared) |
| 8 | `docs/…/making-payments/gasless-payments.md` | the Solana facilitator table | test 4 (dead-host scan) |
| 9 | `examples/basics/sdk-sandbox/suites/live-*.mjs` | live mainnet probes that point at a facilitator URL | test 4 (dead-host scan) |

Also touched, but historical — **do not rewrite**: `sdk/CHANGELOG.md`, `mcp/CHANGELOG.md`.
A changelog records what was true on the day; editing it is falsifying the record. The
guard test's obituary rule lets them keep naming dead hosts.

---

## Scripts

```bash
# Is every seeded facilitator still alive, and does it still advertise what we claim?
node .claude/skills/facilitator-probe/scripts/probe.mjs

# Full GET /supported capture — what they advertise beyond what we seed.
node .claude/skills/facilitator-probe/scripts/deep-probe.mjs

# Are the settlements we CLAIM still on-chain? Re-reads every tx hash from the notes.
node .claude/skills/facilitator-probe/scripts/verify-tx.mjs

# Regenerate the website's copy of the registry (requires sdk/dist — run build:sdk first).
node site/scripts/gen-facilitators.mjs
```

Output lands in `.claude/research/facilitators/` — the JSON is the asset, the terminal is
ephemeral.

---

## Update order — adding or removing a facilitator

Do these in order. Skipping step 3 is how the site silently keeps the old numbers.

1. **Live-settle it** (add) or **confirm it's dead** with `probe.mjs` (remove).
   *Never seed from a `/supported` read — see "Advertised ≠ works" in `SKILL.md`.*
2. Edit **`sdk/src/facilitators.ts`**. On a removal, add a line to the `REMOVED` comment
   block saying which host, when, and how it failed.
3. `npm run build:sdk && node site/scripts/gen-facilitators.mjs`
   *(the generator reads `sdk/dist`, so a stale build silently regenerates stale data)*
4. Update the **docs** — the coverage table, the "Base URLs" line, and the seed-map bullets
   in `facilitator-coverage.md`, plus the Solana table in `gasless-payments.md`.
5. On a removal, repoint any **example probe** aimed at that host.
6. `npm run test:sdk` — test 4 fails loudly on anything you missed in 3–5.
7. `npm run build` (site) and `npm run build:docs`.

---

## What each guard actually catches

`sdk/test/facilitators-surface.test.ts`:

- **`KNOWN_DEAD` is never presented as usable** — scans docs, site, sdk and examples. A dead
  host may only appear within 3 lines of an obituary word (`removed`, `NXDOMAIN`, `offline`,
  …), so writing *about* a removal stays legal while advertising one does not.
- **The docs' copy-paste URL list equals the registry** — set equality in both directions, so
  a missing host (docs under-sell) and an extra one (docs point at nothing) both fail.
- **`site/src/data/facilitators.ts` matches the registry** — same networks, and the same URLs
  **in the same order**. Order matters: it is what `firstKeylessFacilitator` returns, so a
  reordered page misleads a reader about which one their code actually reaches for.
- **Every chain the site renders has a logo** in `site/public/chains/`.
- **The scan is non-empty** — a walker that quietly returned `[]` would make every other
  assertion vacuously pass, which is worse than having no test.

---

## Standing facts (2026-08-28)

- **9 keyless facilitators, 13 chains, 25 linked on-chain receipts.**
- **25/25 receipts re-verified on-chain** by `verify-tx.mjs`. 4 entries have no full hash in
  their note (2 Solana, 1 Base truncated, 1 Base `/supported`-only) — a record-keeping gap,
  not a failed payment.
- **Sei's public RPC keeps ~100k blocks (~13h)** — plenty for the SDK's 600s verification
  window, far too short to re-audit a two-month-old receipt. `verify-tx.mjs` measures each
  endpoint's block time, works out whether it can still serve the settlement date, and only
  calls a receipt refuted when an RPC that *can* see that era says it isn't there. It falls
  back to an archival endpoint (`ARCHIVAL_FALLBACK`) for verification only — never for
  payment.
- Explorers used for the page's receipt links are in `CHAIN_META` in
  `site/scripts/gen-facilitators.mjs`. Note **Monad** moved: `monadexplorer.com` now
  redirects to `monadvision.com`; we link `monadscan.com`.
