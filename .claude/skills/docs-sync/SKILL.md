---
name: docs-sync
description: >-
  The surfaces map — every place a given fact lives in PipRail, so a change
  propagates EVERYWHERE and nothing rots. Front door for `npm run sync`, the
  automated checker (20 rules over chains, packages, MCP, facilitators, discovery,
  site and docs). Use whenever you change the chain/token set, a version, a count,
  the MCP, a facilitator, or any user-facing feature, and whenever the task is
  "update the docs/READMEs", "did I update everything", "is anything out of sync",
  "what else do I need to change", "keep the site in sync", or after merging a
  feature. Includes the easy-to-forget surfaces: the SEPARATE org-profile repo, the
  AEO files, and the external directory listings.
---

# Docs-sync — the surfaces map

## Run the checker first

```bash
npm run sync                                       # is anything out of sync right now?
npm run sync -- --touched sdk/src/facilitators.ts  # "I changed this — what else must change?"
npm run sync -- --graph                            # every source → mirror link
npm run sync -- --domain chains                    # one domain
```

**`--touched` is the one to reach for mid-task.** It prints the mirrors you now owe, read from
the same rule definitions that run the check — so unlike the prose below it cannot go stale.

- Machine map + how to add a rule: **[`.claude/SURFACES.md`](../../SURFACES.md)**
- Rules: `scripts/sync/rules.mjs` · derived facts: `scripts/sync/sources.mjs`
- It is the site's `prebuild` (via `site/scripts/check-sync.mjs`, which now delegates to it) and
  runs in `release.yml` + `mcp-release.yml`, so drift fails the build.

**The prose below is what the checker cannot judge** — which external listings are worth
refreshing, what wording is worth having, and the surfaces that live in other repos.

PipRail states the same facts in many places. The **source of truth** is the code
(`sdk/src/drivers/` for the chain set); the human-facing docs MIRROR it. When a fact
changes, it must change in **every** surface below — or the project contradicts
itself. This skill is the checklist of "where does this live."

> Rule of thumb: prefer wording that doesn't need updating (say "every chain", not a
> count). Where a hard number genuinely lives (a stat tile, a version), **grep for it**
> and change every occurrence in one pass.

---

## Quick index — "I changed X, so I touch…"

| You changed… | Go update… |
|---|---|
| **Chain / family / token set** | the add-chain-integration skill covers the SDK+site; THEN sweep the mirrors below |
| **A version** (released sdk/mcp) | see the `release` skill — package.json + CHANGELOG (+ mcp `server.json`) + the `llms.txt` header |
| **The MCP** (tools, config, behaviour) | MCP surfaces below |
| **Any user-facing feature** | feature surfaces below |

---

## Chain / token set — the mirrors (after the SDK + chains.ts are done)

Code of record: `sdk/src/drivers/` + `sdk/src/drivers/evm/chains.ts`. Mirrors:

- `docs/src/content/docs/chains/*.md` — **the source** for the chain table + per-chain setup & caveats (`chains/overview.md` = the EVM table + token-coverage rule; one page per non-EVM family). docs.piprail.com is canonical now.
- `sdk/README.md` — now a signpost (NO chain table); only the rot-proof family one-liner. The **count** ("29 chains") still lives in `sdk/package.json`'s `description` — grep it there.
- `sdk/CHAINS.md` — now a **stub** that points at docs/chains; nothing to update here but the family list in its one-liner.
- `site/src/data/chains.ts` — the grid + per-chain token badges (a badge needs `site/public/tokens/<sym>.svg`).
- `site/src/pages/index.astro` — the `stats` count tile (grep `chains built in`), the `#chains` grid heading + the `EVM ×N` / "Nineteen EVM mainnets" prose (the EVM subcount rots separately from the grand total), and the `faqs`. The grand-total number also recurs in the hero/section copy — grep the bare number too.
- `site/src/layouts/Layout.astro` — the JSON-LD `description`/`featureList`/`keywords` (5 ld+json blocks) and the meta description.
- `site/src/pages/mcp.astro` — any chain count/list it repeats.
- `site/public/llms.txt` + `llms-full.txt` — the chain list/count **and the version/last-updated header**.
- `README.md` (repo root) — now a signpost (the chain table + `## Supported chains` heading were removed). The only count surface left is the URL-encoded **shields.io chains badge** (`chains-N%20across%20M%20families` — a plain-number grep MISSES this, search `shields.io/badge/chains`). Update that badge label when a chain/family lands.
- **`piprail/.github` (SEPARATE REPO)** — `profile/README.md`: the chain logo grid + count. Easy to forget — it's not in this repo. Clone it, edit, push.
- **External listings** (when materially changed): the awesome-x402 + awesome-mcp-servers entries and the Coinbase x402 ecosystem `metadata.json` (each is a PR to a third-party repo). The maintainer tracks their status in a local distribution ledger.
- New chain logo SVG → `site/public/chains/<slug>.svg` (and the org-profile grid references `piprail.com/chains/<slug>.svg`).

## MCP surfaces

- `mcp/README.md` — now a signpost: the compact 7-tool name list + one minimal config block. The full tool/env/config tables live in `docs/src/content/docs/mcp/*.md` (the source).
- `mcp/server.json` — the registry manifest: bump `version` (twice — top-level + `packages[].version`), keep the `environmentVariables` descriptions in sync with the config, and the stdio `transport`. Note: server.json lists NO tools — the tool set lives in `mcp/README.md`.
- `site/src/pages/mcp.astro` — the /mcp setup guide.
- `site/src/layouts/Layout.astro` — the `mcpLd` SoftwareApplication (#mcp) entity + MCP keywords.
- `site/public/llms.txt` + `llms-full.txt` — the MCP section + the `MCP-Version` header.
- `examples/mcp/` + `examples/README.md` — the teaching example + its pointer to the published package.
- **The MCP registry** (`io.github.piprail/mcp`) — a SEPARATE publish: bump `server.json`, then
  `cd mcp && mcp-publisher publish` (see the `release` skill §7 / `RELEASING.md`). The npm listing and
  the registry listing drift independently — refresh both.
- **The tool COUNT (five)** recurs as prose: grep `five tools` / the tool names across `mcp/README.md`,
  `site/src/pages/mcp.astro`, the `mcpLd` featureList in `Layout.astro`, and `llms.txt` / `llms-full.txt`.

## Discovery surfaces

The discovery feature (EMIT / REGISTER / DISCOVER, the `x-generator` attribution, the
`piprail_discover` + `piprail_register` tools) — code of record is `sdk/src/discovery.ts` +
`sdk/src/indexes.ts`. Mirrors:

- `docs/src/content/docs/discovery/*.md` — **the source**: the complete reference (the three moves,
  the every-chain guarantee, the walkthrough, the emitters, honest caveats). docs.piprail.com is canonical.
- `sdk/DISCOVERY.md` — trimmed to a pointer + the **internal experimental-status / live-integration log**
  (§ "Experimental status & live-integration log"); keep THAT log current as integrations are verified.
- `sdk/README.md` — the "Be discoverable" section + the `paymentTools()` tool list (FIVE tools).
- `mcp/README.md` — the tools table includes `piprail_discover` + `piprail_register`.
- `site/src/pages/discovery.astro` + `site/src/data/snippets.ts` — the discovery page + its emit/register/discover snippets.
- `site/public/llms.txt` + `llms-full.txt` — the **Discovery** section + the tool count.
- `AGENTS.md` — the discovery API ground truth + rules.
- ⚠️ **`SLUG_TO_CAIP2` in `sdk/src/indexes.ts` does NOT gain an entry per new chain** — an earlier
  version of this line said it did, and that is wrong. The map is deliberately PARTIAL: it covers
  only the slugs the open indexes name, and EVM chains beyond those resolve through the client's own
  `net.supports()`. Adding every EVM chain would be noise. What IS a hard invariant: a **non-EVM**
  entry must equal that family driver's own CAIP-2 id — guarded by the `nonevm-caip2` rule.

## Any user-facing feature / API change

- the relevant **`docs/src/content/docs/**` page** (the feature's source of truth) + `sdk/CHANGELOG.md` (always). `sdk/README.md` is a signpost — only touch it if the one-liner pitch/example changes. `sdk/ERRORS.md` only if a **driver error contract** rule changed (the user-facing error model is in `docs/.../errors/`).
- `AGENTS.md` (the public agent-facing rules) and `CLAUDE.md` (architecture) — both are committed now; keep them current but version/count-agnostic.
- `examples/CONCEPTS.md` + the relevant `examples/*` if the surface is demoed.
- The site (`index.astro`, `mcp.astro`, `llms-full.txt`) if it's worth selling.
- The relevant skill (`add-chain-integration`, `release`, etc.) so the playbook stays true.

---

## The three things people forget
1. **The org profile is a different repo** (`piprail/.github` → `profile/README.md`). Nothing in this repo updates it.
2. **`llms.txt` / `llms-full.txt` carry a `Last-Updated` + `SDK-Version` / `MCP-Version` header** — bump it on every ship.
3. **The site JSON-LD in `Layout.astro`** (5 blocks incl. the MCP entity) repeats descriptions/counts — grep it.

> **Automated backstop (widened 2026-08-28):** `npm run sync` — 20 rules across 7 domains — is the
> site's `prebuild` and runs in the release CI, so drift **fails the build**. It now covers the chain
> and family counts (every occurrence, including the URL-encoded README badge a plain grep misses),
> every published package being documented, the MCP tool list, pinned integration versions,
> `mcp/server.json`'s two version fields, the facilitator registry, the driver mirror rule, non-EVM
> CAIP-2 ids, and the built site (highlighting, JSON-LD, internal links, sitemap).
>
> **Still on you** — the checker cannot see these: the **org-profile repo** (`piprail/.github`),
> external directory listings, and whether the wording is any good. When a new hard fact starts
> being restated, add a rule (`.claude/SURFACES.md` → "Adding a new mapped fact") rather than a
> line in a checklist.

> After a docs sweep, run the `verify-gate` skill (the site build catches broken Astro/links).
