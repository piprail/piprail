#!/usr/bin/env node
// X (Twitter) Article assets for "Give your agent a wallet".
// Renders: a 5:2 cover (1500×600, X's recommended article header ratio) + the
// code snippets as on-brand code cards (X Articles can't render code blocks, so
// the code ships as images you Insert inline).
// Brand-pure: true-black bg, single emerald accent (#2ee6a6), Space Grotesk /
// Inter / JetBrains Mono. Output -> ./out/*.png
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire('/Users/john/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../../..')
const OUT = resolve(__dirname, 'out')
mkdirSync(OUT, { recursive: true })

const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`
const logo = b64(resolve(REPO, 'site/public/logo-no-background.png'), 'image/png')

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');`

// ---- tiny, brand-safe syntax highlighter (emerald = the only saturated color) ----
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function hlPlain(s) {
  return s
    .replace(/\b(import|from|export|const|let|await|async|new|return|if)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="nu">$1</span>')
}
function highlight(code) {
  // protect strings + comments in one left-to-right pass; a string directly
  // before a ':' is an object key (neutral), otherwise it's a value (emerald).
  const re = /(\/\/[^\n]*)|((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?=\s*:))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g
  let out = '', last = 0, m
  while ((m = re.exec(code))) {
    out += hlPlain(esc(code.slice(last, m.index)))
    if (m[1]) out += `<span class="cm">${esc(m[1])}</span>`
    else if (m[2]) out += `<span class="ky">${esc(m[2])}</span>`
    else out += `<span class="st">${esc(m[3])}</span>`
    last = m.index + m[0].length
  }
  out += hlPlain(esc(code.slice(last)))
  return out
}

// ---------------------------- the code cards ----------------------------
const cards = [
  {
    name: 'card-1-pay', file: 'pay.ts', cap: 'Pay any 402 URL — within a policy it can’t cross',
    code: `import { PipRailClient } from '@piprail/sdk'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.WALLET_KEY },
  policy: { maxAmount: '0.10', maxTotal: '5.00' }, // caps it can't cross
})

// If this URL 402s, PipRail pays within policy and returns the 200.
const res = await client.fetch('https://api.example.com/premium')
const data = await res.json()`,
  },
  {
    name: 'card-2-policy', file: 'policy.ts', cap: 'The spend policy — a hard wall, checked before any send',
    code: `const client = new PipRailClient({
  chain: 'base',
  wallet: { key },
  policy: {
    maxAmount: '0.10',                        // ceiling for any single payment
    maxTotal: '20.00',                        // lifetime cap, per network + asset
    maxPayments: 200,                         // lifetime number of payments
    tokens: ['USDC'],                         // only ever pay in these
    hosts: ['api.example.com', '*.data.dev'], // only ever pay these hosts
    windowTotal: '1.00',                      // ...and no more than $1
    windowSeconds: 60,                        // ...in any 60-second window
  },
})`,
  },
  {
    name: 'card-3-plan', file: 'plan.ts', cap: 'Look before you pay — read-only, never throws',
    code: `// Look before you leap — all read-only, none of them ever throw:
const quote = await client.quote(url)        // the price, if it's gated
const cost  = await client.estimateCost(url) // + a gas estimate, native coin
const plan  = await client.planPayment(url)  // can I settle it, which rail?

if (plan?.payable) {
  await client.fetch(url)                     // ...only then pay
}`,
  },
  {
    name: 'card-4-server', file: 'server.ts', cap: 'Charge for your own API — one line, paid to your wallet',
    code: `import { requirePayment } from '@piprail/sdk'

app.get('/premium', requirePayment({
  chain: 'base',
  token: 'USDC',
  amount: '0.01',
  payTo: '0xYourWallet...',
}), (req, res) => res.json({ premium: 'data' }))`,
  },
  {
    name: 'card-5-mcp', file: 'mcp.json', cap: 'No code — hand any MCP agent a budget-bound wallet',
    code: `{
  "mcpServers": {
    "piprail": {
      "command": "npx",
      "args": ["-y", "@piprail/mcp"],
      "env": {
        "PIPRAIL_PRIVATE_KEY": "0x...",
        "PIPRAIL_CHAIN": "base",
        "PIPRAIL_MAX_TOTAL": "10.00"
      }
    }
  }
}`,
  },
]

const codeCardHtml = (c) => `<!doctype html><html><head><meta charset="utf-8"><style>
${FONTS}
* { margin:0; padding:0; box-sizing:border-box; }
:root { --accent:#2ee6a6; }
body { background:#000; font-family:'Inter',sans-serif; padding:46px; width:1600px; }
.card { position:relative; background:#0a0b0c; border:1px solid rgba(255,255,255,0.09);
  border-radius:20px; overflow:hidden; box-shadow:0 30px 70px -30px rgba(0,0,0,0.9); }
.glow { position:absolute; right:-160px; top:-200px; width:620px; height:560px; border-radius:50%;
  background:radial-gradient(circle, rgba(46,230,166,0.13) 0%, rgba(46,230,166,0.03) 50%, rgba(0,0,0,0) 72%); }
.bar { position:relative; display:flex; align-items:center; justify-content:space-between;
  padding:20px 26px; border-bottom:1px solid rgba(255,255,255,0.07); }
.bar .left { display:flex; align-items:center; gap:14px; }
.dots { display:flex; gap:8px; }
.dots i { width:12px; height:12px; border-radius:50%; background:rgba(255,255,255,0.14); }
.dots i:first-child { background:rgba(46,230,166,0.55); }
.file { font-family:'JetBrains Mono',monospace; font-size:21px; color:#9aa4b2; font-weight:500; }
.brand { display:flex; align-items:center; gap:9px; opacity:0.92; }
.brand img { width:24px; height:24px; }
.brand span { font-family:'Space Grotesk',sans-serif; font-size:19px; font-weight:600; color:#cfd6dd; letter-spacing:-0.01em; }
pre { position:relative; padding:30px 36px 34px; font-family:'JetBrains Mono',monospace;
  font-size:24px; line-height:1.74; color:#c9d1d9; white-space:pre; tab-size:2; }
.kw { color:#9aa4b2; } .st { color:var(--accent); } .ky { color:#e7eaee; }
.cm { color:#5f6b76; font-style:italic; } .nu { color:#7ee0c0; }
</style></head><body>
  <div class="card">
    <div class="glow"></div>
    <div class="bar">
      <div class="left"><div class="dots"><i></i><i></i><i></i></div><span class="file">${c.file}</span></div>
      <div class="brand"><img src="${logo}"><span>PipRail</span></div>
    </div>
    <pre>${highlight(c.code)}</pre>
  </div>
</body></html>`

// ------------------------------ the 5:2 cover ------------------------------
const W = 1500, H = 600
const chips = ['29 chains', '0% fee', 'no backend', 'self-custody', 'MIT']
const coverHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
${FONTS}
* { margin:0; padding:0; box-sizing:border-box; }
:root { --accent:#2ee6a6; --muted:#8a8f98; }
html,body { width:${W}px; height:${H}px; }
body { background:#000; color:#fff; font-family:'Inter',sans-serif; position:relative; overflow:hidden;
  display:flex; flex-direction:column; padding:56px 66px 46px; }
.glow { position:absolute; right:-240px; top:-260px; width:980px; height:820px; border-radius:50%;
  background:radial-gradient(circle, rgba(46,230,166,0.18) 0%, rgba(46,230,166,0.045) 46%, rgba(0,0,0,0) 70%); }
.frame { position:absolute; inset:22px; border:1px solid rgba(255,255,255,0.07); border-radius:26px; }
body > * { position:relative; z-index:2; }
header { display:flex; align-items:center; justify-content:space-between; }
.brand { display:flex; align-items:center; gap:14px; }
.brand img { width:46px; height:46px; }
.brand .wm { font-family:'Space Grotesk',sans-serif; font-size:30px; font-weight:700; letter-spacing:-0.02em; }
.pill { font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:600; color:var(--accent);
  border:1px solid rgba(46,230,166,0.4); background:rgba(46,230,166,0.07); padding:9px 18px; border-radius:999px;
  letter-spacing:0.03em; display:flex; align-items:center; gap:10px; }
.pill i { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 12px var(--accent); }
.body { margin-top:auto; margin-bottom:auto; }
.eyebrow { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:500; letter-spacing:5px;
  text-transform:uppercase; color:#6b727b; }
h1 { font-family:'Space Grotesk',sans-serif; font-size:92px; font-weight:700; letter-spacing:-0.035em;
  line-height:0.98; margin-top:14px; }
h1 b { color:var(--accent); }
.sub { margin-top:22px; font-size:25px; line-height:1.4; color:#b9bec4; max-width:1020px; }
.sub b { color:#fff; font-weight:600; }
.mono { font-family:'JetBrains Mono',monospace; color:#e7eaee; }
.chips { margin-top:30px; display:flex; flex-wrap:wrap; gap:11px; }
.chip { display:flex; align-items:center; gap:8px; font-family:'JetBrains Mono',monospace; font-size:17px; font-weight:600;
  color:var(--accent); border:1px solid rgba(46,230,166,0.3); background:rgba(46,230,166,0.07); padding:9px 16px; border-radius:999px; }
.chip i { width:7px; height:7px; border-radius:50%; background:var(--accent); }
footer { display:flex; align-items:center; justify-content:space-between; margin-top:18px;
  font-family:'JetBrains Mono',monospace; font-size:18px; color:var(--muted);
  border-top:1px solid rgba(255,255,255,0.06); padding-top:16px; }
footer .by b { color:#e7eaee; font-weight:700; }
footer .site { color:var(--accent); font-weight:700; }
</style></head><body>
  <div class="glow"></div><div class="frame"></div>
  <header>
    <div class="brand"><img src="${logo}"><span class="wm">PipRail</span></div>
    <div class="pill"><i></i>x402 · self-custody · 0% fee</div>
  </header>
  <div class="body">
    <div class="eyebrow">x402 for AI agents</div>
    <h1>Give your agent a <b>wallet.</b></h1>
    <div class="sub">An agent can call any API — until one costs money. Then it stops. PipRail is the <span class="mono">fetch()</span> for <b>“pay two cents and keep going”</b> — with a wall the agent can’t climb over.</div>
    <div class="chips">${chips.map((c) => `<span class="chip"><i></i>${c}</span>`).join('')}</div>
  </div>
  <footer>
    <span class="by">by <b>John Weeks</b> · founder, PipRail</span>
    <span class="site">piprail.com/blog</span>
  </footer>
</body></html>`

// --------------------------------- render ---------------------------------
const browser = await chromium.launch({ executablePath: CHROME_BIN, headless: true })

// cover (fixed 5:2 viewport)
{
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
  await page.setContent(coverHtml, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const out = resolve(OUT, 'cover-5x2.png')
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } })
  await page.close()
  console.log(`✓ ${out}`)
}

// code cards (tight-crop the .card element so height fits the code)
for (const c of cards) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  await page.setContent(codeCardHtml(c), { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  const el = await page.$('.card')
  const out = resolve(OUT, `${c.name}.png`)
  await el.screenshot({ path: out })
  await page.close()
  console.log(`✓ ${out}  (${c.cap})`)
}

await browser.close()
console.log('\nDone. Assets in ./out/')
