# Releasing PipRail

> **The full deployment runbook is the [`deploy`](.claude/skills/deploy/SKILL.md) skill** (run `/deploy`) —
> it covers the doc/`llms.txt` surface sweep, the site + docs deploys, the GitHub Releases, the MCP
> registry, and the external repos, with this file's npm mechanics folded in. This doc is the focused
> tag-and-publish reference.

How a maintainer ships a new version of **`@piprail/sdk`** or **`@piprail/mcp`**. Publishing is
**tag-driven CI**, not a manual `npm publish`: you bump versions, push a tag, and a GitHub Action
builds + publishes with the repo's `NPM_TOKEN`. The **site** is separate — it auto-deploys to Netlify
on every push to `main` (no tag needed).

> One package per tag. `sdk-v*` publishes `@piprail/sdk`; `mcp-v*` publishes `@piprail/mcp`;
> `create-piprail-v*` publishes `@piprail/create` (the merchant scaffolder, run via `npm create @piprail`).
> They are independent —
> release only what changed. If you release **both** the SDK and MCP, release the **SDK first** (the MCP
> depends on the SDK's published `dist`). The scaffolder generates apps that `npm install @piprail/sdk`
> at `latest`, so a scaffolder release that needs new SDK exports should follow the **SDK** release.

---

## The rules

1. **Never `npm publish` by hand.** Only a pushed `sdk-v*` / `mcp-v*` tag publishes (workflows
   `.github/workflows/release.yml` / `mcp-release.yml`). Hand-publishing bypasses the gate.
2. **The gate must be green first.** `prepublishOnly` re-runs build + test + typecheck at publish
   time, so a red gate *fails the release*. It does **not** run the lazy-chunk grep, the surface-map
   sync guard, the ops-script parse or the env-loader tests — so never skip
   **`npm run verify-gate`**, which is all of it in one command (see `.claude/skills/verify-gate`).
   Since 2026-08-28 `sdk.yml` also runs the lazy-chunk invariant and `npm run sync` on every push
   and PR, so drift is caught on `main` rather than at the tag — but the local gate is still the
   only place the *whole* set runs together.
3. **SemVer + [Keep a Changelog](https://keepachangelog.com/).** Patch = fixes, minor = additive/opt-in
   (defaults never change), major = a breaking change. Every release gets a dated `CHANGELOG.md` entry,
   newest first.
4. **Build the SDK before the MCP.** `mcp-release.yml` already builds `@piprail/sdk` before
   `@piprail/mcp`. If you release both, push the SDK tag first and let it land on npm before the MCP tag.

---

## Steps

### 0. Decide the package + version
Confirm what changed since the last tag: `git log <last-tag>..HEAD -- sdk/` (or `-- mcp/`). Pick the
SemVer bump.

### 1. Run the verification gate (must be green)
From the repo root — **one command, the whole gate**:
```bash
npm run verify-gate          # everything below, in the order that matters
```
It runs, in dependency order: `build:sdk` (first — the MCP resolves the SDK's built `dist`) →
`typecheck` (sdk + mcp) → `typecheck:test` for **both** workspaces (the root typecheck does *not*
cover MCP tests) → `test:sdk` → `test:mcp` → `build:mcp` → the **lazy-chunk invariant** → the
**ops-script parse** → the **env-loader tests** → **`npm run sync`** (48 rules) → `build` site →
`build:docs`. `--quick` skips the two site/docs builds; **never use it for a release.**

### 2. Bump the version in **every** file (don't miss one)

**SDK** — two files:
- `sdk/package.json` → `version`
- `sdk/CHANGELOG.md` → new dated entry (+ the version-footer link)

**MCP** — **four** files, all must match (a `version.test.ts` guard fails the gate if they drift):
- `mcp/package.json` → `version`
- `mcp/src/version.ts` → the `VERSION` constant (reported to clients over MCP + in the startup banner — **easy to miss**; 0.2.0 shipped a stale value because of this)
- `mcp/server.json` → `version` **and** `packages[0].version` (the MCP registry reads these)
- `mcp/CHANGELOG.md` → new dated entry

> **MCP `server.json` description ≤ 100 chars.** The MCP registry rejects a longer `description` with a
> 422. A guard test enforces this; keep it punchy.

> **Don't forget the docs.** A released version is a *fact that lives in many places.* After bumping,
> follow the surfaces map in `.claude/skills/docs-sync` — at minimum the `Last-Updated` / `SDK-Version`
> / `MCP-Version` header in `site/public/llms.txt` + `llms-full.txt`, and the JSON-LD in
> `site/src/layouts/Layout.astro`. The **org profile is a separate repo** (`piprail/.github` →
> `profile/README.md`) — nothing here updates it.

### 3. Land the release commit on `main` — **via a PR**
`main` is protected by the `protect-main` ruleset: pull request required, signed commits required,
no force-push, no deletion. A repo **admin can bypass** and push straight to `main`, and this step
used to say `git push origin main` — but bypassing skips the `pull_request` CI, which is exactly
the run you want on a release commit. Use the PR:
```bash
git checkout -b release/sdk-vX.Y.Z
git commit -am "release: @piprail/sdk vX.Y.Z"   # signed automatically (tag.gpgsign/commit.gpgsign)
git push -u origin release/sdk-vX.Y.Z
gh pr create --fill && gh pr merge --squash --admin   # solo is fine: 0 approvals required
git checkout main && git pull
```
> Commits **must be signed** (`required_signatures`). Configure once:
> `git config gpg.format ssh && git config user.signingkey ~/.ssh/id_rsa.pub && git config commit.gpgsign true`.
> Locally `git log --pretty='%G?'` may print `E` ("cannot check") without an `allowed_signers`
> file — that is fine; GitHub verifies against the signing key registered on your account.

### 4. Tag + push (this is what publishes)
```bash
git tag -s sdk-vX.Y.Z -m "@piprail/sdk vX.Y.Z"   # or  mcp-vX.Y.Z
git push origin sdk-vX.Y.Z
```
The matching workflow runs the gate and publishes to npm.

> **Signing is recommended, not required.** `git tag -s` gives GitHub a "Verified" badge but needs a
> signing key configured. No key? `git tag -a sdk-vX.Y.Z -m "…"` (annotated, unsigned) triggers the
> exact same publish — just no badge. (To enable signing once: register an SSH signing key on GitHub,
> then `git config gpg.format ssh && git config user.signingkey <key> && git config tag.gpgsign true`.)

### 5. Confirm it published
Watch the Action (Actions tab → **sdk-release** / **mcp-release**, or `gh run watch`). Then:
```bash
npm view @piprail/sdk version    # shows X.Y.Z
```
If the MCP Action failed at the build step, it's almost always the SDK-not-built-first gotcha (rule 4).

### 6. Create the GitHub Release
```bash
gh release create sdk-vX.Y.Z --verify-tag --latest \
  --title "@piprail/sdk vX.Y.Z — <headline>" --notes "<summary; link to the CHANGELOG>"
```
Mark the newest **SDK** release `--latest`; **MCP** releases use `--latest=false`.

### 7. MCP only — refresh the registry listing
After `mcp-vX.Y.Z` is on npm, publish the manifest to the MCP registry so the listing matches:
```bash
cd mcp
mcp-publisher validate                              # catches the ≤100-char description + schema issues
mcp-publisher login github                          # interactive device flow (a human enters the github.com/login/device code)
mcp-publisher publish                               # reads ./server.json → io.github.piprail/mcp
```
**Auth gotcha (verified):** the registry's token-exchange **rejects the gh-CLI OAuth token** — `mcp-publisher
login github -token "$(gh auth token)"` 401s with "failed to get GitHub user", even though that token
authenticates to GitHub's own API fine. The `-token` flag needs a **classic or fine-grained PAT** with
`read:org` (github.com/settings/tokens), **not** `$(gh auth token)`. So use either the interactive device
flow above, or `mcp-publisher login github -token ghp_…` with a real PAT. The `io.github.piprail/*`
namespace is authorized by **public** membership of the `piprail` GitHub org — if `publish` returns 403,
make your org membership public (<https://github.com/orgs/piprail/people>) and re-run `login`.

---

## Post-release checklist
- [ ] `npm view @piprail/<pkg> version` shows the new version
- [ ] GitHub Release created (`--latest` for SDK, `--latest=false` for MCP)
- [ ] **MCP:** registry listing refreshed (`mcp-publisher publish` succeeded)
- [ ] Docs swept (`docs-sync`): `llms.txt` + `llms-full.txt` headers, site JSON-LD, and the
      `piprail/.github` org profile if anything user-facing changed
- [ ] `CHANGELOG.md` entry is dated and accurate

---

## The release failed at `npm publish` — read this first

### `404 Not Found - PUT https://registry.npmjs.org/@piprail%2fsdk`

**This is an AUTH failure, not a missing package.** npm answers a publish with an invalid or
expired token as **404 rather than 401**, deliberately, so it never reveals whether a private
package exists. The package obviously exists — you can `npm view` it. Do not go looking for a
typo'd package name.

**Cause, in order of likelihood:**
1. **`NPM_TOKEN` has expired.** npm granular access tokens default to **30/60/90-day** expiry, so
   a token that has published happily for months simply stops one day. `gh secret list` shows the
   date it was *created*, which is the only age signal you get.
2. The token was revoked, or lacks **write** on the `@piprail` scope.

**Fix — there is a script for this.** Only a human can mint the token (it needs an npm browser
login), so the script walks you through it and does the rest:
```bash
./scripts/rotate-npm-token.sh --check   # diagnose only: versions, secret age, the failed run id
./scripts/rotate-npm-token.sh           # mint → paste (hidden) → gh secret set → re-run → verify
```
The token is read with `read -s`, so it is never echoed, never written to disk, and never appears
in argv (no shell history, no `ps`, no log). It goes straight to `gh secret set`, which is
write-only afterwards. The script never runs `npm publish` — publishing stays tag-driven CI.

Doing it by hand is the same three steps:
```bash
# 1. npmjs.com → Access Tokens → Generate New Token → Granular
#    • Packages and scopes: Read and write   • Scope: @piprail   • Expiry: set a reminder
#    The 'johnweeks' account enforces 2FA on writes, so CI needs an Automation token
#    (or a Granular one with "Bypass 2FA").
# 2. store it (never paste a token into a file or a commit):
gh secret set NPM_TOKEN            # paste at the prompt; it is write-only after this
# 3. re-run the SAME failed run — the tag is already pushed, nothing needs re-tagging:
gh run rerun <run-id> --failed
npm view @piprail/sdk version      # confirm
```

> **Nothing is half-published.** npm rejected the whole request, so the registry is untouched and
> the version number stays free. The tag stays valid and reusable — **do not** bump to a new
> version to "get around it", and do not delete and re-push the tag.

> ⚠️ **While it is broken, the site advertises the unpublished version.** `llms.txt` mirrors
> `sdk/package.json`, not npm, so the sync guard is happy while the world disagrees. Rotate,
> re-run, done — or, if the fix will be slow, revert the version bump.

**It is not GitHub Actions minutes.** This repo is **public**, so Actions minutes are unlimited
and free. A minutes problem looks like runs that never start; this one ran every step and failed
only at the registry call.

---

## When a release goes wrong — rollback

**There was no rollback procedure here until 2026-08-28.** The single most important fact:

> 🔴 **A published npm version can never be replaced.** `npm publish` on an existing version is a
> hard error, and `npm unpublish` is only permitted within **72 hours** — and even then it *breaks*
> every lockfile that already pinned it. **Rolling forward is almost always right.**

### The fast mitigation (seconds) — move `latest` back
Consumers install `latest`. Repointing it stops the bleeding without touching what is published:
```bash
npm dist-tag add @piprail/sdk@<LAST_GOOD> latest     # e.g. 2.15.0
npm view @piprail/sdk dist-tags                       # confirm
```
New installs immediately get the good version again. The bad version stays on the registry (people
who pinned it keep working) but nobody new receives it.

### Then mark it, so nobody installs it deliberately
```bash
npm deprecate @piprail/sdk@<BAD> "Broken <what>; use <LAST_GOOD> or later. See CHANGELOG."
```
`npm install` prints this warning. It is reversible: `npm deprecate <pkg>@<ver> ""`.

### Then roll forward
Fix, bump a **patch**, and release normally (steps 1-6). Re-point `latest` if you moved it:
```bash
npm dist-tag add @piprail/sdk@<NEW_PATCH> latest
```

### Rolling back the sites (independent of npm — no tag involved)
- **piprail.com (Netlify):** the previous deploy is one click — Netlify → Deploys → the last good
  one → **Publish deploy**. Instant, no rebuild. Then fix forward in git; the next merge to `main`
  supersedes it.
- **docs.piprail.com (GitHub Pages):** no instant rollback. Revert the commit via a PR
  (`git revert <sha>`) and let `deploy-docs.yml` rebuild.

### What a deleted tag does and does not do
Deleting `sdk-vX.Y.Z` (`git push --delete origin sdk-vX.Y.Z`) **does not unpublish anything** — the
npm version and the GitHub Release both survive. Delete a tag only to correct one pushed by mistake
*before* its workflow published, which is a narrow window. Never re-use a tag name.

### MCP registry
The registry mirrors whatever `mcp/server.json` last published. After a rollback release, re-run
the publish (step 7) so the listed version matches npm again.

### Rollback checklist
- [ ] `latest` points at a known-good version (`npm view <pkg> dist-tags`)
- [ ] bad version deprecated with a message naming the fix
- [ ] site rolled back (Netlify) and/or docs reverted, if they were affected
- [ ] patch released and `latest` re-pointed at it
- [ ] MCP registry re-published if the MCP was involved
- [ ] `CHANGELOG.md` records what broke and what fixed it — never silently

---

## Keeping the site in sync — the deploy guard

The site states the same facts as the packages (versions, the MCP tool set), and those can drift.
**You don't have to remember to check — the build does it for you.**

`site/scripts/check-sync.mjs` runs as the site's **`prebuild`** hook, so it executes on *every*
`npm run build` — locally, in CI (`site.yml`), and on the **Netlify deploy** — and it also runs in the
SDK/MCP release workflows. It **fails the build** (exit 1) if:

- the `SDK-Version` / `MCP-Version` headers in `site/public/llms.txt` or `llms-full.txt` don't match
  `sdk/package.json` / `mcp/package.json`, or
- any MCP tool name (there are **8**) is missing from `llms.txt`, `llms-full.txt`, `mcp/README.md`,
  or `sdk/README.md` — the list is derived from the SDK's own `paymentTools()`, never hard-coded.

Run it anytime: **`npm run sync`** (or `node site/scripts/check-sync.mjs`, which delegates to it).

As of 2026-08-28 this is no longer just a version check — it is **48 rules across 13 domains**
(chains · packages · mcp · facilitators · discovery · site · docs · api · errors · ci · security ·
seo · skills), each declaring the fact's owner and every file that mirrors it. Two modes worth
knowing:

```bash
npm run sync -- --touched mcp/package.json   # "I bumped this — what else must change?"
npm run sync -- --graph                      # the whole source → mirror map
```

Human map: `.claude/SURFACES.md`. Rules: `scripts/sync/rules.mjs`.

So the enforcement chain is: a release bumps the package **and** the `llms.txt` headers in the same
commit → the release workflow's guard passes → Netlify rebuilds the site → its `prebuild` guard passes
→ the fresh, in-sync files go live. Forget the `llms.txt` bump and the guard stops you before publish.

### Every-deploy checklist (the guard enforces the ★ items; the rest are judgement calls)
- [ ] ★ `llms.txt` + `llms-full.txt` `SDK-Version` / `MCP-Version` headers match the packages
- [ ] ★ every MCP tool name (8) present across the AEO files + READMEs
- [ ] `Last-Updated` header in `llms.txt` / `llms-full.txt` bumped to today
- [ ] new user-facing feature? added to `llms-full.txt`, the relevant site page, and the
      `Layout.astro` JSON-LD `featureList` (what answer engines extract)
- [ ] chain/token count changed? swept via the `docs-sync` skill (counts live in many places)
- [ ] org profile (`piprail/.github`) still accurate (separate repo)

> Want to widen the guard (e.g. assert the chain count, or block a stale `Last-Updated`)? Add a check
> to `scripts/sync/rules.mjs` — plain Node, no deps, and already wired into every build via
> `site/scripts/check-sync.mjs`. Derive the expected value in `scripts/sync/sources.mjs`; never
> hard-code it in the rule, or the guard becomes one more copy that can rot.
