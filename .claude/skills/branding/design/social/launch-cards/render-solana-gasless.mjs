#!/usr/bin/env node
// Launch card A (1080×1080) — "Solana, now gasless". Clean + lush, same skeleton as the
// Hermes launch card the brand likes: a centered focal (Solana coin in a glow ring + one
// "0 SOL gas" pill), ONE confident headline, ONE muted sub-line, footer. No code wall, no
// delta row — one focal point only. Brand system: #000 bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono.
//   node render-solana-gasless.mjs  ->  ./solana-gasless.png  (1080×1080)
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
const solana = b64(resolve(REPO, 'site/public/chains/solana.svg'), 'image/svg+xml')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:46px; }
  .glow { position:absolute; left:50%; top:40%; transform:translate(-50%,-50%); width:1000px; height:860px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.045) 44%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:28px; }

  .badge { position:relative; z-index:2; display:inline-flex; align-items:center; gap:10px;
    border:1px solid rgba(46,230,166,0.30); background:rgba(46,230,166,0.08); color:var(--accent);
    border-radius:999px; padding:9px 22px; font-family:'JetBrains Mono',monospace; font-size:18px;
    font-weight:600; letter-spacing:0.24em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.7); }

  /* Focal: the Solana coin in a glow ring + one clean "0 SOL gas" pill. */
  .focal { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:24px; }
  .coin { width:188px; height:188px; border-radius:50%; overflow:hidden; display:flex; align-items:center; justify-content:center;
    background:#0c0c0e; border:1px solid rgba(255,255,255,0.12); box-shadow:0 0 80px rgba(46,230,166,0.30), inset 0 1px 0 rgba(255,255,255,0.08); }
  .coin img { width:100%; height:100%; object-fit:cover; }
  .zpill { display:inline-flex; align-items:baseline; gap:11px; padding:13px 26px; border-radius:999px;
    background:rgba(46,230,166,0.12); border:1px solid rgba(46,230,166,0.42);
    box-shadow:0 0 38px rgba(46,230,166,0.26), inset 0 1px 0 rgba(255,255,255,0.10); }
  .zpill .z { font-family:'Space Grotesk',sans-serif; font-size:34px; font-weight:700; color:var(--accent); line-height:1; letter-spacing:-0.02em; }
  .zpill .t { font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:600; color:#e6f6f0; letter-spacing:0.05em; }

  .head { position:relative; z-index:2; text-align:center; }
  .head h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:82px; font-weight:700;
    letter-spacing:-0.04em; line-height:1.0; }
  .head h1 .em { color:var(--accent); }
  .head p { margin-top:26px; font-size:29px; line-height:1.5; color:#c5c9cf; font-weight:400; max-width:820px; margin-left:auto; margin-right:auto; }
  .head p b { color:#fff; font-weight:600; }

  footer { position:absolute; bottom:56px; left:0; right:0; display:flex; align-items:center; justify-content:center; gap:18px; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted); letter-spacing:0.01em; }
  footer b { color:#fff; font-weight:600; }
  footer .dot { color:rgba(255,255,255,0.25); }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <div class="badge"><i></i> Fully gasless</div>

  <div class="focal">
    <div class="coin"><img src="${solana}"></div>
    <div class="zpill"><span class="z">0</span><span class="t">SOL gas for the buyer</span></div>
  </div>

  <div class="head">
    <h1>Solana payments,<br>now <span class="em">gasless.</span></h1>
    <p>Your AI agent signs once — the facilitator covers the SOL. The buyer pays <b>zero gas</b>; the merchant just gets paid in USDC.</p>
  </div>

  <footer><b>piprail.com</b><span class="dot">·</span><span>npm i @piprail/sdk</span></footer>
</body></html>`

const out = resolve(__dirname, 'solana-gasless.png')
writeFileSync(resolve(__dirname, 'solana-gasless.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
