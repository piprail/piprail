# chain-cards/ — per-chain announcement cards

"PipRail now pays on `<chain>`" cards, 1600×900. The reference pipeline: the template is a
**string inside `render.mjs`**, logos are read from `site/public/` and base64-embedded, and
the script writes both a debug `<chain>.html` and the final `<chain>.png` beside itself.

```bash
node render.mjs <chain>          # e.g. base, solana, xrpl  → <chain>.png (+ debug <chain>.html)
node render-reply.mjs <chain>    # the reply/quote-tweet variant
node render-reply-square.mjs <chain>
```

- **SOURCE (tracked):** `render.mjs`, `render-reply.mjs`, `render-reply-square.mjs`.
- **RENDER (gitignored):** every `<chain>.html` **and** `<chain>.png` — both are written by the
  script, so both are disposable. Regenerate, don't commit.
- Known chains live in the `CHAINS` map at the top of `render.mjs`; logos resolve from
  `site/public/chains/<chain>.svg` and `site/public/logo-no-background.png`. Add a chain there.

See [`../../README.md`](../../README.md) for the SOURCE/PUBLISHED/RENDER rule.
