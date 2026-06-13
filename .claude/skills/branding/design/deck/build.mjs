#!/usr/bin/env node
// PipRail pitch deck — generates a brand-accurate, EDITABLE .pptx.
// Run: node build.mjs   (then node embed-fonts.mjs to embed the brand fonts)
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  W, H, MX, CW, C, F, setPptx, bg, card, rule, eyebrow, heading, subhead, pill, chip,
  stat, statCard, step, feature, logo, logoTile, codeWindow, wordmark, footer, tick, ASSET,
} from './theme.mjs'

const require = createRequire(import.meta.url)
const pptxgen = require('pptxgenjs')
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, 'PipRail-deck.pptx')

const pptx = new pptxgen()
setPptx(pptx)
pptx.defineLayout({ name: 'PR', width: W, height: H })
pptx.layout = 'PR'
pptx.author = 'PipRail'
pptx.company = 'PipRail'
pptx.title = 'PipRail — the universal payment rail for the agent economy'

const TOTAL = 15
const S = () => pptx.addSlide()
const mid = (w) => (W - w) / 2          // x to center a box of width w

// inline stat row, centered: pairs of [value, label]
function statRow(slide, y, pairs, { size = 15, align = 'center', x = MX, w = CW } = {}) {
  const runs = []
  pairs.forEach(([v, l], i) => {
    if (i) runs.push({ text: '     ·     ', options: { color: C.dim, fontFace: F.body } })
    runs.push({ text: v, options: { color: C.accent, fontFace: F.bold, bold: true } })
    runs.push({ text: ' ' + l, options: { color: C.fgSoft, fontFace: F.bodyM } })
  })
  slide.addText(runs, { x, y, w, h: 0.42, align, valign: 'middle', fontSize: size })
}

// ════════════════════════════════════════════════════════════ 1 · HERO
{
  const s = S(); bg(s, 'hero')
  wordmark(s, { x: MX, y: 0.5 })
  s.addText('AGENT-NATIVE PAYMENTS', { x: W - MX - 4, y: 0.52, w: 4, h: 0.34, align: 'right', valign: 'middle', fontFace: F.mono, fontSize: 9.5, color: C.faint, charSpacing: 2 })

  pill(s, 'OPEN x402 STANDARD   ·   VERIFIED LIVE ON MAINNET', { x: mid(5.7), y: 1.95, w: 5.7 })
  heading(s, [
    { text: 'The universal payment rail\n', options: { color: C.fg, fontFace: F.semi } },
    { text: 'for the ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'agent economy', options: { color: C.accent, fontFace: F.semi } },
    { text: '.', options: { color: C.fg, fontFace: F.semi } },
  ], { x: mid(11.5), y: 2.62, w: 11.5, size: 47, h: 1.7, align: 'center', lineSpacingMultiple: 1.0 })

  subhead(s, 'Any API charges for itself. Any AI agent pays on its own.\nOne line, every chain — straight to your wallet. No backend, no fee.',
    { x: mid(9.2), y: 4.36, w: 9.2, size: 15, align: 'center', color: C.muted, h: 0.8 })

  statRow(s, 5.28, [['29', 'chains'], ['10', 'families'], ['$0', 'fee'], ['MIT', 'open source']], { size: 15 })

  // install chip
  const iw = 5.0
  card(s, { x: mid(iw), y: 5.82, w: iw, h: 0.56, radius: 0.1, fill: '0E0F12', line: '262B30', shadow: false })
  s.addText([
    { text: '$ ', options: { color: C.dim, fontFace: F.mono } },
    { text: 'npm install ', options: { color: C.fgSoft, fontFace: F.mono } },
    { text: '@piprail/sdk', options: { color: C.accent, fontFace: F.monoM } },
    { text: ' viem', options: { color: C.fgSoft, fontFace: F.mono } },
  ], { x: mid(iw), y: 5.82, w: iw, h: 0.56, align: 'center', valign: 'middle', fontSize: 13 })

  footer(s, 1, TOTAL)
  s.addNotes('PipRail = the universal x402 payment rail for AI agents. One line of code accepts or pays crypto payments across 29 chains / 10 families, straight to your wallet — no backend, no facilitator, no fee, MIT. Open standard (x402), verified live on Base mainnet. This deck: the wave (money on-chain) → the new buyer (agents) → the standard (x402) → the unsolved problem (fragmentation) → PipRail the universal adapter → product → why we win → traction → model → the ask.')
}

// ════════════════════════════════════════════════════════════ 2 · WHY NOW (macro)
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'WHY NOW', { y: 0.62 })
  heading(s, [
    { text: 'Money itself is moving ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'on-chain', options: { color: C.accent, fontFace: F.semi } },
    { text: ' — at trillions of scale.', options: { color: C.fg, fontFace: F.semi } },
  ], { y: 1.0, size: 29, h: 0.7 })
  subhead(s, 'In 2025 stablecoins stopped being “crypto” and became settlement infrastructure. The rails the agent economy needs are already being laid — by the biggest names in finance.', { y: 1.74, w: 11.4, size: 13.5, h: 0.6 })

  const y = 2.7, h = 2.04, g = 0.26, w = (CW - g * 3) / 4
  const cards = [
    { value: '$33T', label: 'stablecoins settled in 2025 — up 72% YoY', source: 'Bloomberg' },
    { value: '> Visa + MC', label: 'stablecoin transfer volume passed Visa + Mastercard combined', source: 'CEX.IO', valueSize: 25 },
    { value: '$1.1B', label: 'Stripe paid for Bridge to own the stablecoin rails', source: 'CNBC' },
    { value: 'GENIUS Act', label: 'first US federal stablecoin law — passed 68–30, signed 2025', source: 'Congress.gov', valueSize: 23 },
  ]
  cards.forEach((c, i) => statCard(s, { x: MX + i * (w + g), y, w, h, ...c }))

  // pull quote
  const qy = 5.12
  card(s, { x: MX, y: qy, w: CW, h: 1.3, radius: 0.12, fill: '0E1411', line: '224134' })
  s.addText([
    { text: '“Stablecoins are the room-temperature superconductors for financial services.”', options: { color: C.fg, fontFace: F.med } },
  ], { x: MX + 0.4, y: qy + 0.22, w: 8.6, h: 0.86, valign: 'middle', fontSize: 17, lineSpacingMultiple: 1.05 })
  s.addText([
    { text: 'Patrick Collison\n', options: { color: C.accent, fontFace: F.bodyS } },
    { text: 'CEO, Stripe', options: { color: C.muted, fontFace: F.body } },
  ], { x: W - MX - 3.0, y: qy + 0.22, w: 2.6, h: 0.86, align: 'right', valign: 'middle', fontSize: 12, lineSpacingMultiple: 1.1 })

  footer(s, 2, TOTAL)
  s.addNotes('The macro tailwind. Stablecoins settled $33T in 2025, +72% YoY (Bloomberg, Jan 2026); on raw transfer volume they passed Visa+Mastercard combined (CEX.IO — note ~70% is automated, but the direction is real). Stripe bought Bridge for $1.1B (CNBC). The US GENIUS Act made stablecoins federal law (signed Jul 2025, Senate 68–30). Visa is settling USDC live ($7B annualized run-rate); JPMorgan put its deposit token on Base; BofA, PayPal (PYUSD ~$3.8B) all in. Money is going programmable, instant, 24/7, global. Collison quote, Oct 2024.')
}

// ════════════════════════════════════════════════════════════ 3 · THE NEW BUYER
{
  const s = S(); bg(s, 'b')
  eyebrow(s, 'THE NEW BUYER', { y: 0.62 })
  heading(s, [
    { text: 'AI agents are a new economic actor — ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'and they can’t use your checkout.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 0.96, size: 25, h: 1.04, w: 11.7 })
  subhead(s, 'Agents now earn and spend on their own — buying data, paying for compute, selling their work. They can’t sign up, hold a credit card, or click “subscribe.” The web has no way to charge them.', { y: 2.0, w: 11.5, size: 13.5, h: 0.55 })

  const y = 2.78, h = 1.84, g = 0.3, w = (CW - g * 2) / 3
  const probs = [
    { glyph: '⊘', title: 'No account, no card', desc: 'An autonomous agent can’t verify an email or type a card number. Every human onboarding step is a dead end.' },
    { glyph: '∿', title: 'Bursty, per-call usage', desc: 'Agents make many tiny calls, unpredictably. Subscriptions and seat licences don’t fit how machines consume.' },
    { glyph: '⛓', title: 'Locked to one chain', desc: 'An agent holds funds on whatever chain it runs on. A rail bound to one network can’t serve the ecosystem.' },
  ]
  probs.forEach((p, i) => feature(s, { x: MX + i * (w + g), y, w, h, ...p }))

  // stat band
  const by = 4.92
  card(s, { x: MX, y: by, w: CW, h: 1.4, radius: 0.12, fill: '101216', line: C.line })
  const bw = CW / 3
  const band = [
    ['98.6%', 'of agent payments\nsettle in USDC'],
    ['176M', 'agent transactions\nin 12 months · avg $0.31'],
    ['$3–5T', 'agentic commerce\nby 2030 (McKinsey)'],
  ]
  band.forEach(([v, l], i) => {
    if (i) s.addShape(pptx.ShapeType.line, { x: MX + i * bw, y: by + 0.26, w: 0, h: 0.88, line: { color: C.line, width: 1 } })
    s.addText(v, { x: MX + i * bw + 0.3, y: by + 0.22, w: bw - 0.5, h: 0.62, fontFace: F.bold, bold: true, fontSize: 30, color: C.accent, valign: 'top' })
    s.addText(l, { x: MX + i * bw + 0.3, y: by + 0.84, w: bw - 0.5, h: 0.5, fontFace: F.bodyM, fontSize: 11, color: C.fgSoft, valign: 'top', lineSpacingMultiple: 1.05 })
  })

  footer(s, 3, TOTAL)
  s.addNotes('The buyer is new and it’s already huge. 98.6% of AI-agent crypto payments settle in USDC; 176M agent transactions in a year, average ticket $0.31 (Keyrock “Who Pays the Agent?”, via CoinDesk). Agentic commerce projected at $3–5T by 2030 (McKinsey). And every incumbent shipped an agent-payments product in ~14 months: Google AP2, Visa Intelligent Commerce, Mastercard Agent Pay, Stripe Agentic Commerce, PayPal. The buyer exists; it needs a rail.')
}

// ════════════════════════════════════════════════════════════ 4 · THE STANDARD (x402)
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'THE STANDARD', { y: 0.62 })
  heading(s, [
    { text: 'The whole industry is converging on one protocol: ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'x402', options: { color: C.accent, fontFace: F.semi } },
    { text: '.', options: { color: C.fg, fontFace: F.semi } },
  ], { y: 1.0, size: 26, h: 0.7, w: 11.8 })
  subhead(s, 'Coinbase revived HTTP’s dormant “402 Payment Required” as a machine-native payment standard — then donated it to the Linux Foundation. It’s the neutral rail the agent economy is standardizing on. It’s what PipRail speaks.', { y: 1.72, w: 11.6, size: 13.5, h: 0.7 })

  // left: the 402 loop, compact
  const lx = MX, lw = 5.55, ly = 2.85, lh = 3.3
  card(s, { x: lx, y: ly, w: lw, h: lh, radius: 0.12, fill: C.panel, line: C.line })
  s.addText('THE 402 HANDSHAKE', { x: lx + 0.32, y: ly + 0.26, w: lw - 0.6, h: 0.3, fontFace: F.monoM, fontSize: 10, color: C.faint, charSpacing: 1.6 })
  const loop = [
    ['GET', '/report', 'agent requests a paid resource', C.fn],
    ['402', 'Payment Required', 'server returns price · token · chain · payTo', C.warn],
    ['PAY', 'on-chain', 'agent pays — straight to the wallet', C.accent],
    ['200', 'OK', 'retry with proof · content flows', C.accent],
  ]
  loop.forEach(([code, label, desc, col], i) => {
    const yy = ly + 0.74 + i * 0.62
    chip(s, code, { x: lx + 0.32, y: yy, w: 0.74, h: 0.4, fill: '0E1216', line: '2A3037', color: col, face: F.monoM, size: 11, align: 'center' })
    s.addText([
      { text: label + '   ', options: { color: C.fgSoft, fontFace: F.monoM } },
      { text: desc, options: { color: C.muted, fontFace: F.body } },
    ], { x: lx + 1.2, y: yy, w: lw - 1.5, h: 0.4, valign: 'middle', fontSize: 10.5 })
  })

  // right: legitimacy — big "22" with its label alongside (horizontal fits a 1.0-tall card)
  const rx = MX + lw + 0.5, rw = CW - lw - 0.5, ry = 2.85
  card(s, { x: rx, y: ry, w: rw, h: 1.0, radius: 0.11 })
  s.addText('22', { x: rx + 0.28, y: ry + 0.05, w: 1.4, h: 0.9, fontFace: F.bold, bold: true, fontSize: 46, color: C.accent, valign: 'middle', charSpacing: -1 })
  s.addText('of the world’s biggest tech + finance companies steward x402 under the Linux Foundation', { x: rx + 1.78, y: ry + 0.16, w: rw - 2.04, h: 0.52, fontFace: F.bodyM, fontSize: 12, color: C.fgSoft, valign: 'middle', lineSpacingMultiple: 1.08 })
  s.addText('LINUX FOUNDATION · 2026', { x: rx + 1.78, y: ry + 0.66, w: rw - 2.04, h: 0.26, fontFace: F.mono, fontSize: 8.5, color: C.faint, valign: 'middle', charSpacing: 0.6 })
  // member names
  card(s, { x: rx, y: ry + 1.16, w: rw, h: 1.12, radius: 0.11, fill: C.card, line: C.line })
  s.addText('STEWARDED BY', { x: rx + 0.26, y: ry + 1.34, w: rw - 0.5, h: 0.26, fontFace: F.monoM, fontSize: 9, color: C.faint, charSpacing: 1.6 })
  s.addText('Google · Microsoft · Amazon · Stripe · Visa · Mastercard · Circle · Cloudflare · Shopify · Coinbase · American Express · Solana Foundation',
    { x: rx + 0.26, y: ry + 1.6, w: rw - 0.52, h: 0.6, fontFace: F.bodyM, fontSize: 12, color: C.fgSoft, valign: 'top', lineSpacingMultiple: 1.16 })
  // AP2 line
  card(s, { x: rx, y: ry + 2.44, w: rw, h: 0.86, radius: 0.11, fill: '0E1411', line: '224134' })
  s.addText([
    { text: 'Google’s Agent Payments Protocol (AP2)', options: { color: C.fg, fontFace: F.bodyS } },
    { text: '  uses x402 as its default stablecoin rail — 60+ launch partners.', options: { color: C.muted, fontFace: F.body } },
  ], { x: rx + 0.26, y: ry + 2.44, w: rw - 0.52, h: 0.86, valign: 'middle', fontSize: 11.5, lineSpacingMultiple: 1.1 })

  footer(s, 4, TOTAL)
  s.addNotes('x402 = the open standard. Coinbase published it May 2025; the Linux Foundation launched the x402 Foundation Apr 2026 with 22 founding members (Google, Microsoft, Amazon, Stripe, Visa, Mastercard, Circle, Cloudflare, Shopify, Coinbase, Amex, Solana Foundation…). Google’s AP2 (60+ partners) uses x402 as its default stablecoin rail. The handshake: request → 402 challenge (price/token/chain/payTo) → pay on-chain → retry with proof → 200. PipRail is a clean, neutral, multi-chain implementation of exactly this.')
}

// ════════════════════════════════════════════════════════════ 5 · THE PROBLEM (fragmentation)
{
  const s = S(); bg(s, 'b')
  eyebrow(s, 'THE CATCH', { y: 0.62 })
  heading(s, [
    { text: 'But the money is ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'scattered across hundreds of chains', options: { color: C.accent, fontFace: F.semi } },
    { text: ' that don’t talk to each other.', options: { color: C.fg, fontFace: F.semi } },
  ], { y: 1.0, size: 26, h: 1.0, w: 11.6 })
  subhead(s, 'An agent holds funds on whatever chain it runs on. A rail bound to one network reaches only a slice of them — and bridging between chains is the single most-exploited thing in crypto.', { y: 1.92, w: 11.5, size: 13.5, h: 0.6 })

  const y = 2.84, h = 1.92, g = 0.26, w = (CW - g * 3) / 4
  const cards = [
    { value: '500+', label: 'live blockchains — yet the top 5 hold ~80% of the money', source: 'DeFiLlama' },
    { value: '50%', label: 'of the top-10 chains can’t natively talk to each other', source: 'Particle Network' },
    { value: '$4B+', label: 'stolen through cross-chain bridges since 2021', source: 'Chainalysis · Immunefi' },
    { value: '65%', label: 'of x402 volume is on Solana — an EVM-only rail misses it', source: 'Linux Foundation' },
  ]
  cards.forEach((c, i) => statCard(s, { x: MX + i * (w + g), y, w, h, ...c }))

  const qy = 5.14
  card(s, { x: MX, y: qy, w: CW, h: 1.28, radius: 0.12, fill: '0E1411', line: '224134' })
  s.addText('“The original vision of L2 and its role within Ethereum no longer makes sense.”',
    { x: MX + 0.4, y: qy + 0.22, w: 8.8, h: 0.84, valign: 'middle', fontSize: 17, color: C.fg, fontFace: F.med, lineSpacingMultiple: 1.05 })
  s.addText([
    { text: 'Vitalik Buterin\n', options: { color: C.accent, fontFace: F.bodyS } },
    { text: 'co-founder, Ethereum', options: { color: C.muted, fontFace: F.body } },
  ], { x: W - MX - 3.0, y: qy + 0.22, w: 2.6, h: 0.84, align: 'right', valign: 'middle', fontSize: 12, lineSpacingMultiple: 1.1 })

  footer(s, 5, TOTAL)
  s.addNotes('The unsolved problem: fragmentation. 500+ chains (DeFiLlama) but the top 5 hold ~80% of value; 50% of top-10 chains can’t natively interoperate (Particle Network). Bridges — the “connect chains” layer — have lost $4B+ since 2021 (Chainalysis/Immunefi), ~40% of all crypto ever stolen. 65% of x402 volume is on Solana (Linux Foundation), so an EVM/Base-only rail (like the reference clients) misses most of it. Even Vitalik says the L2 model is broken. The winning rail must be chain-agnostic.')
}

// ════════════════════════════════════════════════════════════ 6 · THE REVEAL (universal adapter)
{
  const s = S(); bg(s, 'hero')
  eyebrow(s, 'THE FIX', { y: 0.62, color: C.accent })
  heading(s, [
    { text: 'PipRail is the universal adapter. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'One line pays every chain.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 27, h: 0.7, w: 11.8 })

  // diagram: fragmented -> PipRail -> any API <-> any agent
  const dy = 2.5, dh = 2.45
  const lw = 3.5, mw = 3.4, rw = 3.5
  const lx = MX, mx = (W - mw) / 2, rx = W - MX - rw

  // left card — fragmented world
  card(s, { x: lx, y: dy, w: lw, h: dh, radius: 0.12 })
  s.addText('THE FRAGMENTED WORLD', { x: lx + 0.24, y: dy + 0.24, w: lw - 0.48, h: 0.3, fontFace: F.monoM, fontSize: 9.5, color: C.faint, charSpacing: 1.4 })
  const frag = ['ethereum', 'solana', 'bnb', 'xrpl', 'tron', 'stellar']
  frag.forEach((c, i) => logo(s, c, { x: lx + 0.36 + (i % 3) * 0.92, y: dy + 0.66 + Math.floor(i / 3) * 0.66, size: 0.5 }))
  s.addText('29 chains — each its own tokens, signing & gas', { x: lx + 0.24, y: dy + dh - 0.58, w: lw - 0.48, h: 0.44, fontFace: F.body, fontSize: 10.5, color: C.muted, valign: 'top', lineSpacingMultiple: 1.1 })

  // middle — PipRail node (glow)
  card(s, { x: mx, y: dy, w: mw, h: dh, radius: 0.14, fill: '0C1611', line: '2E5A48', glow: 26 })
  logoTile(s, 'logo-no-background', { x: mx + mw / 2 - 0.42, y: dy + 0.4, size: 0.84, pad: 0.0, highlight: false })
  s.addText('PipRail', { x: mx, y: dy + 1.34, w: mw, h: 0.5, align: 'center', fontFace: F.bold, bold: true, fontSize: 22, color: C.fg })
  s.addText('one adapter · one line', { x: mx, y: dy + 1.86, w: mw, h: 0.3, align: 'center', fontFace: F.monoM, fontSize: 11, color: C.accent, charSpacing: 0.5 })
  s.addText('handles the token, signing & proof', { x: mx, y: dy + 2.16, w: mw, h: 0.3, align: 'center', fontFace: F.body, fontSize: 10, color: C.muted })

  // right — payoff
  card(s, { x: rx, y: dy, w: rw, h: dh, radius: 0.12 })
  s.addText('THE PAYOFF', { x: rx + 0.24, y: dy + 0.24, w: rw - 0.48, h: 0.3, fontFace: F.monoM, fontSize: 9.5, color: C.accent, charSpacing: 1.4 })
  chip(s, 'Any API', { x: rx + 0.36, y: dy + 0.96, w: 1.3, h: 0.5, color: C.fg, size: 12.5 })
  s.addText('⇄', { x: rx + 1.66, y: dy + 0.96, w: 0.5, h: 0.5, align: 'center', valign: 'middle', fontFace: F.bold, fontSize: 18, color: C.accent })
  chip(s, 'Any agent', { x: rx + 2.12, y: dy + 0.96, w: 1.4, h: 0.5, color: C.fg, size: 12.5 })
  s.addText('charges for itself · pays on its own', { x: rx + 0.24, y: dy + dh - 0.66, w: rw - 0.48, h: 0.5, fontFace: F.body, fontSize: 10.5, color: C.muted, valign: 'top', lineSpacingMultiple: 1.1 })

  // connectors
  s.addText('→', { x: lx + lw, y: dy + dh / 2 - 0.3, w: mx - (lx + lw), h: 0.6, align: 'center', valign: 'middle', fontFace: F.bold, fontSize: 26, color: C.accent })
  s.addText('→', { x: mx + mw, y: dy + dh / 2 - 0.3, w: rx - (mx + mw), h: 0.6, align: 'center', valign: 'middle', fontFace: F.bold, fontSize: 26, color: C.accent })

  subhead(s, 'Name a chain — PipRail handles the token, the signing and the proof. The only SDK that reaches TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar & the XRP Ledger together with every major EVM chain and Solana.',
    { x: mid(10.6), y: 5.28, w: 10.6, size: 13, align: 'center', color: C.fgSoft, h: 0.7 })
  statRow(s, 6.34, [['29', 'chains'], ['10', 'families'], ['1', 'line'], ['$0', 'fee']], { size: 14.5 })

  footer(s, 6, TOTAL)
  s.addNotes('The reveal. PipRail is a chain-abstracted x402 adapter: one parameter (chain) selects everything — token, signing scheme, proof. It’s the only x402 SDK that reaches the non-EVM world (TON, Tron, NEAR, Sui, Aptos, Algorand, Stellar, XRPL) alongside every major EVM chain + Solana: 29 chains, 10 families, one line, $0 fee. Fragmented world in → any API ⇄ any agent out.')
}

// ════════════════════════════════════════════════════════════ 7 · HOW IT WORKS
{
  const s = S(); bg(s, 'plain')
  eyebrow(s, 'HOW IT WORKS', { y: 0.62 })
  heading(s, [
    { text: 'A four-step round trip over plain HTTP. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'No middleman.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 27, h: 0.7, w: 11.8 })
  subhead(s, 'PipRail is a tool you npm install, not a service you sign up for. Nothing sits between the payer and your wallet.', { y: 1.74, w: 11.5, size: 13.5, h: 0.5 })

  const y = 2.56, h = 2.28, g = 0.26, w = (CW - g * 3) / 4
  const steps = [
    { n: '01', title: 'Agent calls your route', desc: 'It gets back a 402 quote: price, token, recipient, chain.' },
    { n: '02', title: 'Agent pays on-chain', desc: 'One transfer, straight to your wallet. PipRail never touches the funds.' },
    { n: '03', title: 'You verify locally', desc: 'Checked against your own RPC: right amount, recipient, recent, unspent.' },
    { n: '04', title: 'You return the data', desc: '200 OK — and the same proof can never be spent twice.' },
  ]
  steps.forEach((p, i) => step(s, { x: MX + i * (w + g), y, w, h, ...p }))

  // tool-not-platform band
  const by = 5.18
  card(s, { x: MX, y: by, w: CW, h: 1.2, radius: 0.12, fill: '101216', line: C.line })
  s.addText('A TOOL, NOT A PLATFORM', { x: MX + 0.34, y: by + 0.2, w: 5, h: 0.3, fontFace: F.monoM, fontSize: 10, color: C.accent, charSpacing: 1.6 })
  const negs = ['No hosted facilitator or relayer', 'No database', 'No account or API key', 'No monthly or protocol fee']
  const nw = (CW - 0.68) / 4
  negs.forEach((t, i) => s.addText([
    { text: '✕  ', options: { color: C.accentDim, fontFace: F.bodyS } },
    { text: t, options: { color: C.fgSoft, fontFace: F.body } },
  ], { x: MX + 0.34 + i * nw, y: by + 0.6, w: nw - 0.2, h: 0.46, valign: 'middle', fontSize: 10.5, lineSpacingMultiple: 1.0 }))

  footer(s, 7, TOTAL)
  s.addNotes('How it works — the 402 loop, backendless. Agent calls route → 402 quote → agent pays on-chain straight to your wallet (PipRail never custodies) → you verify against your OWN RPC (amount, recipient, recency, single-use) → 200, content flows, proof can’t be replayed. No facilitator, no relayer, no database, no account, no fee. x402 v2 §7 explicitly blesses merchant-local verification, so this backendless shape is spec-supported, not a workaround.')
}

// ════════════════════════════════════════════════════════════ 8 · TWO SIDES, ONE SDK
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'THE SDK', { y: 0.62 })
  heading(s, [
    { text: 'Two sides, ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'one SDK.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 29, h: 0.6 })
  subhead(s, 'The same package lets a server charge an agent for a route — and an agent pay for one. A couple of lines each.', { y: 1.7, w: 11.5, size: 13.5, h: 0.5 })

  const y = 2.52, h = 3.66, g = 0.5, w = (CW - g) / 2
  // ACCEPT label
  s.addText([
    { text: '●  ', options: { color: C.accent } },
    { text: 'ACCEPT', options: { color: C.fg, fontFace: F.bodyS } },
    { text: '   charge an agent for any endpoint', options: { color: C.muted, fontFace: F.body } },
  ], { x: MX, y: y - 0.42, w, h: 0.34, fontSize: 12, valign: 'middle' })
  codeWindow(s, {
    x: MX, y, w, h, file: 'server.ts', size: 11.5,
    lines: [
      [{ t: 'import ', c: C.kw }, { t: '{ requirePayment }', c: C.ident }, { t: ' from ', c: C.kw }, { t: "'@piprail/sdk'", c: C.str }],
      [],
      [{ t: 'app.', c: C.ident }, { t: 'get', c: C.fn }, { t: '(', c: C.op }, { t: "'/report'", c: C.str }, { t: ',', c: C.op }],
      [{ t: '  requirePayment', c: C.fn }, { t: '({', c: C.op }],
      [{ t: '    chain', c: C.ident }, { t: ': ', c: C.op }, { t: "'base'", c: C.chain }, { t: ',', c: C.op }],
      [{ t: '    token', c: C.ident }, { t: ': ', c: C.op }, { t: "'USDC'", c: C.str }, { t: ', ', c: C.op }, { t: 'amount', c: C.ident }, { t: ': ', c: C.op }, { t: "'0.05'", c: C.num }, { t: ', payTo', c: C.ident }],
      [{ t: '  }),', c: C.op }],
      [{ t: '  handler', c: C.ident }, { t: ',', c: C.op }],
      [{ t: ')', c: C.op }],
    ],
  })
  // PAY label
  s.addText([
    { text: '●  ', options: { color: C.accent } },
    { text: 'PAY', options: { color: C.fg, fontFace: F.bodyS } },
    { text: '   let an agent pay for itself', options: { color: C.muted, fontFace: F.body } },
  ], { x: MX + w + g, y: y - 0.42, w, h: 0.34, fontSize: 12, valign: 'middle' })
  codeWindow(s, {
    x: MX + w + g, y, w, h, file: 'agent.ts', size: 11.5,
    lines: [
      [{ t: 'import ', c: C.kw }, { t: '{ PipRailClient }', c: C.ident }, { t: ' from ', c: C.kw }, { t: "'@piprail/sdk'", c: C.str }],
      [],
      [{ t: 'const ', c: C.kw }, { t: 'client', c: C.ident }, { t: ' = ', c: C.op }, { t: 'new ', c: C.kw }, { t: 'PipRailClient', c: C.fn }, { t: '({', c: C.op }],
      [{ t: '  chain', c: C.ident }, { t: ': ', c: C.op }, { t: "'bnb'", c: C.chain }, { t: ',', c: C.op }],
      [{ t: '  wallet', c: C.ident }, { t: ': { privateKey },', c: C.op }],
      [{ t: '})', c: C.op }],
      [],
      [{ t: '// on a 402: pays, then retries', c: C.com }],
      [{ t: 'const ', c: C.kw }, { t: 'res', c: C.ident }, { t: ' = ', c: C.op }, { t: 'await ', c: C.kw }, { t: 'client.', c: C.ident }, { t: 'fetch', c: C.fn }, { t: '(url)', c: C.op }],
    ],
  })

  footer(s, 8, TOTAL)
  s.addNotes('One SDK, two sides. ACCEPT: wrap any route with requirePayment({ chain, token, amount, payTo }) — Express/Next/any edge runtime, no backend. PAY: new PipRailClient({ chain, wallet }) then client.fetch(url) — on a 402 it reads the challenge, pays on-chain, waits for confirmation, retries with proof, all automatically. A spend policy (maxAmount/maxTotal/chains/tokens/hosts) refuses out-of-bounds calls before any send. One parameter — chain — picks everything.')
}

// ════════════════════════════════════════════════════════════ 9 · MCP — give your agent a wallet
{
  const s = S(); bg(s, 'b')
  eyebrow(s, '@piprail/mcp', { y: 0.62 })
  heading(s, [
    { text: 'Give your AI agent ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'a wallet.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 29, h: 0.6 })
  subhead(s, 'Paste one config block and Claude, Cursor, or any MCP client pays x402 APIs on its own — capped by a spend policy it cannot exceed. No code, no backend, no custody.', { y: 1.7, w: 11.5, size: 13.5, h: 0.6 })

  const y = 2.62, h = 3.5
  const lw = 5.5
  codeWindow(s, {
    x: MX, y, w: lw, h, file: 'claude_desktop_config.json', size: 11,
    lines: [
      [{ t: '{', c: C.op }],
      [{ t: '  "mcpServers"', c: C.fn }, { t: ': {', c: C.op }],
      [{ t: '    "piprail"', c: C.str }, { t: ': {', c: C.op }],
      [{ t: '      "command"', c: C.ident }, { t: ': ', c: C.op }, { t: '"npx"', c: C.str }, { t: ',', c: C.op }],
      [{ t: '      "args"', c: C.ident }, { t: ': [', c: C.op }, { t: '"-y", "@piprail/mcp"', c: C.str }, { t: '],', c: C.op }],
      [{ t: '      "env"', c: C.ident }, { t: ': {', c: C.op }],
      [{ t: '        "PIPRAIL_CHAIN"', c: C.ident }, { t: ': ', c: C.op }, { t: '"bnb"', c: C.chain }, { t: ',', c: C.op }],
      [{ t: '        "PIPRAIL_MAX_AMOUNT"', c: C.ident }, { t: ': ', c: C.op }, { t: '"0.10"', c: C.num }],
      [{ t: '      }', c: C.op }],
      [{ t: '    }', c: C.op }],
      [{ t: '  }', c: C.op }],
      [{ t: '}', c: C.op }],
    ],
  })

  // right: 7 tools
  const rx = MX + lw + 0.5, rw = CW - lw - 0.5
  s.addText('SEVEN TOOLS YOUR AGENT GETS', { x: rx, y: y + 0.02, w: rw, h: 0.3, fontFace: F.monoM, fontSize: 10, color: C.faint, charSpacing: 1.6 })
  const tools = [
    ['piprail_discover', 'find payable APIs on the open indexes'],
    ['piprail_quote', 'price a gated URL — without paying'],
    ['piprail_plan', 'check balance, gas & recipient readiness'],
    ['piprail_pay', 'fetch it, paying the 402 automatically'],
    ['piprail_register', 'list an endpoint so other agents find it'],
    ['piprail_budget', 'read the remaining spend + time leash'],
    ['piprail_guide', 'the agent contract: how to quote, plan, pay'],
  ]
  const th = (h - 0.44) / 7
  tools.forEach(([n, d], i) => {
    const yy = y + 0.42 + i * th
    s.addText([
      { text: '◆ ', options: { color: C.accent, fontFace: F.bodyS } },
      { text: n, options: { color: C.fg, fontFace: F.monoM } },
      { text: '   ' + d, options: { color: C.muted, fontFace: F.body } },
    ], { x: rx, y: yy, w: rw, h: th, valign: 'middle', fontSize: 11.2 })
    if (i < tools.length - 1) s.addShape(pptx.ShapeType.line, { x: rx, y: yy + th, w: rw, h: 0, line: { color: '1A1E22', width: 1 } })
  })

  footer(s, 9, TOTAL)
  s.addNotes('The MCP server is the distribution wedge into every AI agent. Paste one config into Claude Desktop / Cursor / Claude Code / Windsurf / VS Code / Cline, and the model gets seven budget-bound tools (discover, quote, plan, pay, register, budget, guide). The spend policy (max per-call, max total, allowed chains/tokens/hosts) is enforced BEFORE any on-chain send — the model literally cannot overspend. Runs locally with the user’s own wallet. @piprail/mcp is live on npm + the official MCP registry.')
}

// ════════════════════════════════════════════════════════════ 10 · OPEN / DUAL-RAIL / GASLESS
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'INTEROPERABLE BY DESIGN', { y: 0.62 })
  heading(s, [
    { text: 'Open standard. No middleman. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'Anyone can pay you.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 27, h: 0.7, w: 11.8 })
  subhead(s, 'Funds settle to your wallet, verified against your own RPC. Nobody can rate-limit you, take a cut, or shut you off — yet any x402 client in the world can still pay your gate.', { y: 1.74, w: 11.5, size: 13.5, h: 0.6 })

  const y = 2.72, h = 2.46, g = 0.3, w = (CW - g * 2) / 3
  const feats = [
    { glyph: '⛉', title: 'Nobody in the middle', desc: 'No facilitator, no relayer, no custody. The payer broadcasts their own transfer; you verify against your own RPC. No one can take a cut or switch you off.' },
    { glyph: '⌘', title: 'Speaks the standard', desc: 'PipRail’s envelope is x402 v2-conformant — so any x402 client, Coinbase’s or the reference client, can pay your gate. Proven on Base mainnet.' },
    { glyph: '⚡', title: 'One gate, both rails — gasless', desc: 'Advertise the backendless onchain-proof rail and the ratified exact (EIP-3009) rail at once. On USDC the payer just signs: zero gas, no approval.' },
  ]
  feats.forEach((f, i) => feature(s, { x: MX + i * (w + g), y, w, h, ...f }))

  // proof strip
  const py = 5.5
  card(s, { x: MX, y: py, w: CW, h: 0.82, radius: 0.1, fill: '0E1411', line: '224134' })
  s.addText([
    { text: '✓  Verified end-to-end ', options: { color: C.accent, fontFace: F.bodyS } },
    { text: 'against the official x402 reference client on Base mainnet — a real 402 → pay → confirm → verify → 200 round trip, with replay rejected.', options: { color: C.fgSoft, fontFace: F.body } },
  ], { x: MX + 0.34, y: py, w: CW - 0.68, h: 0.82, valign: 'middle', fontSize: 12.5, lineSpacingMultiple: 1.08 })

  footer(s, 10, TOTAL)
  s.addNotes('Interoperability is the moat, not a checkbox. Backendless: payer broadcasts, you verify on your own RPC — no facilitator/relayer/custody, nobody can throttle or take a cut. Standard-compliant: x402 v2 envelope, so Coinbase’s client or the open reference client can pay a PipRail gate; dual-rail advertises both onchain-proof AND the ratified exact (EIP-3009) scheme. Gasless: on EIP-3009 tokens (USDC/EURC, plus BNB FDUSD/USD1) the payer just signs — zero gas, no approval. Proven on Base mainnet, replay rejected.')
}

// ════════════════════════════════════════════════════════════ 11 · DISCOVERY + INTEGRATIONS
{
  const s = S(); bg(s, 'b')
  eyebrow(s, 'DISCOVERY + INTEGRATIONS', { y: 0.62 })
  heading(s, [
    { text: 'Payable isn’t the same as findable — ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'PipRail is both.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 26, h: 0.7, w: 11.8 })
  subhead(s, 'Make endpoints discoverable on the open x402 indexes — nothing PipRail-hosted — and drop the whole thing into the frameworks agents already live in.', { y: 1.72, w: 11.5, size: 13.5, h: 0.5 })

  // left: emit/register/discover
  const y = 2.62, lh = 3.5, lw = 6.4
  const moves = [
    ['Emit', 'Turn your gate config into a crawlable openapi.json on your own origin.'],
    ['Register', 'client.register(url) lists you on the open 402 Index — no auth, no fee.'],
    ['Discover', 'client.discover({ query }) reads the open indexes so an agent finds what to pay.'],
  ]
  const mh = (lh - 0.4) / 3 - 0.18
  moves.forEach(([t, d], i) => {
    const yy = y + 0.4 + i * (mh + 0.18)
    card(s, { x: MX, y: yy, w: lw, h: mh, radius: 0.1 })
    s.addText((i + 1).toString(), { x: MX + 0.24, y: yy, w: 0.5, h: mh, valign: 'middle', fontFace: F.bold, bold: true, fontSize: 20, color: C.accentDim })
    s.addText(t, { x: MX + 0.82, y: yy + 0.16, w: lw - 1.0, h: 0.36, fontFace: F.bodyS, fontSize: 14, color: C.fg, valign: 'top' })
    s.addText(d, { x: MX + 0.82, y: yy + 0.52, w: lw - 1.0, h: mh - 0.58, fontFace: F.body, fontSize: 10.8, color: C.muted, valign: 'top', lineSpacingMultiple: 1.1 })
  })
  s.addText('BACKENDLESS — BUILT ON THE OPEN x402 INDEXES', { x: MX, y: y + 0.04, w: lw, h: 0.28, fontFace: F.monoM, fontSize: 9, color: C.faint, charSpacing: 1.4 })

  // right: integrations
  const rx = MX + lw + 0.5, rw = CW - lw - 0.5
  s.addText('USE IT WHERE YOUR AGENTS LIVE', { x: rx, y: y + 0.04, w: rw, h: 0.28, fontFace: F.monoM, fontSize: 9, color: C.faint, charSpacing: 1.4 })
  // OpenClaw featured
  card(s, { x: rx, y: y + 0.4, w: rw, h: 1.76, radius: 0.12, fill: '0E1411', line: '224134' })
  s.addText([
    { text: 'OpenClaw', options: { color: C.fg, fontFace: F.bold, bold: true } },
    { text: '     LIVE', options: { color: C.accent, fontFace: F.monoM } },
  ], { x: rx + 0.3, y: y + 0.58, w: rw - 0.6, h: 0.4, valign: 'middle', fontSize: 16 })
  s.addText('A budget-bound wallet for any OpenClaw agent across 29 chains — install the ClawHub skill, add one mcp.servers entry.', { x: rx + 0.3, y: y + 1.02, w: rw - 0.6, h: 0.54, fontFace: F.body, fontSize: 10.6, color: C.muted, valign: 'top', lineSpacingMultiple: 1.14 })
  card(s, { x: rx + 0.3, y: y + 1.62, w: 3.05, h: 0.38, radius: 0.07, fill: '08120E', line: '224134', shadow: false })
  s.addText([{ text: '$ ', options: { color: C.dim } }, { text: 'clawhub install piprail', options: { color: C.accentBright } }], { x: rx + 0.44, y: y + 1.62, w: 2.8, h: 0.38, fontFace: F.mono, fontSize: 10.5, valign: 'middle' })
  // coming soon
  s.addText('MORE COMING', { x: rx, y: y + 2.36, w: rw, h: 0.26, fontFace: F.monoM, fontSize: 9, color: C.faint, charSpacing: 1.4 })
  const soon = ['Vercel AI SDK', 'Mastra', 'ElizaOS']
  const sw = (rw - 0.4) / 3
  soon.forEach((t, i) => chip(s, t, { x: rx + i * (sw + 0.2), y: y + 2.66, w: sw, h: 0.46, color: C.fgSoft, size: 10.5, fill: C.card }))
  s.addText('Each just wraps @piprail/mcp — the agent gets all seven tools, budget-bound, straight to your wallet.', { x: rx, y: y + 3.26, w: rw, h: 0.5, fontFace: F.body, fontSize: 10.2, color: C.muted, valign: 'top', lineSpacingMultiple: 1.1 })

  footer(s, 11, TOTAL)
  s.addNotes('Reach. Discovery is backendless too: Emit a crawlable openapi.json on your own origin; Register on the open 402 Index (no auth/fee); Discover reads the open indexes so agents find what to pay — nothing PipRail-hosted. Integrations: OpenClaw is LIVE (clawhub install piprail — published under the @piprail org); Vercel AI SDK, Mastra, ElizaOS next. Each integration just wraps @piprail/mcp, so the agent gets all seven tools budget-bound.')
}

// ════════════════════════════════════════════════════════════ 12 · WHY PIPRAIL WINS (moat)
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'WHY PIPRAIL WINS', { y: 0.62 })
  heading(s, [
    { text: 'Everyone else is per-ecosystem. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'PipRail is the neutral layer across all of them.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 25, h: 1.0, w: 11.8 })

  const y = 2.55, h = 1.74, g = 0.26
  // top row: 3 pillars; bottom row: 2 pillars
  const w3 = (CW - g * 2) / 3
  const top = [
    { glyph: '◎', title: 'Universal', desc: 'The only x402 SDK that’s truly chain-agnostic — 29 chains, 10 families, including the non-EVM world no one else touches.' },
    { glyph: '⛉', title: 'Backendless · $0 fee', desc: 'No facilitator, no custody, no cut. The 0% rail is the moat: chains fund PipRail instead of fighting it.' },
    { glyph: '◆', title: 'Agent-native', desc: 'An MCP server, a spend policy the model can’t exceed, and a plan → quote → pay flow built for autonomy.' },
  ]
  top.forEach((f, i) => feature(s, { x: MX + i * (w3 + g), y, w: w3, h, ...f }))
  const w2 = (CW - g) / 2
  const bot = [
    { glyph: '⊚', title: 'Open — MIT, forever', desc: 'Every driver, the SDK, the MCP. Fork it, audit it, ship it. Open is how a neutral rail wins trust.' },
    { glyph: '⚡', title: 'Live, not a whitepaper', desc: 'Mainnet-proven across 29 chains, two npm packages shipping, integrations in the wild — today.' },
  ]
  bot.forEach((f, i) => feature(s, { x: MX + i * (w2 + g), y: y + h + 0.24, w: w2, h, ...f }))

  footer(s, 12, TOTAL)
  s.addNotes('The moat, the “best on market” slide. Coinbase’s x402 SDK and the reference clients are Base/EVM-first and single-ecosystem. PipRail is the neutral layer across all of them. Five pillars: Universal (only truly chain-agnostic x402 SDK — incl. non-EVM), Backendless/$0-fee (chains fund it instead of fighting it — the 0% promise is the moat), Agent-native (MCP + spend policy + plan/quote/pay), Open (MIT), and Live (mainnet-proven, shipping). Nothing else combines universal + backendless + agent-native + open.')
}

// ════════════════════════════════════════════════════════════ 13 · TRACTION
{
  const s = S(); bg(s, 'plain')
  eyebrow(s, 'ALREADY SHIPPING', { y: 0.62 })
  heading(s, [
    { text: 'This isn’t a whitepaper. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'It’s live.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 29, h: 0.6 })
  subhead(s, 'Two packages on npm, mainnet-proven across every chain it ships, an MCP in the official registry, and the first framework integration already live.', { y: 1.7, w: 11.5, size: 13.5, h: 0.5 })

  const y = 2.56, h = 1.74, g = 0.26, w = (CW - g * 2) / 3
  const items = [
    ['@piprail/sdk + /mcp', 'Both live on npm. Publishing is tag-driven, signed CI — never by hand.'],
    ['29 chains, mainnet-proven', 'Real 402 → pay → verify → 200 round trips on live mainnets, with replay rejected.'],
    ['MCP in the official registry', 'Auto-published via GitHub OIDC — listed + isLatest. Also on Glama.'],
    ['OpenClaw — live on ClawHub', 'clawhub install piprail, published under the @piprail org. Moderation: clean.'],
    ['Live payable x402 demo', 'piprail.com/demo settles on Base mainnet — listed on x402scan + 402 Index.'],
    ['MIT open source + docs', 'Full SDK + MCP + chain docs on docs.piprail.com. Fork, audit, ship.'],
  ]
  items.forEach(([t, d], i) => {
    const col = i % 3, row = Math.floor(i / 3)
    const x = MX + col * (w + g), yy = y + row * (h + 0.24)
    card(s, { x, y: yy, w, h, radius: 0.11 })
    s.addShape(pptx.ShapeType.roundRect, { x: x + 0.24, y: yy + 0.26, w: 0.12, h: 0.12, fill: { color: C.accent }, line: { type: 'none' }, rectRadius: 0.06 })
    s.addText(t, { x: x + 0.5, y: yy + 0.16, w: w - 0.7, h: 0.5, fontFace: F.bodyS, fontSize: 13, color: C.fg, valign: 'middle', lineSpacingMultiple: 0.98 })
    s.addText(d, { x: x + 0.24, y: yy + 0.74, w: w - 0.48, h: h - 0.9, fontFace: F.body, fontSize: 10.6, color: C.muted, valign: 'top', lineSpacingMultiple: 1.12 })
  })

  footer(s, 13, TOTAL)
  s.addNotes('Traction / proof it’s real (honest: early but shipping fast). @piprail/sdk + @piprail/mcp live on npm (signed, tag-driven CI). 29 chains mainnet-proven (live-smoke-tested round trips + replay reject). MCP in the official registry (auto-published via OIDC, isLatest) + Glama. OpenClaw integration live on ClawHub under the @piprail org. Live payable x402 demo on piprail.com/demo (Base mainnet, listed on x402scan + 402 Index). MIT + full docs on docs.piprail.com.')
}

// ════════════════════════════════════════════════════════════ 14 · BUSINESS MODEL
{
  const s = S(); bg(s, 'a')
  eyebrow(s, 'THE MODEL', { y: 0.62 })
  heading(s, [
    { text: 'The rail stays free. ', options: { color: C.fg, fontFace: F.semi } },
    { text: 'The value is the network on top.', options: { color: C.accent, fontFace: F.semi } },
  ], { y: 1.0, size: 26, h: 0.7, w: 11.8 })
  subhead(s, '0% on the payment path is the moat — it’s why chains, agents and merchants adopt PipRail instead of routing around it. We monetize the layer around the free rail, never the payment itself.', { y: 1.72, w: 11.6, size: 13.5, h: 0.6 })

  // free rail anchor
  const y = 2.74
  card(s, { x: MX, y, w: CW, h: 0.92, radius: 0.12, fill: '0E1411', line: '2E5A48' })
  s.addText([
    { text: 'FREE RAIL — MIT, 0% FOREVER', options: { color: C.accent, fontFace: F.monoM } },
  ], { x: MX + 0.32, y: y + 0.16, w: 5, h: 0.3, fontSize: 10.5, charSpacing: 1.4, valign: 'top' })
  s.addText('The SDK, the MCP server, every chain driver. The distribution and the adoption flywheel — and the reason the ecosystem trusts it.', { x: MX + 0.32, y: y + 0.46, w: CW - 4.4, h: 0.4, fontFace: F.body, fontSize: 11.5, color: C.fgSoft, valign: 'top', lineSpacingMultiple: 1.05 })
  s.addText('↓  value accrues to', { x: W - MX - 3.6, y: y + 0.16, w: 3.3, h: 0.6, align: 'right', valign: 'middle', fontFace: F.bodyM, fontSize: 11, color: C.muted })

  // four paid layers
  const ly = y + 1.16, lh = 1.92, g = 0.26, w = (CW - g * 3) / 4
  const layers = [
    { tag: 'TODAY', title: 'Ecosystem', desc: 'Chain sponsorships, grants and integration partnerships fund native driver depth.' },
    { tag: 'NEXT', title: 'Managed layer', desc: 'Hosted fleet budgets, spend analytics and SLAs for teams running many agents.' },
    { tag: 'NEXT', title: 'Discovery + reputation', desc: 'Premium placement and trust scores built from real, ungameable payment receipts.' },
    { tag: 'POTENTIAL', title: 'Network token', desc: 'Align chains, agents and merchants as the rail scales — value to the network, not a toll.' },
  ]
  layers.forEach((l, i) => {
    const x = MX + i * (w + g)
    card(s, { x, y: ly, w, h: lh, radius: 0.11 })
    chip(s, l.tag, { x: x + 0.22, y: ly + 0.22, w: 1.2, h: 0.32, fill: '0E1216', line: '2A3037', color: l.tag === 'TODAY' ? C.accent : C.muted, size: 8.5, face: F.monoM, align: 'center' })
    s.addText(l.title, { x: x + 0.22, y: ly + 0.66, w: w - 0.44, h: 0.5, fontFace: F.bodyS, fontSize: 13.5, color: C.fg, valign: 'top', lineSpacingMultiple: 0.98 })
    s.addText(l.desc, { x: x + 0.22, y: ly + 1.12, w: w - 0.44, h: 0.72, fontFace: F.body, fontSize: 10.4, color: C.muted, valign: 'top', lineSpacingMultiple: 1.12 })
  })

  footer(s, 14, TOTAL)
  s.addNotes('Business model = open core. The payment path is 0% forever — that’s the moat and the distribution: chains/agents/merchants adopt because there’s no toll to route around. Monetize the LAYER around the free rail, never the rail: TODAY ecosystem (chain sponsorships, grants, integration partnerships); NEXT a managed layer (hosted fleet budgets, analytics, SLAs for teams running many agents) and premium discovery/reputation built from ungameable payment receipts; POTENTIAL a network token aligning the three sides as it scales. Framing: free rail wins adoption, value accrues to the network + management layer. Charter-safe: no fee on the payment path.')
}

// ════════════════════════════════════════════════════════════ 15 · THE ASK / CLOSE
{
  const s = S(); bg(s, 'close')
  wordmark(s, { x: mid(2.2), y: 1.2, size: 0.5, fontSize: 25 })

  heading(s, [
    { text: 'Own the payment rail for the\n', options: { color: C.fg, fontFace: F.semi } },
    { text: 'agent economy', options: { color: C.accent, fontFace: F.semi } },
    { text: '.', options: { color: C.fg, fontFace: F.semi } },
  ], { x: mid(11), y: 2.1, w: 11, size: 36, h: 1.5, align: 'center', lineSpacingMultiple: 1.0 })

  subhead(s, 'PipRail is open, neutral and already live across 29 chains. We’re raising to go from “the best x402 SDK” to the default settlement layer every agent reaches for. We’re looking for the partners who want open payment rails to win on their network.',
    { x: mid(9.6), y: 3.62, w: 9.6, size: 13.5, align: 'center', color: C.muted, h: 0.9 })

  const y = 4.74, h = 1.16, g = 0.3, w = (CW - g * 2) / 3
  const asks = [
    ['Invest', 'Fund coverage, hardening and an external audit.'],
    ['Sponsor a chain', 'Native driver depth + support on your network.'],
    ['Integrate & partner', 'Bring PipRail to your agents, docs and ecosystem.'],
  ]
  asks.forEach(([t, d], i) => {
    const x = MX + i * (w + g)
    card(s, { x, y, w, h, radius: 0.12, fill: '101216', line: C.lineHi })
    s.addText(t, { x: x + 0.26, y: y + 0.2, w: w - 0.5, h: 0.4, fontFace: F.bodyS, fontSize: 14.5, color: C.accent, valign: 'top' })
    s.addText(d, { x: x + 0.26, y: y + 0.6, w: w - 0.5, h: 0.5, fontFace: F.body, fontSize: 10.8, color: C.fgSoft, valign: 'top', lineSpacingMultiple: 1.1 })
  })

  // contact line
  s.addText([
    { text: 'piprail.com', options: { color: C.accent, fontFace: F.bodyS } },
    { text: '      github.com/piprail', options: { color: C.fgSoft, fontFace: F.body } },
    { text: '      npmjs.com/package/@piprail/sdk', options: { color: C.fgSoft, fontFace: F.body } },
  ], { x: mid(11), y: 6.28, w: 11, h: 0.4, align: 'center', valign: 'middle', fontSize: 12.5 })

  footer(s, 15, TOTAL)
  s.addNotes('The ask. PipRail is open, neutral, live across 29 chains — raising to become the default agent settlement layer. Three ways in: Invest (fund coverage, hardening, external audit), Sponsor a chain (native driver depth on your network), Integrate & partner (bring PipRail to your agents/docs/ecosystem). Contact: piprail.com · github.com/piprail · npmjs.com/package/@piprail/sdk · john.weeks.dev@gmail.com.')
}

await pptx.writeFile({ fileName: OUT })
console.log('wrote', OUT)
