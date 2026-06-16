# chain-cards/ — per-chain announcement cards

"PipRail now pays on `<chain>`" cards, 1600×900. The reference pipeline: the template is a
**string inside `render.mjs`**, logos are read from `site/public/` and base64-embedded, and
the script writes both a debug `<chain>.html` and the final `<chain>.png` beside itself.

```bash
node render.mjs <chain>          # e.g. base, solana, xrpl  → <chain>.png (+ debug <chain>.html)
node render-reply.mjs <chain>    # the reply / quote-tweet variant
node render-reply-square.mjs <chain>
node render-universal.mjs        # the single "works on every chain" card (not per-chain)
```

- **SOURCE (tracked):** `render.mjs`, `render-reply.mjs`, `render-reply-square.mjs`,
  `render-universal.mjs`. Known chains live in the `CHAINS` map at the top of `render.mjs`; logos
  resolve from `site/public/chains/<chain>.svg` and `site/public/logo-no-background.png`.
- **GALLERY (tracked by name):** two reference renders are committed — **`solana.png`** and
  **`base.png`** (the gasless-EURC card), allowlisted in the repo `.gitignore`. Render any other
  chain on demand; it lands as a gitignored PNG.
- **RENDER (gitignored):** every `<chain>.html` **and** every non-gallery `<chain>.png` — both are
  written by the script, so both are disposable. Regenerate, don't commit.

The campaign plan + per-chain copy/tags lives in [`../CAMPAIGN.md`](../CAMPAIGN.md).
See [`../../README.md`](../../README.md) for the SOURCE / PUBLISHED / RENDER / GALLERY rule.
