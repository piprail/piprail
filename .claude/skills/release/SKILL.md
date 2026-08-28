---
name: release
description: >-
  The do-it-every-time playbook for cutting a versioned release of @piprail/sdk
  or @piprail/mcp to npm — the verification gate, which files to bump, the
  CI build-order gotcha, the signed tag that triggers publish, the GitHub
  Release, and the MCP-registry step. Use whenever the task is "release",
  "publish", "cut a version", "ship the SDK/MCP to npm", "bump the version", or
  "tag a release". Publishing is tag-driven CI — never `npm publish` by hand.
---

# Releasing PipRail (`@piprail/sdk` · `@piprail/mcp`)

> **Shipping a real change? Start with the [`deploy`](../deploy/SKILL.md) skill** — the master
> runbook that also covers the doc/`llms.txt` surface sweep, the site/docs deploys, and the external
> repos. **This file is the focused npm tag-and-publish mechanics** that `deploy` Phases 5–8 use.

Publishing is **tag-driven CI**, not a manual `npm publish`. You bump versions,
push a signed tag, and a GitHub Action builds + publishes with the repo's
`NPM_TOKEN`. The **site** is separate: it auto-deploys to Netlify on every push
to `main` — no tag, no action needed.

> One package per tag. `sdk-v*` publishes `@piprail/sdk`; `mcp-v*` publishes
> `@piprail/mcp`. They are independent — release only what changed.

---

## The iron rules

1. **Never `npm publish` by hand.** Only a pushed `sdk-v*` / `mcp-v*` tag publishes
   (workflows `release.yml` / `mcp-release.yml`). Hand-publishing bypasses the gate
   and the lockstep build order.
2. **The gate must be green first.** `prepublishOnly` re-runs build + test + typecheck
   (SDK also `typecheck:test`) in CI, so a red gate *fails the release*. Note it does
   **not** re-run the lazy-chunk grep — that tripwire only runs in your local gate, so
   never skip it. Catch everything locally first (see the `verify-gate` skill).
3. **SemVer + Keep a Changelog.** Patch = fixes, minor = additive/opt-in (defaults
   never change), major = a breaking change. Every release gets a `CHANGELOG.md` entry.
4. **Build the SDK before the MCP.** `@piprail/mcp` imports the SDK's built `dist`.
   `mcp-release.yml` already does `build -w @piprail/sdk` *before* `build -w @piprail/mcp` —
   don't reorder it. If you release both, **release the SDK first** so the MCP resolves
   the published SDK.
5. **Tags are signed.** `git tag -s` (so GitHub shows "Verified").

---

## Procedure

### 0. Decide the package + the version
Pick the new SemVer number. Confirm what actually changed since the last tag
(`git log <last-tag>..HEAD -- sdk/` or `-- mcp/`).

### 1. Run the verification gate (must be green)
See the **`verify-gate`** skill. In short, from the repo root:
```bash
npm run typecheck                       # sdk + mcp type-check
npm run typecheck:test -w @piprail/sdk  # src + tests together
npm run test:sdk                        # (and test:mcp if releasing the MCP)
npm run build:sdk                       # (and build:mcp)
grep -E "from ?['\"]@(solana|ton|stellar)" sdk/dist/index.js   # → expect NO matches
```

### 2. Bump the version in **every** file (don't miss one)
- **SDK release** — `sdk/package.json` (`version`) **and** `sdk/CHANGELOG.md` (new
  dated entry, newest first; add the version-footer link).
- **MCP release** — `mcp/package.json` (`version`) **and** `mcp/CHANGELOG.md` **and**
  `mcp/server.json` (`version`, and the `packages[0].version` — the MCP registry reads
  these) **and** `mcp/src/version.ts` (the `VERSION` constant — reported to clients over MCP
  and in the startup banner). **All four must match** — the `version.test.ts` guard fails the
  gate if they drift (0.2.0 shipped a stale `VERSION` because this file was missed; don't repeat it).

### 3. Land the release commit on `main` — **via a PR**
`main` is protected (`protect-main`): pull request required, **signed commits required**, no
force-push. An admin can bypass, but that skips the `pull_request` CI — the run you most want on a
release commit.
```bash
git checkout -b release/sdk-vX.Y.Z
git commit -am "release: @piprail/sdk vX.Y.Z"   # or @piprail/mcp — auto-signed
git push -u origin release/sdk-vX.Y.Z
gh pr create --fill && gh pr checks --watch && gh pr merge --squash --admin
git checkout main && git pull
```

### 4. Tag + push (this is what publishes)
```bash
git tag -s sdk-vX.Y.Z -m "@piprail/sdk vX.Y.Z"   # or  mcp-vX.Y.Z
git push origin sdk-vX.Y.Z
```
The matching workflow runs the gate (`prepublishOnly`) and publishes to npm.

### 5. Confirm it published
Watch the Action (`gh run watch` / the Actions tab — it shows as **sdk-release** / **mcp-release**, the workflow `name:`). Then verify npm shows the new
version: `npm view @piprail/sdk version`. If the Action failed at the build step for
the MCP, it's almost always the **SDK-not-built-first** gotcha (rule 4).

### 6. Create the GitHub Release from the tag
```bash
gh release create sdk-vX.Y.Z --verify-tag --title "@piprail/sdk vX.Y.Z — <headline>" \
  --latest --notes "<summary; link to the CHANGELOG>"
```
Mark the newest **SDK** release `--latest`; MCP releases use `--latest=false`.

### 7. MCP only — the registry
After `mcp-vX.Y.Z` publishes to npm, refresh the MCP registry (interactive, owner-only):
```bash
cd mcp && mcp-publisher login github && mcp-publisher publish   # reads ./server.json
```
The `io.github.piprail/*` namespace is authorized by piprail-org membership.

---

## Don'ts
- Don't bump `package.json` but forget `CHANGELOG.md` (or, for MCP, `server.json`).
- Don't tag before the version bump is committed — the tag must point at the bump.
- Don't ship with a red gate; don't reorder the SDK→MCP build; don't hand-publish.
