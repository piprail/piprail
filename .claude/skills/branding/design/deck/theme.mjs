// PipRail deck — design system (the brand, in pptxgenjs form).
// Mirrors site/src/styles/global.css: near-black canvas, ONE emerald accent ("paid"),
// Space Grotesk display / Inter body / JetBrains Mono code. Contrast-not-glow.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ASSET = (p) => join(__dirname, 'assets', p)

// ── canvas ────────────────────────────────────────────────────────────────
export const W = 13.333
export const H = 7.5
export const MX = 0.78           // side margin
export const CW = W - MX * 2     // content width
export const FOOTER_Y = 7.08

// ── color (hex, no #) ───────────────────────────────────────────────────────
export const C = {
  bg: '0A0B0C',
  fg: 'F4F6F7', fgSoft: 'C7CCD1', muted: '9BA1A8', faint: '6B7178', dim: '4C5258',
  line: '24282D', lineHi: '2E343A',
  card: '121417', cardHi: '15181C', panel: '0E0F12',
  accent: '2EE6A6', accentBright: '5EE6A8', accentDim: '1C7D5E', accentInk: '052016',
  blue: '5A8DF0',
  // syntax tokens (match global.css .tok-*)
  kw: '9BA1A8', str: '7FE3B6', fn: '8FB7F5', chain: 'E6C56E', num: 'F0A07A', com: '595F66', op: '9098A0', ident: 'D6DBE0',
  good: '2EE6A6', warn: 'E6C56E',
}

// ── type ─────────────────────────────────────────────────────────────────────
// Embedded family names = the TTFs' real internal names (see inspect-fonts.mjs).
export const F = {
  bold: 'Space Grotesk',          // ALWAYS pass bold:true  (wordmark, big numbers)
  semi: 'Space Grotesk SemiBold', // headings
  med: 'Space Grotesk Medium',    // light display
  body: 'Inter',
  bodyM: 'Inter Medium',
  bodyS: 'Inter SemiBold',
  mono: 'JetBrains Mono',
  monoM: 'JetBrains Mono Medium',
}

// ── primitives ────────────────────────────────────────────────────────────────
export function bg(slide, variant = 'a') {
  slide.background = { path: ASSET(`bg/bg-${variant}.png`) }
}

let PPTX // shape-type enum holder (set by build.mjs)
export function setPptx(p) { PPTX = p }
const RR = () => PPTX.ShapeType.roundRect
const RECT = () => PPTX.ShapeType.rect
const LINE = () => PPTX.ShapeType.line

// soft surface card
export function card(slide, { x, y, w, h, fill = C.card, line = C.line, lw = 1, radius = 0.1, glow = 0, shadow = true } = {}) {
  const opts = { x, y, w, h, fill: { color: fill }, line: { color: line, width: lw }, rectRadius: radius }
  if (glow) opts.shadow = { type: 'outer', color: C.accent, blur: glow, offset: 0, angle: 90, opacity: 0.5 }
  else if (shadow) opts.shadow = { type: 'outer', color: '000000', blur: 9, offset: 5, angle: 90, opacity: 0.38 }
  slide.addShape(RR(), opts)
}

// thin accent rule
export function rule(slide, { x, y, w, color = C.line, h = 0 } = {}) {
  slide.addShape(LINE(), { x, y, w, h, line: { color, width: 1 } })
}

// uppercase mono eyebrow, emerald
export function eyebrow(slide, text, { x = MX, y = 0.6, color = C.accent, size = 11 } = {}) {
  slide.addText(text.toUpperCase(), {
    x, y, w: CW, h: 0.3, fontFace: F.monoM, fontSize: size, color, charSpacing: 2.4, bold: false, align: 'left', valign: 'middle',
  })
}

// big display headline; pass a string or run-array
export function heading(slide, runs, { x = MX, y = 0.98, w = CW, size = 31, h = 1.2, align = 'left', lineSpacingMultiple = 1.02 } = {}) {
  const txt = typeof runs === 'string'
    ? [{ text: runs, options: { fontFace: F.semi, color: C.fg } }]
    : runs
  slide.addText(txt, { x, y, w, h, fontSize: size, align, valign: 'top', lineSpacingMultiple, paraSpaceAfter: 0, paraSpaceBefore: 0, fontFace: F.semi })
}

// muted sub-headline (Inter)
export function subhead(slide, text, { x = MX, y, w = CW, size = 13.5, color = C.muted, h = 0.8, align = 'left' } = {}) {
  slide.addText(text, { x, y, w, h, fontFace: F.body, fontSize: size, color, align, valign: 'top', lineSpacingMultiple: 1.18 })
}

// bordered pill (eyebrow-in-a-pill, e.g. the hero badge)
export function pill(slide, runs, { x, y, w, h = 0.4, align = 'center', fill = '0E1714', line = '2E5A48', radius = 0.2 } = {}) {
  slide.addShape(RR(), { x, y, w, h, fill: { color: fill }, line: { color: line, width: 1 }, rectRadius: radius })
  slide.addText(runs, { x, y: y - 0.01, w, h, align, valign: 'middle', fontFace: F.monoM, fontSize: 10.5, color: C.accentBright, charSpacing: 1.6 })
}

// small label/tag chip
export function chip(slide, text, { x, y, w, h = 0.42, fill = C.cardHi, line = C.lineHi, color = C.fgSoft, size = 11.5, face = F.bodyM, radius = 0.09, align = 'center' } = {}) {
  slide.addShape(RR(), { x, y, w, h, fill: { color: fill }, line: { color: line, width: 1 }, rectRadius: radius })
  slide.addText(text, { x: x + 0.04, y, w: w - 0.08, h, align, valign: 'middle', fontFace: face, fontSize: size, color })
}

// big stat: value (display) + label + optional source
export function stat(slide, { x, y, w, value, label, source, valueColor = C.accent, valueSize = 40, labelSize = 11.5, valueFace = F.bold, valueBold = true }) {
  let cy = y
  slide.addText(value, { x, y: cy, w, h: 0.74, fontFace: valueFace, bold: valueBold, fontSize: valueSize, color: valueColor, align: 'left', valign: 'top', charSpacing: -0.3 })
  cy += valueSize > 34 ? 0.72 : 0.6
  slide.addText(label, { x, y: cy, w, h: 0.62, fontFace: F.bodyM, fontSize: labelSize, color: C.fgSoft, align: 'left', valign: 'top', lineSpacingMultiple: 1.06 })
  if (source) slide.addText(source, { x, y: cy + 0.56, w, h: 0.26, fontFace: F.mono, fontSize: 8.5, color: C.faint, align: 'left', valign: 'top', charSpacing: 0.4 })
}

// a stat inside a card
export function statCard(slide, o) {
  card(slide, { x: o.x, y: o.y, w: o.w, h: o.h, radius: 0.11 })
  // emerald top accent tick
  slide.addShape(RR(), { x: o.x + 0.22, y: o.y + 0.24, w: 0.34, h: 0.07, fill: { color: o.valueColor || C.accent }, line: { type: 'none' }, rectRadius: 0.035 })
  stat(slide, { ...o, x: o.x + 0.22, y: o.y + 0.46, w: o.w - 0.44, valueSize: o.valueSize ?? 33, labelSize: o.labelSize ?? 11 })
}

// numbered step (01 ..) with title + desc
export function step(slide, { x, y, w, h, n, title, desc, accent = C.accent }) {
  card(slide, { x, y, w, h, radius: 0.1 })
  slide.addText(n, { x: x + 0.22, y: y + 0.2, w: 1, h: 0.4, fontFace: F.mono, fontSize: 12, color: accent, charSpacing: 1, valign: 'top' })
  slide.addText(title, { x: x + 0.22, y: y + 0.66, w: w - 0.44, h: 0.5, fontFace: F.bodyS, fontSize: 13.5, color: C.fg, valign: 'top', lineSpacingMultiple: 1.0 })
  slide.addText(desc, { x: x + 0.22, y: y + h - 1.18, w: w - 0.44, h: 1.0, fontFace: F.body, fontSize: 10.8, color: C.muted, valign: 'top', lineSpacingMultiple: 1.12 })
}

// feature card: emerald square glyph + title + body
export function feature(slide, { x, y, w, h, glyph, title, desc }) {
  card(slide, { x, y, w, h, radius: 0.11 })
  slide.addShape(RR(), { x: x + 0.24, y: y + 0.26, w: 0.46, h: 0.46, fill: { color: '0E1A15' }, line: { color: '2E5A48', width: 1 }, rectRadius: 0.08 })
  slide.addText(glyph, { x: x + 0.24, y: y + 0.26, w: 0.46, h: 0.46, align: 'center', valign: 'middle', fontFace: F.bold, bold: true, fontSize: 15, color: C.accent })
  slide.addText(title, { x: x + 0.86, y: y + 0.28, w: w - 1.1, h: 0.46, fontFace: F.bodyS, fontSize: 14, color: C.fg, valign: 'middle', lineSpacingMultiple: 0.98 })
  slide.addText(desc, { x: x + 0.24, y: y + 0.92, w: w - 0.48, h: h - 1.1, fontFace: F.body, fontSize: 11, color: C.muted, valign: 'top', lineSpacingMultiple: 1.16 })
}

// chain/token logo
export function logo(slide, slug, { x, y, size = 0.5 }) {
  slide.addImage({ path: ASSET(`logos/${slug}.png`), x, y, w: size, h: size })
}

// logo on a soft rounded tile
export function logoTile(slide, slug, { x, y, size = 0.92, pad = 0.2, label, highlight = false }) {
  card(slide, { x, y, w: size, h: size, radius: 0.13, fill: highlight ? '0E1A15' : C.card, line: highlight ? '2E5A48' : C.line, shadow: false })
  slide.addImage({ path: ASSET(`logos/${slug}.png`), x: x + pad, y: y + pad, w: size - pad * 2, h: size - pad * 2 })
  if (label) slide.addText(label, { x: x - 0.2, y: y + size + 0.04, w: size + 0.4, h: 0.24, align: 'center', valign: 'top', fontFace: F.bodyM, fontSize: 9, color: C.muted })
}

// code window: titlebar (3 dots + filename) + token-colored lines.
// lines: array of arrays of { t, c } runs.  c defaults to ident.
export function codeWindow(slide, { x, y, w, h, file, lines, size = 11 }) {
  card(slide, { x, y, w, h, radius: 0.1, fill: C.panel, line: '202428' })
  // titlebar
  slide.addShape(RECT(), { x, y, w, h: 0.42, fill: { color: '141619' }, line: { type: 'none' } })
  const dots = ['FF5F57', 'FEBC2E', '28C840']
  dots.forEach((c, i) => slide.addShape(PPTX.ShapeType.ellipse, { x: x + 0.22 + i * 0.24, y: y + 0.16, w: 0.11, h: 0.11, fill: { color: c }, line: { type: 'none' } }))
  slide.addText(file, { x: x + 1.2, y, w: w - 2.4, h: 0.42, align: 'left', valign: 'middle', fontFace: F.mono, fontSize: 9.5, color: C.faint })
  // code body
  const txt = []
  lines.forEach((runs, li) => {
    if (runs.length === 0) { txt.push({ text: ' ', options: { breakLine: true } }); return }
    runs.forEach((r, ri) => txt.push({ text: r.t, options: { color: r.c || C.ident, breakLine: ri === runs.length - 1 } }))
  })
  slide.addText(txt, { x: x + 0.32, y: y + 0.56, w: w - 0.6, h: h - 0.72, fontFace: F.mono, fontSize: size, align: 'left', valign: 'top', lineSpacingMultiple: 1.32 })
}

// wordmark (logo mark + "PipRail")
export function wordmark(slide, { x = MX, y = 0.5, size = 0.34, fontSize = 17, color = C.fg } = {}) {
  slide.addImage({ path: ASSET('logos/logo-no-background.png'), x, y, w: size, h: size })
  slide.addText('PipRail', { x: x + size + 0.12, y: y - 0.04, w: 2.2, h: size + 0.08, fontFace: F.bold, bold: true, fontSize, color, valign: 'middle', charSpacing: 0.2 })
}

// footer line + page number
export function footer(slide, page, total = 15) {
  slide.addText([
    { text: 'PipRail', options: { fontFace: F.bodyS, color: C.fgSoft } },
    { text: '   ·   piprail.com', options: { fontFace: F.body, color: C.faint } },
  ], { x: MX, y: FOOTER_Y, w: 6, h: 0.26, fontSize: 9, align: 'left', valign: 'middle' })
  if (page) slide.addText(`${String(page).padStart(2, '0')} / ${total}`, { x: W - MX - 2, y: FOOTER_Y, w: 2, h: 0.26, fontSize: 9, fontFace: F.mono, color: C.faint, align: 'right', valign: 'middle', charSpacing: 0.5 })
}

// small inline "tick" bullet row
export function tick(slide, text, { x, y, w, color = C.accent, size = 11.5, face = F.body, tColor = C.fgSoft }) {
  slide.addText([
    { text: '▸  ', options: { color, fontFace: F.bodyS } },
    { text, options: { color: tColor, fontFace: face } },
  ], { x, y, w, h: 0.34, fontSize: size, align: 'left', valign: 'middle', lineSpacingMultiple: 1.05 })
}
