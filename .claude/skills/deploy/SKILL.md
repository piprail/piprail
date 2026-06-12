---
name: deploy
description: >-
  THE one runbook for shipping PipRail — the complete, crystal-clear checklist of everything that
  must be updated and done for a successful deployment of @piprail/sdk and/or @piprail/mcp: the
  version files, every doc/README/llms.txt surface, the verification gate, the tag-driven npm
  publish, the GitHub Releases, the MCP registry, and the external repos (the x402 ecosystem +
  awesome lists + the separate org-profile repo). Use whenever the task is "deploy", "ship it",
  "release / publish / cut a version", "update everything and deploy", "what needs updating before
  a deploy", "did I update everything", or after merging a feature/chain that should go live. This
  is the master playbook — it folds in and points to release (npm tag mechanics), verify-gate (the
  gate), and docs-sync (the exhaustive surfaces map). Start here every time.
---

# Deploy — the one runbook for shipping PipRail

**This is the single entry point for any deployment.** Read it top to bottom; it is self-sufficient.
It calls three deeper references where you want exhaustive depth, but you don't *need* to open them:

- **[`verify-gate`](../verify-gate/SKILL.md)** — the green-before-ship gate (Phase 4).
- **[`docs-sync`](../docs-sync/SKILL.md)** — the exhaustive "every place a fact lives" surfaces map (Phase 3).
- **[`release`](../release/SKILL.md)** + [`RELEASING.md`](../../../RELEASING.md) — the tag-driven npm mechanics (Phases 5–6).

> **The core truth that makes deploys easy:** publishing is **tag-driven CI**, never a manual
> `npm publish`. You bump versions + sweep the docs + push a signed `sdk-v*` / `mcp-v*` tag, and a
> GitHub Action builds, runs the gate, and publishes. The **site + docs** auto-deploy on every push
> to `main` (Netlify for piprail.com, GitHub Pages for docs.piprail.com) — no tag needed.
>
> **docs.piprail.com (the `docs/` Starlight site) is the source of truth for all documentation.**
> The READMEs are signposts to it. npm only refreshes a package's README **when you publish** — so a
> docs-only change still needs a patch bump + republish to show up on npm.

---

## 0. What are you shipping? (this scopes the whole deploy)

| You changed… | The deploy involves |
|---|---|
| **SDK** code / API / docs | bump `@piprail/sdk` (2 files) → §3 sweep → gate → publish (`sdk-v*`) |
| **MCP** code / config / docs | bump `@piprail/mcp` (**4 files**) → §3 sweep → gate → publish (`mcp-v*`) → **§8 registry** |
| **Both** | bump both; **release the SDK first** (the MCP builds against the SDK's published `dist`) |
| **A chain / family / token** | run **[`add-chain-integration`](../add-chain-integration/SKILL.md) FIRST** (it does the SDK + site), THEN this runbook for the publish + the full §3 surface sweep |
| **Docs / README only** | still a **patch bump + republish** — npm only re-renders the README on publish |
| **Site / docs only** | just push to `main`; Netlify + GitHub Pages auto-deploy. **No tag, no npm.** |

SemVer: **patch** = fixes / docs, **minor** = additive & opt-in (defaults never change), **major** = a breaking change.
Confirm what changed: `git log <last-tag>..HEAD -- sdk/` (or `-- mcp/`).

---

## 1. Pre-flight

- [ ] On `main`, working tree clean for unrelated changes (`git status`). `dist/` is gitignored — CI rebuilds it; never commit it.
- [ ] Pick the new version per SemVer.

## 2. Bump EVERY version file (miss one → the gate fails)

**SDK — 2 files:**
- [ ] `sdk/package.json` → `version`
- [ ] `sdk/CHANGELOG.md` → new dated entry (newest first) **+ the version-footer link** at the bottom

**MCP — 4 files, ALL must match** (a `version.test.ts` guard fails the gate if they drift — 0.2.0 shipped a stale `VERSION` because of this):
- [ ] `mcp/package.json` → `version`
- [ ] `mcp/src/version.ts` → the `VERSION` constant (reported to MCP clients + the startup banner — **easy to miss**)
- [ ] `mcp/server.json` → `version` **and** `packages[0].version` (the registry reads both)
- [ ] `mcp/CHANGELOG.md` → new dated entry
- [ ] **`mcp/server.json` `description` ≤ 100 chars** — the registry 422s a longer one (a guard test enforces it)

## 3. Sweep EVERY doc surface (the part people forget — docs-sync territory)

The **★ items are enforced** by `site/scripts/check-sync.mjs` (it's the site's `prebuild` AND runs in the
release CI — it **fails the build** on drift, so you literally can't ship them stale). The rest are judgement calls.

- [ ] ★ **`site/public/llms.txt` + `llms-full.txt`** — bump the `SDK-Version` / `MCP-Version` header to match the packages, and the `Last-Updated` to today.
- [ ] ★ **All MCP tool names** present in `llms.txt`, `llms-full.txt`, `mcp/README.md` (the signpost root `README.md` and `sdk/README.md` are intentionally exempt).
- [ ] **READMEs are signposts** (`sdk/README.md`, `mcp/README.md`, root `README.md`) → only touch them if the one-line pitch / the single example changed. The deep content lives in `docs/`.
- [ ] **New user-facing feature?** Write it in the **`docs/src/content/docs/**` page** (the source of truth), then mirror to `llms-full.txt`, the relevant `site/src/pages/*.astro`, and the `Layout.astro` JSON-LD `featureList`.
- [ ] **Chain / token / count changed?** It recurs in MANY places — run the **[`docs-sync`](../docs-sync/SKILL.md)** skill. The non-obvious count surfaces: `sdk/package.json` `description` ("across N chains"), the root README **shields.io chains badge** (`chains-N%20across%20M%20families` — a plain grep misses it), `docs/.../chains/overview.md`, `site/src/data/chains.ts`, `site/src/pages/index.astro` (stats tile + grid heading + FAQs), `Layout.astro` (5 JSON-LD blocks).
- [ ] **Don't chase archival files:** `.claude/plans/**` and historical `CHANGELOG` entries are point-in-time records — leave them.

## 4. The verification gate (must be GREEN — see [`verify-gate`](../verify-gate/SKILL.md))

```bash
npm run typecheck                                   # sdk + mcp
npm run typecheck:test -w @piprail/sdk              # src + tests together
npm run test:sdk                                    # (and: npm run test:mcp  if releasing the MCP)
npm run build:sdk                                   # (and: npm run build:mcp)
grep -E "from ?['\"]@(solana|ton|stellar|aptos|mysten|near|tronweb|xrpl)" sdk/dist/index.js \
  && echo "LEAK" || echo "OK: lazy-chunk invariant holds"   # → must be OK (no static non-EVM imports)
npm pack --dry-run -w @piprail/sdk                  # confirm the tarball ships ONLY what files[] lists
node site/scripts/check-sync.mjs                    # the ★ sync guard — versions + tool names
npm run build -w site                               # full site build (runs check-sync as prebuild)
```

All green, or you don't ship. The release CI re-runs the gate (`prepublishOnly`) but **NOT** the lazy-chunk
grep — that tripwire only runs here, so never skip it.

## 5. Commit on `main` + push (this fires the site + docs deploys)

```bash
git commit -am "release: @piprail/sdk vX.Y.Z (+ @piprail/mcp vX.Y.Z)"   # signed if a key is set
git push origin main
```
Pushing `main` triggers **Netlify** (piprail.com) and **`deploy-docs.yml`** (docs.piprail.com). Stage only
the deploy's files if unrelated work is in the tree (`git add <files>` instead of `-am`).

## 6. Tag + publish — SDK first, then MCP (the tag is what publishes)

```bash
git tag -s sdk-vX.Y.Z -m "@piprail/sdk vX.Y.Z — <headline>"   # -a (unsigned) also works; no Verified badge
git push origin sdk-vX.Y.Z                                    # → release.yml builds + publishes
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
npm view @piprail/sdk version                                 # confirms X.Y.Z is live

# THEN the MCP (so it resolves the just-published SDK):
git tag -s mcp-vX.Y.Z -m "@piprail/mcp vX.Y.Z — <headline>"
git push origin mcp-vX.Y.Z
gh run watch "$(gh run list --workflow=mcp-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
npm view @piprail/mcp version
```
If the MCP Action fails at the build step, it's almost always the **SDK-not-built-first** gotcha.

## 7. GitHub Releases

```bash
# GOTCHA: `gh release` needs the token in the env explicitly — `gh release create` alone can 401.
GH_TOKEN=$(gh auth token) gh release create sdk-vX.Y.Z --verify-tag --latest \
  --title "@piprail/sdk vX.Y.Z — <headline>" --notes "<summary; link the CHANGELOG>"
GH_TOKEN=$(gh auth token) gh release create mcp-vX.Y.Z --verify-tag --latest=false \
  --title "@piprail/mcp vX.Y.Z — <headline>" --notes "<summary>"
```
The newest **SDK** release is `--latest`; **MCP** releases use `--latest=false`.

## 8. MCP registry refresh (MCP releases only — `io.github.piprail/mcp`)

```bash
cd mcp
mcp-publisher validate                 # catches the ≤100-char description + schema issues
mcp-publisher login github             # then: mcp-publisher publish   (reads ./server.json)
```

> **CREDENTIAL GOTCHA (hard-won — RELEASING.md was wrong about this):** the registry's token-exchange
> **rejects the gh-CLI OAuth token** (`gho_…`) with a 401 "failed to get GitHub user", even though that
> same token authenticates to GitHub's own API fine. `mcp-publisher login github -token <…>` needs a
> **classic or fine-grained GitHub PAT** with `read:org`, **not** `$(gh auth token)`. So the two working
> paths are:
> 1. **Interactive device flow:** `mcp-publisher login github` → open the printed `github.com/login/device` URL, enter the code. (A human must do this — it can't be automated.)
> 2. **A real PAT:** create one at github.com/settings/tokens (classic, `read:org`) → `mcp-publisher login github -token ghp_…`.
>
> Then `mcp-publisher publish`. A **403** at publish = your `piprail` org membership isn't public — make it
> public at <https://github.com/orgs/piprail/people>, then re-`login` (the token caches perms at login).
> The registry has historically lagged npm by several versions because of this manual, login-gated step —
> it's safe to defer, but note it as deferred so it doesn't get forgotten.

## 9. External repos (when the change is material — "auto-update the other repos")

PipRail is listed in third-party repos that drift independently. Update them with a PR when a deploy
**materially** changes the pitch, the chain count, or the package surface (a routine patch usually doesn't).
The open/where-to PRs are tracked in [`.claude/research/accounts-and-listings.md`](../../research/accounts-and-listings.md) ("Open listing PRs"):

- [ ] **Org profile — `piprail/.github` (SEPARATE REPO)** → `profile/README.md` (the chain logo grid + count + pitch). Nothing in this repo updates it; clone, edit, push. Easiest to forget.
- [ ] **Coinbase x402 ecosystem** (official, x402.org/ecosystem) → `partners-data/piprail/metadata.json` (a PR to `coinbase/x402`).
- [ ] **awesome-x402** (`xpaysh/awesome-x402`) → the PipRail SDK + MCP entries.
- [ ] **awesome-mcp-servers** (`punkpeye/awesome-mcp-servers`) → the PipRail MCP entry.
- [ ] **MCP directories** (Glama, Smithery, mcp.so) — most auto-pull from npm + the registry once §8 lands.

## 10. Post-deploy verification (prove it actually shipped)

```bash
npm view @piprail/sdk version && npm view @piprail/mcp version          # both show the new version
# the published README renders the slim signpost (not a stale 800-line dump):
curl -s https://registry.npmjs.org/@piprail%2Fsdk | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).readme||'';console.log('len',r.length,'| docs link:',r.includes('docs.piprail.com'))})"
gh run list --limit 6   # sdk-release ✓ mcp-release ✓ site ✓ deploy-docs ✓
```
- [ ] npm shows the new version for each released package
- [ ] published README is the slim signpost and points to docs.piprail.com
- [ ] `sdk-release` / `mcp-release` / `site` / `deploy-docs` workflows all green
- [ ] GitHub Releases exist (`--latest` SDK, `--latest=false` MCP)
- [ ] MCP registry version matches npm — **or** explicitly noted as deferred (§8 credential gate)
- [ ] external repos (§9) updated or a PR opened, if the change was material

---

## Gotchas — the things that bite (all hard-won)

1. **npm only refreshes the README on publish.** A docs/README-only change is invisible on npm until you cut a patch release.
2. **Build the SDK before the MCP** — the MCP imports the SDK's built `dist`. Push `sdk-v*`, let it land on npm, then `mcp-v*`.
3. **`check-sync.mjs` fails the build on `llms.txt` drift.** Bump the `SDK-Version`/`MCP-Version` headers in the **same commit** as the package bump, or the Netlify/CI build (and the release) stops.
4. **MCP has 4 version files** (`package.json`, `src/version.ts`, `server.json` ×2, `CHANGELOG.md`) — `version.test.ts` fails the gate if they drift.
5. **`server.json` `description` ≤ 100 chars** — the registry 422s a longer one.
6. **`gh release create` can 401** — pass `GH_TOKEN=$(gh auth token)` explicitly.
7. **MCP registry rejects the gh OAuth token** — needs a classic PAT or the interactive device flow (§8).
8. **`dist/` is gitignored** — CI rebuilds; never commit it.
9. **Don't sweep archival files** — `.claude/plans/**` and old `CHANGELOG` entries are point-in-time; leave them.
10. **The org profile is a different repo** (`piprail/.github`) — this repo's push never touches it.

## The common case, end to end (SDK + MCP docs/patch deploy)

```bash
# 2. bump: sdk/package.json + sdk/CHANGELOG.md ; mcp/{package.json,src/version.ts,server.json,CHANGELOG.md}
# 3. sweep: site/public/llms.txt + llms-full.txt headers (SDK-Version / MCP-Version / Last-Updated)
# 4. gate:
npm run typecheck && npm run typecheck:test -w @piprail/sdk && npm run test:sdk && npm run test:mcp \
  && npm run build:sdk && npm run build:mcp && node site/scripts/check-sync.mjs && npm run build -w site
# 5. ship:
git commit -am "release: @piprail/sdk vX.Y.Z + @piprail/mcp vX.Y.Z" && git push origin main
git tag -s sdk-vX.Y.Z -m "@piprail/sdk vX.Y.Z" && git push origin sdk-vX.Y.Z   # watch → npm view
git tag -s mcp-vX.Y.Z -m "@piprail/mcp vX.Y.Z" && git push origin mcp-vX.Y.Z   # watch → npm view
# 7. releases (GH_TOKEN=$(gh auth token) gh release create …)  ·  8. MCP registry  ·  9. external repos  ·  10. verify
```
```
