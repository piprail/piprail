#!/usr/bin/env node
// Launch card (1080×1080) — "One agent. Every chain." Multi-wallet (MultiChainPayer), dev-focused
// for the AI-agent economy. Deliberately SPACIOUS like the Hermes / solana-gasless cards: a centered
// stack with lots of air — one headline, one quiet sub-line, ONE clean code card (the established
// PipRail code-card style), footer. No clutter. Brand: #000 bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono.
//   node render-multichain.mjs  ->  ./multichain.png  (1080×1080)
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

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:64px 68px; }
  .glow { position:absolute; left:50%; top:34%; transform:translate(-50%,-50%); width:1040px; height:840px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.14) 0%, rgba(46,230,166,0.04) 44%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:28px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand img { width:48px; height:48px; }
  .brand .wm { font-family:'Space Grotesk',sans-serif; font-size:28px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em; }

  /* Centered hero — airy, one focal idea + one code card. */
  .hero { position:relative; z-index:2; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:40px; }
  .head { text-align:center; }
  .head h1 { font-family:'Space Grotesk',sans-serif; font-size:84px; font-weight:700; letter-spacing:-0.04em; line-height:1.0; }
  .head h1 b { color:var(--accent); }
  .head p { margin-top:22px; font-size:27px; line-height:1.5; color:#c4c8ce; font-weight:400; }
  .head p b { color:#fff; font-weight:600; }

  /* The one code card — inset (generous side margins), not full-bleed → spacious. */
  .codecard { width:780px; background:#0a0b0c; border:1px solid rgba(255,255,255,0.09); border-radius:18px; overflow:hidden;
    box-shadow:0 26px 64px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05); }
  .chrome { display:flex; align-items:center; gap:9px; padding:15px 22px; border-bottom:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.015); }
  .chrome i { width:12px; height:12px; border-radius:50%; display:block; }
  .chrome .r{background:#ff5f57} .chrome .y{background:#febc2e} .chrome .g{background:#28c840}
  .chrome .file { font-family:'JetBrains Mono',monospace; font-size:19px; color:#7c848b; margin-left:6px; }
  pre { font-family:'JetBrains Mono',monospace; font-size:23px; line-height:1.7; padding:30px 36px 34px; color:#c9cdd1; white-space:pre; }
  .k{color:#6ea8fe} .s{color:#2ee6a6} .c{color:#5b6770;font-style:italic} .t{color:#e2b15a} .p{color:#e6ebf0} .f{color:#8ab4ff}

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:20px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · multi-chain</div>
  </header>

  <div class="hero">
    <div class="head">
      <h1>One agent.<br><b>Every chain.</b></h1>
      <p>One wallet per chain — your agent pays whichever the 402 asks for.</p>
    </div>

    <div class="codecard">
      <div class="chrome"><i class="r"></i><i class="y"></i><i class="g"></i><span class="file">agent.ts</span></div>
<pre><span class="k">const</span> agent = <span class="t">MultiChainPayer</span>.<span class="f">fromWallets</span>({
  <span class="p">wallets</span>: {
    <span class="p">base</span>:   { <span class="p">privateKey</span> },
    <span class="p">solana</span>: { <span class="p">secretKey</span> },
  },
})

<span class="c">// pays whichever chain the 402 asks for</span>
<span class="k">await</span> agent.<span class="f">fetch</span>(url)</pre>
    </div>
  </div>

  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk</span></footer>
</body></html>`

const out = resolve(__dirname, 'multichain.png')
writeFileSync(resolve(__dirname, 'multichain.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
