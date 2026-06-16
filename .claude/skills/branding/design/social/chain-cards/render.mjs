#!/usr/bin/env node
// Render one campaign image: node render.mjs <chain>
// Output: ./<chain>.png (1600×900). See ../CAMPAIGN.md §1 for the spec.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..') // -> repo root
const CHAINS_DIR = resolve(REPO, 'site/public/chains')
// Transparent (no-box) PipRail mark — floats cleanly on the black canvas. See CAMPAIGN.md §5.
const LOGO = resolve(REPO, 'site/public/logo-no-background.png')

// name = display name · coin = native coin · stable = built-in stablecoins line
const CHAINS = {
  ton:        { name: 'TON',          coin: 'Toncoin (TON)', stable: 'USD₮',          note: 'the chain behind Telegram' },
  solana:     { name: 'Solana',       coin: 'SOL',           stable: 'USDC · USDT' },
  base:       { name: 'Base',         coin: 'ETH',           stable: 'USDC · EURC',
                badge: 'GASLESS · USDC + EURC · $0 GAS',
                pitch: 'Your <b>AI agent</b> pays any <b>x402</b> endpoint on <b>Base</b> — <b>gaslessly</b>. On <b>USDC</b> &amp; <b>EURC</b> it just signs: <b>zero gas, no approval</b> (EIP-3009) — pay in <b>dollars or euros</b>.<br>One <b>npm install</b> — no backend, no facilitator, no fee.' },
  ethereum:   { name: 'Ethereum',     coin: 'ETH',           stable: 'USDC · USDT' },
  tron:       { name: 'Tron',         coin: 'TRX',           stable: 'USD₮' },
  bnb:        { name: 'BNB Chain',    coin: 'BNB',           stable: 'USDC · USDT · FDUSD · USD1',
                badge: 'GASLESS · FDUSD + USD1 · $0 GAS',
                pitch: 'Your <b>AI agent</b> pays any <b>x402</b> endpoint on BNB Chain — <b>gaslessly</b>. On <b>FDUSD</b> &amp; <b>USD1</b> it just signs: <b>zero gas, no approval</b> (EIP-3009).<br>One <b>npm install</b> — no backend, no facilitator, no fee.' },
  polygon:    { name: 'Polygon',      coin: 'POL',           stable: 'USDC · USDT' },
  arbitrum:   { name: 'Arbitrum',     coin: 'ETH',           stable: 'USDC · USDT' },
  avalanche:  { name: 'Avalanche',    coin: 'AVAX',          stable: 'USDC · USDT' },
  optimism:   { name: 'Optimism',     coin: 'ETH',           stable: 'USDC · USDT' },
  sui:        { name: 'Sui',          coin: 'SUI',           stable: 'USDC' },
  aptos:      { name: 'Aptos',        coin: 'APT',           stable: 'USDC · USDT' },
  near:       { name: 'NEAR',         coin: 'NEAR',          stable: 'USDC · USDT' },
  xrpl:       { name: 'XRP Ledger',   coin: 'XRP',           stable: 'USDC · RLUSD' },
  stellar:    { name: 'Stellar',      coin: 'XLM',           stable: 'USDC · EURC' },
  algorand:   { name: 'Algorand',     coin: 'ALGO',          stable: 'USDC' },
  celo:       { name: 'Celo',         coin: 'CELO',          stable: 'USDC · USDT' },
  mantle:     { name: 'Mantle',       coin: 'MNT',           stable: 'USDC · USDT' },
  sonic:      { name: 'Sonic',        coin: 'S',             stable: 'USDC · USDT' },
  linea:      { name: 'Linea',        coin: 'ETH',           stable: 'USDC · USDT' },
  scroll:     { name: 'Scroll',       coin: 'ETH',           stable: 'USDC · USDT' },
  zksync:     { name: 'zkSync',       coin: 'ETH',           stable: 'USDC · USDT' },
  unichain:   { name: 'Unichain',     coin: 'ETH',           stable: 'USDC · USDT' },
  worldchain: { name: 'World Chain',  coin: 'ETH',           stable: 'USDC' },
  sei:        { name: 'Sei',          coin: 'SEI',           stable: 'USDC' },
  injective:  { name: 'Injective',    coin: 'INJ',           stable: 'USDC · USDT' },
  hyperevm:   { name: 'HyperEVM',     coin: 'HYPE',          stable: 'USDC' },
  monad:      { name: 'Monad',        coin: 'MON',           stable: 'USDC' },
  kaia:       { name: 'Kaia',         coin: 'KAIA',          stable: 'USD₮' },
}

// Logos that ship with their OWN full-bleed background (a colored/black square, or TON's
// circle). These FILL the coin chip (corners cropped to the circle). Everything else is a
// bare glyph on transparent → it sits centered with padding on the dark coin face.
// Source of truth: each SVG's first shape (see the classify grep in CAMPAIGN notes).
const FULL_BLEED = new Set([
  'arbitrum', 'avalanche', 'base', 'bnb', 'celo', 'ethereum', 'linea', 'mantle',
  'optimism', 'polygon', 'scroll', 'solana', 'sonic', 'ton', 'unichain', 'worldchain', 'zksync',
])

const key = process.argv[2]
if (!key || !CHAINS[key]) {
  console.error(`Usage: node render.mjs <chain>\nKnown: ${Object.keys(CHAINS).join(', ')}`)
  process.exit(1)
}
const c = CHAINS[key]
const coinClass = FULL_BLEED.has(key) ? 'fill' : 'pad'
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const chainLogo = b64(resolve(CHAINS_DIR, `${key}.svg`), 'image/svg+xml')
const piprailLogo = b64(LOGO, 'image/png')

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1600px; height:900px; }
  body {
    background:#000; color:#fff; font-family:'Inter',sans-serif;
    position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between;
    padding:64px 80px;
  }
  /* single soft emerald glow */
  .glow {
    position:absolute; left:50%; top:46%; transform:translate(-50%,-50%);
    width:1100px; height:1100px; border-radius:50%;
    background:radial-gradient(circle, rgba(46,230,166,0.16) 0%, rgba(46,230,166,0.05) 35%, rgba(0,0,0,0) 68%);
    pointer-events:none;
  }
  .frame { position:absolute; inset:28px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; pointer-events:none; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:16px; }
  .brand img { width:58px; height:58px; }
  .brand .wm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:31px; font-weight:700; letter-spacing:-0.02em; }
  .pill {
    font-family:'JetBrains Mono',monospace; font-size:21px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07);
    padding:10px 22px; border-radius:999px; letter-spacing:0.04em;
  }

  .hero { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:54px; margin-top:-8px; }
  .rail { display:flex; align-items:center; justify-content:center; gap:0; }
  .node { display:flex; align-items:center; justify-content:center; }
  /* uniform circular coin chip — every endpoint gets the same treatment */
  .coin { width:178px; height:178px; border-radius:50%; overflow:hidden;
    display:flex; align-items:center; justify-content:center; background:#0c0c0e;
    border:1px solid rgba(255,255,255,0.10);
    box-shadow:0 0 64px rgba(46,230,166,0.16), inset 0 1px 0 rgba(255,255,255,0.07); }
  .coin.fill img { width:100%; height:100%; object-fit:cover; }
  .coin.pad img  { width:58%;  height:58%;  object-fit:contain; }
  /* the PipRail (payer) coin — emerald rim marks the source of the payment */
  .coin.pip { border-color:rgba(46,230,166,0.45); box-shadow:0 0 64px rgba(46,230,166,0.30), inset 0 1px 0 rgba(255,255,255,0.07); }
  .coin.pip img { width:64%; height:64%; }
  .connector { position:relative; width:280px; height:4px; margin:0 6px;
    background:linear-gradient(90deg, rgba(46,230,166,0) 0%, rgba(46,230,166,0.9) 50%, rgba(46,230,166,0) 100%); }
  .connector::before { /* moving payment dot */
    content:''; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    width:18px; height:18px; border-radius:50%; background:var(--accent);
    box-shadow:0 0 24px 4px rgba(46,230,166,0.8); }
  .connector .tag { position:absolute; left:50%; top:-46px; transform:translateX(-50%);
    font-family:'JetBrains Mono',monospace; font-size:28px; color:var(--accent); font-weight:700; letter-spacing:0.06em;
    text-shadow:0 0 18px rgba(46,230,166,0.55); }

  .copy { text-align:center; }
  .copy h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:84px; font-weight:700; letter-spacing:-0.03em; line-height:1; }
  .copy .asset { margin-top:18px; font-family:'JetBrains Mono',monospace; font-size:24px; color:var(--accent); font-weight:600; }
  .copy .badge { display:inline-block; margin-top:20px; font-family:'JetBrains Mono',monospace;
    font-size:23px; font-weight:600; color:#001b12; background:var(--accent);
    padding:9px 22px; border-radius:999px; letter-spacing:0.02em;
    box-shadow:0 0 38px rgba(46,230,166,0.5); }
  .copy p { margin-top:26px; font-size:27px; color:#c8ccd2; font-weight:400; max-width:980px; line-height:1.4; }
  .copy p b { color:#fff; font-weight:600; }

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:23px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div>
  <div class="frame"></div>

  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>

  <div class="hero">
    <div class="rail">
      <div class="node"><div class="coin pad pip"><img src="${piprailLogo}"></div></div>
      <div class="connector"><span class="tag">x402</span></div>
      <div class="node"><div class="coin ${coinClass}"><img src="${chainLogo}"></div></div>
    </div>
    <div class="copy">
      <h1>${c.name}</h1>
      <div class="asset">${c.coin} · ${c.stable}</div>
      ${c.badge ? `<div class="badge">${c.badge}</div>` : ''}
      <p>${c.pitch || `Your <b>AI agent</b> pays any <b>x402</b> endpoint on ${c.name}.<br>One <b>npm install</b> — no backend, no facilitator, no fee.`}</p>
    </div>
  </div>

  <footer>
    <span class="site">piprail.com</span>
    <span>npm i @piprail/sdk</span>
  </footer>
</body></html>`

const out = resolve(__dirname, `${key}.png`)
writeFileSync(resolve(__dirname, `${key}.html`), html)

const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400) // let webfonts settle
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1600, height: 900 } })
await browser.close()
console.log(`Rendered ${out}`)
