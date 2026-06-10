# launch-cards/ — one-off launch & comparison art

Marketing one-offs that don't fit the repeatable post/chain card pipelines: the
backendless-vs-facilitator comparison deck, chain-launch hero cards, the code-square card.

| Template | Renders to | How |
| --- | --- | --- |
| `compare-402.html` | `_cmp1.png … _cmp6.png` (1920×1080) | `node render-slides.mjs` (six slides via `?slide=N`) |
| `kaia-card.html` | `kaia-launch-1600x900.png` | ad-hoc — open in a browser / Playwright screenshot at 1600×900 |
| `code-square.html` | `code-square-1080.png` | ad-hoc — screenshot at 1080² |

- **SOURCE (tracked):** the `*.html` templates + `render-slides.mjs`.
- **RENDER (gitignored):** every `*.png`. Regenerate; never commit.
- The ad-hoc cards have no dedicated script (they're true one-offs); render with the same
  Playwright pattern as `render-slides.mjs` or open the HTML and screenshot. If a one-off ever
  becomes repeatable, give it a `render.mjs` and move it to `post-cards/`.

See [`../../README.md`](../../README.md) for the SOURCE/PUBLISHED/RENDER rule.
