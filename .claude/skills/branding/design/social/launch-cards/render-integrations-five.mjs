#!/usr/bin/env node
// Launch card (1600×900, landscape) — "PipRail, now native to five agent frameworks."
// Hub layout: PipRail is the source at the top, five integration tiles in a row beneath —
// roomy 16:9 so the five marks breathe (never squashed). Same system as render-hermes.mjs:
// true-black canvas, one emerald whisper of glow, Space Grotesk + Inter + JetBrains Mono.
//   node render-integrations-five.mjs  ->  ./integrations-five.png  (1600×900)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = [
  process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync)

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')
const ig = (name) => b64(resolve(REPO, `site/public/integrations/${name}.webp`), 'image/webp')

// the five, in launch order
const TILES = [
  { logo: ig('elizaos'),  name: 'elizaOS',  slug: 'elizaos' },
  { logo: ig('hermes'),   name: 'Hermes',   slug: 'hermes' },
  { logo: ig('mastra'),   name: 'Mastra',   slug: 'mastra' },
  { logo: ig('n8n'),      name: 'n8n',      slug: 'n8n' },
  { logo: ig('openclaw'), name: 'OpenClaw', slug: 'openclaw' },
]

const tilesHtml = TILES.map(t => `
  <div class="tile">
    <div class="logobox"><img src="${t.logo}" alt="${t.name}"></div>
    <div class="nm">${t.name}</div>
    <div class="slug">/${t.slug}</div>
  </div>`).join('')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1600px; height:900px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; align-items:center; justify-content:flex-start; }
  .glow { position:absolute; left:50%; top:30%; transform:translate(-50%,-50%); width:1280px; height:900px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.04) 44%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:26px; }

  .head { position:relative; z-index:2; text-align:center; margin-top:88px; }
  .badge { display:inline-flex; align-items:center; gap:9px;
    border:1px solid rgba(46,230,166,0.30); background:rgba(46,230,166,0.08); color:var(--accent);
    border-radius:999px; padding:8px 19px; font-family:'JetBrains Mono',monospace; font-size:16px;
    font-weight:600; letter-spacing:0.22em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.7); }

  /* PipRail — the hub/source */
  .hub { display:flex; align-items:center; justify-content:center; gap:18px; margin-top:30px; }
  .hub img { width:60px; height:60px; }
  .hub .wm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:54px; font-weight:700; letter-spacing:-0.03em; }

  .head h1 { margin-top:26px; font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:50px;
    font-weight:700; letter-spacing:-0.035em; line-height:1.06; }
  .head h1 .em { color:var(--accent); }
  .head p { margin-top:16px; font-size:23px; line-height:1.45; color:#c5c9cf; font-weight:400; }
  .head p b { color:#fff; font-weight:600; }

  /* the five tiles */
  .row { position:relative; z-index:2; display:flex; gap:26px; margin-top:70px; }
  .tile { width:244px; height:230px; border-radius:22px; border:1px solid rgba(255,255,255,0.09);
    background:linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 100%);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px;
    box-shadow:0 16px 40px rgba(0,0,0,0.45); }
  .logobox { width:96px; height:96px; border-radius:22px; display:flex; align-items:center; justify-content:center;
    background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); }
  .logobox img { width:64px; height:64px; object-fit:contain; }
  .tile .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:28px; font-weight:600; letter-spacing:-0.02em; }
  .tile .slug { font-family:'JetBrains Mono',monospace; font-size:15px; color:var(--muted); letter-spacing:0.01em; }

  footer { position:absolute; bottom:48px; left:0; right:0; text-align:center; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:20px; color:var(--muted); letter-spacing:0.01em; }
  footer b { color:#fff; font-weight:600; }
  footer .em { color:var(--accent); }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <div class="head">
    <div class="badge"><i></i> 5 new integrations</div>
    <div class="hub"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <h1>Agent payments, native to <span class="em">your stack</span>.</h1>
    <p>x402 payments drop straight into the agents you already build with — <b>self-custodial, every chain, no fee.</b></p>
  </div>

  <div class="row">${tilesHtml}</div>

  <footer><b>npm i @piprail/sdk</b><span class="em"> · </span>docs.piprail.com/integrations</footer>
</body></html>`

const out = resolve(__dirname, 'integrations-five.png')
writeFileSync(resolve(__dirname, 'integrations-five.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height: 900 } })
await browser.close()
console.log(`Rendered ${out}`)
