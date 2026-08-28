// Render one social post-card to a PNG.
//
//   node render.mjs <name>          # -> post-<name>.png  (1080×1080 @2×)
//
// Looks for the template next to this script: `card-<name>.html` (assets.js-bundle
// cards) or `post-<name>.html` (standalone cards). Output `post-<name>.png` is a
// regenerable render — gitignored. The `card-*.html` cards embed logos from the shared
// bundle `../../video/assets.js`, so run `node ../../video/genassets.mjs` once first.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
// Auto-detect the installed Playwright Chromium build (don't hardcode a version —
// it bumps on every `playwright install` and breaks this script).
const PW = process.env.HOME + '/Library/Caches/ms-playwright'
const build = existsSync(PW)
  ? readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +a.slice(9) - +b.slice(9)).pop()
  : null
if (!build) {
  console.error(`No Playwright Chromium under ${PW} — run \`npx playwright install chromium\`.`)
  process.exit(1)
}
const BIN = `${PW}/${build}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

const name = process.argv[2]
if (!name) {
  console.error('Usage: node render.mjs <name>   (e.g. base, ai, near, plan)')
  process.exit(1)
}
const src = ['card-' + name + '.html', 'post-' + name + '.html', name + '.html']
  .map((f) => resolve(HERE, f))
  .find(existsSync)
if (!src) {
  console.error(`No template for "${name}" — expected card-${name}.html or post-${name}.html here.`)
  process.exit(1)
}
const out = resolve(HERE, 'post-' + name + '.png')

const browser = await chromium.launch({ executablePath: BIN, headless: true, args: ['--force-color-profile=srgb'] })
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 })
await page.goto(pathToFileURL(src).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready).catch(() => {})
await page.waitForTimeout(400)
await page.screenshot({ path: out })
await browser.close()
console.log('rendered', out.replace(HERE + '/', ''))
