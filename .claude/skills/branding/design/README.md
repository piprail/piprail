# design/ — PipRail design working files

The one home for everything that produces a PipRail visual: the logo masters, the
published profile assets, and the render pipelines for social cards and the promo video.
**Bundled with the [`branding` skill](../SKILL.md)** so the skill travels with its assets.

> Full brand playbook (tokens, the Astro site, regenerating favicons/OG): see [`../SKILL.md`](../SKILL.md).

---

## The one rule: every file is SOURCE, PUBLISHED, GALLERY, or RENDER

This folder used to be a flat dump of HTML next to PNGs next to MP4s. It isn't anymore.
**Before you add a file, decide which of four kinds it is — that decides where it goes
and whether git tracks it.** No exceptions.

| Kind | What it is | Tracked? | Lives in |
| --- | --- | --- | --- |
| **SOURCE** | what you edit/design *from* — templates (`*.html`), render scripts (`*.mjs`/`*.py`), docs (`*.md`) | ✅ tracked | `social/`, `video/` (the pipelines) |
| **PUBLISHED** | a final deliverable **uploaded to an external surface** and kept canonical | ✅ tracked | `source/` (masters), `social/profile/` (profile assets) |
| **GALLERY** | a small, **named** set of finished renders kept as the canonical *examples* (one per card archetype) so the best work persists in git | ✅ tracked via an explicit `.gitignore` allowlist | beside its script in `social/*-cards/` |
| **RENDER** | any *other* pipeline output — every `*.png`/`*.mp4`/audio, the `assets.js` bundle, `frames/`, chain-card debug `*.html` | ❌ gitignored | beside the script that makes it |

A RENDER is disposable — you regenerate it by running its script. It is **never** committed
(the `.gitignore` enforces this for `social/**` and `video/**`). PUBLISHED and GALLERY are the
opposite: few, named, permanent, version-controlled. The difference between them is *where the asset
goes*: PUBLISHED is uploaded somewhere external (GitHub/X/the site); GALLERY just stays in the repo as
a reference example. The GALLERY allowlist is the short `!…/*.png` block in the repo `.gitignore`.

> **Decision shortcut:** "Is it the template or script itself?" → SOURCE. "Is it uploaded to
> GitHub / X / the site and must persist?" → PUBLISHED (`source/` or `social/profile/`). "Is it a
> finished render worth keeping as the canonical example?" → GALLERY (add it to the `.gitignore`
> allowlist). "Just another render a script can remake?" → RENDER (don't commit).

---

## Folder layout

```
design/
├── README.md            ← this file (the rule)
│
├── source/              ① MASTERS — originals everything derives from        [tracked]
│   └── logo-source.png · logo-512.png · logo-256.png
│
├── social/              ② SOCIAL — all external/brand imagery; source + gallery tracked, rest ignored
│   ├── CAMPAIGN.md              the campaign plan/copy
│   ├── profile/                 PUBLISHED profile deliverables (uploaded, permanent) [tracked PNGs]
│   │   ├── og-github-1280x640.png   → GitHub ▸ repo Settings ▸ Social preview
│   │   ├── x-banner-1500x500.png    → x.com/@piprail ▸ profile header
│   │   └── x-banner.html            the banner's source template
│   ├── chain-cards/             per-chain cards — render.mjs (+ reply/universal) · gallery: solana, base
│   ├── post-cards/              themed posts — 5 essential templates + render.mjs · gallery: open, explainer, plan
│   └── launch-cards/            4 canonical one-offs — hermes · payai · solana-gasless · multichain
│
├── video/               ③ PROMO-VIDEO pipeline — source tracked, renders ignored
│   └── scene.html · capture.mjs · genassets.mjs · synth.py  (+ README)
│
└── deck/                ④ PITCH DECK — generated, editable .pptx (pptxgenjs + embedded fonts)
    └── build.mjs · theme.mjs · assets.mjs · embed-fonts.mjs  (+ README)   [tracked WHOLE]
```

Each pipeline folder has its **own README** stating exactly what it renders and how. Read it
before touching that pipeline.

> **`deck/` is the exception to the render-ignored rule.** A pitch deck you send to partners is a
> **PUBLISHED deliverable**, so the whole folder is tracked (its own `.gitignore` re-includes
> `node_modules/` too) — the `.pptx`/`.pdf` are downloadable from GitHub and the section rebuilds on
> clone. Everything else here still follows SOURCE / PUBLISHED / GALLERY / RENDER.

## Where a new thing goes

| You're making… | Put the SOURCE in… | The RENDER lands in… (gitignored) | PUBLISH / KEEP to… |
| --- | --- | --- | --- |
| Logo / favicon / app icon | `source/` | — | `site/public/` (final, optimized) |
| GitHub repo social card | (the PNG itself) | — | **`social/profile/og-github-1280x640.png`** → repo Settings |
| X/Twitter profile header | `social/profile/x-banner.html` | — | **`social/profile/x-banner-1500x500.png`** → X profile |
| Per-chain announcement card | edit `social/chain-cards/render.mjs` | `chain-cards/<chain>.png` | post to socials; keepers → gallery |
| Themed campaign post | `social/post-cards/<name>.html` | `post-cards/post-<name>.png` | post to socials; keepers → gallery |
| Canonical launch / integration card | `social/launch-cards/<card>.html` + `render-<card>.mjs` | `launch-cards/<card>.png` | post; the 4 are in the gallery |
| Promo / demo video | edit `video/` (scene + scripts) | `video/piprail-demo.mp4` | site / socials |
| Chain / token logo (SVG) | (official brand SVG) | — | `site/public/chains|tokens/` |

> **Never** drop a finished render into `source/` or `social/profile/` just to "keep it." A render
> earns a tracked home only by being either PUBLISHED (uploaded somewhere external) or promoted into the
> **GALLERY** — and a gallery promotion means an explicit `!…/<file>.png` line in the repo `.gitignore`
> (plus a mention in that folder's README), not a stray `git add -f`. Everything else stays gitignored.

## Brand, in one line

Dark (`oklch(0.145 0.005 260)` ≈ `#0a0b0c`), near-white text, **one accent: emerald
`oklch(0.78 0.17 162)` ≈ `#2ee6a6` ("paid")**. Type: **Space Grotesk** (display/headings) · **Inter**
(body) · **JetBrains Mono** (code). Minimal and static — the simplicity is the brand. **Full tokens +
type + treatments: [`../SKILL.md` §2](../SKILL.md) — the single source of truth.** Rasters derive from
`source/logo-source.png`.
