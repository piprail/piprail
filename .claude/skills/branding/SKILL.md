---
name: branding
description: >-
  The PipRail brand bible — the entire visual identity and every design asset. The
  brand system (colors, type, logo, "emerald = paid"), the canonical home for every
  image (master/working files in design/, shipped assets in site/public/), AND how
  to design/edit the website (piprail.com, Astro). Use whenever the task touches the
  brand: "change the site / landing page", "update the logo / favicon / OG image",
  "add a chain or token logo", "tweak colors / fonts / layout", "make a social card /
  banner / promo video", or "where do design files go". Keep it static-first, dark,
  emerald-accented, and dead simple — the minimalism IS the brand.
---

# PipRail branding — brand system, assets & site

The site is **`site/` — Astro 5 + Tailwind v4, static-first** ($0/mo on Netlify).
No React runtime, no SSR adapter, no backend. Three pages: the home (`/`), the
**`@piprail/mcp` setup guide (`/mcp`)**, and the demo (`/demo`). The brand is **dark, minimal,
emerald-accented** ("emerald = paid"). Design working files live in **this skill's
own `design/` folder** (`.claude/skills/branding/design/`); the assets the site
actually serves live in **`site/public/`** (repo). Never confuse the two.

---

## 1. Where everything lives (the asset map)

### `design/` (bundled with this skill) — MASTER + working files
Lives at **`.claude/skills/branding/design/`** — beside this SKILL, so the skill
and its assets travel together and the repo root stays clean. **One strict rule governs it:
every file is SOURCE, PUBLISHED, GALLERY, or RENDER** — read [`design/README.md`](design/README.md),
it's the law for this folder. SOURCE (templates/scripts), PUBLISHED (masters + profile assets), and
GALLERY (a short, named allowlist of example renders) are tracked; every other RENDER a script
generates is gitignored and regenerable.

```
.claude/skills/branding/design/
├── README.md            # the rule (SOURCE / PUBLISHED / GALLERY / RENDER) — read it
├── source/              # ① MASTERS (tracked): logo-source.png · logo-512/256
├── social/              # ② SOCIAL — ALL external/brand imagery; source + gallery tracked, rest ignored
│   ├── CAMPAIGN.md      #    the campaign plan ("one chain a day")
│   ├── profile/         #    PUBLISHED profile deliverables (tracked PNGs): og-github (→ GitHub social
│   │                    #    preview) · x-banner-1500x500 (→ X header) + x-banner.html (its source)
│   ├── chain-cards/     #    per-chain announce cards — render.mjs (template in the script); gallery: solana, base
│   ├── post-cards/      #    themed posts — *.html template library + one render.mjs; gallery: ai, open, explainer
│   └── launch-cards/    #    4 canonical one-offs (png+html+script): hermes · payai · solana-gasless · multichain
├── video/               # ③ PROMO-VIDEO pipeline — own README; scene.html · capture/genassets/synth
│                        #    (renders gitignored)
└── deck/                # ④ PITCH DECK — the investor/partner deck: a generated, EDITABLE .pptx
                         #    (pptxgenjs + embedded brand fonts). Own README; `npm run all` to build.
```

> **The example gallery** (the `[gallery]` cards above) is the answer to "where are the good cards?"
> — a curated, **named** set of finished renders committed to git via an explicit `!…/*.png` allowlist
> in the repo `.gitignore`, so the best work is never lost locally. Everything else a script renders
> stays gitignored and regenerable. To keep a new card, promote it into the gallery (allowlist line +
> a note in that folder's README); don't `git add -f` strays.

> **`deck/` is the one design pipeline tracked WHOLE** (its own `.gitignore` overrides the
> renders-ignored rule): the deck is a **PUBLISHED, shareable deliverable** — the `.pptx`/`.pdf`
> are committed so partners can download them from GitHub, and its (pure-JS) deps ride along so it
> rebuilds on clone. To regenerate or edit copy/structure, read [`design/deck/README.md`](design/deck/README.md).

> **Why `social/profile/` and not a separate `brand/`?** Everything external-facing (profile headers
> *and* campaign cards) now lives under `social/` — one home for brand imagery. The `profile/`
> subfolder holds the few **permanent, uploaded** deliverables (tracked, even though sibling card
> renders are gitignored — a `.gitignore` exception keeps `social/profile/*.png` in git).

Each pipeline folder (`social/*`, `video/`) has its **own README** with the exact render
commands — read that folder's README before touching it; don't reverse-engineer the scripts.
**Don't dump a finished render into `source/` or `social/profile/`** — if a script made it, it's a
RENDER and stays under its pipeline, gitignored.

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

> **Rule:** edit/keep originals in `design/`; export only the final, optimized file into `site/public/`. The GitHub social card (`og-github-1280x640.png`) stays in `design/social/profile/` (the PUBLISHED profile-deliverables folder) — it's uploaded via the GitHub repo UI, not served by the site.

---

## 2. The brand system — THE single source of truth (`site/src/styles/global.css`)

This is the canonical visual identity. **Every PipRail surface — the site, social cards, the promo
video, the GitHub/X profiles — matches THESE tokens.** The site's `global.css` `@theme` block is the
literal source; change a brand value HERE and everything references it. The card/video templates (in
`design/`) and the content studio's media standard (`content-studio/MEDIA.md`) restate the *summary*
below for convenience, but **this section is authoritative — when anything disagrees, this wins.**

### Color — one accent, on a near-black canvas
| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `oklch(0.145 0.005 260)` ≈ **`#0a0b0c`** | near-black canvas (true black, not gray); also `<meta theme-color>` |
| `--color-fg` | `oklch(0.985 0 0)` | near-white text |
| `--color-muted` | `oklch(0.62 0.01 260)` | secondary / sub text |
| `--color-line` | `oklch(1 0 0 / 0.08)` | hairline borders |
| **`--color-accent`** | **`oklch(0.78 0.17 162)` ≈ `#2ee6a6`** | **emerald — "paid". THE one brand color; it does all the work.** |
| `--color-accent-soft` | accent at 12% | tints / fills |
| _lighter emerald_ | `oklch(0.84–0.86 0.13 162)` | glows, particles, the code-string token |
| _blue (hero only)_ | `oklch(0.70 0.16 250)` | the secondary hero-orb glow — low alpha, **never a 2nd brand color** |

A chain's OWN brand color (Base blue, Solana purple, …) is allowed *only as that chain's logo* — the
contrast against black+emerald is what makes it pop. Brand purple `#6e56cf` appears ONLY in the root
README's x402 shields.io badge — it is **not** a site token and never a brand color; don't add it.

### Type — three faces, each with a job
- **Space Grotesk — the DISPLAY face:** `h1`, `h2`, headlines, the wordmark, big stat numbers. A
  geometric grotesk that gives headings their own voice against the Inter body. Weights **500–700**
  (700 = bold display; it has **no 800/900**, so a heading is never heavier than 700 — don't fake it).
- **Inter — body / sub-text / labels / UI.** Weights 400–700.
- **JetBrains Mono — code, terminal text, mono chips, numbers-in-labels.**
- Loaded once in `Layout.astro` from Google Fonts — mirror this exact set in any template that draws a
  heading: `Inter:wght@400;500;600;700` · `Space+Grotesk:wght@500;600;700` · `JetBrains+Mono:wght@400;500`.

### Surfaces, glow & motion (the "feel")
- **`card`** = a crafted surface: a quiet top-down white gradient + 1px border + inset top edge-light +
  soft ambient drop-shadow. **`lift`** = the depth only (for hairline-grid cells). (utilities in global.css)
- **`.cta-glow`** = a soft emerald halo under primary (accent) CTAs; deepens on hover. Premium lift, not a strobe.
- **Hero ambience:** two slow-drifting blurred radial **orbs** (emerald `oklch(0.78 0.17 162 / .17)` +
  blue `oklch(0.70 0.16 250 / .13)`) behind faint emerald **particles** (`oklch(0.86 0.13 162)`) — gentle,
  slow, decorative; the static content sits in front. Social cards echo this with a soft emerald (+ a
  hint of blue) radial glow behind the focal element — a **whisper, not a strobe**.
- **Code tokens** (`.tok-*`): kw `oklch(0.62 0.01 260)` · str `oklch(0.84 0.13 162)` · fn
  `oklch(0.8 0.11 235)` · **chain `oklch(0.85 0.14 85)` (amber — the eye lands on the chain word)** ·
  num `oklch(0.8 0.12 25)` · com `oklch(0.5 0.01 260)` italic.
- Always respect `prefers-reduced-motion` (orbs / particles / marquee / fade-in hold still — handled in global.css).

**The feel in one line:** dark, minimal, emerald-accented, **contrast-not-glow**. The restraint IS the brand.

> **Verbal identity (voice, messaging, what we say) lives in the [`content-studio`](../content-studio/SKILL.md)
> skill** (`BRAND.md` + `PLAYBOOK.md`); its media standard (`MEDIA.md`) defers to THIS section for the
> visual tokens. branding = how it looks; content-studio = what it says. Together they're the brand.

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
SRC=.claude/skills/branding/design/source/logo-source.png
sips -s format png -Z 256 "$SRC" --out site/public/logo.png
sips -s format png -z 16 16   "$SRC" --out site/public/favicon-16.png
sips -s format png -z 32 32   "$SRC" --out site/public/favicon-32.png
sips -s format png -z 48 48   "$SRC" --out site/public/favicon-48.png
sips -s format png -z 180 180 "$SRC" --out site/public/apple-touch-icon.png
```

- **OG card (`site/public/og.png`, 1200×630):** the social card. If recomposing from a wider design, scale to width then center-crop: `sips -Z 1200 in.png; sips -c 630 1200 in.png`. Keep it under ~300 KB.
- **GitHub social card (`design/social/profile/og-github-1280x640.png`, 1280×640):** GitHub's card ratio is 2:1, distinct from OG's 1.91:1 — keep it in `design/social/profile/` (PUBLISHED deliverables), upload via repo **Settings → Social preview**.
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
