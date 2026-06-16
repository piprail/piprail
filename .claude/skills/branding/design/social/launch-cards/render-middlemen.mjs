#!/usr/bin/env node
// Launch card (1600×900, 16:9) — "Four middlemen, or none." Adapted from the pitch-deck
// "WATCH IT MOVE" slide into a public-facing "what PipRail is" card: the same payment, two ways.
// Top = the processor rail (FOUR dim grey middlemen, each holds it / takes a cut / pays out in
// days). Bottom = PipRail (ONE emerald wallet-to-wallet transfer — none). Generic role labels,
// no competitor named (brand rule). Brand-pure: emerald is the only accent; the old path is grey,
// which is exactly what makes the emerald pop. #000 bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono.
//   node render-middlemen.mjs  ->  ./middlemen.png  (1600×900)
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

const W = 1600, H = 900

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; --grey:#5b626b; }
  html,body { width:${W}px; height:${H}px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:60px 70px 54px; }
  /* soft emerald whisper behind the PipRail row (lower-right) — contrast, not glow */
  .glow { position:absolute; right:-180px; bottom:-220px; width:920px; height:760px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.04) 46%, rgba(0,0,0,0) 70%); pointer-events:none; }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:26px; pointer-events:none; }
  body > * { position:relative; z-index:2; }

  header { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { width:46px; height:46px; }
  .brand .wm { font-family:'Space Grotesk',sans-serif; font-size:30px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em;
    display:flex; align-items:center; gap:10px; }
  .pill i { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 12px var(--accent); }

  .titleblock { margin-top:30px; }
  .eyebrow { font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:500; letter-spacing:6px;
    text-transform:uppercase; color:#6b727b; }
  h1 { font-family:'Space Grotesk',sans-serif; font-size:74px; font-weight:700; letter-spacing:-0.035em;
    line-height:1.0; margin-top:14px; }
  h1 b { color:var(--accent); }
  .sub { margin-top:16px; font-size:23px; line-height:1.45; color:#b9bec4; max-width:1180px; }
  .sub b { color:#fff; font-weight:600; }

  /* the two payment rails */
  .rails { margin-top:auto; margin-bottom:auto; display:flex; flex-direction:column; gap:22px; }
  .rail { display:flex; align-items:center; gap:26px; border:1px solid var(--line); border-radius:20px; padding:22px 28px; }
  .rail.old { border-color:rgba(255,255,255,0.10); background:rgba(255,255,255,0.018); }
  .rail.new { border-color:rgba(46,230,166,0.32); background:rgba(46,230,166,0.05); }

  .rlabel { width:150px; flex:none; }
  .rlabel .t { font-family:'Space Grotesk',sans-serif; font-size:21px; font-weight:700; letter-spacing:-0.01em; }
  .rlabel.old .t { color:#cfd3d8; }
  .rlabel.new .t { color:var(--accent); }
  .rlabel .s { font-family:'JetBrains Mono',monospace; font-size:13.5px; color:#717880; margin-top:4px; letter-spacing:0.02em; }

  .track { flex:1; display:flex; align-items:center; justify-content:center; gap:4px; }

  /* endpoints (you / merchant / wallets) */
  .end { display:flex; flex-direction:column; align-items:center; gap:4px; min-width:96px; text-align:center; }
  .end .lab { font-family:'Space Grotesk',sans-serif; font-size:17px; font-weight:600; color:#e7eaee; line-height:1.1; }
  .end.em .lab { color:#fff; }

  /* middleman chips (the FOUR) — dim grey, dashed = friction */
  .hop { display:flex; flex-direction:column; align-items:center; gap:5px; min-width:120px;
    border:1px dashed rgba(255,255,255,0.20); background:rgba(255,255,255,0.03); border-radius:13px; padding:12px 14px; text-align:center; }
  .hop .n { font-family:'Space Grotesk',sans-serif; font-size:18px; font-weight:600; color:#aeb4bb; white-space:nowrap; }
  .hop .c { font-family:'JetBrains Mono',monospace; font-size:12px; color:#7c828a; text-transform:uppercase; letter-spacing:0.03em; white-space:nowrap; }

  .arr { color:var(--grey); font-size:26px; flex:none; padding:0 2px; }

  /* PipRail single connector */
  .wire { flex:1; display:flex; flex-direction:column; align-items:center; gap:8px; padding:0 14px; }
  .wire .lab { font-family:'JetBrains Mono',monospace; font-size:16px; color:#bdeede; font-weight:500; letter-spacing:0.01em; white-space:nowrap; }
  .wire .ln { width:100%; height:2px; position:relative;
    background:linear-gradient(90deg, rgba(46,230,166,0.15), var(--accent) 50%, rgba(46,230,166,0.15)); }
  .wire .ln::after { content:"\\203A"; position:absolute; right:-4px; top:50%; transform:translateY(-52%); color:var(--accent); font-size:30px; font-weight:700; }
  .arr.em { color:var(--accent); }

  /* verdict at the end of each rail */
  .verdict { width:212px; flex:none; text-align:right; }
  .verdict .v { font-family:'JetBrains Mono',monospace; font-size:15px; line-height:1.6; }
  .verdict.old .v { color:#9aa0a7; }
  .verdict.new .v { color:#cdeede; }
  .verdict .v b { font-weight:700; }
  .verdict.old .v b { color:#e7eaee; }
  .verdict.new .v b { color:var(--accent); }

  footer { display:flex; align-items:center; justify-content:space-between;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted);
    border-top:1px solid rgba(255,255,255,0.06); padding-top:18px; }
  footer .npm b { color:#fff; font-weight:700; }
  footer .site { color:var(--accent); font-weight:700; }

  :root { --line:rgba(255,255,255,0.08); }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill"><i></i>x402 · self-custody</div>
  </header>

  <div class="titleblock">
    <div class="eyebrow">What PipRail is</div>
    <h1>Four middlemen, or <b>none</b>.</h1>
    <div class="sub">The same payment, two ways. Every processor rail routes it through parties that <b>hold your money, take a cut, and pay out in days</b>. PipRail is one wallet-to-wallet transfer — verified against your own RPC.</div>
  </div>

  <div class="rails">
    <div class="rail old">
      <div class="rlabel old"><div class="t">Processor rail</div><div class="s">custodial</div></div>
      <div class="track">
        <div class="end"><span class="lab">Your<br>agent</span></div>
        <span class="arr">&rarr;</span>
        <div class="hop"><span class="n">Processor</span><span class="c">holds funds</span></div>
        <span class="arr">&rarr;</span>
        <div class="hop"><span class="n">Card network</span><span class="c">+ fee</span></div>
        <span class="arr">&rarr;</span>
        <div class="hop"><span class="n">Validators</span><span class="c">+ fee</span></div>
        <span class="arr">&rarr;</span>
        <div class="hop"><span class="n">Bank</span><span class="c">T+2 days</span></div>
        <span class="arr">&rarr;</span>
        <div class="end"><span class="lab">Merchant</span></div>
      </div>
      <div class="verdict old"><div class="v">held by <b>others</b><br>~1.5% + FX<br>clears in <b>days</b></div></div>
    </div>

    <div class="rail new">
      <div class="rlabel new"><div class="t">PipRail</div><div class="s">x402 · self-custody</div></div>
      <div class="track">
        <div class="end em"><span class="lab">Your agent's<br>wallet</span></div>
        <div class="wire"><span class="lab">one on-chain tx · 0% fee · your own RPC</span><span class="ln"></span></div>
        <div class="end em"><span class="lab">Your<br>wallet</span></div>
      </div>
      <div class="verdict new"><div class="v">held by <b>nobody</b><br><b>0%</b> protocol fee<br>settles in <b>seconds</b></div></div>
    </div>
  </div>

  <footer>
    <span class="npm">npm i <b>@piprail/sdk</b> · ~29 chains</span>
    <span class="site">piprail.com</span>
  </footer>
</body></html>`

const out = resolve(__dirname, 'middlemen.png')
writeFileSync(resolve(__dirname, 'middlemen.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } })
await browser.close()
console.log(`Rendered ${out}`)
