// Reply card to a16z crypto ("AI can't own property / sign contracts / start companies —
// unless it's onchain"). The pivot: none of it moves until the agent can PAY itself.
// 1080×1080 @2× → a16z-reply.png. Self-contained: base64-embeds the PipRail mark.
//   node render-a16z.mjs            -> ./a16z-reply.png
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../../../..')
const logo = `data:image/png;base64,${readFileSync(resolve(REPO, 'site/public/logo-no-background.png')).toString('base64')}`

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; --sub:#c8ccd2; }
  html,body { width:1080px; height:1080px; }
  body {
    background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:72px 76px;
  }
  .glow { position:absolute; left:50%; top:46%; transform:translate(-50%,-50%);
    width:1220px; height:1220px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.20) 0%, rgba(46,230,166,0.06) 38%, rgba(0,0,0,0) 67%);
    pointer-events:none; }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:26px; pointer-events:none; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:15px; }
  .brand img { width:54px; height:54px; }
  .brand .wm { font-size:30px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em; }

  .hero { position:relative; z-index:2; display:flex; flex-direction:column; gap:30px; }

  .checklist { display:flex; flex-direction:column; gap:14px; }
  .checklist .item { display:flex; align-items:center; gap:16px; font-size:33px; font-weight:600; color:#7e858f; }
  .checklist .item .tick { width:34px; height:34px; border-radius:50%; flex:0 0 auto;
    border:1.5px solid rgba(255,255,255,0.18); display:flex; align-items:center; justify-content:center;
    font-size:19px; color:#9aa0a8; }
  .checklist .item .oc { font-family:'JetBrains Mono',monospace; font-size:18px; color:#6c727b; letter-spacing:0.03em; margin-left:4px; }

  h1 { font-size:104px; font-weight:900; letter-spacing:-0.045em; line-height:0.96; margin-top:6px; }
  h1 .g { color:var(--accent); }
  .sub { font-size:29px; line-height:1.46; color:var(--sub); font-weight:400; max-width:900px; }
  .sub b { color:#fff; font-weight:600; }

  .term { margin-top:4px; border:1px solid rgba(46,230,166,0.22); background:rgba(46,230,166,0.04);
    border-radius:18px; padding:28px 34px; font-family:'JetBrains Mono',monospace; }
  .term .row { display:flex; align-items:center; justify-content:space-between; font-size:26px; line-height:1.95; }
  .term .lhs { color:#e7e9ee; font-weight:500; }
  .term .lhs .k { color:var(--muted); }
  .term .s402 { color:var(--muted); font-weight:600; }
  .term .s200 { color:var(--accent); font-weight:700; }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:22px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div>
  <div class="frame"></div>

  <header>
    <div class="brand"><img src="${logo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>

  <div class="hero">
    <div class="checklist">
      <div class="item"><span class="tick">✓</span> Own property <span class="oc">onchain</span></div>
      <div class="item"><span class="tick">✓</span> Sign contracts <span class="oc">onchain</span></div>
      <div class="item"><span class="tick">✓</span> Start a company <span class="oc">onchain</span></div>
    </div>
    <h1>But first, it has to <span class="g">pay.</span></h1>
    <div class="sub">None of it moves until an agent can <b>settle a bill itself</b>. PipRail is that rail — it pays any <b>x402</b> URL on ~29 chains, no backend, no fee, straight to <b>your</b> wallet.</div>
    <div class="term">
      <div class="row"><span class="lhs"><span class="k">GET</span> /paywalled-api</span><span class="s402">402 Payment Required</span></div>
      <div class="row"><span class="lhs"><span class="k">PAY</span> x402 · onchain · 3 lines</span><span class="s200">200 OK ✓</span></div>
    </div>
  </div>

  <footer>
    <span class="site">piprail.com</span>
    <span>npm i @piprail/sdk</span>
  </footer>
</body></html>`

const b = await chromium.launch({ executablePath: CHROME_BIN, headless: true, args: ['--force-color-profile=srgb'] })
const p = await b.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await p.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'load' })
await p.evaluate(() => document.fonts.ready).catch(() => {})
await p.waitForTimeout(450)
await p.screenshot({ path: resolve(HERE, 'a16z-reply.png'), clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await b.close()
console.log('rendered a16z-reply.png')
