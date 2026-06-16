#!/usr/bin/env node
// Universal code card: one wallet, ANY chain — the "universal tooling for agent payments" message.
// A code window + a strip of chain logos underneath. 1600×900.
//   node render-universal.mjs  ->  ./universal.png
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const CHAINS_DIR = resolve(REPO, 'site/public/chains')
const LOGO = resolve(REPO, 'site/public/logo-no-background.png')

const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(LOGO, 'image/png')

// A diverse strip — EVM + Solana + non-EVM families, to sell "any chain, one parameter".
const STRIP = ['base', 'solana', 'bnb', 'polygon', 'arbitrum', 'xrpl', 'stellar', 'ton', 'tron', 'near', 'sui', 'algorand']
const FULL_BLEED = new Set(['arbitrum', 'avalanche', 'base', 'bnb', 'celo', 'ethereum', 'linea', 'mantle',
  'optimism', 'polygon', 'scroll', 'solana', 'sonic', 'ton', 'unichain', 'worldchain', 'zksync'])
const chips = STRIP.map(k => {
  const cls = FULL_BLEED.has(k) ? 'fill' : 'pad'
  return `<div class="chip ${cls}"><img src="${b64(resolve(CHAINS_DIR, `${k}.svg`), 'image/svg+xml')}"></div>`
}).join('')

// tok-* colors lifted from site/src/styles/global.css
const code = `<span class="kw">import</span> { PipRailClient } <span class="kw">from</span> <span class="str">'@piprail/sdk'</span>

<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">PipRailClient</span>({
  chain: <span class="chain">'base'</span>,<span class="com">  // 'solana' | 'bnb' | 'xrpl' | …</span>
  wallet: { privateKey },
})

<span class="com">// hits a 402 → pays it in USDC → retries.</span>
<span class="kw">const</span> res = <span class="kw">await</span> client.<span class="fn">fetch</span>(url)`

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1600px; height:900px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:60px 80px; }
  .glow { position:absolute; left:50%; top:46%; transform:translate(-50%,-50%); width:1300px; height:1050px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.14) 0%, rgba(46,230,166,0.04) 38%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:16px; }
  .brand img { width:58px; height:58px; }
  .brand .wm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:31px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:21px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:10px 22px; border-radius:999px; letter-spacing:0.04em; }

  .hero { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:26px; }
  h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:52px; font-weight:700; letter-spacing:-0.03em; text-align:center; line-height:1.08; }
  h1 b { color:var(--accent); }

  .win { width:1060px; border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.10);
    background:#0c0e11; box-shadow:0 30px 80px rgba(0,0,0,0.6); }
  .win .bar { display:flex; align-items:center; gap:9px; padding:15px 20px; border-bottom:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.02); }
  .win .bar i { width:13px; height:13px; border-radius:50%; display:block; }
  .win .bar .r{background:#ff5f57}.win .bar .y{background:#febc2e}.win .bar .g{background:#28c840}
  .win .bar span { margin-left:14px; font-family:'JetBrains Mono',monospace; font-size:18px; color:var(--muted); }
  .win pre { margin:0; padding:30px 40px; font-family:'JetBrains Mono',monospace; font-size:28px; line-height:1.5;
    color:#e7eaee; white-space:pre; }
  .kw{color:oklch(0.62 0.01 260)} .str{color:oklch(0.84 0.13 162)} .fn{color:oklch(0.8 0.11 235)}
  .chain{color:oklch(0.85 0.14 85);font-weight:600} .com{color:oklch(0.55 0.01 260);font-style:italic}

  .strip { display:flex; align-items:center; gap:18px; }
  .chip { width:62px; height:62px; border-radius:50%; overflow:hidden; display:flex; align-items:center; justify-content:center;
    background:#0c0c0e; border:1px solid rgba(255,255,255,0.10); box-shadow:inset 0 1px 0 rgba(255,255,255,0.06); }
  .chip.fill img { width:100%; height:100%; object-fit:cover; }
  .chip.pad img  { width:56%; height:56%; object-fit:contain; }
  .strip .more { font-family:'JetBrains Mono',monospace; font-size:26px; color:var(--muted); font-weight:600; margin-left:4px; }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:23px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>
  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>
  <div class="hero">
    <h1>One wallet. <b>Any chain.</b> Your agent pays itself.</h1>
    <div class="win">
      <div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>agent.ts</span></div>
      <pre>${code}</pre>
    </div>
    <div class="strip">${chips}<span class="more">+ ~29 chains</span></div>
  </div>
  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk · no backend · no fee</span></footer>
</body></html>`

const out = resolve(__dirname, 'universal.png')
writeFileSync(resolve(__dirname, 'universal.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height: 900 } })
await browser.close()
console.log(`Rendered ${out}`)
