# design/video/use-cases/ — the "Give software a wallet" use-cases reel

A **viral, movie-grade 43-second showcase** of what you can build on PipRail — the second
PipRail motion piece, alongside the [promo](../README.md). Built for X/Twitter: the first frame is
a finished branded hook (X auto-thumbnails it), every number on screen is true to the SDK, and the
whole thing rides a tension→relief spine — *"your AI agent has a wallet now → and it can't
overspend it."*

**Output:** `piprail-use-cases.mp4` — 1920×1080, 30 fps, 43 s, H.264 + AAC.

> Same pipeline as the parent promo (deterministic HTML → Chromium-frames → ffmpeg), in its own
> clean section so the reel is self-contained. It **reuses the shared `../assets.js` logo bundle**
> (so `genassets.mjs` stays in the parent). **Source tracked, renders gitignored** (`frames/`,
> `sample/`, `music.wav`, `*.mp4` are rebuilt on demand — see [`../../README.md`](../../README.md)
> for the SOURCE / PUBLISHED / RENDER rule).

---

## What's here

| File | Role |
| --- | --- |
| `scene.html` | **the reel** — a deterministic WAAPI timeline (11 segments), paused + seeked per-frame via `window.seek(t)` (`window.duration` = 43). Open `scene.html?preview` in a browser to watch it live. Reuses the promo's `show()`/`key()` helpers, `.win`/`.pill`/`.badge`/flow vocabulary, the canvas particle/glow backdrop, and the persistent bottom rail. |
| `capture.mjs` | drives headless **Chromium** (shared `playwright-core` at `~/.cache/piprail-video-tools/`) and writes `frames/`, **self-locating** (paths resolve from this file). `node capture.mjs sample [t…]` spot-checks → `sample/`; `node capture.mjs all 30` renders the full set at 2× (3840×2160, downscaled at encode). |
| `synth.py` | original, copyright-free 128 BPM EDM, retimed for THIS reel: quiet intro under the hook, a groove that **builds** through the use-case beats, a filter-riser into the **DROP at 32.0 s** (the chain-storm), full body 32–40 s, and an **outro HIT at 40.0 s** (the brand reveal). → `music.wav`. |

Generated (gitignored): `frames/`, `sample/`, `music.wav`, `piprail-use-cases.mp4`.

---

## The reel — shot list (43 s)

| t (s) | Segment | On screen |
| --- | --- | --- |
| 0.0 | **Hook** (frame-0 thumbnail) | "Your AI agent has a **wallet** now." · `npm i @piprail/sdk` · *"and it can't overspend it. Watch."* |
| 3.4 | It pays mid-thought | `agent.fetch(url)` → GET → 402 → **200 ✓ PAID** flow |
| 7.4 | But it **can't** overspend | the policy, a prompt-injection attack, a red **PaymentDeclinedError** stamp, a frozen **$50.00** |
| 12.4 | It buys its own sources | live ledger + a budget meter that **halts at $2.00** |
| 16.2 | Monetize **any API** in 3 lines | the billing stack (Stripe/keys/invoices…) swept away → 3 lines of `requirePayment` |
| 20.4 | AI scrapers pay the **same toll** | one $0.10 paywall, a human **and** an AI agent both pay it |
| 24.2 | Your car pays the **charger** | EV → emerald cable → charger, live `kWh / $` HUD, 0% cut |
| 28.4 | Insure a flight for **8¢** | premium in → DELAYED → **$5 payout out**, both ways on one rail |
| 32.0 | One line. **Every chain.** | **THE DROP** — 29 round chain icons cascade in, `29 chains / 10 families` |
| 37.0 | A payment network, **no backend** | two phones, the struck-through server, no server/db/fee |
| 40.0 | **Finale** | logo + wordmark · "Give software a **wallet.**" · `npm install @piprail/sdk` |

**Music sync:** DROP @ 32.0 s (chain-storm) and OUTRO HIT @ 40.0 s (finale) are frame-synced to the
impact flash + shockwave ring in `scene.html`.

---

## Art direction (matches the brand)

- **Emerald `#2ee6a6` is the ONLY accent, and it's rationed** — it appears on the "paid"/money moment
  of each beat (a pulse igniting, a balance holding, a meter filling, a coin landing, the chain rings),
  so it never dilutes. One disciplined exception: a single muted **red** is allowed ONLY as the
  threat/trigger color, in just two beats (the prompt-injection DECLINE, and the flight DELAY).
- **The "old way" is greyscale** (the billing stack, the struck-through server) so the emerald "new
  way" wins by contrast — *contrast, not glow; the restraint IS the brand.*
- **Type:** Space Grotesk (headlines) · Inter (subs) · JetBrains Mono (code/ledgers).
- **The spine:** the bottom rail-dot travels continuously left→right across all 43 s and lands at the
  far-right edge on the finale — every cut is one unbroken journey toward "paid."

---

## Regenerate

```bash
# from this folder (.claude/skills/branding/design/video/use-cases/)
node ../genassets.mjs        # refresh the SHARED ../assets.js logo bundle (29 chains incl. Kaia)
node capture.mjs sample      # spot-check ~14 frames -> sample/  (fast)
node capture.mjs all 30      # render frames/ at 30fps, 2x  (~8 min)
python3 synth.py             # synth music.wav (43s; DROP@32 OUTRO@40)

ffmpeg -y -framerate 30 -i frames/frame_%05d.png -i music.wav \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 256k -shortest piprail-use-cases.mp4
```

Verify by extracting frames from the mp4 (`ffmpeg -ss <t> -i piprail-use-cases.mp4 -frames:v 1 x.png`)
— and re-check `synth.py`'s structure print (DROP@32 / OUTRO@40).

---

## Notes

- **29 chains:** the parent `genassets.mjs` chain array was missing **Kaia** (it had a logo but no entry);
  it's now added, so the bundle + grid + counter all read **29 chains / 10 families** (true to the SDK).
- **Chain icons are round** (`.ctile` / `.cring`) with an emerald edge-glow that flares as each lands.
- **Finale logo is the TRANSPARENT mark** — `site/public/logo-no-background.png` → `A.logoNoBg`, shown with no
  tile background and an emerald drop-shadow glow (the hero shot). The top-left watermark uses it too. (The
  opaque `A.logo` / `logo.png` is no longer used in this reel.)
- **Clean, impactful outro:** the track ends with a cosine fade-out over the last 0.5 s (resolves to true
  silence — no truncation pop) and the 40.0 s hit carries a sub-bass sweep (60→32 Hz) for a chest-thump slam,
  frame-synced to the logo ignite + shockwave + spark burst.
- **Format:** 16:9 1920×1080 (cinematic, plays natively on X). A 1:1 square cut would need a re-layout
  (several beats use the full width) — a possible follow-up, not a crop.
- **Per-frame determinism:** every animation has explicit `offset:0` + `offset:1` (the `show()`/`key()`
  helpers enforce this). Never add a second `key()` on an element that a `show()` already owns — the
  `key()`'s first point pins to t=0 and the element bleeds onto every frame.
