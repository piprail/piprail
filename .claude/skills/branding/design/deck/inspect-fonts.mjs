// Read the OpenType `name` table of each downloaded TTF so we know the exact
// family name PowerPoint will register the embedded font under.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = join(dirname(fileURLToPath(import.meta.url)), 'assets/fonts')

function names(buf) {
  const u16 = (o) => buf.readUInt16BE(o), u32 = (o) => buf.readUInt32BE(o)
  const num = u16(4); let nameOff = 0
  for (let i = 0; i < num; i++) { const r = 12 + i * 16; if (buf.toString('ascii', r, r + 4) === 'name') { nameOff = u32(r + 8); break } }
  const count = u16(nameOff + 2), strOff = nameOff + u16(nameOff + 4), out = {}
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12
    const plat = u16(r), nameID = u16(r + 6), len = u16(r + 8), off = u16(r + 10)
    if (![1, 2, 16, 17].includes(nameID)) continue
    const base = strOff + off; let s = ''
    if (plat === 3) { for (let k = 0; k < len; k += 2) s += String.fromCharCode(buf.readUInt16BE(base + k)) }
    else s = buf.toString('latin1', base, base + len)
    if (out[nameID] === undefined) out[nameID] = s
  }
  return out
}
for (const f of readdirSync(dir).filter((f) => f.endsWith('.ttf')).sort()) {
  const n = names(readFileSync(join(dir, f)))
  console.log(f.padEnd(26), '| fam:', JSON.stringify(n[1]), 'sub:', JSON.stringify(n[2]), 'typFam:', JSON.stringify(n[16] || ''), 'typSub:', JSON.stringify(n[17] || ''))
}
