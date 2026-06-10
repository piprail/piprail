// Deterministic frame capture: loads scene.html once, then for each frame sets the
// scene's master clock (window.seek) to an exact time and screenshots. No wall-clock,
// no requestAnimationFrame in capture mode -> identical output every run.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire('/Users/john/.cache/piprail-video-tools/');
const { chromium } = require('playwright-core');

const BIN = process.env.HOME +
  "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SCENE = pathToFileURL('/Users/john/Sites/piprail/.claude/skills/site-design/design/video/scene.html').href;

const mode = process.argv[2] || 'sample';
const args = process.argv.slice(3);

const browser = await chromium.launch({ executablePath: BIN, headless: true, args: ['--force-color-profile=srgb','--disable-lcd-text'] });
// deviceScaleFactor 2 -> 3840x2160 screenshots, downscaled to 1080p at encode time
// (supersampled) for razor-sharp text and logos.
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(SCENE, { waitUntil: 'load' });
await page.evaluate(() => window.__ready).catch(()=>{});
await page.waitForTimeout(400); // let webfonts settle

const pad = (n,w=5)=>String(n).padStart(w,'0');

if (mode === 'sample') {
  mkdirSync('/Users/john/Sites/piprail/.claude/skills/site-design/design/video/sample', { recursive: true });
  const times = args.length ? args.map(Number) : [1,5,9,11,14,16,20,24,29,31,33,35];
  for (const t of times) {
    await page.evaluate((tt)=>window.seek(tt), t);
    await page.screenshot({ path: `/Users/john/Sites/piprail/.claude/skills/site-design/design/video/sample/t_${String(t).replace('.','_')}.png` });
    process.stdout.write(`sample t=${t} `);
  }
  console.log('\nsamples done');
} else {
  const fps = Number(args[0]||30);
  const dir = '/Users/john/Sites/piprail/.claude/skills/site-design/design/video/frames';
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const total = await page.evaluate(()=>window.duration);
  const N = Math.round(total*fps);
  const t0 = Date.now();
  for (let f=0; f<N; f++){
    const t = f/fps;
    await page.evaluate((tt)=>window.seek(tt), t);
    await page.screenshot({ path: `${dir}/frame_${pad(f)}.png` });
    if (f%60===0){ const el=(Date.now()-t0)/1000; process.stdout.write(`\r${f}/${N} (${(f/N*100|0)}%) ${el.toFixed(0)}s `); }
  }
  console.log(`\nrendered ${N} frames @ ${fps}fps in ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
await browser.close();
