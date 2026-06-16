#!/usr/bin/env node
// Square (1080×1080) reply image — same content as render-reply.mjs, 1:1 for feeds that
// favour square cards. A code window showing the actual integration for one chain.
//   node render-reply-square.mjs arbitrum  ->  ./reply-<chain>-square.png  (1080×1080)
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
const LOGO = resolve(REPO, 'site/public/logo-no-background.png')

// name · coin · stable (built-in stablecoins). Mirrors render-reply.mjs.
const CHAINS = {
  ton:{name:'TON',coin:'TON',stable:'USD₮'}, solana:{name:'Solana',coin:'SOL',stable:'USDC · USDT'},
  base:{name:'Base',coin:'ETH',stable:'USDC'}, ethereum:{name:'Ethereum',coin:'ETH',stable:'USDC · USDT'},
  tron:{name:'Tron',coin:'TRX',stable:'USD₮'}, bnb:{name:'BNB Chain',coin:'BNB',stable:'USDC · USDT'},
  polygon:{name:'Polygon',coin:'POL',stable:'USDC · USDT'}, arbitrum:{name:'Arbitrum',coin:'ETH',stable:'USDC · USDT'},
  avalanche:{name:'Avalanche',coin:'AVAX',stable:'USDC · USDT'}, optimism:{name:'Optimism',coin:'ETH',stable:'USDC · USDT'},
  sui:{name:'Sui',coin:'SUI',stable:'USDC'}, aptos:{name:'Aptos',coin:'APT',stable:'USDC · USDT'},
  near:{name:'NEAR',coin:'NEAR',stable:'USDC · USDT'}, xrpl:{name:'XRP Ledger',coin:'XRP',stable:'USDC · RLUSD'},
  stellar:{name:'Stellar',coin:'XLM',stable:'USDC · EURC'}, algorand:{name:'Algorand',coin:'ALGO',stable:'USDC'},
  celo:{name:'Celo',coin:'CELO',stable:'USDC · USDT'}, mantle:{name:'Mantle',coin:'MNT',stable:'USDC · USDT'},
  sonic:{name:'Sonic',coin:'S',stable:'USDC · USDT'}, linea:{name:'Linea',coin:'ETH',stable:'USDC · USDT'},
  scroll:{name:'Scroll',coin:'ETH',stable:'USDC · USDT'}, zksync:{name:'zkSync',coin:'ETH',stable:'USDC · USDT'},
  unichain:{name:'Unichain',coin:'ETH',stable:'USDC · USDT'}, worldchain:{name:'World Chain',coin:'ETH',stable:'USDC'},
  sei:{name:'Sei',coin:'SEI',stable:'USDC'}, injective:{name:'Injective',coin:'INJ',stable:'USDC · USDT'},
  hyperevm:{name:'HyperEVM',coin:'HYPE',stable:'USDC'}, monad:{name:'Monad',coin:'MON',stable:'USDC'},
  kaia:{name:'Kaia',coin:'KAIA',stable:'USD₮'},
}
const FULL_BLEED = new Set(['arbitrum','avalanche','base','bnb','celo','ethereum','linea','mantle',
  'optimism','polygon','scroll','solana','sonic','ton','unichain','worldchain','zksync'])

const key = process.argv[2]
if (!key || !CHAINS[key]) {
  console.error(`Usage: node render-reply-square.mjs <chain>\nKnown: ${Object.keys(CHAINS).join(', ')}`)
  process.exit(1)
}
const c = CHAINS[key]
const assets = `${c.coin} / ${c.stable.replace(/ · /g, ' / ')}`
const coinClass = FULL_BLEED.has(key) ? 'fill' : 'pad'
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const chainLogo = b64(resolve(CHAINS_DIR, `${key}.svg`), 'image/svg+xml')
const piprailLogo = b64(LOGO, 'image/png')

const code = `<span class="kw">import</span> { PipRailClient } <span class="kw">from</span> <span class="str">'@piprail/sdk'</span>

<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">PipRailClient</span>({
  chain: <span class="chain">'${key}'</span>,<span class="com">  // ← name the chain</span>
  wallet: { privateKey },
})

<span class="com">// On a 402: pays in ${assets},</span>
<span class="com">// then retries — no backend, no fee.</span>
<span class="kw">const</span> res = <span class="kw">await</span> client.<span class="fn">fetch</span>(url)`

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --accent:#2ee6a6; --muted:#8a8f98; }
  html,body { width:1080px; height:1080px; }
  body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
    display:flex; flex-direction:column; justify-content:space-between; padding:60px 64px; }
  .glow { position:absolute; left:50%; top:46%; transform:translate(-50%,-50%); width:1000px; height:900px;
    border-radius:50%; background:radial-gradient(circle, rgba(46,230,166,0.15) 0%, rgba(46,230,166,0.045) 38%, rgba(0,0,0,0) 70%); }
  .frame { position:absolute; inset:26px; border:1px solid rgba(255,255,255,0.07); border-radius:24px; }

  header { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2; }
  .brand { display:flex; align-items:center; gap:15px; }
  .brand img { width:54px; height:54px; }
  .brand .wm { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:30px; font-weight:700; letter-spacing:-0.02em; }
  .pill { font-family:'JetBrains Mono',monospace; font-size:19px; font-weight:600; color:var(--accent);
    border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 20px; border-radius:999px; letter-spacing:0.04em; }

  .hero { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:36px; }
  .badge { display:flex; flex-direction:column; align-items:center; gap:22px; }
  .coin { width:108px; height:108px; border-radius:50%; overflow:hidden; display:flex; align-items:center; justify-content:center;
    background:#0c0c0e; border:1px solid rgba(255,255,255,0.10); box-shadow:0 0 52px rgba(46,230,166,0.20), inset 0 1px 0 rgba(255,255,255,0.07); }
  .coin.fill img { width:100%; height:100%; object-fit:cover; }
  .coin.pad img  { width:58%; height:58%; object-fit:contain; }
  .badge h1 { font-family:'Space Grotesk','Inter',system-ui,sans-serif; font-size:50px; font-weight:700; letter-spacing:-0.03em; text-align:center; line-height:1.08; }
  .badge h1 b { color:var(--accent); }

  .win { width:100%; border-radius:16px; overflow:hidden; border:1px solid rgba(255,255,255,0.10);
    background:#0c0e11; box-shadow:0 30px 80px rgba(0,0,0,0.6); }
  .win .bar { display:flex; align-items:center; gap:9px; padding:15px 20px; border-bottom:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.02); }
  .win .bar i { width:13px; height:13px; border-radius:50%; display:block; }
  .win .bar .r{background:#ff5f57}.win .bar .y{background:#febc2e}.win .bar .g{background:#28c840}
  .win .bar span { margin-left:14px; font-family:'JetBrains Mono',monospace; font-size:17px; color:var(--muted); }
  .win pre { margin:0; padding:30px 36px; font-family:'JetBrains Mono',monospace; font-size:25px; line-height:1.5;
    color:#e7eaee; white-space:pre; }
  .kw{color:oklch(0.62 0.01 260)} .str{color:oklch(0.84 0.13 162)} .fn{color:oklch(0.8 0.11 235)}
  .chain{color:oklch(0.85 0.14 85);font-weight:600} .com{color:oklch(0.55 0.01 260);font-style:italic}

  footer { display:flex; align-items:center; justify-content:space-between; position:relative; z-index:2;
    font-family:'JetBrains Mono',monospace; font-size:21px; color:var(--muted); }
  footer .site { color:#fff; font-weight:600; }
</style></head>
<body>
  <div class="glow"></div><div class="frame"></div>
  <header>
    <div class="brand"><img src="${piprailLogo}"><span class="wm">PipRail</span></div>
    <div class="pill">x402 · agent payments</div>
  </header>
  <div class="hero">
    <div class="badge">
      <div class="coin ${coinClass}"><img src="${chainLogo}"></div>
      <h1>Your agent pays<br>x402 on <b>${c.name}</b></h1>
    </div>
    <div class="win">
      <div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i><span>pay.ts</span></div>
      <pre>${code}</pre>
    </div>
  </div>
  <footer><span class="site">piprail.com</span><span>npm i @piprail/sdk</span></footer>
</body></html>`

const out = resolve(__dirname, `reply-${key}-square.png`)
writeFileSync(resolve(__dirname, `reply-${key}-square.html`), html)
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1080 } })
await browser.close()
console.log(`Rendered ${out}`)
