# post-cards/ — themed campaign post cards

Square (1080×1080) posts. This folder is a **curated, minimal template set** — one template per
*distinct layout*, not one per slogan. The copy inside each is swappable; the layout is the reusable
asset. One generic renderer drives them all.

```bash
# render any card by name -> post-<name>.png
node render.mjs open        # uses card-open.html
node render.mjs plan        # uses post-plan.html
```

`render.mjs <name>` finds `card-<name>.html` or `post-<name>.html` beside it and screenshots it to
`post-<name>.png` at 1080² @2×.

## The five essential templates (one per layout)

| Template | Layout / archetype | Use it for |
| --- | --- | --- |
| `card-open.html` | **two-bullet thesis** (logo · eyebrow · big headline · sub · 2 bullet rows · chain strip) | the workhorse — any "agents pay, here's why" claim. Swap the copy. |
| `post-plan.html` | **centered code card** | showing a feature in code — here `planPayment()` |
| `post-policy.html` | **centered code card** | a second feature — the spend policy |
| `post-explainer.html` | **402 → 200 flow** | the signature "what PipRail does" explainer |
| `card-rwa.html` | **logo grid** | "live where the money flows" — a wall of chain logos |
| `card-custody.html` | **benefit checklist + mission strip** | self-custody / "not your keys, not your crypto" — you own everything |

> `card-*` templates embed logos from the shared bundle `../../video/assets.js` — run
> `node ../../video/genassets.mjs` once first to (re)build it. `post-*` templates read `site/public/`
> directly (self-contained). Per-chain cards are **not** here — that's the [`chain-cards/`](../chain-cards/) pipeline.

- **SOURCE (tracked):** the five templates + `render.mjs`. Need a new layout? Add one template here;
  don't add a fifth copy of an existing layout.
- **GALLERY (tracked by name):** three reference renders are committed — **`post-open.png`**
  (two-bullet), **`post-explainer.png`** (flow), **`post-plan.png`** (code) — allowlisted in the repo
  `.gitignore`, one per visual archetype.
- **RENDER (gitignored):** every other `post-*.png`. Regenerate from its template; never commit.
- **No local logo copies.** Templates reference `site/public/` or the shared bundle. See [`../../README.md`](../../README.md).
