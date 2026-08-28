#!/usr/bin/env node
// Launch card (1080×1080, square) — "Pay. Get paid." The merchant on-ramp: both sides of the
// agent economy are now one command each — buyers pay any 402 with `npx -y @piprail/mcp`, sellers
// become a payable x402 endpoint with `npm create @piprail`. Deliberately SPACIOUS like the
// multichain / x402-parity cards: a centered stack with lots of air — one two-word headline, one
// quiet sub-line, TWO clean terminal command cards (the symmetry IS the focal point), footer.
// Brand: true-black bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono (branding SKILL §2).
//   node render-merchant-onramp.mjs  ->  ./merchant-onramp.png  (1080×1080)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
// Prefer the pinned playwright Chromium; fall back to system Chrome/Chromium (fine for a static shot).
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

// The two sides — one command each. Label · the terminal command (verb emphasized) · one muted line.
const rows = [
  ['PAY',      'npx -y ',     '@piprail/mcp',  'Your agent pays any x402 URL by itself.'],
  ['GET PAID', 'npm create ', '@piprail',      'You become a payable x402 endpoint.'],
]

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#08090a; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:74px 76px 72px; }
  /* a soft emerald whisper behind the headline, a fainter one under the commands */
  .glow  { position:absolute; left:50%; top:30%; transform:translate(-50%,-50%); width:880px; height:660px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.045) 44%, rgba(0,0,0,0) 70%); }
  .glow2 { position:absolute; left:50%; bottom:4%; transform:translateX(-50%); width:760px; height:520px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.06) 0%, rgba(0,0,0,0) 68%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:30px; }

  .top { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { width:44px; height:44px; }
  .brand .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:29px; font-weight:700; letter-spacing:-0.02em; }
  .badge { display:inline-flex; align-items:center; gap:9px; border:1px solid rgba(46,230,166,0.32);
    background:rgba(46,230,166,0.09); color:var(--accent); border-radius:999px; padding:8px 18px;
    font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:600; letter-spacing:0.24em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.75); }

  /* Centered hero — airy: a two-word headline, a quiet sub, then the two command cards. */
  .hero { position:relative; z-index:2; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .head { text-align:center; }
  .head h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:118px; font-weight:700; letter-spacing:-0.04em; line-height:0.98; }
  .head h1 .em { color:var(--accent); }
  .head p { margin-top:24px; font-size:28px; line-height:1.45; color:#9aa0a8; font-weight:400; }
  .head p b { color:#fff; font-weight:600; }

  .cmds { margin-top:62px; display:flex; flex-direction:column; gap:26px; width:812px; }
  .cmd { display:flex; align-items:center; gap:26px; border-radius:20px; border:1px solid rgba(255,255,255,0.08);
    background:linear-gradient(155deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.012) 60%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 50px -20px rgba(0,0,0,0.7); padding:30px 34px; }
  .tag { flex:0 0 auto; min-width:148px; font-family:'JetBrains Mono',monospace; font-size:17px; font-weight:600;
    letter-spacing:0.22em; color:var(--accent); }
  .body { flex:1; min-width:0; }
  .term { font-family:'JetBrains Mono',monospace; font-size:30px; font-weight:500; line-height:1.0; color:#e6ebf0; white-space:nowrap; }
  .term .pr { color:#4f5862; margin-right:14px; }
  .term .em { color:var(--accent); font-weight:600; }
  .desc { margin-top:13px; font-size:20px; line-height:1.35; color:#9aa0a8; font-weight:400; }

  footer { position:relative; z-index:2; margin-top:40px; display:flex; align-items:center; justify-content:space-between;
    font-family:'JetBrains Mono',monospace; font-size:20px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
  footer .meta b { color:rgba(255,255,255,0.85); font-weight:500; }
  footer .meta .sep { color:rgba(255,255,255,0.20); margin:0 10px; }
</style></head>
<body>
  <div class="glow"></div><div class="glow2"></div><div class="frame"></div>

  <div class="top">
    <div class="brand"><img src="${piprailLogo}"><span class="nm">PipRail</span></div>
    <div class="badge"><i></i> Shipped</div>
  </div>

  <div class="hero">
    <div class="head">
      <h1>Pay. <span class="em">Get&nbsp;paid.</span></h1>
      <p>Both sides of the agent economy — <b>one command each</b>.</p>
    </div>

    <div class="cmds">
      ${rows.map(([tag, pre, pkg, desc]) => `<div class="cmd">
        <div class="tag">${tag}</div>
        <div class="body">
          <div class="term"><span class="pr">$</span>${pre}<span class="em">${pkg}</span></div>
          <div class="desc">${desc}</div>
        </div>
      </div>`).join('')}
    </div>
  </div>

  <footer>
    <span class="site">piprail.com</span>
    <span class="meta"><b>no key</b><span class="sep">·</span><b>no account</b><span class="sep">·</span><b>no backend</b><span class="sep">·</span><b>no fee</b></span>
  </footer>
</body></html>`

const out = resolve(__dirname, 'merchant-onramp.png')
writeFileSync(resolve(__dirname, 'merchant-onramp.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
