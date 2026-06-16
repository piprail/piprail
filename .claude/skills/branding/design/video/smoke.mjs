import { chromium } from 'playwright-core';
const BIN = process.env.HOME + "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const b = await chromium.launch({ executablePath: BIN, headless: true });
const p = await b.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
await p.setContent('<body style="margin:0;background:#0a0b0c"><h1 style="color:#2ee6a6;font:700 48px Inter,sans-serif;padding:40px">PipRail ✓</h1></body>');
await p.screenshot({ path: 'smoke.png' });
await b.close();
console.log('screenshot written');
