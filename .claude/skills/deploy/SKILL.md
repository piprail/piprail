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
> GitHub Action builds, runs the gate, publishes to npm, **and now also cuts the GitHub Release
> automatically** (and refreshes the MCP registry, once its secret is set — see below). The
> **site + docs** auto-deploy on every push to `main` (Netlify for piprail.com, GitHub Pages for
> docs.piprail.com) — no tag needed.
>
> **docs.piprail.com (the `docs/` Starlight site) is the source of truth for all documentation.**
> The READMEs are signposts to it. npm only refreshes a package's README **when you publish** — so a
> docs-only change still needs a patch bump + republish to show up on npm.

### What's automatic (read this first)

The pipeline is **push-to-ship**. After you've bumped versions + swept docs + passed the gate, the
ONLY actions are a push and one or two tags — CI does the rest. **No human-gated step remains**, and
**no extra secret is needed** (only `NPM_TOKEN`, already set):

| You do this | CI does this — automatically | Manual? |
|---|---|---|
| merge a PR into `main` | Deploy **piprail.com** (Netlify) + **docs.piprail.com** (GitHub Pages) + IndexNow ping + run CI checks | **None** |
| `git push origin sdk-vX.Y.Z` | `release.yml`: gate → **npm publish `@piprail/sdk`** → **cut the GitHub Release** (`--latest`) | **None** |
| `git push origin mcp-vX.Y.Z` | `mcp-release.yml`: gate → **npm publish `@piprail/mcp`** → **cut the GitHub Release** → **publish the MCP registry via OIDC** (no secret) | **None** |
| `clawhub skill publish …` | publish/refresh the **OpenClaw ClawHub skill** `piprail` (`clawhub install piprail`; it wraps `@piprail/mcp`) | **Manual** — re-publish when the skill or its MCP tool set changes (§8.5) |
| `hermes skills publish …` | publish/refresh the **Hermes skills tap** `piprail/skills` (`hermes skills tap add piprail/skills`; it wraps `@piprail/mcp`) | **Manual** — re-publish when the skill or its MCP tool set changes (§8.6) |

So: **GitHub Releases AND the MCP registry are now fully automatic** — CI cuts the release from the tag
(auto-generated notes) and publishes `io.github.piprail/mcp` to the MCP registry using **GitHub Actions
OIDC** (`mcp-publisher login github-oidc` — the runner's OIDC token is trusted for the `io.github.piprail`
namespace, so **no PAT, no device-flow login, no stored secret**). To (re)publish the registry without
cutting a new npm release, trigger the on-demand lever: **`gh workflow run mcp-registry.yml`** (§8).
**External repos** (the separate `piprail/.github` org-profile, awesome-x402, coinbase/x402) stay manual
*by design* — they're third-party / cross-repo and only need touching on a **material** change (chain
count, pitch), not a routine patch (§9). The **integration skill registries** likewise re-publish manually
— the **OpenClaw ClawHub skill** (`clawhub skill publish`, §8.5) and the **Hermes skills tap**
(`hermes skills publish`, §8.6) — re-ship each whenever its `SKILL.md` or the MCP tool set it wraps changes.

> **RULE — every integration is a deploy lane.** Each folder under `integrations/*` MUST have its publish
> steps documented in this runbook (a `§8.x` entry + a `CLAWHUB.md`/`HERMES.md`-style runbook) and a row
> in the §0 table below. **Adding a new integration isn't "done" until it's wired into this deploy** — so a
> future deploy can't silently skip it. When you add one, add: (1) a §0 row, (2) the automatic-lanes row
> above if it has a publish command, (3) a `§8.x` quick section, and (4) a `<NAME>.md` full runbook.

> **You (the agent) can run this entire deploy yourself.** With bypass permissions + `gh` auth you can
> `git commit` / `push` / `tag` and trigger workflows (`gh workflow run`, `gh run watch`). Nothing here
> requires a human — including the MCP registry (OIDC). Do the full ship end to end when asked.

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
| **OpenClaw integration** (`integrations/openclaw/piprail/`) — its `SKILL.md`, **or the MCP tool set it advertises** | bump the skill `--version` + **`clawhub skill publish`** under `--owner piprail` (§8.5). A stale listing shows the wrong tools/install. |
| **Hermes integration** (`integrations/hermes/piprail/`) — its `SKILL.md`, **or the MCP tool set/config it advertises** | bump the skill `version:` + **`hermes skills publish … --repo piprail/skills`** (§8.6). The universal `hermes mcp add` path is always-current; only the tap listing goes stale. |

SemVer: **patch** = fixes / docs, **minor** = additive & opt-in (defaults never change), **major** = a breaking change.
Confirm what changed: `git log <last-tag>..HEAD -- sdk/` (or `-- mcp/`).

---

## 1. Pre-flight

- [ ] On `main`, working tree clean for unrelated changes (`git status`). `dist/` is gitignored — CI rebuilds it; never commit it.
- [ ] Pick the new version per SemVer.
- [ ] `gh secret list` shows **`NPM_TOKEN`** (the only secret a release needs — the MCP registry uses OIDC).
- [ ] `npm view @piprail/sdk version` — confirm the version you are about to publish is **not already taken**. npm never lets you replace one.
- [ ] Ask the map what your change drags along: **`npm run sync -- --touched <file>`**.

### ✅ The clean-clone class of bug is now caught AUTOMATICALLY

`npm run verify-gate` includes a **`clean-clone sync`** step: it re-runs all 50 sync rules with the
resolvers pretending untracked files don't exist (`git ls-files` is the authority; build outputs stay
visible, because the real build makes them before sync runs). It takes ~1s and needs no `npm ci`.

**If `sync` passes but `clean-clone sync` fails, a rule is reading a path git does not ship.** Guard
it with `exists()` first — ⚠️ **`read()` THROWS ENOENT; it does not return falsy**, so
`const src = read(f); return src && …` looks defensive and isn't. That exact mistake shipped into
`custody-claim-mirrors` on 2026-08-30 and would have failed the Netlify build.

```bash
PIPRAIL_SYNC_CLEAN_CLONE=1 npm run sync    # reproduce it directly
```

The **full** manual clean-clone test below is still the definitive check — it also proves `npm ci`
resolves, all four build lanes pass, and **no secret is in the commit**. Run it for any release or
any change to `scripts/`, the build, or a sync rule. The automatic step covers only the sync-rule
half, which is the half that has actually broken twice.

### 🔴 If you changed anything the BUILD depends on — test a CLEAN CLONE

Your working tree is not what CI and Netlify get. Anything **gitignored** is missing there, and the
site's `prebuild` runs the sync guard, so a guard that reads a local-only file **fails the production
build** while passing forever on your machine.

That is not hypothetical. `surfaces-index` did
`if (!exists('.claude/SURFACES.md')) return bad(…)` — and `.claude/` ships only an allowlist of six
skills, so that file is absent from every clone. The first Netlify deploy after `scripts/` shipped
would have failed. Caught only by this:

```bash
# build a tree from exactly what git would ship (HEAD + your staged changes)
git add -A
rm -rf /tmp/cc && mkdir -p /tmp/cc
git archive --format=tar HEAD | tar -x -C /tmp/cc
git diff --cached --name-only -z | while IFS= read -r -d '' f; do
  git cat-file -e ":$f" 2>/dev/null && { mkdir -p "/tmp/cc/$(dirname "$f")"; git show ":$f" > "/tmp/cc/$f"; }
done

cd /tmp/cc
ls .env .secrets 2>/dev/null && echo "🔴 SECRET LEAKED INTO THE COMMIT"   # must print nothing
npm ci
npm run build:sdk && npm run build          # ← the EXACT Netlify command
npm run sync && npm run build -w @piprail/docs   # ← the docs lane
npm test -w @piprail/sdk && npm test -w @piprail/mcp
```

All four lanes must pass **there**, not just locally. It doubles as the definitive check that no
secret is in the commit.

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

The **★ items are enforced** by `npm run sync` (reached via `site/scripts/check-sync.mjs`, the site's `prebuild` AND run in the
release CI — it **fails the build** on drift, so you literally can't ship them stale). The rest are judgement calls.

- [ ] ★ **`site/public/llms.txt` + `llms-full.txt`** — bump the `SDK-Version` / `MCP-Version` header to match the packages, and the `Last-Updated` to today.
- [ ] ★ **All MCP tool names** present in `llms.txt`, `llms-full.txt`, `mcp/README.md` (the signpost root `README.md` and `sdk/README.md` are intentionally exempt).
- [ ] **READMEs are signposts** (`sdk/README.md`, `mcp/README.md`, root `README.md`) → only touch them if the one-line pitch / the single example changed. The deep content lives in `docs/`.
- [ ] **New user-facing feature?** Write it in the **`docs/src/content/docs/**` page** (the source of truth), then mirror to `llms-full.txt`, the relevant `site/src/pages/*.astro`, and the `Layout.astro` JSON-LD `featureList`.
- [ ] **Chain / token / count changed?** It recurs in MANY places — run the **[`docs-sync`](../docs-sync/SKILL.md)** skill. The non-obvious count surfaces: `sdk/package.json` `description` ("across N chains"), the root README **shields.io chains badge** (`chains-N%20across%20M%20families` — a plain grep misses it), `docs/.../chains/overview.md`, `site/src/data/chains.ts`, `site/src/pages/index.astro` (stats tile + grid heading + FAQs), `Layout.astro` (5 JSON-LD blocks).
- [ ] **Don't chase archival files:** `.claude/plans/**` and historical `CHANGELOG` entries are point-in-time records — leave them.

## 4. The verification gate (must be GREEN — see [`verify-gate`](../verify-gate/SKILL.md))

**One command. Do not hand-run the pieces** — this used to be ten commands to paste, and the list
drifted (it still claimed "20 rules, 7 domains" long after the map reached 47/13).

```bash
npm run verify-gate          # the whole gate, in dependency order
```

What it runs, and why the order matters:

| # | step | why here |
|---|---|---|
| 1 | `build:sdk` | **first** — the MCP resolves the SDK's built `dist` |
| 2 | `typecheck` | sdk + mcp **src only** |
| 3 | `typecheck:test -w @piprail/sdk` | src + tests together |
| 4 | `typecheck:test -w @piprail/mcp` | the root typecheck does **not** cover MCP tests |
| 5–6 | `test:sdk`, `test:mcp` | the canonical contract |
| 7 | `build:mcp` | after the SDK exists |
| 8 | **lazy-chunk invariant** | no static non-EVM import in the EVM bundle |
| 8b | **custody invariant** | no keys in the protocol layer · the gate needs no secret · no telemetry |
| 9 | **ops scripts parse** | `.claude/` + `scripts/` are gitignored — nothing else compiles them |
| 10 | **env-loader tests** | the credential parser's contract |
| 11 | **`npm run sync`** | 50 rules, 13 domains |
| 11b | **`clean-clone sync`** | 🔴 the same rules against ONLY what git ships — what Netlify actually builds |
| 12–13 | `build` site, `build:docs` | the site build re-runs the sync guard as `prebuild` |

`--quick` skips 12–13. **Never use it for a release.**

> The gate is **16 steps** as of 2026-08-30 (added `custody invariant` + `clean-clone sync`).

```bash
npm run sync -- --touched <file>    # "I changed this — what else must change?"
npm pack --dry-run -w @piprail/sdk  # confirm the tarball ships ONLY what files[] lists
```

All green, or you don't ship. `prepublishOnly` re-runs build + test + typecheck at publish time,
and since 2026-08-28 `sdk.yml` also runs the lazy-chunk invariant and the sync guard on every push
and PR — but the **whole** set only runs together here.

## 5. Land it on `main` — **via a PR** (this fires the site + docs deploys)

`main` is protected (`protect-main`): **pull request required, signed commits required**, no
force-push, no deletion. A repo admin *can* bypass and push straight to `main` — this step used to
say exactly that — but bypassing skips the `pull_request` CI, which is the run you most want on a
release commit.

```bash
git checkout -b release/sdk-vX.Y.Z
git commit -am "release: @piprail/sdk vX.Y.Z (+ @piprail/mcp vX.Y.Z)"   # auto-signed
git push -u origin release/sdk-vX.Y.Z
gh pr create --fill
gh pr checks --watch                    # let sdk/mcp/site CI go green FIRST
gh pr merge --squash --admin            # solo is fine: 0 approvals required
git checkout main && git pull
```

Merging to `main` triggers **Netlify** (piprail.com) and **`deploy-docs.yml`** (docs.piprail.com).
Stage only the deploy's files if unrelated work is in the tree (`git add <files>` instead of `-am`).

> **Signing is required, not optional.** `git config gpg.format ssh && git config user.signingkey
> ~/.ssh/id_rsa.pub && git config commit.gpgsign true && git config tag.gpgsign true`. Locally
> `git log --pretty='%G?'` may print `E` without an `allowed_signers` file — harmless; GitHub
> verifies against the signing key on your account.

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

## 7. GitHub Releases — now AUTOMATIC (CI cuts them)

**You don't run anything here.** `release.yml` / `mcp-release.yml` create the GitHub Release for the
tag right after npm publish, using the built-in `GITHUB_TOKEN` (no secret) and `--generate-notes` (the
body is auto-built from commits since the previous tag). SDK = `--latest`; MCP = `--latest=false`. The
step is idempotent (skips if the release already exists) and runs *after* publish, so a hiccup never
un-publishes npm.

```bash
# Just VERIFY they appeared (the run watched in §6 already includes this step):
gh release view sdk-vX.Y.Z --json name,isLatest,url --jq '{name,isLatest,url}'
gh release view mcp-vX.Y.Z --json name,isLatest,url --jq '{name,isLatest,url}'
```
Only if CI's release step failed (rare), cut it by hand — `gh release create` needs the token in the
env explicitly: `GH_TOKEN=$(gh auth token) gh release create sdk-vX.Y.Z --verify-tag --latest --generate-notes`.

## 8. MCP registry — AUTOMATIC via OIDC (no secret, no human)

**You don't run anything here on a normal release.** `mcp-release.yml`'s "Publish to the MCP Registry
(OIDC)" step installs `mcp-publisher`, authenticates with **GitHub Actions OIDC**
(`mcp-publisher login github-oidc`), and publishes `mcp/server.json` → `io.github.piprail/mcp` on every
`mcp-v*` tag. The registry trusts the runner's OIDC token for the `io.github.piprail` namespace (matched
by the workflow's `repository_owner` + `id-token: write`), so there is **no PAT, no stored secret, and no
device-flow login** — the historical credential gate is gone. It runs after npm publish and is
best-effort (`continue-on-error`), so it never fails the release.

**Re-publish on demand** (e.g. a `server.json`-only change, or if a release-run's registry step hiccuped)
— a dedicated `workflow_dispatch` workflow, runnable straight from a shell with just `gh` auth:
```bash
gh workflow run mcp-registry.yml          # publishes the CURRENT mcp/server.json via OIDC
gh run watch "$(gh run list --workflow=mcp-registry.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```
Verify it landed: `curl -s https://registry.modelcontextprotocol.io/v0/servers?search=io.github.piprail/mcp | jq '.servers[].version'`.

**Manual fallback** (only if you're publishing from a laptop, off-CI — OIDC needs the Actions runner):
```bash
cd mcp && mcp-publisher validate && mcp-publisher login github && mcp-publisher publish   # device flow (human)
```
> Why OIDC beats the old PAT path: a PAT is a long-lived secret someone must create, scope (`read:org`),
> keep public-org-membership for, and rotate. OIDC is short-lived, scoped to this repo's owner, and
> needs nothing stored. Prefer it. (The local `mcp-publisher login github` device flow still exists for
> off-CI publishing, but you should rarely need it.)

## 8.5 OpenClaw ClawHub skill (`piprail`) — manual `clawhub skill publish`

> **Full runbook: [`CLAWHUB.md`](./CLAWHUB.md)** — the exhaustive guide (identity model, the avatar/bio
> web-form step, the auto-classified category + "API key required" badge, verification). This §8.5 is the
> quick version.

The OpenClaw integration is **also published to ClawHub** (OpenClaw's skill registry, ~250k★ community) as
**`piprail`** (`clawhub install piprail`), owned by the **`@piprail` org publisher** — a SKILL.md listing that wraps the
`@piprail/mcp` server. It's a **separate registry from npm**, so a `git push`/tag does **nothing** to it;
re-publish it by hand whenever its content drifts.

**Re-publish WHEN:**
- `integrations/openclaw/piprail/SKILL.md` changed (description, config, the **7-tools table**, benefits), OR
- the **MCP tool set / names changed** (a new `piprail_*` tool, a renamed one) — the listing's tool table goes stale, OR
- the env/config surface changed (a new `PIPRAIL_*` var worth documenting).
- A routine SDK/MCP patch that doesn't touch the skill's content needs **no** re-publish.

**How (the CLI is `npm i -g clawhub` — NOT the PyPI `clawhub`, which is unrelated):**
```bash
clawhub whoami || clawhub login              # GitHub auth (browser / --device / --token); free, once
# Published under the @piprail ORG publisher — owner + slug must BOTH be explicit now
# (the folder is `piprail`, so the slug no longer derives from the folder name):
clawhub skill publish integrations/openclaw/piprail \
  --owner piprail --slug piprail --name "PipRail" --version X.Y.Z \
  --tags latest --changelog "<what changed>"
clawhub inspect piprail        # confirm Latest=X.Y.Z, owner=piprail, Moderation: CLEAN
```
- **`--owner piprail` (the org publisher) is mandatory** — without it the skill publishes under your *personal*
  handle (the page then shows your avatar/handle, not PipRail's). The publisher was created once with
  `clawhub publisher create piprail --display-name "PipRail"`; to move an already-personal skill, republish with
  `--owner piprail --migrate-owner`. The publisher's **avatar/logo is a one-time web setting** on clawhub.ai
  (no CLI flag) — set it to the PipRail mark if the page shows a placeholder.
- **`--slug piprail`** — matches the folder name, so it's the natural default; pass it explicitly to be safe.
  The slug is just `piprail` (ClawHub is OpenClaw-only → one PipRail skill here, no suffix needed; it also
  **rejects** `openclaw-*`/`*-openclaw`). It lists as `clawhub install piprail`; old slugs redirect.
- **Auto-classified (you don't set these):** ClawHub derives the **category** from the `description` (lead with
  payments/wallet/402 language → "Payments"; mention APIs/data feeds → "Data & APIs"), and shows an **"API key
  required" badge** whenever it auto-detects a user-supplied secret in the body (our wallet-key config). The badge
  is honest (the MCP needs `PIPRAIL_PRIVATE_KEY`) and **can't be removed** without deleting the setup docs — we
  accept it. Frontmatter declares only `requires.bins: [npx]` (no `requires.env`/`primaryEnv`) to avoid over-declaring. See `CLAWHUB.md` §4.
- **Branding is web-only:** the `@piprail` publisher's **avatar URL** (`https://piprail.com/logo.png`) + **bio**
  are set at `clawhub.ai/settings → Organizations → @piprail` — there is **no CLI/REST path** (all publisher-update
  endpoints 404). See `CLAWHUB.md` §2.
- Bump `--version` (semver) each publish; old slugs (`piprail`, `piprail-openclaw`) redirect.
- ClawHub runs automated security checks on publish; `clawhub scan download piprail --version X.Y.Z` fetches the report.
- **Verify before publishing:** `cd integrations/openclaw/piprail && node verify.mjs --live` (handshake + 7 tools + live quote + budget refusal).
- *Future:* Vercel AI SDK / ElizaOS integrations are **not** ClawHub skills (ClawHub is OpenClaw-only) — they ship via their own ecosystems (npm tool / ElizaOS plugin registry); only this one publishes to ClawHub.

## 8.6 Hermes skills tap (`piprail/skills`) — manual `hermes skills publish`

> **Full runbook: [`HERMES.md`](./HERMES.md)** — the three distribution lanes, the tap publish command,
> the external-PR tracking. This §8.6 is the quick version.

The Hermes integration (`integrations/hermes/piprail/`) wraps the same `@piprail/mcp` server for **Hermes
Agent** users, via three lanes: a **skills tap we own** (`piprail/skills` — the manual lane), the
always-works **`hermes mcp add`** path (nothing to deploy), and a **native MCP-catalog PR** (external,
pending). Like ClawHub it's a **separate registry from npm** — a `git push`/tag does nothing to it.

**Re-publish the tap WHEN:** `integrations/hermes/piprail/SKILL.md` (or `config.yaml`/`manifest.yaml`)
changed · the MCP tool set/names changed · the env/config surface changed (e.g. a new `PIPRAIL_*` var).
A routine SDK/MCP patch that doesn't touch the skill content needs **no** re-publish.

**How (the Hermes Agent CLI):**
```bash
hermes --version || echo "install Hermes Agent first"
# bump the SKILL.md frontmatter `version:` first, then push to the tap we own:
hermes skills publish integrations/hermes/piprail --to github --repo piprail/skills
# users then: hermes skills tap add piprail/skills   (the universal `hermes mcp add piprail …` always works too)
```
- **`--repo piprail/skills`** is our tap; pushing there refreshes the listing (needs push rights). If the
  `hermes` CLI isn't handy, the tap is just a git repo — clone `piprail/skills`, copy the updated folder in, commit, push.
- **Verify before publishing:** `cd integrations/hermes/piprail && node verify.mjs --live` (handshake + 7 tools + live quote + budget refusal).
- **External PRs** (native `hermes mcp install piprail` catalog, awesome-hermes-agent, Hermes Atlas) are
  out of our hands and tracked in the root `CLAUDE.md` — they never block a release; swap the site install
  chips to `hermes mcp install piprail` once the catalog PR merges.

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

- 🔴 **`npm publish` failing with `404 Not Found - PUT …` is an EXPIRED TOKEN, not a missing
  package.** npm returns 404 instead of 401 so it never leaks package existence. npm granular
  tokens expire on a **30/60/90-day** default, so a token that worked for months just stops.
  Fix: **`./scripts/rotate-npm-token.sh`** (mints → hidden paste → `gh secret set` → re-runs
  the failed run; `--check` diagnoses without changing anything). **Nothing is half-published** — the version stays free and the
  tag stays valid; never bump the version or re-push the tag to work around it. Full procedure:
  `RELEASING.md` → "The release failed at `npm publish`".

- 🔴 **A multi-commit push can silently skip the Netlify deploy.** `netlify.toml`'s `ignore`
  used `git diff HEAD^ HEAD`, which inspects only the **last** commit of a push. Land a site
  change in commit 1 and anything else in commit 2, and Netlify sees no watched path in
  `HEAD^..HEAD` and **skips the build** — CI is all green, the merge succeeded, and
  piprail.com just quietly stays on the old version. Exactly what happened on PR #83.
  Fixed to diff against **`$CACHED_COMMIT_REF`** (the last commit Netlify actually built),
  which is correct across any number of commits, with an unset-guard that forces a build when
  it cannot tell. **After any merge, verify the site actually changed** — don't assume:
  `curl -s https://piprail.com/llms.txt | sed -n '3p'`.

1. **npm only refreshes the README on publish.** A docs/README-only change is invisible on npm until you cut a patch release.
2. **Build the SDK before the MCP** — the MCP imports the SDK's built `dist`. Push `sdk-v*`, let it land on npm, then `mcp-v*`.
3. **The sync guard fails the build on `llms.txt` drift** (and on chain-count, package, MCP-tool, facilitator or pinned-version drift). Bump the `SDK-Version`/`MCP-Version` headers in the **same commit** as the package bump, or the Netlify/CI build (and the release) stops.
4. **MCP has 4 version files** (`package.json`, `src/version.ts`, `server.json` ×2, `CHANGELOG.md`) — `version.test.ts` fails the gate if they drift.
5. **`server.json` `description` ≤ 100 chars** — the registry 422s a longer one.
6. **GitHub Releases are auto now** — CI cuts them from the tag (§7). Only `gh release create` by hand if CI's step failed (then pass `GH_TOKEN=$(gh auth token)` explicitly — it can 401 otherwise).
7. **MCP registry auto-publishes via OIDC** (§8) — no secret, no human. Re-run on demand with `gh workflow run mcp-registry.yml`. (The runner needs `id-token: write`; that's already set in the workflows.)
8. **`dist/` is gitignored** — CI rebuilds; never commit it.
9. **Don't sweep archival files** — `.claude/plans/**` and old `CHANGELOG` entries are point-in-time; leave them.
10. **The org profile is a different repo** (`piprail/.github`) — this repo's push never touches it.

## The common case, end to end (SDK + MCP docs/patch deploy)

```bash
# 2. bump: sdk/package.json + sdk/CHANGELOG.md ; mcp/{package.json,src/version.ts,server.json,CHANGELOG.md}
# 3. sweep: site/public/llms.txt + llms-full.txt headers (SDK-Version / MCP-Version / Last-Updated)
# 4. gate:
npm run verify-gate                                  # the WHOLE gate, one command
# 5. ship — main is protected: PR required, commits must be signed
git checkout -b release/sdk-vX.Y.Z
git commit -am "release: @piprail/sdk vX.Y.Z + @piprail/mcp vX.Y.Z"
git push -u origin release/sdk-vX.Y.Z
gh pr create --fill && gh pr checks --watch && gh pr merge --squash --admin
git checkout main && git pull
git tag -s sdk-vX.Y.Z -m "@piprail/sdk vX.Y.Z" && git push origin sdk-vX.Y.Z   # → npm + GitHub Release (auto)
git tag -s mcp-vX.Y.Z -m "@piprail/mcp vX.Y.Z" && git push origin mcp-vX.Y.Z   # → npm + Release + registry (auto)
# CI now auto-cuts the GitHub Releases (§7) and refreshes the MCP registry (§8, if MCP_PUBLISHER_PAT set).
# You only: watch the runs → npm view both → verify releases (§7) → external repos if material (§9) → §10.
```
```
