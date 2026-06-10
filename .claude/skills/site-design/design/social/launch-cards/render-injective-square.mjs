#!/usr/bin/env node
// One-off custom square (1080×1080) card for the Injective "Agentic Payments / Stablecoins"
// reply. Dead-clear on what PipRail does, with the built-in assets (USDC · USDT · INJ) as the
// visual centerpiece. Reuses the brand system (true black, emerald, Inter/JetBrains Mono).
//   node render-injective-square.mjs  ->  ./injective-square.png  (1080×1080)
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
const inj  = b64(resolve(REPO, 'site/public/chains/injective.svg'), 'image/svg+xml')
const usdc = b64(resolve(REPO, 'site/public/tokens/usdc.svg'), 'image/svg+xml')
const usdt = b64(resolve(REPO, 'site/public/tokens/usdt.svg'), 'image/svg+xml')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:64px 68px; }
  .glow { position:absolute; left:50%; top:42%; transform:translate(-50%,-50%); width:1050px; height:920px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.045) 38%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:15px; }
  .brand img { width:52px; height:52px; }
  .brand .wm { font-size:30px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em; }

  .hero { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; text-align:center; gap:26px; margin-top:6px; }
  .coin { width:124px; height:124px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    background:#0c0c0e; border:1px solid rgba(255,255,255,0.10); box-shadow:0 0 56px rgba(77,61,255,0.28), inset 0 1px 0 rgba(255,255,255,0.07); }
  .coin img { width:60%; height:60%; object-fit:contain; }
  h1 { font-size:66px; font-weight:900; letter-spacing:-0.035em; line-height:1.02; }
  h1 b { color:var(--accent); }
  .sub { font-size:27px; line-height:1.42; color:#c4c8ce; max-width:760px; font-weight:400; }
  .sub b { color:#fff; font-weight:700; }

  .assets { display:flex; flex-direction:column; align-items:center; gap:18px; position:relative; z-index:2; }
  .assets .lbl { font-family:'JetBrains Mono',monospace; font-size:18px; letter-spacing:0.16em; color:var(--muted); text-transform:uppercase; }
  .chips { display:flex; gap:18px; }
  .chip { display:flex; align-items:center; gap:13px; padding:15px 26px 15px 16px; border-radius:999px;
    background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.12); }
  .chip.stable { border-color:rgba(46,230,166,0.45); background:rgba(46,230,166,0.06); }
  .chip img { width:42px; height:42px; border-radius:50%; }
  .chip .tk { font-family:'JetBrains Mono',monospace; font-size:25px; font-weight:600; letter-spacing:-0.01em; }
  .chip .inj { width:42px; height:42px; border-radius:50%; background:#0c0c0e; display:flex; align-items:center; justify-content:center;
    border:1px solid rgba(255,255,255,0.10); }
  .chip .inj img { width:62%; height:62%; }

  .loop { display:flex; align-items:center; justify-content:center; gap:18px; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:#cfd3d9;
    border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:14px; padding:18px 28px; }
  .loop .req { color:var(--muted); }
  .loop .x402 { color:#ff7a7a; font-weight:600; }
  .loop .arrow { color:var(--muted); }
  .loop .ok { color:var(--accent); font-weight:600; }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:20px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>
  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>

  <div class="hero">
    <div class="coin"><img src="${inj}"></div>
    <h1>Your AI agent<br><b>pays for itself</b></h1>
    <div class="sub">It hits any paywalled x402 URL on <b>Injective</b> and settles it autonomously — <b>no backend, no fee.</b></div>
  </div>

  <div class="assets">
    <div class="lbl">Pays in</div>
    <div class="chips">
      <div class="chip stable"><img src="${usdc}"><span class="tk">USDC</span></div>
      <div class="chip stable"><img src="${usdt}"><span class="tk">USDT</span></div>
      <div class="chip"><span class="inj"><img src="${inj}"></span><span class="tk">INJ</span></div>
    </div>
  </div>

  <div class="loop">
    <span class="req">GET /premium-api</span><span class="arrow">→</span><span class="x402">402</span>
    <span class="arrow">·</span>
    <span class="req">PAY x402</span><span class="arrow">→</span><span class="ok">200 OK ✓</span>
  </div>

  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk</span></footer>
</body></html>`

const out = resolve(__dirname, 'injective-square.png')
writeFileSync(resolve(__dirname, 'injective-square.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
