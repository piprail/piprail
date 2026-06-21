# Publishing to npm — runbook

**How PipRail packages get to npm, and how Claude publishes them autonomously.**
Companion to [`SKILL.md`](./SKILL.md) (server deploys) and [`CLAWHUB.md`](./CLAWHUB.md) (ClawHub).

---

## Two publish lanes — don't mix them

| Package(s) | Path | Trigger |
|---|---|---|
| **`@piprail/sdk`**, **`@piprail/mcp`** | Signed git tag → release CI (`release.yml` / `mcp-release.yml`) → npm | `git tag sdk-v… && git push --tags`. **NEVER `npm publish` by hand** (CLAUDE.md). |
| **Standalone integration packages** — e.g. **`@piprail/elizaos-plugin`** (`integrations/elizaos/piprail/`) and any future per-framework package | **`integrations-publish.yml`** workflow → npm (with provenance) | **`gh workflow run integrations-publish.yml -f directory=<path>`** |

These integration packages are **not npm workspaces** and have no tag-CI of their own, so the
`integrations-publish` workflow is their sanctioned path. The "never publish by hand" charter rule is
about the **core SDK/MCP only**.

---

## The autonomous path — `integrations-publish.yml` (use this)

```bash
gh workflow run integrations-publish.yml -f directory=integrations/elizaos/piprail
# then watch:
gh run list --workflow integrations-publish.yml --limit 1
```

The workflow (`.github/workflows/integrations-publish.yml`) is self-contained and safe:
- reads the package **name + version** from `package.json` (no hardcoding),
- **gates**: `npm install` → `build` → `typecheck` → `smoke` (never publishes broken code),
- **idempotent**: skips if that exact `name@version` is already on npm (re-run freely),
- publishes with **`--provenance`** (OIDC supply-chain attestation — the "Built and signed on GitHub
  Actions" badge), `--access public`,
- **verifies** the version is live + writes a job summary with the npm link.

It authenticates with the repo's **`NPM_TOKEN`** Actions secret (`NODE_AUTH_TOKEN`) — a CI-grade token
that **bypasses 2FA**, so no OTP is ever needed.

### ⚠ The token is `@piprail`-scoped → integration packages MUST be `@piprail/*`
`NPM_TOKEN` can publish the **`@piprail`** scope (it ships `@piprail/sdk` + `@piprail/mcp`). It **cannot
publish an unscoped package** — `npm publish elizaos-plugin-piprail` (unscoped) fails with `403 You may
not perform that action with these credentials`. **That's why the elizaOS plugin is
`@piprail/elizaos-plugin`, not the unscoped `elizaos-plugin-piprail`.** Name any new integration package
under `@piprail/…` so this workflow can publish it. (elizaOS discovery is keyword-based — `keywords`
includes `elizaos` — so the scope doesn't affect discoverability.)

### Releasing a new version
Bump `version` in the package's `package.json`, commit, then re-run the workflow. (npm forbids
republishing the same version; the workflow's skip-check makes that a clean no-op rather than a failure.)

---

## Local manual publish (fallback only)

The npm account is **`johnweeks`** (`npm whoami`) and it **enforces 2FA on writes**. An interactive
`npm login` session authenticates `whoami` but **does not bypass 2FA for publish** (→ `E403`). To
publish locally you need a **bypass-2FA token** in `~/.npmrc`
(`//registry.npmjs.org/:_authToken=<token>`, from npmjs.com → Access Tokens → **Automation**, or a
Granular token with "Bypass 2FA"), or a fresh `--otp=<6-digit code>`. Prefer the CI workflow above.

---

## After publishing `@piprail/elizaos-plugin` — the elizaOS registry PR (optional, discoverability)

The elizaOS runtime auto-discovers any npm package whose `keywords` include `elizaos`, so the registry
entry is curation only. To add it: PR the ready-made
[`registry-entry.json`](../../../integrations/elizaos/piprail/registry-entry.json) into
`elizaOS/eliza` under `packages/registry/entries/third-party/`, then
`bun run --cwd packages/registry generate`. (`elizaos publish` does npm + this PR in one step, if the
CLI is installed.)

---

## Security invariants (do not violate)

- **Never commit or print an npm token / private key.** The CI secret `NPM_TOKEN` is write-only; the
  local token lives only in `~/.npmrc` (never tracked — no `.npmrc` is in the repo).
- **Re-verify identity before any local publish** (`npm whoami` → `johnweeks`).
- New integration packages → name them **`@piprail/…`** (so `NPM_TOKEN` can publish them) with a
  `keywords` entry for the framework's discovery (e.g. `elizaos`).
