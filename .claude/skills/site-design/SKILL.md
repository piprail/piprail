---
name: site-design
description: >-
  How to design and edit the PipRail website (piprail.com) and manage all design
  assets — the brand system, the Astro site structure, and the canonical home for
  every image (master/working files in design/, shipped assets in site/public/).
  Use this whenever the task is "change the site / landing page", "update the
  logo / favicon / OG image", "add a chain or token logo to the site", "tweak
  colors / fonts / layout", "make a social card / banner", or "where do design
  files go". Keep it static-first, dark, emerald-accented, and dead simple.
---

# PipRail site & design

The site is **`site/` — Astro 5 + Tailwind v4, static-first** ($0/mo on Netlify).
No React runtime, no SSR adapter, no backend. Three pages: the home (`/`), the
**`@piprail/mcp` setup guide (`/mcp`)**, and the demo (`/demo`). The brand is **dark, minimal,
emerald-accented** ("emerald = paid"). Design working files live in **this skill's
own `design/` folder** (`.claude/skills/site-design/design/`); the assets the site
actually serves live in **`site/public/`** (repo). Never confuse the two.

---

## 1. Where everything lives (the asset map)

### `design/` (bundled with this skill) — MASTER + working files (local only)
Lives at **`.claude/skills/site-design/design/`** — beside this SKILL, so the skill
and its assets travel together and the repo root stays clean. **One strict rule governs it:
every file is SOURCE, PUBLISHED, or RENDER** — read [`design/README.md`](design/README.md), it's
the law for this folder. SOURCE (templates/scripts) and PUBLISHED (masters + profile assets)
are tracked; RENDER (anything a script generates) is gitignored and regenerable.

```
.claude/skills/site-design/design/
├── README.md            # the rule (SOURCE / PUBLISHED / RENDER) — read it
├── source/              # ① MASTERS (tracked): logo-source.png · logo-512/256
├── brand/               # ② PUBLISHED profile assets (tracked): og-github (→ GitHub social
│                        #    preview) · x-banner (→ X header) + x-banner.html
├── social/              # ③ SOCIAL pipelines — source tracked, renders gitignored
│   ├── CAMPAIGN.md      #    the campaign plan
│   ├── chain-cards/     #    per-chain announce cards — render.mjs (template is in the script)
│   ├── post-cards/      #    themed posts — *.html templates + one generic render.mjs
│   └── launch-cards/    #    one-off launch/comparison art + render-slides.mjs
└── video/               # ④ PROMO-VIDEO pipeline (was root .video-build/) — own README;
                         #    scene.html · capture/genassets/synth; renders gitignored
```

Each pipeline folder (`social/*`, `video/`) has its **own README** with the exact render
commands — read that folder's README before touching it; don't reverse-engineer the scripts.
**Don't dump a finished render into `brand/`/`source/`** — if a script made it, it's a RENDER
and stays under its pipeline, gitignored.

### `site/public/` — SHIPPED assets (served verbatim at piprail.com/…)
Only optimized, final files go here. Everything is referenced by absolute path (`/logo.png`).

| File | What | Size |
| --- | --- | --- |
| `logo.png` | header/footer mark | square (≥256) |
| `favicon-16.png` `favicon-32.png` `favicon-48.png` | browser favicons | 16/32/48 |
| `apple-touch-icon.png` | iOS home-screen icon | 180×180 |
| `og.png` | Open Graph / Twitter card (site) | **1200×630** |
| `chains/<chain>.svg` | one logo per built-in chain (filename = lowercase SDK chain key/slug, e.g. `base.svg`, `xrpl.svg`); the set in `site/public/chains/` is the source of truth for the current count | SVG |
| `tokens/<sym>.svg` | one logo per default token (`usdc` `usdt` `eurc` `rlusd`); add one when a new default token ships | SVG |
| `robots.txt` `llms.txt` `llms-full.txt` | crawler/LLM hints | — |

> **Rule:** edit/keep originals in `design/`; export only the final, optimized file into `site/public/`. The GitHub social card (`og-github-1280x640.png`) stays in `design/brand/` (the PUBLISHED-deliverables folder) — it's uploaded via the GitHub repo UI, not served by the site.

---

## 2. The brand system (single source: `site/src/styles/global.css`)

Tailwind v4 `@theme` tokens — change brand colors HERE (everything else references them):

- `--color-bg`   `oklch(0.145 0.005 260)` — near-black background
- `--color-fg`   `oklch(0.985 0 0)` — near-white text
- `--color-muted` `oklch(0.62 0.01 260)` — secondary text
- `--color-line` `white / 0.08` — hairline borders
- **`--color-accent` `oklch(0.78 0.17 162)` — emerald ("paid"); the one brand color.** Hex ≈ `#2ee6a6`.
- `--color-accent-soft` — accent at 12%
- Secondary glow (hero only): blue `oklch(0.7 0.16 250)` at low alpha
- Fonts: **Inter** (sans), **JetBrains Mono** (mono) — loaded from Google Fonts in the layout
- Hero has a soft emerald+blue radial glow; code blocks use the `.tok-*` token colors (the chain word is amber so the eye lands on it)
- Brand purple `#6e56cf` is used only for the x402 shields.io badge in the root `README.md` — it is **not** a site token and does not appear in `global.css` or any component; don't add it as a brand color.

Respect `prefers-reduced-motion` (already handled in global.css).

---

## 3. Editing the site

```
site/src/
├── pages/        index.astro · mcp.astro · demo.astro   # / · /mcp (@piprail/mcp guide) · /demo
├── layouts/      Layout.astro                       # <head>: SEO meta, OG, favicons, JSON-LD
├── components/   Navigation · Footer · CodeWindow · FeatureGrid · SectionHeading  (.astro)
├── data/         chains.ts · snippets.ts            # content data (no hardcoding in markup)
└── styles/       global.css                         # the @theme tokens above
```

- **Run/build:** `npm run dev -w @piprail/site` · `npm run build -w @piprail/site` (output → `site/dist/`, gitignored).
- **SEO / social / favicons** are wired in `Layout.astro` (og:image → `/og.png`, theme-color `#0a0b0c`, full Open Graph + Twitter `summary_large_image`, hreflang/canonical, keywords). It emits **five** `application/ld+json` blocks — SoftwareApplication (#sdk), Organization, WebSite, SoftwareSourceCode, and a **distinct SoftwareApplication (#mcp)** for `@piprail/mcp` (url `/mcp`). Update there.
- **Sitemap** is generated by the `@astrojs/sitemap` integration in `astro.config.mjs` (custom `serialize()` sets per-page priority/changefreq; output `sitemap-index.xml`).
- **AEO/GEO files** live in `site/public/`: `llms.txt` (concise index) + `llms-full.txt` (full pitch). Both carry a header line pinning `SDK-Version`, `MCP-Version`, and `Last-Updated` — refresh all three on every SDK/MCP publish (this is part of the `release` + `docs-sync` flow, not just a site edit). Any chain count quoted in these files must be re-synced with the rest of the site.
- **Content lives in `site/src/data/`** — prefer adding to `chains.ts`/`snippets.ts` over hardcoding in the page.
- Match the existing component style; keep it static (no client JS unless the page genuinely needs it, like `demo.astro`).

---

## 4. Regenerating raster assets (macOS `sips`, from the master)

All raster assets derive from `design/source/logo-source.png`. Regenerate, then copy the final into `site/public/`:

```bash
# run from the repo root — the masters travel with this skill
SRC=.claude/skills/site-design/design/source/logo-source.png
sips -s format png -Z 256 "$SRC" --out site/public/logo.png
sips -s format png -z 16 16   "$SRC" --out site/public/favicon-16.png
sips -s format png -z 32 32   "$SRC" --out site/public/favicon-32.png
sips -s format png -z 48 48   "$SRC" --out site/public/favicon-48.png
sips -s format png -z 180 180 "$SRC" --out site/public/apple-touch-icon.png
```

- **OG card (`site/public/og.png`, 1200×630):** the social card. If recomposing from a wider design, scale to width then center-crop: `sips -Z 1200 in.png; sips -c 630 1200 in.png`. Keep it under ~300 KB.
- **GitHub social card (`design/brand/og-github-1280x640.png`, 1280×640):** GitHub's card ratio is 2:1, distinct from OG's 1.91:1 — keep it in `design/brand/` (PUBLISHED deliverables), upload via repo **Settings → Social preview**.
- For higher fidelity than `sips`, `sharp` (already an Astro dep) or an SVG master works too.

---

## 5. Chain & token logos

- One **SVG** per chain in `site/public/chains/<chain>.svg`, filename = the **lowercase SDK chain key** (`base`, `bnb`, `solana`, `xrpl`, …) — one per built-in chain; `ls site/public/chains/` is the current count, never a number quoted here.
- One SVG per token in `site/public/tokens/` (`usdc`, `usdt`, `eurc`, `rlusd`).
- These render in the site's chain grid **and** are reused by the GitHub org profile README (via `https://piprail.com/chains/<chain>.svg`).
- **Adding a chain?** Dropping its logo SVG here is part of the **`add-chain-integration`** skill — a chain isn't "done" until it's on the site. Use the official brand SVG, simplified/trimmed, viewBox-normalized to sit cleanly at ~44px.
- **The chain/family count is hardcoded in many places on the site** — the `{ v: '…', l: 'chains built in' }` stat tile in `index.astro`, the feature/FAQ copy, the `EVM ×N` families strip, the snippet comment in `data/snippets.ts`, and the JSON-LD in `Layout.astro`. When the built-in set changes, bump *every* occurrence: `grep -rn "chains built in" site/src && grep -rnE "[0-9]+ chains|EVM ×|EVM mainnets|families" site/src`. The authoritative total lives in `sdk/README.md` + `sdk/CHAINS.md`; the full count-propagation procedure is owned by the `add-chain-integration` and `docs-sync` skills — follow those rather than treating any number here as fixed.

---

## 6. Don'ts

- Don't commit working files to `site/public/` — only final, optimized assets the site serves.
- Don't add a React runtime, SSR adapter, or backend "for design" — static-first is the charter.
- Don't hardcode a new brand color in a component — add/adjust a token in `global.css`.
- Don't break `prefers-reduced-motion` or the dark theme.
- Keep it simple: the minimalism *is* the brand.
