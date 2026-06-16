# social/ — social-card pipelines + the example gallery

Everything for the social presence: the campaign plan, the published profile assets, and three
render pipelines. Each pipeline is **self-contained** — its templates + render script live
together, and its PNG outputs land right beside them.

```
social/
├── README.md          ← this file
├── CAMPAIGN.md        the "one chain a day" campaign plan + per-chain copy/tags
├── profile/           PUBLISHED, uploaded deliverables — X header + GitHub social card   [tracked]
├── launch-cards/      the 4 canonical one-off cards (integration · gasless · code)        [gallery]
├── post-cards/        themed square posts — 5 essential templates + 3 example renders        [gallery]
└── chain-cards/       per-chain "now pays on <chain>" cards — pipeline + 2 example renders  [gallery]
```

| Pipeline | What it renders | Run |
| --- | --- | --- |
| [`chain-cards/`](chain-cards/) | per-chain announcement cards, 1600×900 (+ reply / universal variants) | `node render.mjs <chain>` |
| [`post-cards/`](post-cards/) | themed campaign posts, 1080×1080 | `node render.mjs <name>` |
| [`launch-cards/`](launch-cards/) | 4 canonical one-offs (Hermes · PayAI · Solana-gasless · multichain) | `node render-<card>.mjs` |

## The rule here — four kinds, only two land in git

Same as the [parent rule](../README.md), with one addition (GALLERY):

- **SOURCE** — the `*.html` templates (or the template literal inside `render.mjs`) + the `*.mjs`
  scripts. **Tracked.**
- **PUBLISHED** — the uploaded, permanent deliverables in `profile/`. **Tracked.**
- **GALLERY** — a small, **named** set of finished renders kept as canonical examples (the 4
  launch cards + `post-open`/`post-explainer`/`post-plan` + `chain-cards/solana`/`base`). **Tracked by
  an explicit allowlist** in the repo `.gitignore` — so the best cards persist and nothing else does.
- **RENDER** — every other `*.png`/`*.mp4` a script writes, plus the `chain-cards/*.html` debug
  dumps. **Gitignored.** Never commit one; rerun the script instead.

Logos come from the **single source of truth** `site/public/` (chain SVGs, `logo*.png`) or the
shared `../video/assets.js` bundle — never a duplicated copy in here. See [`../README.md`](../README.md).
