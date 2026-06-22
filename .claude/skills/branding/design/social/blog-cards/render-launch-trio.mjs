#!/usr/bin/env node
// Blog OG cards (1200×630) for the June 2026 launch trio:
//   /blog/give-your-agent-a-wallet · /blog/x402-chains · /blog/backendless-x402
// Brand-pure: #000 bg, emerald #2ee6a6 accent. Mirrors render-open-rail.mjs.
//   node render-launch-trio.mjs  ->  site/public/blog/<slug>.png  (×3)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')

// Pick the first Chrome that actually exists on this machine.
const CHROME_CANDIDATES = [
  process.env.HOME +
    '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
]
const CHROME_BIN = CHROME_CANDIDATES.find(existsSync)
if (!CHROME_BIN) {
  console.error('No Chrome binary found. Install Google Chrome or Chrome for Testing.')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const logo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')

const W = 1200, H = 630

const cards = [
  {
    slug: 'give-your-agent-a-wallet',
    eyebrow: 'Guide',
    h1: 'Give your agent a <b>wallet</b> it can’t overspend.',
    sub: 'Pay any x402 URL in one call — capped by a spend policy the model <b>can’t cross</b>.',
    chips: ['client.fetch(url)', 'spend policy', '29 chains', 'MCP + elizaOS', '0% fee'],
    by: 'John Weeks', role: 'founder of PipRail',
  },
  {
    slug: 'x402-chains',
    eyebrow: 'Guide',
    h1: 'Every chain PipRail pays <b>x402</b> on.',
    sub: 'One <b>chain:</b> parameter — 29 chains, ten families, USDC almost everywhere.',
    chips: ['29 chains', '10 families', 'USDC + USDT', 'native everywhere', 'any token by address'],
    by: 'John Weeks', role: 'founder of PipRail',
  },
  {
    slug: 'backendless-x402',
    eyebrow: 'Architecture',
    h1: 'No facilitator. No custody. <b>No fee.</b>',
    sub: 'How backendless x402 works: the merchant <b>verifies the payment itself</b>, locally.',
    chips: ['merchant-local verify', 'no backend', 'x402 v2 §7', '29 chains', 'self-custody'],
    by: 'Tim Roelofs', role: 'cofounder of PipRail',
  },
]

const tpl = (c) => `<!doctype html><html><head><meta charset="utf-8">
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
  h1 { font-family:'Space Grotesk',sans-serif; font-size:70px; font-weight:700; letter-spacing:-0.035em;
    line-height:1.02; margin-top:16px; max-width:1030px; }
  h1 b { color:var(--accent); }
  .sub { margin-top:20px; font-size:23px; line-height:1.4; color:#b9bec4; max-width:920px; }
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
    <div class="eyebrow">${c.eyebrow}</div>
    <h1>${c.h1}</h1>
    <div class="sub">${c.sub}</div>
    <div class="chips">${c.chips.map((x) => `<span class="chip"><i></i>${x}</span>`).join('')}</div>
  </div>
  <footer>
    <span class="by">by <b>${c.by}</b>, ${c.role}</span>
    <span class="site">piprail.com/blog</span>
  </footer>
</body></html>`

const outDir = resolve(REPO, 'site/public/blog')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
for (const c of cards) {
  const html = tpl(c)
  writeFileSync(resolve(__dirname, `${c.slug}.html`), html)
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const out = resolve(outDir, `${c.slug}.png`)
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } })
  await page.close()
  console.log(`Rendered ${out}`)
}
await browser.close()
