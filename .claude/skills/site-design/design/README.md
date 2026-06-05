# design/ — PipRail design working files

**Bundled with the `site-design` skill** (`.claude/skills/site-design/design/`) and
**local-only** — the source of truth you design *from*. The site only ships *final*
assets, and those live in `site/public/` (repo) — not here.

> Full playbook (brand tokens, the Astro site, how to regenerate every asset):
> see the skill at [`../SKILL.md`](../SKILL.md).

## Folder layout

```
design/
├── source/      # MASTERS — the originals everything derives from
│   ├── logo-source.png      # high-res master logo (1254×1254)
│   ├── logo-512.png
│   └── logo-256.png
├── exports/     # rendered/staged assets not served by the site
│   └── og-github-1280x640.png   # GitHub repo "Social preview" (upload via repo Settings)
├── mockups/     # WIP layouts / design explorations   (add as needed)
└── screenshots/ # reference shots                       (add as needed)
```

## Where things go

| You're making… | Save the master in… | Ship the final to… |
| --- | --- | --- |
| Logo / favicon / app icon | `design/source/` | `site/public/` (`logo.png`, `favicon-*.png`, `apple-touch-icon.png`) |
| Site OG / Twitter card | `design/source/` (composition) | `site/public/og.png` (1200×630) |
| GitHub repo social card | — | `design/exports/og-github-1280x640.png` (1280×640; upload, not served) |
| Chain / token logo | (official brand SVG) | `site/public/chains/<chain>.svg`, `site/public/tokens/<sym>.svg` |
| WIP mockups / screenshots | `design/mockups/`, `design/screenshots/` | — |

## Brand, in one line

Dark (`oklch(0.145 0.005 260)`), near-white text, **one accent: emerald
`oklch(0.78 0.17 162)` ≈ `#2ee6a6` ("paid")**. Fonts: Inter + JetBrains Mono.
Minimal and static — the simplicity is the brand. Regenerate rasters from
`source/logo-source.png` with `sips` (commands in the skill).
