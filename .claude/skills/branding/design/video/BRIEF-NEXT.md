# PipRail promo video: the brief

Written 2026-09-07. A self-contained brief for rebuilding the PipRail promo to a
premium standard. Everything below is verified against the repo on that date.

> **Status, 2026-09-07 evening: DELIVERED.** Astra rebuilt the film to this brief
> (revision 1: every beat, all three formats, a real settled receipt, a separate live
> 60-second demo, and a build-time chain assertion). A second pass then added the ambient
> depth, the light event at 12s, the typing caret and the grid highlight. Section 2's
> stale counts are gone: the scene now throws if the catalogue is not 29 / 10 / 20 with
> Kaia. See `README.md` in this folder for the current state; this file stays as the record
> of what was asked for.

---

## 1. Where everything is

All paths absolute, machine is macOS, repo root `/Users/john/Sites/piprail`.

**The promo (the piece this brief is about)**

```
/Users/john/Sites/piprail/.claude/skills/branding/design/video/
├── scene.html          38KB  THE SHOW. 8-beat WAAPI timeline, seeked per frame
├── capture.mjs               drives headless Chromium, writes frames/
├── genassets.mjs             base64-bundles chain logos from site/public/ -> assets.js
├── assets.js          372KB  GENERATED, gitignored
├── synth.py                  stdlib EDM soundtrack -> music.wav
├── smoke.mjs · debug.mjs     render smoke test / scene debugging
├── piprail-demo.mp4   8.2MB  CURRENT RENDER. 36s, 1920x1080, H.264+AAC. GITIGNORED
└── README.md                 the pipeline, and the regenerate commands
```

**The second, newer piece (do not overwrite, read it for the quality bar)**

```
/Users/john/Sites/piprail/.claude/skills/branding/design/video/use-cases/
├── scene.html
├── piprail-use-cases.mp4     43s, 1920x1080. "Give software a wallet" reel
├── reference-hook.png        the intended first frame
├── reference-finale.png      the intended last frame
└── README.md                 calls itself "viral, movie-grade"
```

**Assets and rules**

```
/Users/john/Sites/piprail/site/public/chains/          29 chain logo SVGs, incl. kaia.svg
/Users/john/Sites/piprail/site/public/                 logo.png and site assets
/Users/john/Sites/piprail/.claude/skills/branding/SKILL.md      the brand bible
/Users/john/Sites/piprail/.claude/skills/humanizer/PIPRAIL.md   the house voice
/Users/john/Sites/piprail/sdk/src/drivers/                      source of truth for chains
```

**Rebuild commands** (run from the video folder)

```bash
cd /Users/john/Sites/piprail/.claude/skills/branding/design/video/
node genassets.mjs          # rebuild assets.js from site/public/  (picks up kaia.svg)
node capture.mjs all 30     # render frames/ at 30fps, 2x (3840x2160), ~4 min
python3 synth.py            # synth music.wav
ffmpeg -framerate 30 -i frames/frame_%05d.png -i music.wav \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 256k -shortest piprail-demo.mp4
```

`node capture.mjs sample <times...>` spot-checks single frames without a full render.
Chromium lives outside the monorepo at `~/.cache/piprail-video-tools/`.

---

## 2. 🔴 Fix these first, they are factually wrong today

The current render states counts that contradict piprail.com. Sending it to anyone is
a correctness problem, not a taste one.

| Where | Says | Must say |
|---|---|---|
| `scene.html` line 232 | `28 chains` | **29 chains** |
| `scene.html` line 336 | `19 EVM mainnets` | **20 EVM mainnets** |
| `scene.html` line 321 | grid comment assumes 28 tiles flowing 10/10/8 | 29 tiles |
| the chain grid | **Kaia is absent** (`kaia` appears 0 times in `scene.html`) | add Kaia |

`site/public/chains/kaia.svg` already exists, and `genassets.mjs` bundles straight from
that folder, so re-running it picks the logo up automatically. Only the hardcoded
counts and the grid layout need hand-editing.

⚠️ **`npm run sync` cannot catch this.** Its 54 rules guard every chain-count mirror in
the repo, but the video is a gitignored render and is not a sync surface, so it drifted
a full chain silently. Re-render the video whenever a chain is added.

---

## 3. The numbers and claims, verified 2026-09-07

Every figure on screen must be true and must match piprail.com.

- **29 chains · 10 families · 20 EVM mainnets** plus Solana, TON, Tron, NEAR, Sui,
  Aptos, Algorand, Stellar, XRP Ledger
- `@piprail/sdk` **2.16.2** · `@piprail/mcp` **0.9.0** · both **MIT**, both live on npm
- **No backend. No fee. No custody.** Self-custodial: your key, your RPC
- USDC almost everywhere · USDT on most · EURC where Circle issues it · RLUSD on XRPL ·
  the native coin on every chain

🔴 **Never put a download count, a user count or any traction figure on screen.** The
honest numbers are small. Nothing in this film needs them.

---

## 4. What the video must do to wow people

**The one idea: software pays for itself, and you watch the money move.**

Nobody has seen a machine pay a machine. That is the whole hook, and it is a *visual*
event. The current film explains what PipRail is. The new one should make somebody feel
the moment a paywall opens because an agent paid it, unprompted.

**The spine, in one line:** a request is refused, an agent pays, the door opens.
`402 -> payment -> 200`. Everything serves that arc.

### The premium bar, concretely

Premium here is **restraint plus precision**, not more effects. Judge every frame against these:

1. **One accent colour doing all the work.** Emerald `#2ee6a6` means *paid*, and nothing
   else in the film may be emerald. When the payment lands and the UI floods emerald for
   the first time, that colour has to have been earned by 20 seconds of near-black.
2. **Type is the design.** Space Grotesk for headings, Inter for sub-text, JetBrains
   Mono for anything that is code or a number. Big, confident, generous letter spacing.
   No gradients on text, no bevels, no drop shadows.
3. **Real code, real output, correctly highlighted.** Every snippet must be code that
   actually runs. Developers spot fake syntax instantly and stop trusting the rest.
4. **Motion with weight.** Ease-out, never linear. Things settle, they do not bounce.
   One camera idea per beat. If two things move for two different reasons, cut one.
5. **Silence before the drop.** The current `synth.py` already breaks at 11s and drops at
   12s. Put the payment landing exactly on that drop and let the frame before it be still.
6. **Every cut lands on a beat.** No cut anywhere near a beat but not on it.
7. **No stock anything.** No stock footage, no stock icons, no generic "AI" imagery, no
   glowing brains, no humanoid robots, no floating blockchain cubes.

### The beats

Target **35 to 45 seconds**. Times are a rhythm, not a rule.

| # | Time | Beat | What is on screen | Why it earns its place |
|---|---|---|---|---|
| 1 | 0.0 to 2.5 | **The hook** | Near-black. A terminal. `GET /report` then a hard red-tinged **`402 PAYMENT REQUIRED`**. Nothing else | Opens on refusal, not on a logo. The first frame is also the thumbnail, so it must read at 200px |
| 2 | 2.5 to 6 | **The problem, stated once** | One line of Space Grotesk: *"Your agent hit a paywall. Now what?"* | The only sentence of setup the film gets |
| 3 | 6 to 11 | **Three lines** | `server.ts`: `requirePayment({ chain, token, amount, payTo })`, typed live, real syntax highlighting | The pitch is the simplicity. Show it, do not claim it |
| 4 | 11 to 13 | **THE MOMENT** | The agent pays. Hold one still frame, then the `402` flips to **`200 OK`** and the first emerald of the film floods the frame. **Land this on the 12s drop** | This is the whole video. Everything before is setup, everything after is proof |
| 5 | 13 to 18 | **The receipt** | A real transaction hash, resolving on a real explorer. Use an actual settled tx from `piprail.com/facilitators` | This is what separates us from every animated explainer. The money really moved |
| 6 | 18 to 26 | **Every chain** | The 29-logo grid assembles, counters ticking to **29 chains · 10 families**. One parameter changes and the same code runs on another chain | Breadth, shown as one gesture rather than a list |
| 7 | 26 to 32 | **The guard rail** | `agent.ts`: `planPayment()` and a budget the model cannot exceed. A payment attempt exceeds it and is **refused** | The strongest trust beat we have. Show the agent being *stopped*. Nobody else shows the failure case |
| 8 | 32 to 38 | **Close** | Logo, `npm install @piprail/sdk`, `piprail.com`, MIT · no backend · no fee | Calm, still, one breath. Let it sit |

### The one thing that will do the most work

**Beat 5, the real transaction.** Every competitor animates a fake payment. If a viewer
can pause the film, read the hash, paste it into an explorer and see it settle, the
entire piece stops being a promo and becomes evidence. Pull a genuine one from
`https://piprail.com/facilitators`, which carries real mainnet hashes with the date each
was checked.

### Words

House voice applies: technically correct, simple, **no em dashes, ever**. Full rules in
`/Users/john/Sites/piprail/.claude/skills/humanizer/PIPRAIL.md`.

Say: *pay*, *settle*, *verify*, *your key, your RPC*, *no backend, no fee*.
Never say: *revolutionary*, *seamless*, *unlock*, *empower*, *the future of*, *game-changing*.

---

## 5. 🔴 This is NOT the grant demo, and the difference matters

Base Builder Grants and similar forms ask for **"a 1 minute demo of the project"** and
judge whether the work is *live and making an impact*. A branded film with music, however
good, shows positioning rather than the product working, and a reviewer can tell.

**Make a second, separate asset:** an unedited screen recording, roughly 60 seconds, no
music, of a real `402 -> pay -> 200` round trip against the live endpoint
`https://piprail.com/x402/demo`, with the terminal and the resulting transaction visible.
Rough and real beats polished and abstract for that audience.

Two different assets, two different jobs. Do not send the promo where a demo was asked for.

---

## 6. Delivery

- **1920x1080, 30fps, H.264 + AAC**, `-crf 17`, `+faststart` (the existing ffmpeg line is right)
- Also export a **1:1** and a **9:16** crop for social, with the hook safe inside both
- **The first frame must be a finished, branded still**: X and LinkedIn auto-thumbnail it
- Must read **muted**, so any spoken idea has to survive as type on screen
- ⚠️ Renders are gitignored by `/Users/john/Sites/piprail/.gitignore` line 169
  (`.claude/skills/branding/design/video/**/*.mp4`). Publishing it publicly is a separate
  decision: 8.2MB into the repo, or host it externally.
