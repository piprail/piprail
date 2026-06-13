#!/usr/bin/env node
// Embed the brand TTFs into the .pptx so it looks identical on any machine
// (PowerPoint / Keynote / Google Slides) — no "font not installed" fallback.
// OOXML font embedding: add ppt/fonts/*.fntdata parts + a <p:embeddedFontLst>
// in presentation.xml + relationships + a Content-Types default.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const __dirname = dirname(fileURLToPath(import.meta.url))
const PPTX = join(__dirname, 'PipRail-deck.pptx')
const FDIR = join(__dirname, 'assets/fonts')

// family name (must equal the TTF's internal name) -> file + which weight slot
const FONTS = [
  { fam: 'Space Grotesk SemiBold', file: 'SpaceGrotesk-SemiBold.ttf', slot: 'regular' },
  { fam: 'Space Grotesk Medium', file: 'SpaceGrotesk-Medium.ttf', slot: 'regular' },
  { fam: 'Space Grotesk', file: 'SpaceGrotesk-Bold.ttf', slot: 'bold' },
  { fam: 'Inter', file: 'Inter-Regular.ttf', slot: 'regular' },
  { fam: 'Inter Medium', file: 'Inter-Medium.ttf', slot: 'regular' },
  { fam: 'Inter SemiBold', file: 'Inter-SemiBold.ttf', slot: 'regular' },
  { fam: 'JetBrains Mono', file: 'JetBrainsMono-Regular.ttf', slot: 'regular' },
  { fam: 'JetBrains Mono Medium', file: 'JetBrainsMono-Medium.ttf', slot: 'regular' },
]
const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

const zip = await JSZip.loadAsync(readFileSync(PPTX))

// 1. font parts
FONTS.forEach((f, i) => zip.file(`ppt/fonts/font${i + 1}.fntdata`, readFileSync(join(FDIR, f.file))))

// 2. [Content_Types].xml — register the fntdata extension
let ct = await zip.file('[Content_Types].xml').async('string')
if (!ct.includes('Extension="fntdata"')) {
  ct = ct.replace('<Types ', '<Types ').replace(
    /(<Types[^>]*>)/,
    '$1<Default Extension="fntdata" ContentType="application/x-fontdata"/>',
  )
  zip.file('[Content_Types].xml', ct)
}

// 3. relationships — one per font part, with fresh rIds
let rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string')
let maxId = 0
for (const m of rels.matchAll(/Id="rId(\d+)"/g)) maxId = Math.max(maxId, +m[1])
const relXml = FONTS.map((f, i) =>
  `<Relationship Id="rId${maxId + 1 + i}" Type="${FONT_REL}" Target="fonts/font${i + 1}.fntdata"/>`).join('')
rels = rels.replace('</Relationships>', relXml + '</Relationships>')
zip.file('ppt/_rels/presentation.xml.rels', rels)

// 4. presentation.xml — embeddedFontLst (before defaultTextStyle) + embedTrueTypeFonts flag
let pres = await zip.file('ppt/presentation.xml').async('string')
const lst = '<p:embeddedFontLst>' + FONTS.map((f, i) =>
  `<p:embeddedFont><p:font typeface="${f.fam}"/><p:${f.slot} r:id="rId${maxId + 1 + i}"/></p:embeddedFont>`).join('') + '</p:embeddedFontLst>'
if (pres.includes('<p:defaultTextStyle>')) pres = pres.replace('<p:defaultTextStyle>', lst + '<p:defaultTextStyle>')
else pres = pres.replace('</p:presentation>', lst + '</p:presentation>')
if (!pres.includes('embedTrueTypeFonts')) pres = pres.replace('<p:presentation ', '<p:presentation embedTrueTypeFonts="1" ')
zip.file('ppt/presentation.xml', pres)

const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
writeFileSync(PPTX, out)
console.log(`embedded ${FONTS.length} fonts -> ${PPTX} (${(out.length / 1024 / 1024).toFixed(2)} MB)`)
