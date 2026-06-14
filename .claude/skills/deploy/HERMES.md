# Hermes publishing — the full runbook

**Everything about getting the PipRail integration in front of Hermes Agent users.**
This is the exhaustive reference; the deploy skill's **§8.6** is the quick version and points here.
Hermes Agent is a large AI agent runtime (MCP client) with no native payment rail — PipRail is the
agent's wallet. The integration lives at `integrations/hermes/piprail/`.

> **The one-sentence model:** the Hermes integration is a `SKILL.md` (+ `config.yaml` / `manifest.yaml`)
> that wraps the already-published `@piprail/mcp` server. It ships through **three lanes** — a **skills
> tap we own** (`piprail/skills`, the manual lane you re-publish), the **universal `hermes mcp add`**
> path (works today, nothing to deploy), and a **native MCP-catalog PR** (external, pending merge).
> Like ClawHub, **none of this is git/tag-triggered** — re-publish the tap by hand when the listing drifts.

---

## 0. It is NOT git/tag-triggered — re-publish by hand

An `sdk-v*`/`mcp-v*` tag or a `main` push does **nothing** to the Hermes lanes. The npm package the
skill wraps updates automatically (users run `npx -y @piprail/mcp`), but the **skill listing** in our
tap is a separate artifact you re-publish with the `hermes` CLI.

**Re-publish the tap WHEN:** `integrations/hermes/piprail/SKILL.md` (or `config.yaml`/`manifest.yaml`)
changed · the MCP tool set/names changed · the env/config surface changed (e.g. a new `PIPRAIL_*` var).
A routine SDK/MCP patch that doesn't touch the skill content needs **no** re-publish.

---

## 1. The three distribution lanes

| Lane | Command (user) | Who controls it | Deploy action when the skill changes |
|---|---|---|---|
| **Skills tap (ours)** | `hermes skills tap add piprail/skills` | **Us** (`github.com/piprail/skills`) | **Re-publish** (`hermes skills publish …`, §2) — the one manual lane |
| **Universal MCP add** | `hermes mcp add piprail --command npx --args -y @piprail/mcp` | Works on every Hermes version, no listing needed | **None** — it spawns `@piprail/mcp` directly; auto-current |
| **Native MCP catalog** | `hermes mcp install piprail` | **External** (NousResearch PR, pending) | **None from us** — works once the PR merges; track its status (§3) |

The universal `hermes mcp add` path is the always-works fallback and needs no deploy. The tap is the
lane we keep fresh. The catalog is the prize (one-step native install) but is out of our hands.

---

## 2. Publishing / re-publishing the skills tap (the command + gotchas)

The CLI is the Hermes Agent CLI (`hermes`). Publish the integration folder to the `piprail/skills`
GitHub tap:

```bash
hermes --version || echo "install Hermes Agent first"
hermes skills publish integrations/hermes/piprail --to github --repo piprail/skills
# users then: hermes skills tap add piprail/skills   →   the `piprail` skill + its 7 tools appear
```

- **`--repo piprail/skills`** is the tap we own; pushing there is what updates the listing. (You need
  push rights to `github.com/piprail/skills`.)
- The folder is `piprail`, so the skill `name:` (frontmatter) = `piprail` — keep them aligned.
- Bump the SKILL.md frontmatter **`version:`** on a content change (semver) so consumers see the update.
- If the `hermes` CLI isn't available, the tap is just a git repo: clone `piprail/skills`, copy the
  updated `integrations/hermes/piprail/` contents into it, commit, push. The CLI is a convenience wrapper.

---

## 3. External submissions (out of our hands — track, don't block a deploy)

These are open PRs/issues to third-party repos; they merge on their own timeline. **They never block a
release** — track them and swap the install instructions to the cleaner native command once they land.
The live status + the merge-check commands are tracked in the root **`CLAUDE.md`** ("Pending: Hermes
integration distribution") — keep that the source of truth and delete an entry when it lands.

- **MCP catalog (primary)** — NousResearch/hermes-agent PR. When merged, `hermes mcp install piprail`
  works natively. **On merge:** swap the site install chips (`site/src/pages/index.astro` + `mcp.astro`)
  from `hermes mcp add piprail --command npx --args -y @piprail/mcp` to `hermes mcp install piprail`, and
  tighten the docs Setup page.
- **Awesome-hermes-agent list** — a PR adding PipRail.
- **Hermes Atlas** (hermesatlas.com) — an ecosystem-listing issue.

Quick status check (also in CLAUDE.md):
`gh pr view <PR#> --repo NousResearch/hermes-agent --json state,mergedAt`.

---

## 4. Verify before publishing

```bash
cd integrations/hermes/piprail && node verify.mjs --live   # handshake + 7 tools + live quote + budget refusal
```

A green run proves Hermes will spawn `@piprail/mcp`, register all 7 `mcp_piprail_*` tools, read a live
402 quote, and refuse an over-budget pay. Run it before every tap re-publish.

---

## 5. Healthy state

- The `piprail/skills` tap has the **current** `SKILL.md` (version bumped, 7 tools, correct config incl.
  `PIPRAIL_CHAINS` if multi-chain is documented).
- `hermes mcp add piprail --command npx --args -y @piprail/mcp` connects and finds **7 tools** (the
  universal path always works regardless of the tap/catalog).
- The external PRs are either merged (then the site chips use `hermes mcp install piprail`) or tracked
  as open in CLAUDE.md.

Full record + re-test recipe: `.claude/plans/framework-integrations/04-hermes.md` + `07-hermes-test-log.md`.
