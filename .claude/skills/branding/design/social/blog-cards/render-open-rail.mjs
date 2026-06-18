#!/usr/bin/env node
// Blog OG card (1200×630) for /blog/the-agent-economy-needs-an-open-rail.
// Brand-pure: #000 bg, emerald #2ee6a6 accent. "open" is the emphasis; a strip of
// emerald spec chips grounds the claim. By Tim Roelofs.
//   node render-open-rail.mjs  ->  ../../../../../../site/public/blog/the-agent-economy-needs-an-open-rail.png
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
const chips = ['29 chains', '0% fee', 'no facilitator', 'self-custody', 'MIT', '1 line of code']

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:${W}px; height:${H}px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:52px 60px 44px; }
  .glow { position:absolute; right:-200px; top:-220px; width:860px; height:720px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.17) 0%, rgba(46,230,166,0.04) 46%, rgba(0,0,0,0) 70%); pointer-events:none; }
  .frame { position:absolute; inset:22px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; pointer-events:none; }
  body > * { position:relative; z-index:2; }

  header { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:13px; }
  .brand img { width:43px; height:43px; }
  .brand .wm { font-family:'Space Grotesk',sans-serif; font-size:28px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:8px 18px; border-radius:999px; letter-spacing:0.04em;
    display:flex; align-items:center; gap:9px; }
  .pill i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 12px var(--accent); }

  .body { margin-top:auto; margin-bottom:auto; }
  .eyebrow { font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:500; letter-spacing:6px;
    text-transform:uppercase; color:#6b727b; }
  h1 { font-family:'Space Grotesk',sans-serif; font-size:78px; font-weight:700; letter-spacing:-0.035em;
    line-height:1.0; margin-top:16px; max-width:1020px; }
  h1 b { color:var(--accent); }
  .sub { margin-top:20px; font-size:23px; line-height:1.4; color:#b9bec4; max-width:900px; }
  .sub b { color:#fff; font-weight:600; }

  .chips { margin-top:28px; display:flex; flex-wrap:wrap; gap:10px; }
  .chip { display:flex; align-items:center; gap:8px; font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:600;
    color:var(--accent); border:1px solid rgba(46,230,166,0.3); background:rgba(46,230,166,0.07);
    padding:8px 15px; border-radius:999px; }
  .chip i { width:7px; height:7px; border-radius:50%; background:var(--accent); }

  footer { display:flex; align-items:center; justify-content:space-between; margin-top:18px;
    font-family:'JetBrains Mono',monospace; font-size:18px; color:var(--muted);
    border-top:1px solid rgba(255,255,255,0.06); padding-top:16px; }
  footer .by b { color:#e7eaee; font-weight:700; }
  footer .site { color:var(--accent); font-weight:700; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <header>
    <div class="brand"><img src="${logo}"><span class="wm">PipRail</span></div>
    <div class="pill"><i></i>x402 · open &amp; self-custody</div>
  </header>

  <div class="body">
    <div class="eyebrow">Perspective</div>
    <h1>The agent economy needs an <b>open</b> rail.</h1>
    <div class="sub">Every network that scaled ran on <b>open protocols</b>, not private ones. Its payment rail just got opened up.</div>
    <div class="chips">${chips.map((c) => `<span class="chip"><i></i>${c}</span>`).join('')}</div>
  </div>

  <footer>
    <span class="by">by <b>Tim Roelofs</b>, cofounder of PipRail</span>
    <span class="site">piprail.com/blog</span>
  </footer>
</body></html>`

const outDir = resolve(REPO, 'site/public/blog')
mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, 'the-agent-economy-needs-an-open-rail.png')
writeFileSync(resolve(__dirname, 'open-rail.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } })
await browser.close()
console.log(`Rendered ${out}`)
