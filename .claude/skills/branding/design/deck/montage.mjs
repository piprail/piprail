// Contact sheet: tile preview/slide-NN.png into a grid for fast review.
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), 'noop'))
const sharp = createRequire('/Users/john/Sites/piprail/site/')('sharp')
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'preview')
const COLS = +(process.argv[2] || 3), CW = 640, CH = Math.round(CW * 9 / 16), GAP = 16, LBL = 22
const files = readdirSync(DIR).filter((f) => /^slide-\d+\.png$/.test(f)).sort()
const rows = Math.ceil(files.length / COLS)
const W = COLS * CW + (COLS + 1) * GAP, H = rows * (CH + LBL) + (rows + 1) * GAP
const tiles = []
for (let i = 0; i < files.length; i++) {
  const r = Math.floor(i / COLS), c = i % COLS
  const x = GAP + c * (CW + GAP), y = GAP + r * (CH + LBL + GAP)
  const img = await sharp(join(DIR, files[i])).resize(CW, CH, { fit: 'contain', background: { r: 20, g: 22, b: 26 } }).png().toBuffer()
  tiles.push({ input: img, top: y + LBL, left: x })
  const label = await sharp({ text: { text: `<span foreground="#9BA1A8">${files[i].replace('.png', '')}</span>`, font: 'Inter', rgba: true, dpi: 120 } }).png().toBuffer()
  tiles.push({ input: label, top: y, left: x })
}
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 10, g: 11, b: 12 } } })
  .composite(tiles).png().toFile(join(DIR, 'contact.png'))
console.log('wrote', join(DIR, 'contact.png'), `${W}x${H}`)
