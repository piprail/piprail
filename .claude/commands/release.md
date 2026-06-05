---
description: Cut a versioned npm release of @piprail/sdk or @piprail/mcp (tag-driven CI)
---

Use the **release** skill at `.claude/skills/release/SKILL.md` as the playbook. Release: $ARGUMENTS

Non-negotiables (the skill expands each): run the **verify-gate** first; bump the version
in EVERY file (`package.json` + `CHANGELOG.md`, and for the MCP also `server.json`); commit
on `main`; then push a **signed** `sdk-v*` / `mcp-v*` tag — that's what publishes. **Never
`npm publish` by hand.** Build the SDK before the MCP. After CI publishes, create the GitHub
Release from the tag (and for the MCP, refresh the registry with `mcp-publisher`).
