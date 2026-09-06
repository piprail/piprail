import { readFileSync } from 'node:fs'
const s = readFileSync('/Users/john/Sites/piprail/site/src/data/facilitators.ts', 'utf8')

/* The naive indexOf('[') lands on the `FacilitatorChain[]` type annotation, not
   the array. Anchor on the assignment, then match brackets. */
const marker = 'facilitatorCoverage: FacilitatorChain[] = '
const from = s.indexOf(marker)
if (from === -1) throw new Error('marker not found')
const start = s.indexOf('[', from + marker.length - 1)
let depth = 0
let end = -1
let inStr = false
for (let i = start; i < s.length; i++) {
  const ch = s[i]
  if (inStr) {
    if (ch === '\\') i++
    else if (ch === '"') inStr = false
    continue
  }
  if (ch === '"') inStr = true
  else if (ch === '[') depth++
  else if (ch === ']') {
    depth--
    if (depth === 0) { end = i + 1; break }
  }
}
const data = JSON.parse(s.slice(start, end))

console.log('chains covered:', data.length)
console.log('  ' + data.map((c) => c.chain).join(', '))

const all = data.flatMap((c) => c.facilitators)
const byName = new Map()
for (const c of data) {
  for (const f of c.facilitators) {
    if (!byName.has(f.name)) byName.set(f.name, { host: f.host, keyless: f.keyless, chains: [] })
    byName.get(f.name).chains.push(c.chain)
  }
}
console.log('\ndistinct facilitators:', byName.size)
for (const [n, v] of byName) {
  console.log('  ' + n.padEnd(16) + v.host.padEnd(36) + (v.keyless ? 'keyless' : 'GATED  ') + '  ' + v.chains.join(', '))
}
console.log('\npairings (chain x facilitator):', all.length)
console.log('live-settled receipts:', all.flatMap((f) => f.txs).filter((t) => t.full).length)
console.log('every entry keyless?', all.every((f) => f.keyless))
