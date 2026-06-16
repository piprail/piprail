#!/usr/bin/env node
// Launch card (1080×1080, square) — "PipRail × PayAI". Co-brand gasless shout-out: a centered
// lockup (PipRail mark + PayAI logo) as the hero, a "FULLY GASLESS" badge, one confident
// headline crediting PayAI, a muted sub-line, and one mono proof strip. True-black canvas,
// one emerald whisper of glow. Same brand system as the other launch cards (#000 bg, #2ee6a6
// accent, Space Grotesk + Inter + JetBrains Mono). PayAI logo = their own brand mark on a tile.
//   node render-payai.mjs  ->  ./payai-gasless.png  (1080×1080)
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
const payaiLogo = b64(resolve(__dirname, 'payai.jpg'), 'image/jpeg')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:46px; }
  .glow { position:absolute; left:50%; top:43%; transform:translate(-50%,-50%); width:1000px; height:840px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.04) 45%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:28px; }

  .badge { position:relative; z-index:2; display:inline-flex; align-items:center; gap:9px;
    border:1px solid rgba(46,230,166,0.30); background:rgba(46,230,166,0.08); color:var(--accent);
    border-radius:999px; padding:9px 20px; font-family:'JetBrains Mono',monospace; font-size:18px;
    font-weight:600; letter-spacing:0.22em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.7); }

  /* Co-brand lockup — the hero. PipRail × PayAI. */
  .lockup { display:flex; align-items:center; gap:38px; position:relative; z-index:2; }
  .mark { display:flex; align-items:center; gap:22px; }
  .mark img.pip { width:112px; height:112px; }
  .mark .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:60px; font-weight:700; letter-spacing:-0.03em; }
  .x { font-family:'Inter',sans-serif; font-size:42px; font-weight:400; color:rgba(255,255,255,0.30); }
  .payai { width:146px; height:146px; border-radius:30px; box-shadow:0 18px 50px rgba(0,0,0,0.55); }

  .head { position:relative; z-index:2; text-align:center; }
  .head h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:72px; font-weight:700;
    letter-spacing:-0.035em; line-height:1.04; }
  .head h1 .em { color:var(--accent); }
  .head p { margin-top:24px; font-size:29px; line-height:1.5; color:#c5c9cf; font-weight:400; max-width:800px; }
  .head p b { color:#fff; font-weight:600; }

  .proof { position:relative; z-index:2; display:flex; align-items:center; justify-content:center; gap:16px;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:#cfd3d9;
    border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:14px; padding:16px 26px; }
  .proof .mut { color:var(--muted); } .proof b { color:#fff; font-weight:600; } .proof .ok { color:var(--accent); font-weight:600; }

  footer { position:absolute; bottom:52px; left:0; right:0; text-align:center; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted); letter-spacing:0.01em; }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <div class="badge"><i></i> Fully gasless</div>

  <div class="lockup">
    <div class="mark"><img class="pip" src="${piprailLogo}"><span class="nm">PipRail</span></div>
    <span class="x">×</span>
    <img class="payai" src="${payaiLogo}">
  </div>

  <div class="head">
    <h1>Your agent pays.<br><span class="em">PayAI</span> pays the gas.</h1>
    <p>The buyer just signs — <b>PayAI sponsors the gas</b> as fee-payer. Zero native coin to hold,
       the merchant gets paid in USDC. PipRail hosts nothing; it just points at a keyless facilitator.</p>
  </div>

  <div class="proof"><span class="mut">agent signs</span><span class="mut">→</span><span><b>PayAI</b> pays the gas</span><span class="mut">→</span><span>buyer pays <b>0 native</b></span><span class="ok">✓</span></div>

  <footer><span class="site">piprail.com</span> &nbsp;·&nbsp; default keyless facilitator &nbsp;·&nbsp; npm i @piprail/sdk</footer>
</body></html>`

const out = resolve(__dirname, 'payai-gasless.png')
writeFileSync(resolve(__dirname, 'payai-gasless.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
