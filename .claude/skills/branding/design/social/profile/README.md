# brand/ — PUBLISHED profile deliverables

The few canonical assets that get **uploaded to an external surface** and must stay
version-controlled. Unlike everything under `social/` and `video/` (regenerable renders,
gitignored), these are **tracked** — they are the live face of the project and have a fixed
home they're published to.

| File | Dimensions | Published to | Source |
| --- | --- | --- | --- |
| `og-github-1280x640.png` | 1280×640 (2:1) | GitHub ▸ repo **Settings ▸ Social preview** | (composited PNG) |
| `x-banner-1500x500.png` | 1500×500 | **x.com/@piprail** ▸ Edit profile ▸ header | `x-banner.html` |

> The site's own Open Graph card is **not** here — it's a shipped asset at
> `site/public/og.png` (1200×630). This folder is only for assets uploaded to a *profile/repo*.

## Rules

- **Tracked, permanent.** Commit changes here deliberately. Don't delete unless the asset is
  truly retired.
- **Render → resize → drop the final here.** `x-banner.html` is rendered at 1500×500 (open in
  a browser or screenshot via Playwright) and the optimized PNG saved as `x-banner-1500x500.png`.
- **Not a junk drawer.** Only assets that are *uploaded somewhere and must persist* belong here.
  A regenerable card or video is a RENDER — it lives under `social/`/`video/` and stays gitignored.
  See [`../README.md`](../README.md) for the SOURCE / PUBLISHED / RENDER rule.
