---
description: Run the SDK/MCP verification gate (typecheck + tests + build + lazy-chunk invariant)
---

Use the **verify-gate** skill at `.claude/skills/verify-gate/SKILL.md`. Run the full gate from
the repo root and report exactly what's red:

- `npm run typecheck` (sdk + mcp)
- `npm run typecheck:test -w @piprail/sdk` (src + tests together)
- `npm run test:sdk` (and `test:mcp` if the MCP changed)
- `npm run build:sdk` (and `build:mcp` if the MCP changed)
- `grep -E "from ?['\"]@(solana|ton|stellar)" sdk/dist/index.js` → expect **no matches** (the lazy-chunk invariant)

Nothing is "done" until every step is green.
