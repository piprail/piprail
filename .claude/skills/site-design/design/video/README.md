# design/video/ — the promo-video & social-card render pipeline

The local HTML → Chromium-frames → ffmpeg pipeline that produces the PipRail promo
video (`piprail-demo.mp4`) and the per-theme social cards. It used to live at the repo
root as `.video-build/`; it now lives here so the whole **design** workflow sits in one
place under the `site-design` skill.

> **Local-only render tooling.** The **source** here (the `.html` scenes/cards, the
> `.mjs` render scripts, `synth.py`, this README) is tracked so the skill is
> self-contained. The **generated outputs** (`assets.js`, `wave.png`, `music.wav`,
> `frames/`, `sample/`, any `*.png`/`*.mp4`) are gitignored — they're rebuilt on demand
> and would only bloat the repo. The finished video ships to `../exports/` (and onto the
> site / socials), never from here.

All brand/asset sources are owned by the [`site-design` skill](../../SKILL.md); the design
masters live in [`../source/`](../source/).

---

## What's here

| File | Role |
| --- | --- |
| `scene.html` | **the promo show** — an 8-beat WAAPI timeline, paused and seeked per-frame via `window.seek(t)` (deterministic). Open `scene.html?preview` in a browser to watch it live. |
| `genassets.mjs` → `assets.js` | base64-embeds the chain logos + token SVGs + `logo.png` from `site/public/` so `scene.html` is self-contained (no network at render time). |
| `capture.mjs` | drives headless **Chromium** (`playwright-core`, installed OUT of the monorepo at `~/.cache/piprail-video-tools/` to avoid hoisting) and writes `frames/`. `node capture.mjs sample <times…>` spot-checks; `node capture.mjs all 30` renders the full set at 2× (3840×2160, downscaled at encode). |
| `synth.py` | pure-stdlib (no numpy) EDM build→drop→outro soundtrack → `music.wav`. Original, copyright-free; the drop is synced to the 12s chain-storm. |
| `card-*.html` + `render-*.mjs` | the **social cards** — one HTML template per theme (`ai` · `base` · `economy` · `machines` · `news` · `polygon` · `rwa` · `card`); each `render-<theme>.mjs` rasterizes its `card-<theme>.html` to a 2160² PNG. |
| `render-export.mjs` | rasterizes a `../exports/post-<name>.html` card to a 2160² PNG (the "post-*" set). |
| `render-slides.mjs` | renders the comparison/slide cards (`../exports/compare-402.html`, `card.html`). |
| `smoke.mjs` · `debug.mjs` | quick render smoke-test / debugging helpers. |

Generated (gitignored): `assets.js`, `wave.png`, `music.wav`, `frames/`, `sample/`, `*.png`, `*.mp4`.

---

## Regenerate the promo video

```bash
# from this folder (.claude/skills/site-design/design/video/)
node genassets.mjs            # rebuild assets.js from site/public/
node capture.mjs all 30       # render frames/ at 30fps, 2× (~4 min)
python3 synth.py              # synth music.wav

# encode (manual — not scripted): 36s, 1920×1080, H.264 + AAC
ffmpeg -framerate 30 -i frames/frame_%05d.png -i music.wav \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 256k -shortest ../exports/piprail-demo.mp4
```

Verify by extracting frames from the mp4; you can't hear the audio in-agent, so check
`synth.py`'s RMS print instead (quiet intro → groove@4s → break@11s → DROP@12s → outro@32s).

## Regenerate a social card

```bash
node render-base.mjs          # → _base2160.png  (one per card-*.html theme)
node render-export.mjs <name> # → _<name>2160.png from ../exports/post-<name>.html
```

---

## Conventions baked in

- **Paths are absolute to the repo** (`/Users/john/Sites/piprail/…`) — dev tooling for one
  machine. The render scripts read brand assets from `site/public/` and card sources from
  `../exports/`, and write outputs beside themselves.
- **Per-frame determinism:** every animation needs explicit `offset:0` **and** `offset:1`
  keyframes, or the WAAPI fill bleeds the element in. The chain grid is flex-wrap (10/10/8),
  not a 14-wide grid (that overflowed 1920px).
- **Don't install playwright inside the monorepo** — it hoists into the workspace and
  pollutes the root `package.json`. The cached binary lives at `~/.cache/piprail-video-tools/`.
