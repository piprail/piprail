#!/usr/bin/env node
// Announcement card (1600×900) — "the docs are live". A branded docs-browser mock
// (docs.piprail.com + the section nav) beside the pitch, with the full 29-chain flex
// strip underneath. Reuses the brand system (true black, emerald, Inter/JetBrains Mono).
//   node render-docs.mjs  ->  ./docs-announce.png  (1600×900)
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
const CHAINS_DIR = resolve(REPO, 'site/public/chains')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')

// 29 chains, popular-first. Each rendered as a small uniform badge in the flex strip.
const CHAINS = ['base','ethereum','arbitrum','optimism','polygon','bnb','avalanche','solana','sui',
  'aptos','near','ton','tron','xrpl','stellar','algorand','celo','mantle','sonic','linea','scroll',
  'zksync','unichain','worldchain','sei','injective','hyperevm','monad','kaia']
const chainImg = (k) => b64(resolve(CHAINS_DIR, `${k}.svg`), 'image/svg+xml')
const FILL = new Set(['arbitrum','avalanche','base','bnb','celo','ethereum','linea','mantle',
  'optimism','polygon','scroll','solana','sonic','ton','unichain','worldchain','zksync'])

const SECTIONS = ['Getting started','Accepting payments','Making payments','Spend controls',
  'Agent toolkit','Discovery','Chains','Errors','MCP server','Reference']

const navHtml = SECTIONS.map((s, i) =>
  `<div class="nav ${i === 0 ? 'on' : ''}">${s}</div>`).join('')
const ccHtml = (k) => `<div class="cc ${FILL.has(k) ? 'fill' : 'pad'}"><img src="${chainImg(k)}"></div>`
const SPLIT = 15 // first row gets 15, second row the remaining 14 — balanced, never cramped
const rowOne = CHAINS.slice(0, SPLIT).map(ccHtml).join('')
const rowTwo = CHAINS.slice(SPLIT).map(ccHtml).join('')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1600px; height:900px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:56px 64px; }
  .glow { position:absolute; left:30%; top:38%; transform:translate(-50%,-50%); width:1100px; height:900px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.13) 0%, rgba(46,230,166,0.04) 40%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:15px; }
  .brand img { width:50px; height:50px; }
  .brand .wm { font-size:29px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em; }

  .mid { display:flex; align-items:center; gap:56px; position:relative; z-index:2; }
  .pitch { width:560px; flex:none; }
  .pitch h1 { font-size:74px; font-weight:900; letter-spacing:-0.04em; line-height:0.98; }
  .pitch h1 b { color:var(--accent); }
  .pitch p { margin-top:22px; font-size:25px; line-height:1.46; color:#c4c8ce; }
  .pitch p b { color:#fff; font-weight:700; }
  .url { display:inline-flex; align-items:center; gap:12px; margin-top:30px; font-family:'JetBrains Mono',monospace;
    font-size:25px; font-weight:600; color:#031a12; background:var(--accent); padding:14px 26px; border-radius:12px;
    box-shadow:0 0 44px rgba(46,230,166,0.28); }

  .win { flex:1; border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.10);
    background:#0b0d10; box-shadow:0 34px 90px rgba(0,0,0,0.6); }
  .win .bar { display:flex; align-items:center; gap:9px; padding:14px 18px; border-bottom:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.02); }
  .win .bar i { width:12px; height:12px; border-radius:50%; display:block; }
  .win .bar .r{background:#ff5f57}.win .bar .y{background:#febc2e}.win .bar .g{background:#28c840}
  .win .bar .addr { margin-left:14px; flex:1; display:flex; align-items:center; gap:9px;
    font-family:'JetBrains Mono',monospace; font-size:17px; color:#cfd3d9; background:rgba(255,255,255,0.04);
    border:1px solid rgba(255,255,255,0.07); border-radius:8px; padding:7px 14px; }
  .win .bar .addr .lock { color:var(--accent); }
  .win .bar .addr .path { color:var(--muted); }
  .win .body { display:flex; min-height:300px; }
  .win .side { width:208px; flex:none; border-right:1px solid rgba(255,255,255,0.06); padding:18px 0; background:rgba(255,255,255,0.012); }
  .win .nav { font-size:16.5px; color:var(--muted); padding:9px 22px; }
  .win .nav.on { color:#fff; font-weight:600; border-left:2px solid var(--accent); padding-left:20px; background:rgba(46,230,166,0.05); }
  .win .main { flex:1; padding:30px 34px; }
  .win .main .crumb { font-family:'JetBrains Mono',monospace; font-size:15px; color:var(--accent); letter-spacing:0.04em; }
  .win .main h2 { font-size:38px; font-weight:800; letter-spacing:-0.02em; margin-top:12px; }
  .win .main .lede { font-size:18px; color:#aeb3ba; line-height:1.5; margin-top:14px; }
  .win .main .links { margin-top:22px; display:flex; flex-direction:column; gap:11px; }
  .win .main .lk { font-size:18px; color:#dfe3e8; display:flex; align-items:center; gap:10px; }
  .win .main .lk::before { content:'→'; color:var(--accent); font-weight:700; }

  .chains { position:relative; z-index:2; }
  .chains .lbl { font-family:'JetBrains Mono',monospace; font-size:17px; color:var(--muted); letter-spacing:0.06em;
    margin-bottom:14px; display:flex; align-items:center; gap:10px; }
  .chains .lbl b { color:#fff; font-weight:600; }
  .rows { display:flex; flex-direction:column; gap:14px; }
  .row { display:flex; gap:18px; flex-wrap:nowrap; }
  .cc { width:54px; height:54px; border-radius:50%; overflow:hidden; flex:none; display:flex; align-items:center; justify-content:center;
    background:#0c0c0e; border:1px solid rgba(255,255,255,0.10); }
  .cc.fill img { width:100%; height:100%; object-fit:cover; }
  .cc.pad img  { width:60%; height:60%; object-fit:contain; }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:19px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>
  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>

  <div class="mid">
    <div class="pitch">
      <h1>The docs<br>are <b>live.</b></h1>
      <p>Every function, chain, and example — <b>x402 payments for AI agents</b>, end to end.</p>
      <div class="url">docs.piprail.com</div>
    </div>
    <div class="win">
      <div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i>
        <div class="addr"><span class="lock">⊙</span>docs.piprail.com<span class="path">/getting-started</span></div>
      </div>
      <div class="body">
        <div class="side">${navHtml}</div>
        <div class="main">
          <div class="crumb">GETTING STARTED</div>
          <h2>PipRail docs</h2>
          <div class="lede">Accept and make x402 payments — any chain, no backend, no fee. Install, name a chain, add a wallet.</div>
          <div class="links"><span class="lk">Accept a payment in one line</span><span class="lk">Pay any 402 URL by wrapping fetch</span><span class="lk">Give an agent a budget-bound wallet</span></div>
        </div>
      </div>
    </div>
  </div>

  <div class="chains">
    <div class="lbl"><b>29 chains</b> · 10 families · USDC almost everywhere · native coin on every one</div>
    <div class="rows"><div class="row">${rowOne}</div><div class="row">${rowTwo}</div></div>
  </div>

  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk · MIT</span></footer>
</body></html>`

const out = resolve(__dirname, 'docs-announce.png')
writeFileSync(resolve(__dirname, 'docs-announce.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height: 900 } })
await browser.close()
console.log(`Rendered ${out}`)
