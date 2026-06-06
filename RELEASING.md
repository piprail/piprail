# Releasing PipRail

How a maintainer ships a new version of **`@piprail/sdk`** or **`@piprail/mcp`**. Publishing is
**tag-driven CI**, not a manual `npm publish`: you bump versions, push a tag, and a GitHub Action
builds + publishes with the repo's `NPM_TOKEN`. The **site** is separate — it auto-deploys to Netlify
on every push to `main` (no tag needed).

> One package per tag. `sdk-v*` publishes `@piprail/sdk`; `mcp-v*` publishes `@piprail/mcp`. They are
> independent — release only what changed. If you release **both**, release the **SDK first** (the MCP
> depends on the SDK's published `dist`).

---

## The rules

1. **Never `npm publish` by hand.** Only a pushed `sdk-v*` / `mcp-v*` tag publishes (workflows
   `.github/workflows/release.yml` / `mcp-release.yml`). Hand-publishing bypasses the gate.
2. **The gate must be green first.** `prepublishOnly` re-runs build + test + typecheck in CI, so a red
   gate *fails the release*. It does **not** re-run the lazy-chunk grep — that runs only in your local
   gate, so never skip `npm run verify-gate` (see `.claude/skills/verify-gate`).
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
From the repo root:
```bash
npm run typecheck                                  # sdk + mcp
npm run typecheck:test -w @piprail/sdk             # src + tests together
npm run test:sdk                                   # (and test:mcp if releasing the MCP)
npm run build:sdk                                  # (and build:mcp)
grep -E "from ?['\"]@(solana|ton|stellar)" sdk/dist/index.js   # → expect NO matches (lazy-chunk invariant)
```

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

### 3. Commit on `main`
```bash
git commit -am "release: @piprail/sdk vX.Y.Z"   # or @piprail/mcp vX.Y.Z
git push origin main
```

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
mcp-publisher login github                          # interactive device flow; or: login github --token "$(gh auth token)"
mcp-publisher publish                               # reads ./server.json → io.github.piprail/mcp
```
The `io.github.piprail/*` namespace is authorized by **public** membership of the `piprail` GitHub org —
if `publish` returns 403, make your org membership public
(<https://github.com/orgs/piprail/people>) and re-run `login` (the token caches permissions at login).

---

## Post-release checklist
- [ ] `npm view @piprail/<pkg> version` shows the new version
- [ ] GitHub Release created (`--latest` for SDK, `--latest=false` for MCP)
- [ ] **MCP:** registry listing refreshed (`mcp-publisher publish` succeeded)
- [ ] Docs swept (`docs-sync`): `llms.txt` + `llms-full.txt` headers, site JSON-LD, and the
      `piprail/.github` org profile if anything user-facing changed
- [ ] `CHANGELOG.md` entry is dated and accurate
