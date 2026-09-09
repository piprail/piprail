// Continuous wall-clock capture of actual subprocess stdout, without scripted output or edits.
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(process.env.HOME+'/.cache/piprail-video-tools/');
const { chromium }=require('playwright-core');
const root=process.env.HOME+'/Library/Caches/ms-playwright';
const bin=readdirSync(root).filter(x=>/^chromium-\d+$/.test(x)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(x=>join(root,x,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const output=join(here,'live-recording');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:bin});
const context=await browser.newContext({viewport:{width:1920,height:1080},recordVideo:{dir:output,size:{width:1920,height:1080}}});
const page=await context.newPage();
await page.setContent('<style>body{background:#0a0b0c;color:#eee;margin:60px;font:23px/1.5 monospace}h1{font-size:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>PipRail | Live Base mainnet demo</h1><pre id="terminal">$ node live-demo.mjs\n</pre>');
const start=Date.now(); let transcript='';let queue=Promise.resolve();
const child=spawn(process.execPath,[join(here,'live-demo.mjs')],{cwd:here,stdio:['ignore','pipe','pipe']});
function append(data){const value=data.toString();transcript+=value;process.stdout.write(value);queue=queue.then(()=>page.evaluate(t=>{document.getElementById('terminal').textContent+=t},value));}
child.stdout.on('data',append);child.stderr.on('data',append);
const code=await new Promise(resolve=>child.on('close',resolve));await queue;
writeFileSync(join(output,'transcript.txt'),transcript);
await page.waitForTimeout(Math.max(0,60000-(Date.now()-start)));
const video=page.video();await context.close();await video.saveAs(join(output,'live-demo.webm'));await browser.close();
console.log('Recording saved; subprocess exit:',code);process.exitCode=code;
