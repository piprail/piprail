#!/usr/bin/env node
// Launch card (1080×1080) — "Native USDC, 23 chains." A Circle-USDC hype card: the official
// Circle USDC mark up top, the number, then a tidy grid of the 23 chain logos where PipRail
// ships Circle-ISSUED native USDC (23 of Circle's 34 native networks — verified on-chain in
// .claude/research/usdc-usdt-chain-map.md; bridged USDC on Mantle/Scroll and Binance-peg on BNB
// are deliberately EXCLUDED so every claim survives Circle's own scrutiny).
// Brand: #000 bg, #2ee6a6 accent, Space Grotesk + Inter + JetBrains Mono. Spacious, one focal idea.
//   node render-usdc-everywhere.mjs  ->  ./usdc-everywhere.png  (1080×1080)
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
import { existsSync } from 'node:fs'
// Prefer the pinned Playwright Chromium; fall back to system Chrome if it isn't installed.
const PINNED = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const CHROME_BIN = existsSync(PINNED) ? PINNED : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const piprailLogo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')
const usdc = b64(resolve(REPO, 'site/public/tokens/usdc.svg'), 'image/svg+xml')

// The 23 chains where PipRail ships Circle-ISSUED native USDC, prominence-ordered for a balanced grid.
// Each gets its authentic brand color as the tile background + a flush white/black mask of its logo —
// so every tile is consistently a flush colored badge (the raw SVGs mix full-bleed badges with bare
// floating marks, which is the inconsistency we're normalizing away). ink = mark color (black on light bgs).
// [slug, tile brand color, ink] — ink 'w' = white mark, 'b' = black mark (for light-colored tiles).
// Order is tuned for a balanced wall — the few monochrome-brand chains (Aptos, XRP, Stellar, Linea,
// World Chain, Algorand) carry a refined dark tile and are spread out so no row reads as "dark".
const CHAINS = [
  ['ethereum',   '#627EEA', 'w'],
  ['base',       '#0052FF', 'w'],
  ['solana',     '#9945FF', 'w'],
  ['aptos',      '#1B1F2A', 'w'],
  ['avalanche',  '#E84142', 'w'],
  ['polygon',    '#7B3FE4', 'w'],
  ['xrpl',       '#23292F', 'w'],
  ['sui',        '#4DA2FF', 'w'],
  ['arbitrum',   '#2D81F7', 'w'],
  ['near',       '#00EC97', 'b'],
  ['stellar',    '#11202E', 'w'],
  ['optimism',   '#FF0420', 'w'],
  ['celo',       '#FCFF52', 'b'],
  ['linea',      '#1A1A17', 'w'],
  ['zksync',     '#1E69FF', 'w'],
  ['unichain',   '#F50DB4', 'w'],
  ['worldchain', '#15181D', 'w'],
  ['sei',        '#C8202B', 'w'],
  ['injective',  '#4D3DFF', 'w'],
  ['algorand',   '#1C1C1E', 'w'],
  ['sonic',      '#FE9A4D', 'b'],
  ['hyperevm',   '#50D2C1', 'b'],
  ['monad',      '#836EF9', 'w'],
]
// Strip any full-bleed background square so only the mark remains; the mark is rendered as an <img>
// and recolored flush (white/black) via filter on the brand-color tile — uniform across all 23.
const stripBg = (svg) => svg
  .replace(/<path[^>]*\sd="M24 0H0v24h24z"[^>]*\/>/g, '')
  .replace(/<path[^>]*\sd="M0 0h146v146H0z"[^>]*\/>/g, '')
const tiles = CHAINS.map(([c, bg, ink]) => {
  const svg = stripBg(readFileSync(resolve(REPO, `site/public/chains/${c}.svg`), 'utf8'))
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return `<div class="tile" style="background:${bg}"><img class="mark ink-${ink}" src="${src}" alt="${c}"></div>`
}).join('\n      ')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:60px 64px; }
  .glow { position:absolute; left:50%; top:30%; transform:translate(-50%,-50%); width:1040px; height:820px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.045) 44%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:28px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:13px; }
  .brand img { width:46px; height:46px; }
  .brand .wm { font-family:'Space Grotesk',sans-serif; font-size:27px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:17px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:8px 18px; border-radius:999px; letter-spacing:0.04em; }

  .hero { position:relative; z-index:2; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:30px; }

  /* USDC mark with a quiet emerald halo */
  .coin { position:relative; display:flex; align-items:center; justify-content:center; }
  .coin::before { content:''; position:absolute; width:230px; height:230px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.28) 0%, rgba(46,230,166,0) 68%); }
  .coin img { width:128px; height:128px; position:relative; filter:drop-shadow(0 10px 30px rgba(0,0,0,0.55)); }

  .head { text-align:center; }
  .head h1 { font-family:'Space Grotesk',sans-serif; font-size:78px; font-weight:700; letter-spacing:-0.035em; line-height:1.0; }
  .head h1 b { color:var(--accent); }
  .head p { margin:20px auto 0; max-width:760px; font-size:25px; line-height:1.5; color:#c4c8ce; font-weight:400; }
  .head p b { color:#fff; font-weight:600; }

  /* The 23-chain grid — the "loads of chains" centerpiece. Every tile a flush brand-color badge. */
  .grid { display:flex; flex-wrap:wrap; justify-content:center; gap:14px; max-width:830px; }
  .tile { width:88px; height:88px; border-radius:21px; display:flex; align-items:center; justify-content:center;
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.07), 0 6px 16px rgba(0,0,0,0.45); }
  .mark { width:52px; height:52px; object-fit:contain; display:block; }
  .ink-w { filter:brightness(0) invert(1); }
  .ink-b { filter:brightness(0); }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:19px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>

  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">native USDC · x402</div>
  </header>

  <div class="hero">
    <div class="coin"><img src="${usdc}" alt="USDC"></div>
    <div class="head">
      <h1>Native USDC.<br><b>23 chains.</b></h1>
      <p>Your AI agent pays <b>Circle-issued USDC</b> across 23 networks — one <b>chain:</b> parameter, no backend, no fee.</p>
    </div>
    <div class="grid">
      ${tiles}
    </div>
  </div>

  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk</span></footer>
</body></html>`

const out = resolve(__dirname, 'usdc-everywhere.png')
writeFileSync(resolve(__dirname, 'usdc-everywhere.html'), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
