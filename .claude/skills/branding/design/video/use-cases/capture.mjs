// Deterministic frame capture for the USE-CASES reel. Loads scene.html once, then for each
// frame sets the scene's master clock (window.seek) to an exact time and screenshots. No
// wall-clock, no requestAnimationFrame in capture mode -> identical output every run.
//
//   node capture.mjs sample [t...]   # spot-check frames -> sample/
//   node capture.mjs all [fps]       # render the full set -> frames/  (default 30fps, 2x)
//
// Mirrors ../capture.mjs but is SELF-LOCATING (paths resolve from this file), so the section
// is self-contained. Reuses the shared playwright-core + Chromium installed OUT of the monorepo
// at ~/.cache/piprail-video-tools/ (see ../README.md — don't install playwright in the workspace).
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.HOME + '/.cache/piprail-video-tools/');
const { chromium } = require('playwright-core');

// Find the cached "Google Chrome for Testing" binary (prefer the newest chromium-* build).
function findChrome() {
  const root = join(process.env.HOME, 'Library/Caches/ms-playwright');
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    const p = join(root, b, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('No cached Chromium for Testing found under ~/Library/Caches/ms-playwright');
}

const SCENE = pathToFileURL(join(HERE, 'scene.html')).href;
const mode = process.argv[2] || 'sample';
const args = process.argv.slice(3);

const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
// deviceScaleFactor 2 -> 3840x2160 screenshots, downscaled to 1080p at encode (supersampled) for razor-sharp text.
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(SCENE, { waitUntil: 'load' });
await page.evaluate(() => window.__ready).catch(() => {});
await page.waitForTimeout(400); // let webfonts settle

const pad = (n, w = 5) => String(n).padStart(w, '0');

if (mode === 'sample') {
  const dir = join(HERE, 'sample');
  mkdirSync(dir, { recursive: true });
  const dur = await page.evaluate(() => window.duration);
  const times = args.length ? args.map(Number) : Array.from({ length: 14 }, (_, i) => +(i * dur / 13).toFixed(2));
  for (const t of times) {
    await page.evaluate((tt) => window.seek(tt), t);
    await page.screenshot({ path: join(dir, `t_${String(t).replace('.', '_')}.png`) });
    process.stdout.write(`t=${t} `);
  }
  console.log('\nsamples ->', dir);
} else {
  const fps = Number(args[0] || 30);
  const dir = join(HERE, 'frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const total = await page.evaluate(() => window.duration);
  const N = Math.round(total * fps);
  const t0 = Date.now();
  for (let f = 0; f < N; f++) {
    await page.evaluate((tt) => window.seek(tt), f / fps);
    await page.screenshot({ path: join(dir, `frame_${pad(f)}.png`) });
    if (f % 60 === 0) { const el = (Date.now() - t0) / 1000; process.stdout.write(`\r${f}/${N} (${(f / N * 100 | 0)}%) ${el.toFixed(0)}s `); }
  }
  console.log(`\nrendered ${N} frames @ ${fps}fps in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${dir}`);
}
await browser.close();
