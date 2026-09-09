# PipRail promo video

38 seconds. A request gets a 402, the agent pays, and the API returns 200.
The separate `use-cases/` film is preserved.

## Outputs

- `piprail-demo.mp4`: 1920 x 1080, 30 fps.
- `piprail-demo-square.mp4`: 1080 x 1080, 30 fps.
- `piprail-demo-vertical.mp4`: 1080 x 1920, 30 fps.
- `piprail-live-demo.mp4`: continuous capture of real subprocess output, no music.

All promo exports use H.264, CRF 17, AAC 256 kbps, yuv420p and faststart.
Square and vertical use adjusted layouts instead of cutting off code with a centre crop.
The first frame is a finished 402 still with the PipRail wordmark. Every beat reads muted.
Sources are tracked. Frames, recordings, thumbnails and audio are regenerable and ignored.
Nothing is published by this pipeline.

## Rebuild

Run from this folder:

```sh
node genassets.mjs
python3 synth.py
node capture.mjs all 30
FORMAT=square node capture.mjs all 30
FORMAT=vertical node capture.mjs all 30
node encode.mjs
```

`node capture.mjs sample 0 9.5 11 12 15 24 30 34` renders spot checks.
Set `FORMAT=square` or `FORMAT=vertical` for the other layouts.
Frame folders are named `frames-wide`, `frames-square`, and `frames-vertical`.
The capture script discovers the newest cached Chromium under `~/Library/Caches/ms-playwright`.
Playwright stays outside the monorepo at `~/.cache/piprail-video-tools`.
Fonts load from Google Fonts before capture; logo assets are embedded locally.
Open `scene.html?preview` for a browser preview.

## Timing and evidence

| Seconds | Beat |
| --- | --- |
| 0 to 2.5 | GET /report, 402 PAYMENT REQUIRED |
| 2.5 to 6 | Your agent hit a paywall. Now what? |
| 6 to 11 | Express payment middleware, typed |
| 11 to 13 | Still hold, payment moves, 200 at exactly 12 seconds |
| 13 to 18 | Recorded settlement with full explorer hash |
| 18 to 26 | 29 logos, 10 families, Base changes to Arbitrum |
| 26 to 32 | Read-only planning, then a spend policy refuses payment |
| 32 to 38 | Logo, install command, URL |

Cuts land on the 120 BPM half-second grid. Audio is silent from 11 to 12 seconds.
The 12-second payment drop takes precedence over the brief's conflicting reference to
20 seconds without emerald. Emerald first appears at 12 seconds and denotes payment.
The finale holds still and the soundtrack resolves before the end.

The receipt is explicitly labelled as a recorded mainnet settlement, separate from the
illustrative `/report` animation. Its full hash is:

`0x0ca795dc9fec056304b4341bf0378ab4968766bf79a8bcda09c2f36d162efce8`

[BaseScan](https://basescan.org/tx/0x0ca795dc9fec056304b4341bf0378ab4968766bf79a8bcda09c2f36d162efce8)
shows a successful 0.01 USDC transfer at 13:39:27 UTC on 6 September 2026.
It is linked from [PipRail's facilitator evidence](https://piprail.com/facilitators).
Both pages were checked on 7 September 2026.

The scene asserts 29 chains, 20 EVM chains and the presence of Kaia against `CHAINS`.
The shared `genassets.mjs` already included Kaia when this revision began.
If chain support changes, update the catalogue and scene assertion, then re-render all formats.

## Code context

The server excerpt imports `requirePayment` and constructs Express middleware. `payTo`
is the merchant's configured address; mount `gate` on the Express route that serves the report.
The agent excerpt assumes `PipRailClient` imported from `@piprail/sdk`, a configured `wallet`,
and a `url` that quotes 0.02 USDC. `planPayment` is read-only. `fetch` enforces `maxAmount`
and throws when the request exceeds 0.01 USDC. `OUTSIDE_POLICY` is the plan's blocker,
not the name of the thrown error. The displayed refusal is a summary of that policy example.
These signatures were checked against `sdk/src/index.ts` and their implementations.

## Separate live recording

`live-demo.mjs` runs against `https://piprail.com/x402/demo`. It loads the existing local
test wallet without printing its signing material, requests a real 402, plans, then pays
using `exact`. Its policy caps the payment at 0.01 USDC and one payment.
`PIPRAIL_DEMO_WALLET` can select another local wallet JSON file.

**Running the recorder moves real mainnet funds.** Each invocation can spend 0.01 USDC.

```sh
node record-live.mjs
ffmpeg -y -i live-recording/live-demo.webm -t 60 -an \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  -movflags +faststart piprail-live-demo.mp4
```

The recorder captures a terminal-style browser view of actual child-process stdout in real
time for at least 60 seconds. It has no edits, simulated output, typing effect or music.
It is a continuous browser capture, not a recording of the macOS desktop terminal.
The raw WebM and transcript remain in `live-recording/`. Only use a successful take with
a 200 and a transaction hash as the grant demo.

## Revision 2, 2026-09-07 evening: the premium pass

Same eight beats, same 38 seconds, same soundtrack, same facts, same build-time chain
assertion. Nothing factual changed. What changed is what the frames look like, and every
change is still a pure function of `t` inside `window.seek`, so capture stays deterministic.

| Beat | Before | After |
| --- | --- | --- |
| Every frame | Flat `#0a0b0c` | Two slow blurred orbs (blue, and emerald) plus 44 seeded drifting particles behind everything, and a soft vignette. Depth without a second accent |
| 6 to 11, typing | Text sliced mid-word with nothing at the end, so `amoun` read as a glitch | A block caret: solid while typing, blinking on a deterministic 0.4s grid once complete |
| 11.5 to 12, the coin | A white ring on a grey line | The ring turns emerald and gains a glow that grows as it travels; an emerald trail ignites the line behind it |
| 12.0, the payment | A flat full-frame green tint at 65% | A radial burst erupts from the API node and decays over 0.75s; the node and the line stay lit emerald; the tint is now a soft 22% wash under it |
| 12 onward | n/a | The emerald orb and the emerald-tinted particles only exist from 12s, so the ambience itself obeys the rule that emerald means paid |
| 19.8 to 22, the grid | 29 grayscale tiles | The Base tile lights in its own colours with an emerald label once the grid settles |
| 22, the parameter | `'base'` becomes `'arbitrum'` in white | The word turns emerald and the highlight jumps from the Base tile to the Arbitrum tile: one parameter, one visible change |
| Portrait grid | 7 per row, leaving Kaia alone on a fifth row | 6 per row, so 6 / 6 / 6 / 6 / 5 |

Sample frames of every changed beat were rendered and inspected in all three formats
before the full render. The first frame is still a finished 402 still and still reads at
thumbnail size; the burst centres on the API node in wide, square and vertical.

Two things found on the way, both fixed in the repo rather than here:

- The live `/x402/demo` endpoint's own JSON reply carried an em dash in its paid `message`,
  which is why one is visible on screen in `piprail-live-demo.mp4`. Its 402 `description`
  and OpenAPI `title` carried one too. All three fixed in `site/netlify/functions/x402-demo.mjs`.
  The house-voice gate had never scanned that directory; `scripts/prose-audit.mjs` now does,
  comments exempt, the same way it treats the Astro configs.
- Re-recording the live demo would move another 0.01 USDC, so the existing take stands. Its
  on-screen em dash is the endpoint's old copy, not an edit.

## Validation of this revision

`node verify-snippets.mjs` exercises the shown middleware in Express and confirms the
0.02 USDC request produces `OUTSIDE_POLICY` in its plan and `PaymentDeclinedError`
from `fetch`. It uses an ephemeral unfunded key and never sends a payment.

The successful live take settled 0.01 USDC on 7 September 2026 at 12:51:09 UTC:

[Live transaction](https://basescan.org/tx/0xce48b9687f978041cc74a9289ac2576b43811d7c62b4b765a6a939a6435e4ffe).

The initial attempt had insufficient tokens and did not settle. A 0.01 USDC top-up
from the local merchant test wallet funded the payer before the successful take.
The delivered live clip is the first continuous 60 seconds of that successful
recording; only the idle tail is omitted. No internal cuts or retiming.
