# deck/ — the PipRail pitch deck (generated, brand-accurate, editable)

The investor / partner / vision pitch deck for PipRail — **the universal payment rail
for the agent economy**. A generated, fully **editable** `.pptx` that matches the brand
exactly (Space Grotesk / Inter / JetBrains Mono on the near-black + emerald canvas), with
the brand fonts **embedded** so it looks identical on any machine that opens it.

> Part of the PipRail **branding** skill (`.claude/skills/branding/`). The visual tokens here
> mirror `site/src/styles/global.css` — that file is the source of truth; `theme.mjs` restates it.

---

## What it is

15 slides, a hard-selling-but-true arc:

1. Hero · 2. Why now (money on-chain) · 3. The new buyer (agents) · 4. The standard (x402) ·
5. The problem (fragmentation) · 6. The reveal (universal adapter) · 7. How it works ·
8. Two sides, one SDK · 9. The MCP (give your agent a wallet) · 10. Open / dual-rail / gasless ·
11. Discovery + integrations · 12. Why PipRail wins (moat) · 13. Traction · 14. Business model
(open core) · 15. The ask.

Every stat is sourced in that slide's **speaker notes** (Bloomberg, Keyrock, Linux Foundation,
Chainalysis, McKinsey, Visa/Stripe/Mastercard IR, etc.). Counts (29 chains / 10 families) match
the SDK. The business-model slide is charter-safe: 0% on the payment path forever, monetize the
layer around the rail.

## Build it

```bash
npm install          # pptxgenjs (jszip rides along for font embedding)
npm run all          # assets.mjs -> build.mjs -> embed-fonts.mjs   => PipRail-deck.pptx
node preview.mjs     # QA: one PNG per slide (LibreOffice if present, else qlmanage)
node montage.mjs 3   # contact sheet of all slides -> preview/contact.png
node pdf.mjs         # shareable PipRail-deck.pdf (needs LibreOffice)
```

`npm run all` is the whole chain:
- **`assets.mjs`** — downloads the 8 brand TTFs (if missing), rasterizes the 29 chain + token
  logos from `site/public/chains|tokens/*.svg` (sharp), and renders the emerald-glow slide
  backgrounds (HTML → Chromium, the same pipeline `video/` uses).
- **`build.mjs`** — the deck itself. `theme.mjs` holds the brand tokens + layout helpers
  (card, stat, code window, footer…); `build.mjs` lays out the 15 slides + speaker notes.
- **`embed-fonts.mjs`** — post-processes the `.pptx` to embed the TTFs (OOXML `embeddedFontLst`),
  so the deck renders correctly on a machine without the fonts (verified: renders Space Grotesk
  under an isolated `$HOME` that hides the installed fonts).

## Editing the content

Two ways, by audience:
- **Quick copy tweaks for a meeting** — open `PipRail-deck.pptx` in PowerPoint / Keynote /
  Google Slides and edit the text directly. Everything except the decorative background glow is
  native, editable text + shapes. Embedded fonts travel with the file.
- **Structural / regenerable changes** — edit the slide functions in `build.mjs` (copy lives
  inline, clearly sectioned per slide) and re-run `npm run all`. Re-generating **overwrites**
  the baseline `.pptx`, so don't hand-edit the workspace copy and regenerate over it — the
  hand-edited, shared deliverable lives at the **repo root**, separate from this baseline.

## SOURCE vs RENDER (see ../README.md)

Tracked **SOURCE**: `*.mjs`, `theme.mjs`, `README.md`, `package.json`, `package-lock.json`,
`.gitignore`.
Gitignored **RENDER** (rebuild with `npm run all`): `node_modules/`, `assets/` (fonts + logos +
backgrounds), `preview/`, `*.pptx`, `*.pdf`.

## Notes

- Slide size is 13.333 × 7.5 in (16:9). Backgrounds render at 3840×2160 for crisp full-bleed.
- The deck pulls logos from `site/public/` — when a chain ships, `npm run assets` picks up its
  new SVG automatically.
- QA without LibreOffice falls back to `qlmanage`, which **ignores** embedded fonts (type shows a
  serif). Install the brand TTFs locally, or install LibreOffice, for a faithful preview.
