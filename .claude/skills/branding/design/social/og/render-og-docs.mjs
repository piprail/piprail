#!/usr/bin/env node
// Open Graph / social-share card for the DOCS site (docs.piprail.com) — 1200×630 (1.91:1, the OG ratio).
//
// Deliberately a SIBLING of the marketing card (site/public/og.png) — same brand system (#08090a canvas,
// #2ee6a6 emerald, Space Grotesk + Inter + JetBrains Mono, the inset frame, the emerald glow) — but with
// a distinct DOCS identity so a shared link is instantly recognisable as the documentation, not the
// landing page: a "DOCUMENTATION" badge, a build-focused headline, the docs URL front-and-centre, and the
// marketing card's payment-glow ring swapped for a real quickstart CODE PANEL (reads "developer reference").
//
//   node render-og-docs.mjs   ->   ./og-docs.png   (renders at 2×, downscale into docs/public/og.png after)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
// The pinned playwright Chromium build was cleaned from the cache; fall back to system Chrome.
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

const chainSvg = (name) => b64(resolve(REPO, `site/public/chains/${name}.svg`), 'image/svg+xml')
// Big, instantly-recognisable chains where a third-party facilitator already sponsors gas (buyer pays $0 gas):
// Base · Ethereum · BNB · Solana · Polygon · Arbitrum — all in the keyless-facilitator set. +23 more = 29 total.
const featured = ['base', 'ethereum', 'bnb', 'solana', 'polygon', 'arbitrum']

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1200px; height:630px; }
  body { background:#08090a; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; padding:52px 60px 48px; }
  /* emerald whisper behind the headline (left), fainter one behind the code panel (right) */
  .glow  { position:absolute; left:20%; top:30%; transform:translate(-50%,-50%); width:680px; height:600px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.05) 42%, rgba(0,0,0,0) 70%); }
  .glow2 { position:absolute; right:2%; bottom:-6%; width:560px; height:520px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.08) 0%, rgba(0,0,0,0) 66%); }
  .frame { position:absolute; inset:22px; border:1px solid rgba(255,255,255,0.07); border-radius:26px; }

  .top { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:13px; }
  .brand img { width:42px; height:42px; }
  .brand .nm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:27px; font-weight:700; letter-spacing:-0.02em; }
  .badge { display:inline-flex; align-items:center; gap:9px; border:1px solid rgba(46,230,166,0.32);
    background:rgba(46,230,166,0.09); color:var(--accent); border-radius:999px; padding:8px 18px;
    font-family:'JetBrains Mono',monospace; font-size:14px; font-weight:600; letter-spacing:0.26em; text-transform:uppercase; }
  .badge i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 10px 1px rgba(46,230,166,0.75); }

  .hero { position:relative; z-index:2; flex:1; display:flex; align-items:center; gap:52px; }
  .left { flex:1; min-width:0; }
  h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:66px; font-weight:700;
    letter-spacing:-0.035em; line-height:1.0; }
  h1 .em { color:var(--accent); }
  .sub { margin-top:20px; font-size:23px; line-height:1.45; color:#9aa0a8; font-weight:400; max-width:480px; }
  .sub b { color:#fff; font-weight:600; }
  .chains { margin-top:30px; display:flex; align-items:center; gap:15px; }
  .chains .logos { display:flex; gap:10px; }
  .cl { width:42px; height:42px; border-radius:11px; overflow:hidden; border:1px solid rgba(255,255,255,0.12);
    background:#13151a; display:flex; align-items:center; justify-content:center; box-shadow:0 5px 14px rgba(0,0,0,0.4); }
  .cl img { width:100%; height:100%; display:block; }
  .chains .more { font-family:'JetBrains Mono',monospace; font-size:16px; color:#aeb4bc; font-weight:500; }
  .chains .more b { color:#fff; font-weight:600; }

  /* the quickstart code panel — the established PipRail code-card, vertically centred on the right */
  .codecard { width:520px; flex-shrink:0; background:#0a0b0c; border:1px solid rgba(255,255,255,0.09); border-radius:16px;
    overflow:hidden; box-shadow:0 26px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05); }
  .chrome { display:flex; align-items:center; gap:8px; padding:14px 20px; border-bottom:1px solid rgba(255,255,255,0.07);
    background:rgba(255,255,255,0.015); }
  .chrome i { width:11px; height:11px; border-radius:50%; display:block; }
  .chrome .r{background:#ff5f57} .chrome .y{background:#febc2e} .chrome .g{background:#28c840}
  .chrome .file { font-family:'JetBrains Mono',monospace; font-size:16px; color:#7c848b; margin-left:6px; }
  pre { font-family:'JetBrains Mono',monospace; font-size:18.5px; line-height:1.72; padding:26px 28px 28px; color:#c9cdd1; white-space:pre; }
  .k{color:#6ea8fe} .s{color:#2ee6a6} .c{color:#5b6770;font-style:italic} .t{color:#e2b15a} .p{color:#e6ebf0} .f{color:#8ab4ff}

  footer { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between;
    font-family:'JetBrains Mono',monospace; font-size:19px; color:var(--muted); }
  footer .url { color:#fff; font-weight:600; letter-spacing:0.01em; }
  footer .url b { color:var(--accent); font-weight:600; }
  footer .cmd b { color:var(--accent); font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="glow2"></div><div class="frame"></div>

  <div class="top">
    <div class="brand"><img src="${piprailLogo}"><span class="nm">PipRail</span></div>
    <div class="badge"><i></i> Documentation</div>
  </div>

  <div class="hero">
    <div class="left">
      <h1>Build on <span class="em">PipRail</span>.</h1>
      <p class="sub">Guides, API reference, and copy-paste quickstarts for the <b>x402 SDK</b> + <b>MCP server</b>.</p>
      <div class="chains">
        <div class="logos">${featured.map((n) => `<span class="cl"><img src="${chainSvg(n)}"></span>`).join('')}</div>
        <span class="more"><b>+ 23</b> more chains</span>
      </div>
    </div>

    <div class="codecard">
      <div class="chrome"><i class="r"></i><i class="y"></i><i class="g"></i><span class="file">quickstart.ts</span></div>
<pre><span class="k">import</span> { <span class="t">PipRailClient</span> } <span class="k">from</span> <span class="s">'@piprail/sdk'</span>

<span class="k">const</span> client = <span class="k">new</span> <span class="t">PipRailClient</span>({
  <span class="p">chain</span>: <span class="s">'base'</span>,  <span class="c">// or 'bnb', 'solana', …</span>
  <span class="p">wallet</span>,
})

<span class="c">// pays the 402, returns the data</span>
<span class="k">await</span> client.<span class="f">fetch</span>(url)</pre>
    </div>
  </div>

  <footer>
    <span class="url">docs.<b>piprail.com</b></span>
    <span class="cmd">npm i <b>@piprail/sdk</b></span>
  </footer>
</body></html>`

const out = resolve(__dirname, 'og-docs.png')
writeFileSync(resolve(__dirname, 'og-docs.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } })
await browser.close()
console.log(`Rendered ${out}`)
