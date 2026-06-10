# social/ — social-card render pipelines + campaign

Everything for the social presence: the campaign plan and three render pipelines. Each
pipeline is **self-contained** — its templates + render script live together, and its PNG
outputs land right beside them (gitignored; regenerate by running the script).

| Path | What it renders | Run |
| --- | --- | --- |
| [`CAMPAIGN.md`](CAMPAIGN.md) | the campaign plan/copy (not a render) | — |
| [`chain-cards/`](chain-cards/) | per-chain announcement cards, 1600×900 (+ reply variants) | `node render.mjs <chain>` |
| [`post-cards/`](post-cards/) | themed campaign posts, 1080×1080 | `node render.mjs <name>` |
| [`launch-cards/`](launch-cards/) | one-off launch/comparison art | `node render-slides.mjs` (etc.) |

## The rule here (same as the parent)

- **SOURCE** = the `*.html` templates (or the template literal inside `render.mjs`) + the
  `*.mjs` scripts. **Tracked.**
- **RENDER** = every `*.png`/`*.mp4` a script writes. **Gitignored** — `.gitignore` ignores
  `social/**/*.png` and `social/**/*.mp4`. Never commit one; rerun the script instead.

Logos come from the **single source of truth** `site/public/` (chain SVGs, `logo*.png`) or the
shared `../video/assets.js` bundle — never a duplicated copy in here. See [`../README.md`](../README.md).
