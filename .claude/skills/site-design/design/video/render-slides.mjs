import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('/Users/john/.cache/piprail-video-tools/');
const { chromium } = require('playwright-core');
const BIN = process.env.HOME + "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SRC = '/Users/john/Sites/piprail/.claude/skills/site-design/design/exports/compare-402.html';
const b = await chromium.launch({ executablePath: BIN, headless: true, args:['--force-color-profile=srgb'] });
const p = await b.newPage({ viewport:{width:1920,height:1080}, deviceScaleFactor:2 });
for (const n of [1,2,3,4,5,6]) {
  await p.goto(pathToFileURL(SRC).href + '?slide=' + n, { waitUntil:'load' });
  await p.evaluate(()=>document.fonts.ready).catch(()=>{});
  // overflow guard: report if any .body content exceeds its box
  const over = await p.evaluate(()=>{ const b=document.querySelector('.slide[style*="flex"] .body')||document.querySelector('.body'); return b ? (b.scrollHeight - b.clientHeight) : -1; });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `/Users/john/Sites/piprail/.claude/skills/site-design/design/video/_cmp${n}.png` });
  console.log('slide', n, 'body overflow px:', over);
}
await b.close();
