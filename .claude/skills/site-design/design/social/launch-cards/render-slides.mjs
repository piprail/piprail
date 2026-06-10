// Render the comparison deck `compare-402.html` to six slide PNGs (_cmp1..6.png,
// 1920×1080 @2×). Each slide is selected by the `?slide=N` query param. Outputs are
// regenerable renders next to this script — gitignored.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')
const BIN = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const SRC = resolve(HERE, 'compare-402.html')

const browser = await chromium.launch({ executablePath: BIN, headless: true, args: ['--force-color-profile=srgb'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
for (const n of [1, 2, 3, 4, 5, 6]) {
  await page.goto(pathToFileURL(SRC).href + '?slide=' + n, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready).catch(() => {})
  // overflow guard: report if any slide's .body content exceeds its box
  const over = await page.evaluate(() => {
    const b = document.querySelector('.slide[style*="flex"] .body') || document.querySelector('.body')
    return b ? b.scrollHeight - b.clientHeight : -1
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(HERE, `_cmp${n}.png`) })
  console.log('slide', n, 'body overflow px:', over)
}
await browser.close()
