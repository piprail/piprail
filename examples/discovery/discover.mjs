// DISCOVER — find payable x402 resources on the open indexes (free, read-only).
//
//   npm run discover
//   QUERY="weather" NETWORK=any npm run discover
//
// client.discover() merges the open indexes (CDP Bazaar + 402 Index). No wallet
// spend, no signature — just a read. `network: 'self'` (default) filters to the
// client's chain; 'any' searches all chains; or pass a CAIP-2 id.

import { PipRailClient } from '@piprail/sdk'

const QUERY = process.env.QUERY ?? 'api'
const NETWORK = process.env.NETWORK ?? 'any' // 'self' | 'any' | a CAIP-2 id like 'eip155:8453'

// No funds needed for a read — a throwaway key is fine; discovery never pays.
const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: '0x' + '1'.repeat(64) },
})

console.log(`discover({ query: ${JSON.stringify(QUERY)}, network: ${JSON.stringify(NETWORK)} }) — reading the open indexes…\n`)

const hits = await client.discover({ query: QUERY, network: NETWORK, limit: 10 })

console.log(`→ ${hits.length} resource(s):\n`)
for (const h of hits) {
  const rail = h.rails?.[0]
  const price = h.priceUsd != null ? `$${h.priceUsd}` : '—'
  console.log(`• ${h.resource}`)
  console.log(`    ${h.name ?? '(no name)'}  ·  ${price}  ·  via ${h.source}  ·  ${rail?.scheme ?? '?'} on ${rail?.network ?? '?'}`)
}
if (!hits.length) console.log('(no matches — try a different QUERY, or NETWORK=any)')

// To actually pay one: const res = await client.fetch(hits[0].resource)  // quote → plan → pay
