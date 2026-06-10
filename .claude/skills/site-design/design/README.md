# design/ — PipRail design working files

The one home for everything that produces a PipRail visual: the logo masters, the
published profile assets, and the render pipelines for social cards and the promo video.
**Bundled with the [`site-design` skill](../SKILL.md)** so the skill travels with its assets.

> Full brand playbook (tokens, the Astro site, regenerating favicons/OG): see [`../SKILL.md`](../SKILL.md).

---

## The one rule: every file is SOURCE, PUBLISHED, or RENDER

This folder used to be a flat dump of HTML next to PNGs next to MP4s. It isn't anymore.
**Before you add a file, decide which of three kinds it is — that decides where it goes
and whether git tracks it.** No exceptions.

| Kind | What it is | Tracked? | Lives in |
| --- | --- | --- | --- |
| **SOURCE** | what you edit/design *from* — templates (`*.html`), render scripts (`*.mjs`/`*.py`), docs (`*.md`) | ✅ tracked | `social/`, `video/` (the pipelines) |
| **PUBLISHED** | a final deliverable **uploaded to an external surface** and kept canonical | ✅ tracked | `source/` (masters), `brand/` (profile assets) |
| **RENDER** | anything a pipeline **generates** — every `*.png`/`*.mp4`/audio, the `assets.js` bundle, `frames/` | ❌ gitignored | beside the script that makes it |

A RENDER is disposable — you regenerate it by running its script. It is **never** committed
(the `.gitignore` enforces this for `social/**` and `video/**`). A PUBLISHED asset is the
opposite: few, permanent, version-controlled, and it has somewhere it gets uploaded.

> **Decision shortcut:** "Can a script regenerate this?" → RENDER (don't commit). "Is this
> uploaded to GitHub / X / the site and must persist?" → PUBLISHED (`brand/` or `source/`).
> "Is it the template or script itself?" → SOURCE (tracked, beside its pipeline).

---

## Folder layout

```
design/
├── README.md            ← this file (the rule)
│
├── source/              ① MASTERS — originals everything derives from        [tracked]
│   └── logo-source.png · logo-512.png · logo-256.png
│
├── brand/               ② PUBLISHED profile deliverables (uploaded, permanent) [tracked]
│   ├── og-github-1280x640.png   → GitHub ▸ repo Settings ▸ Social preview
│   ├── x-banner-1500x500.png    → x.com/@piprail ▸ profile header
│   └── x-banner.html            the banner's source template
│
├── social/              ③ SOCIAL render pipelines — source tracked, renders ignored
│   ├── CAMPAIGN.md              the campaign plan/copy
│   ├── chain-cards/             per-chain announcement cards — render.mjs (+ replies)
│   ├── post-cards/              themed campaign posts — *.html templates + render.mjs
│   └── launch-cards/            one-off launch art — compare/kaia/code-square + render-slides
│
└── video/               ④ PROMO-VIDEO pipeline — source tracked, renders ignored
    └── scene.html · capture.mjs · genassets.mjs · synth.py  (+ README)
```

Each pipeline folder has its **own README** stating exactly what it renders and how. Read it
before touching that pipeline.

## Where a new thing goes

| You're making… | Put the SOURCE in… | The RENDER lands in… (gitignored) | PUBLISH to… |
| --- | --- | --- | --- |
| Logo / favicon / app icon | `source/` | — | `site/public/` (final, optimized) |
| GitHub repo social card | (the PNG itself) | — | **`brand/og-github-1280x640.png`** → repo Settings |
| X/Twitter profile header | `brand/x-banner.html` | — | **`brand/x-banner-1500x500.png`** → X profile |
| Per-chain announcement card | edit `social/chain-cards/render.mjs` | `chain-cards/<chain>.png` | post to socials |
| Themed campaign post | `social/post-cards/<name>.html` | `post-cards/post-<name>.png` | post to socials |
| Launch / comparison card | `social/launch-cards/*.html` | `launch-cards/*.png` | post / slides |
| Promo / demo video | edit `video/` (scene + scripts) | `video/piprail-demo.mp4` | site / socials |
| Chain / token logo (SVG) | (official brand SVG) | — | `site/public/chains|tokens/` |

> **Never** drop a finished render into `brand/` or `source/` just to "keep it" — if a script
> made it, it's a RENDER and stays gitignored. Only assets that are *uploaded somewhere and
> must persist* earn a tracked home. Commit a genuine new published asset with `git add -f`.

## Brand, in one line

Dark (`oklch(0.145 0.005 260)`), near-white text, **one accent: emerald
`oklch(0.78 0.17 162)` ≈ `#2ee6a6` ("paid")**. Fonts: Inter + JetBrains Mono. Minimal and
static — the simplicity is the brand. Rasters derive from `source/logo-source.png` (see the skill).
