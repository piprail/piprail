// Build the two LinkedIn Company Page profile assets.
//
//   node render-linkedin.mjs          # cover + logo
//   node render-linkedin.mjs cover    # just the cover
//   node render-linkedin.mjs logo     # just the logo
//
// COVER  linkedin-cover-2256x384.png   Page -> Edit page -> Cover image
// LOGO   linkedin-logo-400x400.png     Page -> Edit page -> Logo
//
// 🔴 WHERE LINKEDIN'S OWN NUMBERS DISAGREE, BUILD THE LARGER. Its upload form
// says 300x300 for a logo and its help pages say 400x400; downscaling is
// lossless and upscaling never is, so we ship 400. The cover is 2x LinkedIn's
// 1128x191 slot for the same reason.
//
// Both outputs are PUBLISHED deliverables, not throwaway renders: this folder is
// allowlisted in the repo .gitignore (`!…/social/profile/*.png`) exactly like the
// X header and the GitHub social card, so what was uploaded stays recoverable
// rather than merely regenerable. Commit them; re-run this to change them.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = import.meta.dirname
const REPO = resolve(HERE, '../../../../../..')
const what = process.argv[2] ?? 'all'

/* ── the logo: a straight resize of the master, no browser needed ───────── */
if (what === 'all' || what === 'logo') {
  const src = resolve(HERE, '../../source/logo-512.png')
  const out = resolve(HERE, 'linkedin-logo-400x400.png')
  if (!existsSync(src)) {
    console.error(`Missing master ${src}`)
    process.exit(1)
  }
  /* `sips` is macOS-native and already the tool design/SKILL.md uses for the
     favicon set, so the logo pipeline stays one command everywhere. */
  execFileSync('sips', ['-s', 'format', 'png', '-z', '400', '400', src, '--out', out], {
    stdio: 'ignore',
  })
  console.log(`✓ ${out}`)
}

/* ── the cover: Chromium screenshot of the template ─────────────────────── */
if (what === 'all' || what === 'cover') {
  const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/')
  const { chromium } = require('playwright-core')
  // Auto-detect the installed build; the version bumps on every
  // `playwright install` and a hardcoded path breaks silently.
  const PW = process.env.HOME + '/Library/Caches/ms-playwright'
  const build = existsSync(PW)
    ? readdirSync(PW)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => +a.slice(9) - +b.slice(9))
        .pop()
    : null
  if (!build) {
    console.error(`No Playwright Chromium under ${PW} — run \`npx playwright install chromium\`.`)
    process.exit(1)
  }
  const BIN = `${PW}/${build}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

  const src = resolve(HERE, 'linkedin-cover.html')
  const out = resolve(HERE, 'linkedin-cover-2256x384.png')
  const browser = await chromium.launch({
    executablePath: BIN,
    headless: true,
    args: ['--force-color-profile=srgb', '--allow-file-access-from-files'],
  })
  const page = await browser.newPage({
    viewport: { width: 2256, height: 384 },
    deviceScaleFactor: 1,
  })
  await page.goto(pathToFileURL(src).href, { waitUntil: 'load' })
  /* Wait for the webfonts, or the headline renders in the fallback and the
     letter-spacing is visibly wrong. */
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.screenshot({ path: out })
  await browser.close()
  console.log(`✓ ${out}`)
  console.log(`  repo: ${resolve(out).replace(REPO + '/', '')}`)
}
