---
description: Ship PipRail — the full deployment runbook (versions, docs, gate, publish, releases, registry, external repos)
---

Use the **deploy** skill at `.claude/skills/deploy/SKILL.md` as the playbook — it is THE single,
crystal-clear runbook for everything a PipRail deployment touches. Deploy: $ARGUMENTS

Work the phases in order (the skill expands each): **0** scope what changed → **2** bump EVERY
version file (SDK 2 / MCP 4) → **3** sweep every doc surface (the ★ `llms.txt` headers + tool names
the build enforces, plus counts via `docs-sync`) → **4** the **verify-gate** (green or stop) → **5**
commit + push `main` (fires the site + docs deploys) → **6** signed `sdk-v*` / `mcp-v*` tags, **SDK
first** (that's what publishes) → **7** GitHub Releases → **8** MCP registry → **9** external repos
(x402 ecosystem + awesome lists + the separate `piprail/.github` org profile) → **10** verify it
shipped. **Never `npm publish` by hand.** A docs/README-only change still needs a patch bump to show on npm.
