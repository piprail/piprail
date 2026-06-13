#!/usr/bin/env node
// QA previews. Prefers LibreOffice (honors embedded fonts) -> one PNG per slide.
// Falls back to splitting the deck into single-slide .pptx + qlmanage (layout-only;
// qlmanage ignores embedded fonts, so type shows a serif fallback — fine for layout).
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const __dirname = dirname(fileURLToPath(import.meta.url))
const PPTX = join(__dirname, 'PipRail-deck.pptx')
const OUT = join(__dirname, 'preview')
const SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })

if (existsSync(SOFFICE)) {
  // LibreOffice: pptx -> pdf -> page PNGs (pdftoppm via sips per-page is messy; use LO pdf then sips)
  const tmp = '/tmp/pr-lo'; rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true })
  execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', tmp, PPTX], { stdio: 'ignore' })
  const pdf = join(tmp, 'PipRail-deck.pdf')
  // rasterize each page with macOS `sips` won't split pages; use `qlmanage`? use pdftoppm if present, else `gs`/`sips`.
  try {
    execFileSync('pdftoppm', ['-png', '-r', '150', pdf, join(OUT, 'slide')], { stdio: 'ignore' })
  } catch {
    // fallback: ask LO to export PNGs directly (first page only) — or use macOS `qlmanage` on the pdf per page is N/A.
    execFileSync(SOFFICE, ['--headless', '--convert-to', 'png', '--outdir', OUT, PPTX], { stdio: 'ignore' })
  }
  console.log('rendered via LibreOffice ->', OUT)
} else {
  // split + qlmanage
  const orig = readFileSync(PPTX)
  const baseZip = await JSZip.loadAsync(orig)
  const pres = await baseZip.file('ppt/presentation.xml').async('string')
  const ids = [...pres.matchAll(/<p:sldId [^>]*\/>/g)].map((m) => m[0])
  console.log(`${ids.length} slides — splitting + qlmanage`)
  for (let i = 0; i < ids.length; i++) {
    const z = await JSZip.loadAsync(orig)
    const only = pres.replace(/<p:sldIdLst>.*?<\/p:sldIdLst>/s, `<p:sldIdLst>${ids[i]}</p:sldIdLst>`)
    z.file('ppt/presentation.xml', only)
    const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const f = join('/tmp/pr-split', `s${String(i + 1).padStart(2, '0')}.pptx`)
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, buf)
    execFileSync('qlmanage', ['-t', '-s', '1600', '-o', OUT, f], { stdio: 'ignore' })
  }
  // qlmanage names outputs <file>.png — rename to slideNN.png
  for (const f of readdirSync(OUT)) {
    const m = f.match(/^s(\d+)\.pptx\.png$/)
    if (m) renameSync(join(OUT, f), join(OUT, `slide-${m[1]}.png`))
  }
  console.log('rendered via qlmanage (layout only) ->', OUT)
}
