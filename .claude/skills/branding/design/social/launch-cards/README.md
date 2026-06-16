# launch-cards/ — the canonical card gallery

The one-offs that don't fit the repeatable post/chain pipelines: integration co-brands,
gasless announcements, a flagship code card. This folder is deliberately **small and curated** —
it holds **four canonical cards**, each kept in git as the reference example of its archetype.
When you need a card of one of these shapes, copy its template; don't start from scratch.

| Card | Archetype it demonstrates | Source | Committed PNG |
| --- | --- | --- | --- |
| **hermes-launch** | integration / partnership co-brand (two marks + "NEW INTEGRATION") | `hermes-launch.html` · `render-hermes.mjs` | `hermes-launch.png` (1080²) |
| **payai-gasless** | facilitator gasless ("your agent pays, X pays the gas") | `payai-gasless.html` · `render-payai.mjs` · `payai.jpg` | `payai-gasless.png` (1080²) |
| **solana-gasless** | chain-gasless ("\<chain\> payments, now gasless") | `solana-gasless.html` · `render-solana-gasless.mjs` | `solana-gasless.png` (1080²) |
| **multichain** | flagship code / feature ("One agent. Every chain.") | `multichain.html` · `render-multichain.mjs` | `multichain.png` (1080²) |

```bash
# regenerate any of the four from repo root
node .claude/skills/branding/design/social/launch-cards/render-hermes.mjs   # -> hermes-launch.png
node .claude/skills/branding/design/social/launch-cards/render-payai.mjs     # -> payai-gasless.png
node .claude/skills/branding/design/social/launch-cards/render-solana-gasless.mjs
node .claude/skills/branding/design/social/launch-cards/render-multichain.mjs
```

- **SOURCE (tracked):** the four `*.html` templates + their `render-*.mjs` + `payai.jpg` (the only
  local logo input; PipRail/Hermes/Solana marks resolve from `site/public/…`).
- **GALLERY (tracked by name):** the four `*.png` are the **only** renders in `social/` committed to
  git besides `profile/` — kept so the best cards are never lost locally. The allowlist lives in the
  repo `.gitignore`. Every other render under `social/` stays gitignored.
- **Making a NEW launch card?** Design it to the [MEDIA standard](../../../../content-studio/MEDIA.md),
  give it a template + `render-*.mjs` here, and render to a (gitignored) PNG. Only promote it into the
  committed gallery — template, script, **and** an entry in the `.gitignore` allowlist + the table
  above — if it's a keeper worth persisting. If a shape becomes repeatable, graduate it to `post-cards/`.

See [`../../README.md`](../../README.md) for the SOURCE / PUBLISHED / RENDER / GALLERY rule.
