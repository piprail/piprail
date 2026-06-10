# post-cards/ — themed campaign post cards

Square (1080×1080) posts for the campaign themes (the machine economy, RWAs, the 402 loop,
`planPayment`, the spend policy, chain launches, …). One template per card; one generic
renderer for all of them.

```bash
# render any card by name -> post-<name>.png
node render.mjs base        # uses card-base.html
node render.mjs near        # uses post-near.html
node render.mjs plan        # uses post-plan.html
```

`render.mjs <name>` finds `card-<name>.html` or `post-<name>.html` beside it and screenshots it
to `post-<name>.png` at 1080² @2×. (This one script replaced the old per-theme
`render-ai.mjs` / `render-base.mjs` / … / `render-export.mjs` zoo.)

## Two template flavours

| Prefix | Logos via | Notes |
| --- | --- | --- |
| `card-*.html` | the shared bundle `../../video/assets.js` | run `node ../../video/genassets.mjs` once first to (re)build the bundle |
| `post-*.html` | `site/public/` directly (relative `../../../../../../site/public/…`) | self-contained; no bundle needed |

- **SOURCE (tracked):** the `card-*.html` / `post-*.html` templates + `render.mjs`.
- **RENDER (gitignored):** `post-*.png`. Regenerate; never commit.
- **No local logo copies.** Templates reference `site/public/` (the single source of truth) or
  the shared bundle — the old duplicated `logo.png` was deleted. See [`../../README.md`](../../README.md).
