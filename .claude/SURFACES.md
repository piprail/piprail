# SURFACES — what is linked to what

**PipRail states the same fact in a lot of places.** The chain count lives in nine files (one is a
URL-encoded shields badge that a plain grep for the number *misses*). The MCP tool list exists in
four. The facilitator registry in nine. Every one of those is a chance to ship a contradiction —
and we have shipped one: the SDK's facilitator registry was corrected on 2026-08-28 and the docs
site, the website data and a live mainnet example probe went on advertising two dead hosts.

This file is the human map. **The machine map is `npm run sync`**, and the two cannot disagree,
because a rule in the checker fails if a domain here is missing.

```bash
npm run verify-gate                           # the WHOLE gate in one command (--quick to skip builds)
npm run sync                                  # is anything out of sync right now?
npm run sync -- --graph                       # print every source → mirror link
npm run sync -- --touched sdk/src/facilitators.ts   # "I changed this — what else must change?"
npm run sync -- --domain chains               # one domain
npm run sync -- --only tool-names             # one rule
```

`--touched` is the one to reach for mid-task. It reads the same rule definitions that just ran, so
unlike a prose checklist it cannot rot.

---

## The rule

> **One owner per fact.** Everything else is a mirror and must be derived, generated, or guarded.
> If you find yourself hand-maintaining a second copy, that is the bug — fix the copy, then add a
> rule so the next one is caught.

Three ways a mirror stays honest, best first:

| | Mechanism | Example |
|---|---|---|
| 1 | **Generated** — the mirror is a build artifact | `site/src/data/facilitators.ts` ← `gen-facilitators.mjs` |
| 2 | **Derived at render** — the page computes from data | every count on `/facilitators` and `/chains` |
| 3 | **Guarded** — prose, held to the source by a check | the chain count in `llms.txt`, the MCP tool list |

Prefer wording that cannot rot ("every chain", not "29 chains") over anything needing a guard.

---

## Domains

### `chains` — the chain, family and token set
**Source of truth: `sdk/src/drivers/`** (one folder per family; EVM presets in `evm/chains.ts`).
The public count is *EVM presets + one per non-EVM family*.

| Mirror | What it holds |
|---|---|
| `README.md` | 🔴 the **shields.io badge** — `chains-29%20across%2010%20families`, URL-encoded |
| `AGENTS.md` | the intro sentence |
| `sdk/package.json` | the npm `description` — this is what shows on npmjs.com |
| `site/public/llms.txt` · `llms-full.txt` | the summary, the chain bullet, "The N chains, by family" |
| `site/src/layouts/Layout.astro` | JSON-LD `featureList` + the meta description |
| `site/src/data/chains.ts` | the chain grid (+ a token badge needs `site/public/tokens/<sym>.svg`) |
| `site/src/pages/index.astro` | the stat tile, hero prose, FAQs |
| `site/src/data/posts.ts` | blog post descriptions |
| `docs/src/content/docs/chains/*` | the per-family reference — **canonical** for setup + caveats |
| `sdk/src/indexes.ts` | `SLUG_TO_CAIP2` — ⚠️ see the correction below |
| **`piprail/.github`** | ⚠️ **A SEPARATE REPO.** `profile/README.md` holds the logo grid + count |

🔴 **The EVM sub-count rots independently of the grand total.** "20 EVM mainnets" and "29 chains"
are two different numbers in the same sentences; the checker asserts both.

⚠️ **Correction to older guidance:** `docs-sync` used to say "`SLUG_TO_CAIP2` gains one entry per new
chain". **That is wrong.** It is deliberately partial — it maps only the slugs the *open indexes*
name, and EVM chains beyond those resolve through the client's own `net.supports()`. What IS a hard
invariant: every **non-EVM** entry must equal that family driver's own CAIP-2 id. Guarded by
`nonevm-caip2`.

**`token-registry`** — every built-in EVM token is EIP-55 checksummed with a matching symbol key
and plausible decimals (40 entries). Deliberately **offline**: on-chain confirmation belongs to the
`add-chain-integration` skill at authoring time, and making `npm run sync` hit ~20 RPCs would make
it slow and flaky, with a rate-limited node reporting a false failure about a fine token.

**`driver-contract`** — every family implements all **11 REQUIRED** `ResolvedNetwork` methods.
The other 10 are optional and deliberately family-specific (`payExact`, `settleExactSelf`,
`payUpto`, the Permit2 helpers…); an early draft flagged nine families for "missing" methods they
are not supposed to have.

Playbook: **`add-chain-integration`** skill.

---

### `packages` — versions and what exists
**Source of truth: each `package.json`.** Five packages are published to npm:
`@piprail/sdk`, `@piprail/mcp`, `@piprail/create`, `@piprail/elizaos-plugin`,
`@piprail/n8n-nodes-piprail`.

| Mirror | What it holds |
|---|---|
| `site/public/llms.txt` · `llms-full.txt` | the `SDK-Version` / `MCP-Version` headers — **AI crawlers read these** |
| `mcp/server.json` | 🔴 the version appears **TWICE** — top level *and* `packages[].version` |
| `integrations/hermes/piprail/manifest.yaml` | pins `@piprail/mcp@X` in its install args |
| `README.md` | the "What's here" table must name every published package |

🔴 **`create-piprail` was invisible.** A published package that appeared in no README and neither
AEO file — found by this checker on 2026-08-28, now fixed and guarded.

Playbook: **`release`** skill · `RELEASING.md`.

---

### `mcp` — the tool set
**Source of truth: `sdk/src/agent.ts` → `paymentTools()`.** Everything else is a copy.

| Mirror | What it holds |
|---|---|
| `mcp/src/banner.ts` | `TOOL_NAMES` — a hand-copy of `paymentTools()` |
| `mcp/README.md` | the tools table |
| `site/public/llms.txt` · `llms-full.txt` | the MCP section |
| `site/src/pages/mcp.astro` | the setup guide |
| `site/src/layouts/Layout.astro` | the `mcpLd` SoftwareApplication entity |

The old guard hard-coded the tool names, making it a **third** copy of the list. It now derives
them from `paymentTools()`, so the checker itself cannot drift.

**`tool-count-claims`** — every written "N tools" claim across **34 files** (the integrations, their
docs pages, the AEO files, the top-level READMEs) matches the real count. It found
`integrations/TESTING.md` still saying **7** after the 8th tool shipped.
🔴 SUBSET claims are legitimate and skipped: openclaw's *"Six tools — discover, quote, register,
budget, guide, verify_receipt — work with no key at all"* is true (six of the eight are keyless).
A claim that names specific tools, or says keyless/no-key/of-the, is about a subset.

---

### `facilitators` — who settles x402 on which chain
**Source of truth: `sdk/src/facilitators.ts` (`KNOWN_FACILITATORS`).**
Full nine-location map + update order: **[`skills/facilitator-probe/FACILITATORS-MAP.md`](skills/facilitator-probe/FACILITATORS-MAP.md)**

Guarded here (`dead-hosts`, `site-data-generated`, `dead-list-agrees`) *and* in the test suite
(`sdk/test/facilitators-surface.test.ts`), because facilitator drift can send a developer to a
domain that does not resolve.

Playbook: **`facilitator-probe`** skill.

---

### `discovery` — the open indexes
**Source of truth: `sdk/src/discovery.ts` + `sdk/src/indexes.ts`.**
Mirrors: `docs/…/discovery/*`, `sdk/DISCOVERY.md` (a pointer + the live-integration log),
`site/src/pages/discovery.astro`, the AEO files, `AGENTS.md`.

---

### `site` — the built output
**Source of truth: `site/src/`.** These rules check the *artifact*, so they need `npm run build`
first and SKIP (loudly) without it.

- **`code-blocks-highlighted`** — `<CodeWindow />` renders its prop with `set:html` and expects
  pre-highlighted markup, so a plain string renders as plain text with no error. Author snippets as
  plain code and pass them through **`site/src/lib/highlight.ts`**. Markdown fences in the blog go
  through Astro's Shiki instead; the rule knows both markers (`tok-*` and `class="line"`).
- **`structured-data`** — every page carries parseable JSON-LD.
- **`internal-links`** — every `href="/…"` resolves to a real built page or asset.
- **`sitemap-covers-pages`** — every built page is in the sitemap.
- **`blog-pages`** — `posts.ts` ↔ `pages/blog/<slug>.astro`, both directions. A post with no page
  is a 404 in the index *and* in the sitemap; a page absent from the data is unlinked.
- **`assets-exist`** — every image/icon/file referenced by built HTML on **both** hosts ships.
  Checks the *artifact*, not the source: an earlier draft scanned `site/src` and flagged
  `/og-sdk.png`, which appears only inside a JSDoc example of what you *could* pass.
- **`cross-host-links`** — the 191 links between piprail.com and docs.piprail.com resolve on the
  other host. Skips `/x402/demo` (a Netlify Function, real but never in `dist`) and HTML-escaped
  fragments inside code samples.
- **`jsonld-shared-ids`** — 🔴 **276 docs pages reference `https://piprail.com/#sdk`** and 368
  reference `/#organization`, so both hosts resolve to ONE entity graph. Rename either `@id` on
  the apex and every one of those references silently dangles. The rule asserts the apex still
  defines what the docs point at.

Playbooks: **`seo-audit`**, **`structured-data`**, **`indexability`**, **`branding`**.

---

### `api` — the SDK's public surface
**Source of truth: `sdk/dist/index.d.ts` + `index.cjs`** — values *and* types, 457 symbols.

- **`sdk-imports-in-samples`** — every `import { … } from '@piprail/sdk'` across the docs, the
  site, the examples and the top-level READMEs resolves. **665 identifiers across 263 files.**
  Rename an export and this names every stale sample.
  🔴 The export surface is NOT `Object.keys(require(...))` — that sees values only, so
  `import type { X402Challenge }` looks broken when it is fine. The `.d.ts` supplies the rest;
  an early draft reported 24 false failures for exactly this reason.
- **`exports-documented`** — ⭐ **the SDK → docs propagation.** All **152** public runtime exports
  appear somewhere in the docs. Adding an export is the most common change; forgetting the docs
  page is the most common omission.
- **`schemes-documented`** — every scheme literal the wire layer knows (`onchain-proof`, `exact`,
  `upto`) is documented.
- **`scaffolder-api`** — `create-piprail` writes merchant apps that call `createPaywall` /
  `createTipJar` / `proxyTo` / `toFetchHandler` and `gate.selfTest|describe|challenge|
  landingPage|verify`. The rule constructs a real gate and introspects it, because a rename in
  the SDK would silently break **every scaffolded app** and nothing else in the repo would notice.

---

### `errors` — the error model
**Source of truth: `sdk/src/errors.ts`** — 18 classes, each with a stable `.code`.

Every code must appear in **`sdk/ERRORS.md`** (the internal standard drivers conform to) *and*
**`docs/…/errors/`** (the public model, 4 pages), and every class must be publicly exported —
a class you cannot import is a class you cannot `catch` with `instanceof`.

---

### `ci` — the workflows
**`workflow-paths`** — every script path a workflow invokes exists. A renamed script otherwise
fails only when that workflow next runs, which may be at release time.

---

### `security` — credentials live in exactly one place
- **`secrets-untracked`** — no `.env`, nothing under `.secrets/`, and no wallet/key JSON is
  tracked by git, and both paths stay in `.gitignore`. The `.env.example` templates are
  *supposed* to be tracked and are excluded.
- **`env-example-documents-secrets`** — ⭐ every operational credential appears in the root
  **`.env.example`**, and no real value is ever committed there. Three failure modes, all
  proven to fire: a value in the tracked example, an undocumented var in the live `.env`, and
  an ops script reading a credential nobody wrote down.

  **Why:** ops secrets were spread across `.env`, `.secrets/live-matrix.env` and
  `.secrets/x-api.env`, behind **five hand-rolled parsers that disagreed** — one stripped
  surrounding quotes, another didn't. That is how `RPC_TON='https://…'` reached the SDK with
  the quotes attached and produced `TypeError: Invalid URL`, which reads exactly like an SDK
  bug and is not one. Now: one file (`.env`), one parser (`scripts/load-env.mjs`), one map.

  Two stores deliberately stay OUT of `.env` — both named in `.env.example`, so "where is
  everything?" still has one answer: `.secrets/wallets/*.json` (structured per-chain payer +
  merchant; flattening 12 families would lose the shape and pool the blast radius) and
  `~/.config/gcp/*-oauth.json` (a Google-issued token file, machine-level, shared with the
  sister sites).

> 🔴 **Scope, and the rule that is still deliberately NOT written.** This covers the ROOT
> `.env.example` — *our* ops credentials — and scans only executable ops code. It excludes
> `/design/`, `/drafts/` and `/content-studio/`, whose samples show a **user** how to configure
> the SDK (`wallet: { key: process.env.EVM_KEY }`); documenting those in our `.env.example`
> would be a lie. It also excludes `scripts/sync/`, or it flags the example names in its own
> comments.
>
- **`custody-claim-mirrors`** — ⭐ *"nobody holds it / no account, no API key"* is the **lead
  marketing claim** (BRAND.md), and it is true only because `RequirePaymentOptions` asks for no
  secret. That single fact is restated on the landing hero, in two READMEs and in the brand bible —
  **five copies of one fact.**

  Two silent failure modes, both guarded: (1) the **code** grows a credential, making every
  marketing surface a lie; (2) the **guard itself** is deleted from `verify-gate.mjs`, after which
  (1) happens unnoticed. So the rule asserts the `custody invariant` step still exists, that
  `server.ts` declares no secret, and that all four marketing surfaces still make the claim.

  **The deep code assertion lives in the GATE, not here** — it needs comment-stripping (`client.ts`
  *documents* that a caller may pass a TON/Algorand mnemonic, which is the opposite of holding one).
  Duplicating it in the checker would be the second copy this repo forbids. Proven to fail by
  removing "no API key" from `README.md`.

  **Why it matters beyond marketing:** the same no-control fact is what FinCEN's four criteria and
  CLARITY §109's non-controlling-developer test turn on — see
  `.claude/research/nobody-holds-it-positioning-push-2026-08-30.md`. A hosted signer, a managed MCP
  or a fee on the payment path now turns the build red instead of shipping quietly.

> The **product** templates (`mcp/`, `site/`, `integrations/*/`) are still NOT checked for
> var coverage. That was tried and every hit was a false positive — `PIPRAIL_MCP_BIN` is an
> optional developer override documented in its own file header, and the site's function vars
> all have documented defaults set in the Netlify UI. A rule that cries wolf gets ignored,
> which is worse than no rule.

---

### `seo` — indexing plumbing
- **`indexnow-key`** — 🔴 the key file must be named **exactly** as its own contents, on both hosts.
  A mismatch makes every IndexNow submission fail verification **silently** — nothing errors on our
  side. Identified by shape (`/[0-9a-f]{32}\.txt`); matching "any .txt that isn't robots or llms"
  swept up `security.txt`.
- **`robots-sitemaps`** — every `Sitemap:` line resolves against the host **it names**, not the host
  that declared it. Both robots files cross-declare the other property, so a local-only check would
  silently pass.
- **`sameas-mirrors`** — the `Organization.sameAs` identity list is byte-identical on both hosts,
  and every entry is an absolute https URL. 🔴 It also **refuses a numeric LinkedIn company URL**:
  logged out, `linkedin.com/company/<id>/` serves a SIGN-IN WALL at HTTP 200, so a status check
  passes it while the crawler (logged out by definition) sees a login screen where our identity
  should be. A sister project shipped exactly that across its whole site. Only the vanity form is
  a real identity claim.

---

### `skills` — the gitignored blind spot
- **`skill-paths-resolve`** — ⭐ every repo path a skill imports or cites still exists
  (156 references). **Why this domain exists:** every other rule guards a *tracked* mirror
  against a *tracked* source. `.claude/` is **gitignored**, so a skill that hard-codes a tracked
  path is invisible to both the rules above *and* git-based review — a refactor "updates all
  refs", the diff looks complete, and the skill silently rots.

  That is not hypothetical. Commit `8451271` moved the sandboxes to `examples/basics/`; the
  `sdk-audit` skill kept pointing at `examples/sdk-sandbox/` and was **dead for ~10 weeks** —
  the one tool whose whole job is "prove the SDK works" could not start. The same blind spot
  left that skill's wallet shapes on the pre-v2 field names, so all 13 live families failed at
  bind time.

  🔴 It scans **three** forms, and the third is the one that matters: relative `import`
  specifiers, backticked markdown paths, and **paths built by interpolation**
  (`` `${ROOT}examples/…` ``). The first draft did only the first two, scored *"133/133 all
  resolve"*, and still passed when the original bug was reintroduced — because that bug was in
  the interpolated form. A green checker proves nothing until you have watched it go red.

  Two false positives are filtered deliberately: prose **elision** (`docs/.../overview.md`) and
  `sdk|mcp/dist/**` (absent in a fresh clone — "not built", not "wrong path").

---

### `docs` — the meta layer
- **`docs-internal-links`** — every `href="/…"` across ~107 built docs pages resolves.
- **`examples-indexed`** — every directory under `examples/` is listed in `examples/README.md`.
  Two substantial A2A proofs were unlisted, so nobody navigating the index would ever find them.
- **`docs-sidebar-reachable`** — all 92 docs pages appear in the 90-link sidebar. An orphaned page
  is invisible to readers *and* crawlers. 🔴 Read the sidebar from a CONTENT page: the docs home
  uses Starlight's splash template and renders no sidebar, so sampling it reports every page as an
  orphan.
- **`integration-surfaces`** — each of the 5 integrations exists on all **four** of its surfaces:
  its own README, a `docs/…/integrations/` page, `site/src/data/integrations.ts`, and the status
  table in `integrations/README.md`.
- **`npm-scripts-referenced`** — every `npm run X` in the top-level docs **and every skill** is a
  real script (93 references, 74 files, 28 scripts across root/workspaces/nested manifests).
  It caught RELEASING.md saying *"never skip `npm run verify-gate`"* — a script that did not
  exist, so following the release doc literally produced `npm error Missing script`. **The fix was
  to make the script real** (`scripts/verify-gate.mjs` — the whole gate in one command), not to
  soften the doc.
- **`standards-gate-real`** — every command in `sdk/STANDARDS.md` §6 exists, and the one-shot
  runner is present.
- **`stubs-stay-stubs`** — `sdk/CHAINS.md` and `sdk/DISCOVERY.md` were deliberately reduced to
  pointers because their tables duplicated the docs and rotted on every change. This fails if one
  regrows a chain table or stops pointing at the canonical docs.
- **`rules-are-well-formed`** — ⭐ **the checker checks itself.** Every rule must have a reachable
  `bad()` path (except explicitly warn-only ones), declare a source and mirrors, carry a unique id,
  and name **one path per entry** — a `·`-joined location reads fine in `--graph` but makes
  `--touched` blind to every file after the first. Three rules went through drafts that passed on
  every input; this makes that impossible to leave in.
- **`surfaces-index`** — every domain in the checker appears in *this file*. It is why the two maps
  cannot silently diverge.
- **`changelog-unreleased`** — a warning, not a failure: fine right after a release, but add an
  `[Unreleased]` section as soon as you touch `sdk/src`.

---

## Adding a new mapped fact

1. Add a rule to **`scripts/sync/rules.mjs`** with `source`, `mirrors`, and a `check()`.
   Derive the expected value in `scripts/sync/sources.mjs` — **never hard-code it in the rule**,
   or the checker becomes one more copy that can rot.
2. Add the domain to this file (the `surfaces-index` rule fails until you do).
3. **Prove the rule fires.** Break the mirror on purpose, watch it go red, restore it. A guard that
   cannot fail is worse than no guard — it reads as coverage while providing none.
   (`rules-are-well-formed` enforces the *shape* of this, but only you can prove the logic.)
4. If a rule cannot run (missing build, optional file), it must `skip` **with a reason**.
5. **One path per `mirrors` entry.** Two files in one string breaks `--touched`.

## Coverage

Every top-level area of the repo is named by at least one rule:
`sdk/` (20) · `site/` (24) · `docs/` (18) · `mcp/` (5) · `integrations/` (4) · `examples/` (3) ·
`create-piprail/` · `scripts/` · `.github/workflows/` · the custody claim (`custody-claim-mirrors`).

**Deliberately out of reach** — flagged rather than pretended: the **`piprail/.github`
org-profile repo** (a different repo entirely), external directory listings, on-chain token
confirmation (belongs to `add-chain-integration` at authoring time, not to a fast offline check),
and whether any of the wording is actually good.

## ⭐ Where the good stuff already is — map (added 2026-08-30)

A deep dive this session found several things **already built and documented** that earlier
planning assumed were missing. Recorded here so nobody re-derives or duplicates them.

| If you're looking for… | It already lives at | Notes |
|---|---|---|
| **Agent spend controls / budgets** | `docs/src/content/docs/spend-controls/` — **7 pages, 1,394 lines** | payment-policy · time-envelope · total-budget · persistence · spend-ledger · evaluate-policy · internals. **Complete — link, don't author.** |
| The policy field list (authoritative) | `sdk/src/policy.ts` → `PaymentPolicy` — **15 fields** | Includes `maxPayments`, `warnAtFraction`, `denomFor`, which prose lists keep dropping. Regenerate; never copy a table forward |
| **`planPayment` / affordability** | `docs/src/content/docs/making-payments/plan-payment.md` (185 L) + `estimate-cost.md` | Correctly lists all 5 blocker codes |
| Blocker codes (authoritative) | `sdk/src/client.ts:245` → `PayBlocker` — **5, not 4** | `INSUFFICIENT_TOKEN` · `INSUFFICIENT_GAS` · `RECIPIENT_NOT_READY` · `OUTSIDE_POLICY` · **`OUTSIDE_WINDOW`** ← the one prose keeps missing |
| Policy deny codes | `sdk/src/policy.ts` → `PolicyDenyCode` — 11 | Distinct from `PayBlocker`; don't conflate |
| Protocol-layer module list | `sdk/STANDARDS.md` §6 — **20 modules** | ⭐ read by BOTH the `viem-free` and `custody invariant` gate steps. Never hard-code it |
| The custody guard | `scripts/verify-gate.mjs` → `custody invariant` step | No keys in protocol layer · gate needs no secret · no telemetry |
| Optional facilitator delegation | `sdk/src/facilitator.ts` → `settleViaFacilitator` | We are *facilitator-optional*, not facilitator-hostile. Under-advertised |
| Merchant scaffolder | `create-piprail/` (workspace) | Emits `/.well-known/x402`; mainnet-by-default |
| Self-description on 402s | `sdk/src/selfdescribe.ts` | **Default-ON**; opt out with `selfDescribe: false` |

### 🏗️ The build & deploy guard chain — what catches what

`npm run verify-gate` is **16 steps**. The three that are PipRail-specific invariants (nothing else
in the toolchain would catch them):

| Step | Catches | Proven by |
|---|---|---|
| **lazy-chunk invariant** | a static non-EVM import leaking into the EVM bundle → pure-EVM installs download Solana/TON/Stellar | grep of `sdk/dist/index.js` |
| **viem-free protocol layer** | a chain SDK imported by the chain-agnostic core | module list read from `sdk/STANDARDS.md` §6 (never hard-coded) |
| **custody invariant** *(added 2026-08-30)* | key material in the protocol layer · the merchant gate growing a secret · telemetry | comment-stripped scan; **proven to fail** by injecting `apiKey?: string` |
| **clean-clone sync** *(added 2026-08-30)* | 🔴 **a sync rule that reads a gitignored path** — passes locally forever, **fails the Netlify build** | re-runs all 50 rules with `PIPRAIL_SYNC_CLEAN_CLONE=1`; **proven to fail** by reverting the `exists()` guard |

#### 🔴 The clean-clone trap — it has bitten twice

The site's `prebuild` runs `npm run sync`, and **`.claude/` ships only an allowlist**, so most of it
is on the maintainer's disk and absent from every clone.

1. `surfaces-index` hard-failed on a missing `.claude/SURFACES.md` (caught pre-ship).
2. `custody-claim-mirrors` threw ENOENT on the gitignored `content-studio/BRAND.md` (2026-08-30).

⚠️ **The root cause both times: `read()` THROWS ENOENT — it does not return falsy.** So
`const src = read(f); return src && …` *looks* defensive and is not. **Always `exists(f)` first.**

```bash
PIPRAIL_SYNC_CLEAN_CLONE=1 npm run sync   # reproduce a clean clone in ~1s, no npm ci
```

The simulation hides untracked files (`git ls-files` is the authority) but **keeps build outputs
visible** (`sdk/dist`, `mcp/dist`, `site/dist`, `docs/dist`, `node_modules`) — the real build makes
those before sync runs, and hiding them produced false failures on `sdk-imports-in-samples`.

#### Which of our own files actually ship

| Path | Ships? |
|---|---|
| `.claude/SURFACES.md`, `.claude/commands/**`, most `.claude/skills/**` | ✅ tracked (526 files) |
| `.claude/plans/**`, `.claude/research/**` | ❌ **local only** — deliberately; they're working notes |
| `.claude/skills/content-studio/**` (incl. `BRAND.md`) | ❌ **gitignored** — any rule touching it must `exists()`-guard |
| `sdk/dist`, `mcp/dist`, `site/dist`, `docs/dist` | ❌ gitignored, ✅ built by CI |

#### Deploy lanes — what a change actually triggers

| Change | Lane | Tag needed? |
|---|---|---|
| `site/**` | Netlify → piprail.com, on merge to `main` | no |
| `docs/**` | `deploy-docs.yml` → docs.piprail.com, on merge | no |
| `scripts/**`, `.claude/**`, root docs | no deploy — but `scripts/sync` + `verify-gate` gate every later build | no |
| `sdk/src/**` | npm, only on a signed `sdk-v*` tag | **yes** |
| `sdk/README.md` alone | npm re-renders the README **only on publish** → needs a patch bump to appear | **yes, if it must show on npm** |
| `mcp/**` | signed `mcp-v*` tag → npm + GitHub Release + MCP registry (OIDC) | **yes** |

🔴 **A multi-commit push can silently skip the Netlify deploy** — `netlify.toml`'s `ignore` now diffs
against `$CACHED_COMMIT_REF`, not `HEAD^`. **After any merge, verify the site actually changed**:
`curl -s https://piprail.com/llms.txt | sed -n '3p'`.

### 📋 The September push plan — status at a glance

[`.claude/plans/push-2026-09/`](plans/push-2026-09/). Thesis: **the gap is marketing, not product.**

| § | What | Status |
|---|---|---|
| 01 | Positioning + hero — "nothing to sign up for" | ✅ shipped 2026-08-30 |
| 02 | Agent-safety landing section (spend controls) | ✅ shipped — landing §6.7 `#agent-safety` |
| 03 | Surface `planPayment` / `estimateCost` | ✅ shipped inside §02's section |
| 04 | Optional-facilitator framing | ✅ shipped — landing §6.5 + first `/facilitators/` link |
| 05 | Custody invariant | ✅ `custody invariant` step in `verify-gate` + `custody-claim-mirrors` rule. Docs page + badge outstanding |
| 06 | Hedera, the 30th chain | 🔴 **blocked on John** — fund the wallet (accounts are 404). Audit complete, rebase risk LOW |
| 07 | Content + distribution | queued — cites 01–05, so it goes after them |
| 08 | CLARITY §109 page + Treasury comment | ⏳ dated: **Sept 15** cloture · **Oct 19** comment deadline |

**Errors the triple-checks caught** (all fixed — kept here as a warning about copying prose forward):
`PayBlocker` is **5** codes not 4 · `PaymentPolicy` is **15** fields not 12 · the spend-controls and
plan-payment **docs already existed** (the plan said to write them) · Hedera is **53 commits behind**,
not "slightly stale" · `docs-sync` SKILL.md claimed **20 rules** when there were 50 · the
"orphaned pages" alarm was a **grep-the-source artifact**.

### 🪤 Verification traps — how to check these surfaces WITHOUT getting a false answer

Every one of these produced a wrong answer during the 2026-08-30 audit before being caught.

| Checking… | ❌ Wrong way | ✅ Right way | Why |
|---|---|---|---|
| **Is a page linked / orphaned?** | `grep 'href="/x/"' site/src/**` | `grep site/dist/**/*.html` | The footer builds links from a **JS array** (`{ href: '/sdk/' }`), so an attribute grep on source reports every page as orphaned. **It is not — the footer links all 8 pages + the blog on every page.** Always check built HTML |
| **Sitemap URL count** | `grep -c '<url>'` | `grep -o '<loc>' \| wc -l` | The XML is emitted on **one line**; a line-count grep returns 1 |
| **Test count** | `grep -c 'it(\|test('` | `npm run verify-gate` | Formatting variants undercount. Real: **1,636 SDK + 120 MCP** |
| **Key material in a module** | plain `grep privateKey` | strip comments first | `client.ts` *documents* that a caller may pass a TON/Algorand mnemonic — the opposite of holding one |
| **Is a chain's RPC/account live?** | call any endpoint | probe a **real balance/token**, and confirm the host with a known-good id first | A 404 can mean "wrong host", not "no account". See [[default-rpc-health]] |
| **Rebase risk on a stale branch** | `git merge` / checkout | `git merge-tree --write-tree A B` | Object-DB only — safe with a dirty working tree |
| **What a rule counts** | trust prose | `npm run sync` | `docs-sync` SKILL.md claimed "20 rules / 7 domains" for months; it was 50 / 13 |

### 🔗 Landing page → where each section points

`site/src/pages/index.astro`, in order. Numbered comments in the source are the anchor.

| § | Section | Links out to |
|---|---|---|
| 1 | Hero | `/sdk/` · `/mcp/` — carries the **"No account, no API key"** claim (guarded by `custody-claim-mirrors`) |
| 2 | The story | — |
| 3 | The fork | `/sdk/` · `/mcp/` |
| 4 | Live demo | `/demo/` |
| 5 | Why PipRail | `/chains/` |
| 6 | How it works | `/sdk/` |
| 6.5 | Open standard, no middleman | — ⚠️ **does not link `/facilitators/`** (plan §04) |
| **6.7** | **Agent safety** (added 2026-08-30) | docs `/spend-controls/payment-policy/` · `/spend-controls/persistence/` · `/making-payments/plan-payment/` — **the first landing links into either docs section** |
| 7 | MCP teaser | `/mcp/` |
| 7.4 | Integrations | docs `/integrations/*` |
| 7.5 | Discoverability | `/discovery/` |
| 9 | FAQ | — |
| 10 | CTA | `/sdk/` · `/mcp/` |
| 11 | Partners | `/partners/` |

Site pages: `index · sdk · mcp · chains · demo · discovery · facilitators · partners` + `blog/` (5 posts).
**All are footer-linked on every page** — nothing is orphaned.

### ⛓️ Hedera — the 30th chain, parked on a branch

Local-only branch **`hedera-chain-integration`** (tip `e9929f2`), **1 ahead / 53 behind `main`**,
no PR. Full audit: [`plans/push-2026-09/06-chain-gap-hedera.md`](plans/push-2026-09/06-chain-gap-hedera.md).

- **Complete**: driver (5-file onchain-proof shape, correctly mirroring stellar/sui/ton/tron/xrpl —
  needs **no** `exact.ts`), 937 lines of tests, and every surface (site, docs, llms, counts).
- **Rebase risk LOW**: `drivers/types.ts` · `registry.ts` · `index.ts` have a **zero diff** since the
  branch — the contract has not moved. 29 files auto-merge, **7 conflict**, all mechanical
  count/list files (`package-lock` · `sdk/package.json` · `cost.test.ts` · `posts.ts` ·
  `chains/demo/mcp.astro`).
- **Verified live 2026-08-30**: Mirror Node up; USDC **`0.0.456858` = symbol USDC, decimals 6** ✅
- 🔴 **Sole blocker, human**: both wallet accounts are **404 / never created on mainnet**
  (`accountId: null` in `.secrets/wallets/hedera-wallet.json`). Fund the ECDSA **EVM alias** to
  auto-create, then associate USDC.
- Shipping it moves **29 → 30 chains, 10 → 11 families** — a wide `sync` ripple.

**🔴 The real gap this mapping exposed:** the **landing page** never links to any of it — its only
`docs.piprail.com` link is `/integrations/`. The problem was never missing capability or missing
docs; it was that piprail.com doesn't point at either. Plan: `.claude/plans/push-2026-09/`.

## Related

- **`docs-sync`** skill — the prose playbook this file supersedes for the machine-checkable parts.
  It still holds the judgement calls (what's worth saying, which external listings to refresh).
- **`verify-gate`** skill — the build/test gate to run after a sync sweep.
- **`.claude/URLS.md`** — every external URL we touch.
