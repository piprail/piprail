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

## 🔑 The token model — read this before debugging any publish failure

**The account `johnweeks` is `two-factor auth: auth-and-writes`** (`npm profile get`). That single
setting explains every publish failure below: npm refuses **any** publish unless the credential is
one that is explicitly allowed to bypass 2FA. A valid, correctly-scoped token is **not enough**.

| Credential | Can publish from CI? | Why |
|---|---|---|
| Web-login session (`npm login`) → `~/.npmrc` | ❌ | authenticates, but `auth-and-writes` demands an OTP |
| Granular token, read+write, **without** Bypass 2FA | ❌ | authenticates → **403**, "bypass 2fa … is required" |
| **Granular token, read+write on `@piprail`, ☑️ Bypass 2FA** | ✅ | **this is the one CI needs** |
| Classic → **Automation** token | ✅ | bypasses 2FA by design, but npm is deprecating these |

### The 2026-08-28 outage, from the token list — the whole failure in one table

| Token | Bypass 2FA | Created | Expires | |
|---|---|---|---|---|
| `piprail-sdk-publish-gha` | ✅ | May 30 2026 | **Aug 28 2026** | **Expired — the CI token, dead that same day** |
| `piprail-ci` | ❌ | Aug 28 2026 | Nov 26 2026 | the replacement, missing the flag → 403 |

The original CI token was correct in every way **and simply reached its 90-day expiry**, which is why
a pipeline that had worked for months failed with no code change. The replacement authenticated
(404 → 403) but could not publish until **Bypass 2FA** was ticked.

🔴 **Ticking Bypass 2FA on an existing token does NOT change its value**, so the `NPM_TOKEN` secret
does not need re-setting — just re-run the failed workflow. Check the flag in the **Bypass 2FA
column of the token list**; it is the fastest way to see what is wrong.

> ☑️ **The "Bypass two-factor authentication" checkbox is the whole game.** It is easy to miss on the
> Granular Access Token form, and missing it produces a 403 that reads like a permissions problem.

### Minting the right token
`npmjs.com` → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**
- **Expiration** — the longest offered, **and set a calendar reminder for the day before.**
  Expiry is the single most likely cause of a future failure (see below).
- **Packages and scopes → Permissions**: **Read and write**
- **Select packages**: *Only select packages and scopes* → the **`@piprail`** scope
- ☑️ **Bypass two-factor authentication**

Then: `./scripts/rotate-npm-token.sh` (or `gh secret set NPM_TOKEN`) → `gh run rerun <id> --failed`.

---

## 🚨 Publish error decoder (all three seen live on 2026-08-28)

| Error | What it ACTUALLY means | Fix |
|---|---|---|
| **`404 Not Found - PUT …/@piprail%2fsdk`** | **The token is expired or revoked.** npm answers an unauthenticated publish with **404, not 401**, deliberately, so it never leaks whether a package exists. **It is not a missing package** — `npm view` it and see. | rotate the token |
| **`403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`** | The token is **valid and authenticating** (that is why it is 403 and no longer 404) but lacks **Bypass 2FA**. | re-mint with ☑️ Bypass 2FA |
| **`E401` on `npm whoami`** | The local `~/.npmrc` token is dead. Unrelated to CI, but usually the same token, expiring at the same time. | `npm login --auth-type=web` |

**404 → 403 is progress**, not a new problem: you moved from "no credential" to "credential, wrong kind".

### It is almost never GitHub Actions minutes
This repo is **public**, so Actions minutes are **unlimited and free**. A minutes problem looks like
runs that **never start**. If checkout, `npm ci` and the build all ran and it died at the registry
call, it is the token. Confirm with `gh run list` (runs completing at all) and `gh repo view --json visibility`.

### Nothing is ever half-published
npm rejects the whole request, so the registry is untouched, **the version number stays free, and
the pushed tag stays valid and reusable**. Re-run the *same* failed run:
`gh run rerun <run-id> --failed`. **Never** bump the version or delete/re-push the tag to "get
around it" — that burns a version for no reason and breaks the CHANGELOG.

> ⚠️ While a release is stuck, the **site advertises the unpublished version**. `llms.txt` mirrors
> `sdk/package.json`, not npm, so the sync guard is green while the world disagrees. That is the
> correct design (a build guard must not depend on the network) — just know it is expected.

---

## 🤖 What an agent can and cannot do here

Documented so nobody re-derives it under pressure. An agent **can** do everything except mint:

| Step | Agent? | Notes |
|---|---|---|
| Diagnose the failure, read run logs | ✅ | `gh run view <id> --log` |
| `npm login --auth-type=web` | ⚠️ partly | it can start it and hand you the URL; **you** complete the browser auth |
| **Mint the token** | ❌ | needs your authenticated npm session + 2FA. `npm token create` demands the account **password** on an interactive TTY and cannot be piped |
| Get the token into GitHub | ✅ | `pbpaste \| gh secret set NPM_TOKEN` — copy it, the agent never sees or logs it |
| Re-run the release, verify, cut/confirm the Release | ✅ | |

### 🔴 Never paste a token into a chat/agent message
It lands in the conversation transcript (on disk under `~/.claude/projects/**/*.jsonl` **and** in the
provider's systems) and cannot be redacted afterwards. A token pasted that way must be treated as
**compromised: revoke it after use.** Use the clipboard hand-off instead — copy the token, tell the
agent "continue", and it reads `pbpaste` without the value ever entering the log.
(Screenshots of a token are the same problem; `.gitignore` covers `Screenshot*.png`, which stops it
reaching git but not your disk.)

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
