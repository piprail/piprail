# post-cards/ — themed campaign post cards

Square (1080×1080) posts for the campaign themes (the machine economy, RWAs, the 402 loop,
`planPayment`, the spend policy, chain launches, …). **One template per card; one generic
renderer for all of them** — this folder is the reusable template library, so it keeps *all*
the templates even though only a few rendered PNGs live in git.

```bash
# render any card by name -> post-<name>.png
node render.mjs base        # uses card-base.html
node render.mjs near        # uses post-near.html
node render.mjs plan        # uses post-plan.html
```

`render.mjs <name>` finds `card-<name>.html` or `post-<name>.html` beside it and screenshots it
to `post-<name>.png` at 1080² @2×. (This one script replaced the old per-theme
`render-ai.mjs` / `render-base.mjs` / … zoo.)

## Two template flavours

| Prefix | Logos via | Notes |
| --- | --- | --- |
| `card-*.html` | the shared bundle `../../video/assets.js` | run `node ../../video/genassets.mjs` once first to (re)build the bundle |
| `post-*.html` | `site/public/` directly (relative `../../../../../../site/public/…`) | self-contained; no bundle needed |

- **SOURCE (tracked):** every `card-*.html` / `post-*.html` template + `render.mjs`. The full
  template set is the library — keep it; it's cheap and it's the actual reusable IP.
- **GALLERY (tracked by name):** three reference renders are committed as examples —
  **`post-ai.png`**, **`post-open.png`**, **`post-explainer.png`** (allowlisted in the repo
  `.gitignore`). Pick a kept one to add a new example.
- **RENDER (gitignored):** every other `post-*.png`. Regenerate from its template; never commit.
- **No local logo copies.** Templates reference `site/public/` (the single source of truth) or
  the shared bundle. See [`../../README.md`](../../README.md).
