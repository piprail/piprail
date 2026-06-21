// Generate theme-adaptive, transparent PipRail logo variants for the docs.
//
// Source: site/public/logo-no-background.png — the brand mark on a TRANSPARENT
// background: a white "P" body + an emerald "pip" rail.
//
//   • logo-dark.png  → white P + emerald rail   (shown on the dark theme)
//   • logo-light.png → black P + emerald rail   (shown on the light theme)
//
// The rail stays emerald in both. We split body-vs-rail by "greenness"
// (G clearly above R/B = the emerald rail; everything else = the white body),
// recolor only the body, and preserve the original alpha so the anti-aliased
// edges stay crisp at any size.
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '../../site/public/logo-no-background.png')
const OUT = [resolve(here, '../public'), resolve(here, '../src/assets')]

// The body colour for the light theme — the brand near-black, matching the
// light-theme heading/wordmark colour so the mark + "PipRail" read as one unit.
const BLACK = [10, 11, 13]

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info
const px = Buffer.from(data)

let bodyPx = 0
let railPx = 0
for (let i = 0; i < px.length; i += channels) {
  const r = px[i]
  const g = px[i + 1]
  const b = px[i + 2]
  const a = px[i + 3]
  if (a === 0) continue
  // "greenness": how much green dominates — the emerald rail scores high, the
  // white/grey body scores ~0. A modest threshold keeps the rail fully intact.
  const greenness = g - Math.max(r, b)
  if (greenness > 24) {
    railPx++
    continue // emerald rail — leave it exactly as-is
  }
  // Body pixel → recolour to near-black, keep its alpha (soft edges preserved).
  px[i] = BLACK[0]
  px[i + 1] = BLACK[1]
  px[i + 2] = BLACK[2]
  bodyPx++
}

const light = await sharp(px, { raw: { width, height, channels } }).png().toBuffer()
for (const dir of OUT) {
  // Dark = the untouched transparent source; light = our recoloured buffer.
  await sharp(SRC).png().toFile(resolve(dir, 'logo-dark.png'))
  await sharp(light).toFile(resolve(dir, 'logo-light.png'))
}

console.log(`source ${width}x${height} · body px recoloured: ${bodyPx} · rail px kept: ${railPx}`)
console.log('wrote logo-dark.png + logo-light.png to', OUT.join(' , '))
