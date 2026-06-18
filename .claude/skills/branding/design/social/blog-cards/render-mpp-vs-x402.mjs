#!/usr/bin/env node
// Blog OG card (1200×630) for /blog/mpp-vs-x402 — "MPP vs. x402: Two ways to pay an agent."
// A comparison post, so naming MPP is on-topic (the article + README flow graphic name it too).
// Brand-pure: #000 bg, emerald #2ee6a6 = the open/self-custody rail (it pops), grey = the
// custodial rail. The split is the visual: one card holds the money, one card doesn't.
//   node render-mpp-vs-x402.mjs  ->  ../../../../../../site/public/blog/mpp-vs-x402.png  (1200×630)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const logo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')

const W = 1200, H = 630

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; --grey:#5b626b; }
  html,body { width:${W}px; height:${H}px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:48px 56px 42px; }
  .glow { position:absolute; right:-200px; bottom:-240px; width:820px; height:680px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.04) 46%, rgba(0,0,0,0) 70%); pointer-events:none; }
  .frame { position:absolute; inset:22px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; pointer-events:none; }
  body > * { position:relative; z-index:2; }

  header { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:13px; }
  .brand img { width:42px; height:42px; }
  .brand .wm { font-family:'Space Grotesk',sans-serif; font-size:27px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:8px 17px; border-radius:999px; letter-spacing:0.04em;
    display:flex; align-items:center; gap:9px; }
  .pill i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 12px var(--accent); }

  .titleblock { margin-top:30px; }
  .eyebrow { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:500; letter-spacing:5px;
    text-transform:uppercase; color:#6b727b; }
  h1 { font-family:'Space Grotesk',sans-serif; font-size:82px; font-weight:700; letter-spacing:-0.035em;
    line-height:0.98; margin-top:13px; }
  h1 .vs { color:#5b626b; font-weight:600; }
  h1 b { color:var(--accent); }
  .sub { margin-top:16px; font-size:22px; line-height:1.4; color:#b9bec4; max-width:880px; }
  .sub b { color:#fff; font-weight:600; }

  /* two rails */
  .rails { margin-top:auto; margin-bottom:6px; display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .card { border-radius:18px; padding:22px 26px; }
  .card.old { border:1px solid rgba(255,255,255,0.11); background:rgba(255,255,255,0.02); }
  .card.new { border:1px solid rgba(46,230,166,0.34); background:rgba(46,230,166,0.05); }
  .ctop { display:flex; align-items:center; gap:10px; }
  .ctag { font-family:'Space Grotesk',sans-serif; font-size:25px; font-weight:700; letter-spacing:-0.01em; }
  .card.old .ctag { color:#d6dade; }
  .card.new .ctag { color:var(--accent); }
  .csub { font-family:'JetBrains Mono',monospace; font-size:13px; color:#717880; }
  .cline { margin-top:14px; font-size:19px; font-weight:600; line-height:1.25; }
  .card.old .cline { color:#cfd3d8; }
  .card.new .cline { color:#fff; }
  .cmeta { margin-top:10px; font-family:'JetBrains Mono',monospace; font-size:14px; line-height:1.7; }
  .card.old .cmeta { color:#8b9097; }
  .card.new .cmeta { color:#9be3c7; }
  .cmeta b { font-weight:700; }
  .card.old .cmeta b { color:#e7eaee; }
  .card.new .cmeta b { color:var(--accent); }

  footer { display:flex; align-items:center; justify-content:space-between; margin-top:18px;
    font-family:'JetBrains Mono',monospace; font-size:18px; color:var(--muted);
    border-top:1px solid rgba(255,255,255,0.06); padding-top:15px; }
  footer .npm b { color:#fff; font-weight:700; }
  footer .site { color:var(--accent); font-weight:700; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <header>
    <div class="brand"><img src="${logo}"><span class="wm">PipRail</span></div>
    <div class="pill"><i></i>both speak HTTP 402</div>
  </header>

  <div class="titleblock">
    <div class="eyebrow">Two ways to pay an agent</div>
    <h1>MPP <span class="vs">vs.</span> <b>x402</b></h1>
    <div class="sub">Same handshake. The fork is <b>custody</b> — who holds the money once the agent agrees to pay.</div>
  </div>

  <div class="rails">
    <div class="card old">
      <div class="ctop"><span class="ctag">MPP</span><span class="csub">Stripe + Tempo</span></div>
      <div class="cline">A custodian holds it.</div>
      <div class="cmeta">held by <b>Stripe</b> · ~<b>1.5%</b> fee<br>permissioned chain · can freeze</div>
    </div>
    <div class="card new">
      <div class="ctop"><span class="ctag">x402</span><span class="csub">self-custody</span></div>
      <div class="cline">Nobody holds it.</div>
      <div class="cmeta">wallet-to-wallet · <b>0%</b> fee<br>any of ~29 chains · you verify</div>
    </div>
  </div>

  <footer>
    <span class="npm">npm i <b>@piprail/sdk</b></span>
    <span class="site">piprail.com/blog</span>
  </footer>
</body></html>`

const outDir = resolve(REPO, 'site/public/blog')
mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, 'mpp-vs-x402.png')
writeFileSync(resolve(__dirname, 'mpp-vs-x402.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } })
await browser.close()
console.log(`Rendered ${out}`)
