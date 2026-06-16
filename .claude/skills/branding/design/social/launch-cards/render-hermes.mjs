#!/usr/bin/env node
// Launch card (1080×1080, square) — "PipRail × Hermes". Deliberately SIMPLE + lush:
// a centered co-brand lockup (PipRail mark + Hermes mark) as the hero, one confident
// headline, one muted sub-line, the docs in the footer. True-black canvas, one emerald
// whisper of glow. No code wall, no clutter — one focal point. Same brand system as the
// other launch cards (branding SKILL §2: #0a0b0c bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono).
//   node render-hermes.mjs  ->  ./hermes-launch.png  (1080×1080)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')
const hermesLogo = b64(resolve(REPO, 'site/public/integrations/hermes.webp'), 'image/webp')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:52px; }
  .glow { position:absolute; left:50%; top:44%; transform:translate(-50%,-50%); width:980px; height:820px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.04) 44%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:28px; }

  .badge { position:relative; z-index:2; display:inline-flex; align-items:center; gap:9px;
    border:1px solid rgba(46,230,166,0.30); background:rgba(46,230,166,0.08); color:var(--accent);
    border-radius:999px; padding:9px 20px; font-family:'JetBrains Mono',monospace; font-size:18px;
    font-weight:600; letter-spacing:0.22em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.7); }

  /* Co-brand lockup — the hero. PipRail × Hermes. */
  .lockup { display:flex; align-items:center; gap:40px; position:relative; z-index:2; }
  .mark { display:flex; align-items:center; gap:22px; }
  .mark img { width:118px; height:118px; }
  .mark img.hermes { border-radius:26px; box-shadow:0 18px 50px rgba(0,0,0,0.55); }
  .mark .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:62px; font-weight:700; letter-spacing:-0.03em; }
  .x { font-family:'Inter',sans-serif; font-size:44px; font-weight:400; color:rgba(255,255,255,0.30); }

  .head { position:relative; z-index:2; text-align:center; }
  .head h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:70px; font-weight:700;
    letter-spacing:-0.035em; line-height:1.04; }
  .head h1 .em { color:var(--accent); }
  .head p { margin-top:24px; font-size:30px; line-height:1.5; color:#c5c9cf; font-weight:400; max-width:760px; }
  .head p b { color:#fff; font-weight:600; }

  footer { position:absolute; bottom:54px; left:0; right:0; text-align:center; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted); letter-spacing:0.01em; }
  footer b { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <div class="badge"><i></i> New integration</div>

  <div class="lockup">
    <div class="mark"><img src="${piprailLogo}"><span class="nm">PipRail</span></div>
    <span class="x">×</span>
    <div class="mark"><img class="hermes" src="${hermesLogo}"><span class="nm">Hermes</span></div>
  </div>

  <div class="head">
    <h1>Agent payments,<br>native to <span class="em">Hermes</span>.</h1>
    <p>Your Hermes agent pays any x402 URL by itself — <b>self-custodial, every chain, no fee.</b></p>
  </div>

  <footer><b>docs.piprail.com/integrations/hermes</b></footer>
</body></html>`

const out = resolve(__dirname, 'hermes-launch.png')
writeFileSync(resolve(__dirname, 'hermes-launch.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
