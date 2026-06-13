#!/usr/bin/env node
// Build the deck's raster assets:
//   1. emerald-glow slide backgrounds (HTML -> Chromium screenshot, 1920x1080 @2x)
//   2. chain + token logos rasterized from the canonical site SVGs (sharp)
//   3. the PipRail marks copied in
// All outputs land in ./assets/{bg,logos} and are RENDER (gitignored, regenerable).
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../../..') // -> /Users/john/Sites/piprail
const OUT_BG = join(__dirname, 'assets/bg')
const OUT_LOGO = join(__dirname, 'assets/logos')
const OUT_FONT = join(__dirname, 'assets/fonts')
mkdirSync(OUT_BG, { recursive: true })
mkdirSync(OUT_LOGO, { recursive: true })
mkdirSync(OUT_FONT, { recursive: true })

// --- 0. brand fonts (static TTFs, for embedding) — download any that are missing ---
// @expo-google-fonts static instances; internal family names verified by inspect-fonts.mjs.
const FONT_URLS = {
  'SpaceGrotesk-Medium.ttf': 'space-grotesk/SpaceGrotesk_500Medium.ttf',
  'SpaceGrotesk-SemiBold.ttf': 'space-grotesk/SpaceGrotesk_600SemiBold.ttf',
  'SpaceGrotesk-Bold.ttf': 'space-grotesk/SpaceGrotesk_700Bold.ttf',
  'Inter-Regular.ttf': 'inter/Inter_400Regular.ttf',
  'Inter-Medium.ttf': 'inter/Inter_500Medium.ttf',
  'Inter-SemiBold.ttf': 'inter/Inter_600SemiBold.ttf',
  'JetBrainsMono-Regular.ttf': 'jetbrains-mono/JetBrainsMono_400Regular.ttf',
  'JetBrainsMono-Medium.ttf': 'jetbrains-mono/JetBrainsMono_500Medium.ttf',
}
async function fetchFonts() {
  const base = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts'
  for (const [file, path] of Object.entries(FONT_URLS)) {
    const out = join(OUT_FONT, file)
    if (existsSync(out)) continue
    const r = await fetch(`${base}/${path}`)
    if (!r.ok) throw new Error(`font fetch failed ${file}: ${r.status}`)
    writeFileSync(out, Buffer.from(await r.arrayBuffer()))
    console.log('font', file)
  }
}

// --- resolve the shared tooling the brand pipeline already uses ---------------
const reqRepo = createRequire(join(REPO, 'site/'))      // sharp is hoisted here
const sharp = reqRepo('sharp')
const reqTools = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = reqTools('playwright-core')

// find an installed Chromium for Testing
function chromeBin() {
  const base = process.env.HOME + '/Library/Caches/ms-playwright'
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const d of dirs) {
    const p = join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (existsSync(p)) return p
  }
  throw new Error('no Chromium for Testing found')
}

// --- 1. backgrounds -----------------------------------------------------------
// Brand: near-black #0a0b0c, emerald #2ee6a6 ("paid"), a whisper of blue (hero only),
// faint emerald particles + a hairline dot-grid. Contrast-not-glow: a whisper, never a strobe.
const bgHtml = (variant) => {
  const orbs = {
    hero: `
      <div class="orb" style="left:50%;top:88%;width:1500px;height:1100px;background:radial-gradient(closest-side, rgba(46,230,166,.20), rgba(46,230,166,0) 70%)"></div>
      <div class="orb" style="left:16%;top:6%;width:900px;height:900px;background:radial-gradient(closest-side, rgba(74,124,240,.12), rgba(74,124,240,0) 70%)"></div>`,
    a: `
      <div class="orb" style="left:88%;top:0%;width:1100px;height:1000px;background:radial-gradient(closest-side, rgba(46,230,166,.17), rgba(46,230,166,0) 70%)"></div>
      <div class="orb" style="left:4%;top:104%;width:760px;height:760px;background:radial-gradient(closest-side, rgba(74,124,240,.07), rgba(74,124,240,0) 70%)"></div>`,
    b: `
      <div class="orb" style="left:8%;top:100%;width:1100px;height:1000px;background:radial-gradient(closest-side, rgba(46,230,166,.17), rgba(46,230,166,0) 70%)"></div>
      <div class="orb" style="left:98%;top:2%;width:760px;height:760px;background:radial-gradient(closest-side, rgba(74,124,240,.07), rgba(74,124,240,0) 70%)"></div>`,
    plain: `
      <div class="orb" style="left:100%;top:108%;width:1000px;height:900px;background:radial-gradient(closest-side, rgba(46,230,166,.11), rgba(46,230,166,0) 70%)"></div>`,
    close: `
      <div class="orb" style="left:50%;top:64%;width:1700px;height:1300px;background:radial-gradient(closest-side, rgba(46,230,166,.22), rgba(46,230,166,0) 70%)"></div>
      <div class="orb" style="left:50%;top:2%;width:1100px;height:800px;background:radial-gradient(closest-side, rgba(74,124,240,.09), rgba(74,124,240,0) 70%)"></div>`,
  }[variant]
  // a few faint particles, deterministic positions
  const pts = [[14,28],[27,71],[41,18],[63,82],[78,33],[86,67],[33,46],[71,12],[9,84],[92,22],[52,8],[58,58]]
  const particles = pts.map(([x, y], i) => `<div class="pt" style="left:${x}%;top:${y}%;opacity:${0.10 + (i % 4) * 0.05}"></div>`).join('')
  return `<!doctype html><html><head><meta charset="utf8"><style>
    *{margin:0;box-sizing:border-box}
    html,body{width:1920px;height:1080px}
    body{background:#0a0b0c;position:relative;overflow:hidden}
    .orb{position:absolute;transform:translate(-50%,-50%);filter:blur(40px)}
    .grid{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.045) 1px, transparent 1.4px);background-size:46px 46px;
          -webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 45%, #000 30%, transparent 78%)}
    .pt{position:absolute;width:4px;height:4px;border-radius:50%;background:#5ee6a8;filter:blur(.4px);box-shadow:0 0 10px 2px rgba(94,230,168,.5)}
    .vig{position:absolute;inset:0;background:radial-gradient(ellipse 120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,.45) 100%)}
  </style></head><body>
    <div class="grid"></div>
    ${orbs}
    ${particles}
    <div class="vig"></div>
  </body></html>`
}

// --- 2. logos -----------------------------------------------------------------
async function rasterizeSvgDir(srcDir, prefix = '') {
  if (!existsSync(srcDir)) return []
  const done = []
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.svg'))) {
    const slug = f.replace(/\.svg$/, '')
    const out = join(OUT_LOGO, `${prefix}${slug}.png`)
    let svg = readFileSync(join(srcDir, f), 'utf8')
    // currentColor -> emerald-tinted white so monochrome marks stay visible on black
    svg = svg.replace(/currentColor/g, '#e9edf0')
    try {
      await sharp(Buffer.from(svg), { density: 384 })
        .resize(220, 220, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toFile(out)
      done.push(slug)
    } catch (e) { console.warn('  logo FAIL', slug, e.message) }
  }
  return done
}

// --- run ----------------------------------------------------------------------
await fetchFonts()
const browser = await chromium.launch({ executablePath: chromeBin(), headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
for (const v of ['hero', 'a', 'b', 'plain', 'close']) {
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(bgHtml(v)), { waitUntil: 'load' })
  await page.waitForTimeout(120)
  await page.screenshot({ path: join(OUT_BG, `bg-${v}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } })
  console.log('bg  bg-' + v + '.png')
}
await browser.close()

const chainsDone = await rasterizeSvgDir(join(REPO, 'site/public/chains'))
const tokensDone = await rasterizeSvgDir(join(REPO, 'site/public/tokens'), 'token-')
console.log(`logos: ${chainsDone.length} chains, ${tokensDone.length} tokens`)

// PipRail marks
for (const name of ['logo.png', 'logo-no-background.png']) {
  const src = join(REPO, 'site/public', name)
  if (existsSync(src)) { copyFileSync(src, join(OUT_LOGO, name)); console.log('mark', name) }
}
console.log('done.')
