#!/usr/bin/env node
// Launch card (1080×1080, square) — "Now speaking full x402." A Linear/Vercel-grade changelog
// card: a confident headline as the focal point over a 2×2 grid of feature tiles (line icon +
// mono keyword + one muted line each), install + docs in the footer. True-black canvas, one
// emerald accent, a soft whisper of glow behind the headline, the brand frame. Same system as the
// other launch cards (branding SKILL §2: #0a0b0c bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono).
//   node render-x402-parity.mjs  ->  ./x402-parity.png  (1080×1080)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
// The pinned playwright Chromium build was cleaned from the cache; fall back to system Chrome
// (playwright-core drives it fine for a static screenshot).
const CHROME_BIN = [
  process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => existsSync(p))
if (!CHROME_BIN) throw new Error('No Chrome/Chromium found — install Google Chrome or `npx playwright install chromium`.')

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')

// Lucide line icons (MIT) — stroke, 24 viewBox.
const ic = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
}
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`

const tiles = [
  [ic.gauge, 'upto rail', 'Metered — your agent pays for exactly what it uses.'],
  [ic.check, 'verifiable receipts', 'Re-check any payment on-chain — no wallet, no trust.'],
  [ic.share, 'A2A transport', "x402 over Google's Agent2Agent."],
  [ic.terminal, 'verify_receipt', "The MCP server's new 8th tool."],
]

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#08090a; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:80px 76px 76px; }
  /* soft emerald whisper behind the headline (upper-left), and a fainter one under the grid */
  .glow  { position:absolute; left:24%; top:24%; transform:translate(-50%,-50%); width:760px; height:680px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.05) 42%, rgba(0,0,0,0) 70%); }
  .glow2 { position:absolute; right:8%; bottom:6%; width:620px; height:560px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.07) 0%, rgba(0,0,0,0) 68%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:30px; }

  .top { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { width:44px; height:44px; }
  .brand .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:29px; font-weight:700; letter-spacing:-0.02em; }
  .badge { display:inline-flex; align-items:center; gap:9px; border:1px solid rgba(46,230,166,0.32);
    background:rgba(46,230,166,0.09); color:var(--accent); border-radius:999px; padding:8px 18px;
    font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:600; letter-spacing:0.24em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.75); }

  h1 { position:relative; z-index:2; margin-top:38px; font-family:'Space Grotesk','Inter',system-ui,sans-serif;
    font-size:74px; font-weight:700; letter-spacing:-0.035em; line-height:1.0; }
  h1 .em { color:var(--accent); }
  .sub { position:relative; z-index:2; margin-top:18px; font-size:25px; color:#9aa0a8; font-weight:400; letter-spacing:0.005em; }
  .sub b { color:#fff; font-weight:600; }

  .grid { position:relative; z-index:2; margin-top:42px; display:grid; grid-template-columns:1fr 1fr;
    grid-auto-rows:1fr; gap:20px; flex:1; }
  .tile { border-radius:20px; border:1px solid rgba(255,255,255,0.08);
    background:linear-gradient(155deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.012) 60%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.05); padding:30px 30px; display:flex; flex-direction:column;
    justify-content:center; gap:18px; position:relative; overflow:hidden; }
  .tile .ic { width:56px; height:56px; border-radius:15px; background:rgba(46,230,166,0.10);
    border:1px solid rgba(46,230,166,0.30); display:flex; align-items:center; justify-content:center;
    box-shadow:0 0 26px -6px rgba(46,230,166,0.45); }
  .tile .ic svg { width:28px; height:28px; color:var(--accent); }
  .tile .k { font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:600; color:var(--accent); letter-spacing:-0.01em; }
  .tile .d { font-size:21px; line-height:1.42; color:#aeb4bc; font-weight:400; max-width:380px; }

  footer { position:relative; z-index:2; margin-top:40px; display:flex; align-items:center; gap:18px;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted); }
  footer .cmd { color:#e6e8ea; }
  footer .cmd b { color:var(--accent); font-weight:600; }
  footer .sep { color:rgba(255,255,255,0.20); }
</style></head>
<body>
  <div class="glow"></div><div class="glow2"></div><div class="frame"></div>

  <div class="top">
    <div class="brand"><img src="${piprailLogo}"><span class="nm">PipRail</span></div>
    <div class="badge"><i></i> Shipped</div>
  </div>

  <h1>Now speaking <span class="em">full&nbsp;x402</span>.</h1>
  <p class="sub">Still <b>backendless</b>. Still <b>self-custody</b>. Still <b>0% fee</b>.</p>

  <div class="grid">
    ${tiles.map(([icon, k, d]) => `<div class="tile"><div class="ic">${svg(icon)}</div><div class="k">${k}</div><div class="d">${d}</div></div>`).join('')}
  </div>

  <footer><span class="cmd">npm i <b>@piprail/sdk</b></span><span class="sep">·</span><span>docs.piprail.com</span></footer>
</body></html>`

const out = resolve(__dirname, 'x402-parity.png')
writeFileSync(resolve(__dirname, 'x402-parity.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
