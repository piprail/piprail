import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('/Users/john/.cache/piprail-video-tools/');
const { chromium } = require('playwright-core');
const BIN = process.env.HOME + "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const b = await chromium.launch({ executablePath: BIN, headless: true });
const p = await b.newPage({ viewport:{width:1920,height:1080} });
await p.goto(pathToFileURL('/Users/john/Sites/piprail/.claude/skills/branding/design/video/scene.html').href,{waitUntil:'load'});
await p.evaluate(()=>window.__ready).catch(()=>{});
const r = await p.evaluate(()=>{
  const out={anims: window.__anims.length, t:{}};
  for(const t of [14.5,20.5]){
    window.seek(t);
    const ghosts=[];
    document.querySelectorAll('#stage *').forEach(el=>{
      if(el.children.length) return;               // leaf only
      const o=parseFloat(getComputedStyle(el).opacity);
      const txt=(el.textContent||'').trim().slice(0,34);
      if(o>0.02 && o<0.98 && txt) ghosts.push({o:+o.toFixed(2),txt});
    });
    out.t[t]=ghosts.slice(0,12);
  }
  return out;
});
console.log(JSON.stringify(r,null,2));
await b.close();
