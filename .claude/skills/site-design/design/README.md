# design/ — PipRail design working files

**Bundled with the `site-design` skill** (`.claude/skills/site-design/design/`) and
**local-only** — the source of truth you design *from*. The site only ships *final*
assets, and those live in `site/public/` (repo) — not here.

> Full playbook (brand tokens, the Astro site, how to regenerate every asset):
> see the skill at [`../SKILL.md`](../SKILL.md).

## Folder layout

Four peers — **inputs** (`source/`), the two **render pipelines** (`social/`, `video/`),
and the **outputs** (`exports/`):

```
design/
├── source/      # ① MASTERS — the originals everything derives from   (tracked)
│   ├── logo-source.png      # high-res master logo (1254×1254)
│   ├── logo-512.png
│   └── logo-256.png
├── social/      # ② SOCIAL — the campaign copy + per-chain card pipeline
│   ├── CAMPAIGN.md          # the campaign strategy/copy               (tracked)
│   └── (render.mjs + chain cards live in exports/social/ — see below)
├── video/       # ③ VIDEO — the promo-video & social-card render pipeline
│   ├── README.md            # how the pipeline works (read it)        (tracked)
│   ├── scene.html · card-*.html · *.mjs · synth.py   # the source     (tracked)
│   └── assets.js · frames/ · *.png · *.mp4           # generated       (ignored)
└── exports/     # ④ rendered/staged OUTPUTS not served by the site    (local, ignored)
    ├── og-github-1280x640.png   # GitHub repo "Social preview" (upload via repo Settings)
    ├── piprail-demo.mp4         # the finished promo video
    ├── post-*.png / .html       # the themed "post" social cards
    └── social/                  # per-chain announcement cards + their render.mjs
```

> **Tracked vs local:** `source/`, `social/CAMPAIGN.md`, this README, and the `video/`
> *source* are committed (the skill is self-contained). Everything under `exports/` and the
> `video/` *generated outputs* are gitignored — rebuilt on demand, never bloating the repo.
> Commit a new design asset deliberately with `git add -f`.

## Where things go

| You're making… | Save the master in… | Ship the final to… |
| --- | --- | --- |
| Logo / favicon / app icon | `design/source/` | `site/public/` (`logo.png`, `favicon-*.png`, `apple-touch-icon.png`) |
| Site OG / Twitter card | `design/source/` (composition) | `site/public/og.png` (1200×630) |
| GitHub repo social card | — | `design/exports/og-github-1280x640.png` (1280×640; upload, not served) |
| Chain / token logo | (official brand SVG) | `site/public/chains/<chain>.svg`, `site/public/tokens/<sym>.svg` |
| Promo / demo video | edit `design/video/` (scene + scripts) | `design/exports/piprail-demo.mp4` (then site / socials) |
| Social post / chain card | edit `design/video/card-*.html` or `design/exports/social/` | `design/exports/` (`post-*.png`, `social/<chain>.png`) |
| Social campaign copy | `design/social/CAMPAIGN.md` | — (the plan; posts derive from it) |
| WIP mockups / screenshots | `design/mockups/`, `design/screenshots/` | — |

## Brand, in one line

Dark (`oklch(0.145 0.005 260)`), near-white text, **one accent: emerald
`oklch(0.78 0.17 162)` ≈ `#2ee6a6` ("paid")**. Fonts: Inter + JetBrains Mono.
Minimal and static — the simplicity is the brand. Regenerate rasters from
`source/logo-source.png` with `sips` (commands in the skill).
