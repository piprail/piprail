# brand/ — PUBLISHED profile deliverables

The few canonical assets that get **uploaded to an external surface** and must stay
version-controlled. Unlike everything under `social/` and `video/` (regenerable renders,
gitignored), these are **tracked** — they are the live face of the project and have a fixed
home they're published to.

| File | Dimensions | Published to | Source |
| --- | --- | --- | --- |
| `og-github-1280x640.png` | 1280×640 (2:1) | GitHub ▸ repo **Settings ▸ Social preview** | (composited PNG) |
| `x-banner-1500x500.jpg` | 1500×500 | **x.com/@piprail** ▸ Edit profile ▸ header (this is the file you upload) | exported from the PNG by `render-x-banner.mjs` |
| `x-banner-1500x500.png` | 1500×500 | master render (the JPEG above is exported from it) | `render-x-banner.mjs` → `x-banner.html` |

> The site's own Open Graph card is **not** here — it's a shipped asset at
> `site/public/og.png` (1200×630). This folder is only for assets uploaded to a *profile/repo*.

## Rules

- **Tracked, permanent.** Commit changes here deliberately. Don't delete unless the asset is
  truly retired.
- **Render → resize → drop the final here.** Run `node render-x-banner.mjs` — it writes the
  `x-banner.html` source, the master `x-banner-1500x500.png` (retina-rendered, downscaled to
  1500×500), **and** the optimized `x-banner-1500x500.jpg` you actually upload to X. The layout
  keeps the **bottom-left empty** so the live profile avatar never clips it (logo top-left ·
  `npm i` pill top-right · statement centre-left · 402→Paid card centre-right).
- **Not a junk drawer.** Only assets that are *uploaded somewhere and must persist* belong here.
  A regenerable card or video is a RENDER — it lives under `social/`/`video/` and stays gitignored.
  See [`../README.md`](../README.md) for the SOURCE / PUBLISHED / RENDER rule.
