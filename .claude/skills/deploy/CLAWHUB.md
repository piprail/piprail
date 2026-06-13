# ClawHub publishing + branding — the full runbook

**Everything about getting the `piprail` skill onto ClawHub correctly, under the PipRail identity.**
This is the exhaustive reference; the deploy skill's **§8.5** is the quick version and points here.
ClawHub is OpenClaw's skill registry ("npm for AI agents", ~250k★ community).

> **The one-sentence model:** the OpenClaw integration at `integrations/openclaw/piprail/` is published
> to ClawHub as the skill **`piprail`** (install: **`clawhub install piprail`**), owned by the
> **`@piprail` org publisher**, and it's just a SKILL.md listing that *wraps* the already-published
> `@piprail/mcp` server (discovery + instructions — the real tool wiring is the user's `mcp.servers` config).
> **folder = SKILL `name` = slug = `piprail`.**

---

## 0. It is a SEPARATE registry — nothing here is git/tag-triggered

A `git push` or an `sdk-v*`/`mcp-v*` tag does **nothing** to ClawHub. You re-publish it **by hand**
with the `clawhub` CLI whenever the listing's content drifts. (Site/docs/npm are the automated lanes;
ClawHub is the one manual lane — that's why it lives in the deploy runbook so it isn't forgotten.)

**Re-publish WHEN:** `SKILL.md` changed · the MCP tool set/names changed · the env/config surface
changed. A routine SDK/MCP patch that doesn't touch the skill's content needs **no** re-publish.

---

## 1. The identity model — why it first showed `@john-weeks-dev`

**A skill's handle + avatar come from its PUBLISHER, not from the skill.** This is the crux of the
whole confusion:

- Publish **without `--owner`** → it defaults to your **personal** account (`@john-weeks-dev` + your
  personal GitHub avatar). **That was the original bug.**
- Publish **with `--owner piprail`** → it lists under the **`@piprail` org publisher** (the PipRail
  identity). This is mandatory for us, every time.

`clawhub inspect piprail --json` → the `owner` block is the source of truth
(`owner.handle`, `owner.image`).

---

## 2. One-time: the `@piprail` org publisher + its branding

```bash
clawhub publisher create piprail --display-name "PipRail"     # already done; idempotent-ish (errors if it exists)
```

Then set its **avatar + bio** — **on the website only**. There is **no CLI flag and no REST endpoint**
for this (confirmed: `GET/PATCH/PUT/POST /api/v1/publishers/piprail` all `404`; the settings page uses
an internal Convex mutation that isn't exposed). So a human pastes two values:

> **clawhub.ai/settings → Organizations → `@piprail`:**
> - **DISPLAY NAME:** `PipRail`
> - **AVATAR URL:** `https://piprail.com/logo.png`  *(the on-brand 512×512 PipRail mark; verified live, `image/png`)*
> - **BIO:** `Backendless x402 payments for AI agents — npm install, name a chain, add a wallet, and your agent pays any 402 paywall across every major chain. No facilitator, no fee, no signup. piprail.com`
> - **Save changes**

Until that's saved, `owner.image` stays `null` and the listing shows a placeholder box instead of the
logo. (Personal-account bio at `clawhub.ai/settings → Account` is **optional/cosmetic** — the skill is
under `@piprail` now, so John's personal bio doesn't affect the PipRail listing.)

---

## 3. Publishing / re-publishing (the command + the gotchas)

```bash
clawhub whoami || clawhub login          # GitHub auth (browser / --device / --token); free, once
clawhub skill publish integrations/openclaw/piprail \
  --owner piprail --slug piprail --name "PipRail" --version X.Y.Z \
  --tags latest --changelog "<what changed>"
clawhub inspect piprail   # confirm owner=piprail, latest=X.Y.Z, moderation=clean
```

**Mandatory flags (both, every time):**
- **`--owner piprail`** — without it you republish under your *personal* handle (see §1). To *move* an
  already-personal skill the first time, add **`--migrate-owner`** (we used it for 1.0.3; the old
  `clawhub.ai/john-weeks-dev/…` URL now `307`-redirects).
- **`--slug piprail`** — matches the folder name `piprail`, so it's the natural default; pass it
  explicitly to be safe (a wrong/absent slug could fork a separate skill).

**Why the slug is just `piprail`:** ClawHub is **OpenClaw-only** (Vercel/ElizaOS ship via npm + the
ElizaOS registry, never here), so there's only ever **one** PipRail skill on ClawHub — no suffix needed
to disambiguate. (ClawHub also **rejects** slugs starting `openclaw-` or ending `-openclaw`, so
`piprail-openclaw` was never possible; we briefly used `piprail-openclaw-skill`, then **renamed it to
`piprail`** — the old slugs now redirect.) Install is by **bare slug** — `clawhub install piprail`,
identical no matter who owns it.

**CLI facts:** `npm i -g clawhub` (the OpenClaw CLI — **NOT** the unrelated PyPI `clawhub`).
`--version` is optional (semver, recommended). Useful commands: `publisher create` · `skill publish` ·
`skill rename` (keeps a redirect) · `transfer` · `inspect` · `scan download <slug> --version X.Y.Z`.

---

## 4. Auto-classified fields you do NOT set directly

ClawHub computes two things from the skill content on each publish — there's no explicit field for
either, so you steer them indirectly:

### Category (e.g. "Payments" vs "Data & APIs")
Classified from the **`description`** text. Lead with **payments / wallet / crypto / 402 / "pays
paywalls"** language to land **Payments**; mention **"APIs / data feeds / AI services"** and it drifts
to **"Data & APIs"**. *(Confirmed: rewording the description in 1.0.4 flipped it Data&APIs → Payments.)*
Keep the SKILL.md `description` payment-forward.

### The "API key required" badge — why it's there and why it stays
ClawHub flags any skill that **needs a user-supplied secret to run**, rendered as a 🔑 **"API key
required"** chip (tooltip: *"…an API key (or equivalent secret)…"* — a deliberate catch-all).

- **It is substantively HONEST for us:** the PipRail MCP **exits without `PIPRAIL_PRIVATE_KEY`** (you
  must supply a funded wallet key to pay). It is **not** a claim that PipRail sells an API key or needs
  a signup.
- **It is auto-detected from the SKILL.md BODY** — the `mcp.servers` `"env": { …PIPRAIL_PRIVATE_KEY… }`
  block + the Configure table's ✅-required row — **not** just the frontmatter. Proof: it **persisted**
  after we removed `requires.env`/`primaryEnv` from the frontmatter **and** stripped all "API/key"
  language from the description (while the category *did* re-classify). So it's body-driven (and/or
  sticky from the first publish, which declared `requires.env`).
- **We deliberately declare only `requires.bins: [npx]`** in the frontmatter (no `requires.env`,
  no `primaryEnv`) so we're not *over*-declaring — but the badge stays regardless.
- **The only way to remove it is to delete the wallet-key setup docs from the body** — which we will
  **not** do (it's essential, and the requirement is real). **So we accept the badge.** If we ever
  truly need it gone, the paths are: make the MCP boot read-only without a key (a product change — and
  even then the body docs may still trigger it), or re-slug as a brand-new skill that never declared a
  secret (loses the slug/redirects). Neither is worth it for an honest, accurate signal.

---

## 5. Verify the live listing

```bash
clawhub inspect piprail --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s.slice(s.indexOf('{')));console.log('owner',j.owner?.handle,'| latest',j.latestVersion?.version,'| moderation',j.moderation?.verdict,'| image',j.owner?.image)})"
# page checks (use --compressed + grep -a; the page renders fresh, cache MISS):
curl --compressed -fsSL "https://clawhub.ai/piprail/piprail" \
  | grep -ac 'api-key-required-badge'          # body-detected → expect 1 (accepted)
cd integrations/openclaw/piprail && node verify.mjs --live   # handshake + 7 tools + live quote + budget refusal
```

**Healthy state:** `owner=piprail`, `moderation=clean`, category chip = **Payments**, title = **PipRail**
(the breadcrumb `skills / piprail / piprail` correctly shows the slug — that's the
install ID, not the title). `moderation` briefly shows `pending` right after a publish (the security
re-scan) and settles back to `clean`.

---

## 6. Current published state (2026-06-13)

`piprail@1.0.5` · owner **`@piprail`** · slug **`piprail`** (`clawhub install piprail`; old
`piprail-openclaw-skill` + `piprail-openclaw` slugs redirect) · category **Payments** · moderation
**clean** · MIT-0. **Avatar/bio:** set on the web (§2) — the one manual step left. Badge: present, accepted (§4).
