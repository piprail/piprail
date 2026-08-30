---
name: facilitator-probe
description: "Live-probe every keyless x402 facilitator PipRail ships — is it still up, does it still advertise the networks we claim, and what does it support that we don't seed yet. Triggers on 'check the facilitators', 'are the facilitators still live', 'facilitator coverage', 'probe facilitators', 'is x402 facilitator X up', 'which chains have a facilitator', before any release touching facilitator routing, and before trusting piprail.com/facilitators. Read-only — never signs, never spends."
---

# x402 facilitator probe

```bash
node .claude/skills/facilitator-probe/scripts/probe.mjs          # liveness + drift
node .claude/skills/facilitator-probe/scripts/probe.mjs --json
node .claude/skills/facilitator-probe/scripts/deep-probe.mjs     # full /supported capture
node .claude/skills/facilitator-probe/scripts/verify-tx.mjs      # are the CLAIMED settlements still on-chain?
```

📍 **[`FACILITATORS-MAP.md`](FACILITATORS-MAP.md) — every place facilitator data lives (nine
of them), what each holds, and the order to update them in.** Read it before editing
anything facilitator-related. `sdk/src/facilitators.ts` is the only source of truth; the
website data is generated and the docs prose is now held to the registry by a test.

Reads `GET /supported` on every URL in the SDK's `KNOWN_FACILITATORS`. Results land in
`.claude/research/facilitators/` — **the JSON is the asset**, terminal output is ephemeral.
That directory is gitignored and created on first run: probe results are a local artefact with a
timestamp, not a committed surface.

## 🔴 Why this exists

`KNOWN_FACILITATORS` is seed data that **only ever grows** — an entry is added after a real
settlement succeeds and is never revisited. So a facilitator that goes offline stays in the
map, silently, and the SDK keeps handing it to callers.

That is not hypothetical. **2026-08-28: 2 of 11 were dead**, and one of them
(`facilitator.corbits.dev`, now NXDOMAIN) was **first** in the Monad list — so
`firstKeylessFacilitator('eip155:143')` returned a URL that does not resolve, and anyone
using `exact: true` on Monad had a broken rail. `facilitator.bitcoinsapi.com` was also dead
(CNAME → a deleted Azure Container App).

**Run this before any release that touches facilitator routing.** Three regression tests in
`sdk/test/facilitators.test.ts` now keep those two out, but they cannot catch the next one.

## What the output means

| Column | Meaning |
|---|---|
| `STATUS` | HTTP from `/supported`. `TypeError` = DNS or connection failure — treat as dead |
| `CLAIMED→SEEN` | how many of the networks we seed it for it still advertises. Less than claimed = drift |
| `KINDS` | how many scheme/network pairs it advertises in total |

## ⚠️ Advertised ≠ works — do not "expand coverage" from this

`/supported` is a claim. The deep probe shows facilitators advertising **82** networks we
don't seed; strip testnets and slug-duplicates and it is **18**, and even that overstates it.

Our own suite proves why: `it('does NOT seed Celo/Scroll (UVD advertises them but
contract_call_failed → never live-settled)')`. Ultravioleta DAO advertises 78 networks;
a real settle fails on at least two of them.

**Never add a network to `KNOWN_FACILITATORS` from a probe alone.** It goes in only after a
live settle, with the date and tx hash in the note — that provenance is the entire reason
`piprail.com/facilitators` is worth citing.

## Ship checklist when a facilitator dies

1. Remove the entry from `sdk/src/facilitators.ts`, leaving a comment saying which host and why.
2. Check `firstKeylessFacilitator()` for every affected network — a dead host that was *first* is a user-facing break.
3. Add it to `KNOWN_DEAD` in **both** `sdk/test/facilitators.test.ts` and `sdk/test/facilitators-surface.test.ts`.
4. Update any test that asserted its presence (e.g. the Polygon count).
5. `npm run build:sdk && node site/scripts/gen-facilitators.mjs` — the generator reads
   `sdk/dist`, so a stale build silently regenerates stale data.
6. Update the **docs** (coverage table + "Base URLs" line + seed-map bullets) and repoint any
   **example probe** aimed at the dead host. `facilitators-surface.test.ts` fails until you do.
7. Full gate: `typecheck` + `typecheck:test` + `test` + `build` + `build:docs`.

Full location list and update order: **[`FACILITATORS-MAP.md`](FACILITATORS-MAP.md)**.

## Re-verifying the claims (`verify-tx.mjs`)

The page claims every entry was proven by a real settlement. `verify-tx.mjs` re-reads each tx
hash from the notes and asks the **chain** — via the SDK's own `resolveChain()` RPC, not an
explorer web page, which returns 200 for a hash that never existed.

🔴 **A missing tx is not automatically a bad receipt.** Most public RPCs prune. Before calling
anything a failure the script measures the endpoint's block time, works out which block the
claimed settlement date falls in, and asks for *that* block — only an RPC that can still serve
the era gets to contradict a receipt. Anything else is `unverifiable:pruned-rpc`, a gap in our
evidence rather than a lie in the note. Getting this backwards would make the script worse
than useless: it would cry wolf about payments that really happened.

**2026-08-28: 25/25 verified, 0 refuted**, 4 skipped for having no full hash recorded.

## Related

`add-chain-integration` (the live-settle procedure) · `verify-gate` · `seo-audit` ·
`.claude/research/facilitators/`.
