---
description: Add a new chain, EVM preset, driver family, or token to PipRail (SDK + site)
---

Use the **add-chain-integration** skill at `.claude/skills/add-chain-integration/SKILL.md`
as the playbook. Follow it end-to-end for: $ARGUMENTS

Non-negotiables (the skill expands each): verify every token address on-chain before it
ships, ship native tokens only, keep the protocol layer chain-agnostic, mirror the driver
templates, lazy-load optional chain libs, update the tests first — and **finish the job on
the site**: add the chain to `site/src/pages/index.astro` with its real logo SVG in
`site/public/chains/`. A chain isn't done until it's on piprail.com. Do not publish to npm.
