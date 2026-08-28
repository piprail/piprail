// Render the spend-cap hero card to a PNG (portrait 1080×1350 @2×).
//   node render-spendcap.mjs   -> post-spendcap.png  (gitignored, regenerable)
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const HERE = import.meta.dirname
const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
const { chromium } = require('playwright-core')

// Resolve whatever chromium build is installed (the pinned path drifts on update).
const base = process.env.HOME + '/Library/Caches/ms-playwright'
const dir = readdirSync(base).find((d) => /^chromium-\d+$/.test(d))
const BIN = `${base}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

const src = resolve(HERE, 'post-spendcap.html')
const out = resolve(HERE, 'post-spendcap.png')

const browser = await chromium.launch({ executablePath: BIN, headless: true, args: ['--force-color-profile=srgb'] })
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 })
await page.goto(pathToFileURL(src).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready).catch(() => {})
await page.waitForTimeout(500)
await page.screenshot({ path: out })
await browser.close()
console.log('rendered', out.replace(HERE + '/', ''))
