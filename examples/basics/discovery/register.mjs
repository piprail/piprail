// REGISTER — list an x402 endpoint you run on the open indexes so agents can find it.
//
//   URL="https://api.yoursite.com/report" npm run register
//
// client.register() POSTs to 402 Index by default — no auth, no signature, any chain.
// The index PROBES your URL and only lists endpoints that actually return a 402, so a
// non-402 URL is rejected (no junk listing). It moves no funds. To also list on
// x402scan (SIWX, Base/Solana only), pass { targets: ['402index', 'x402scan'] }.

import { PipRailClient } from '@piprail/sdk'

// Default to a URL that ISN'T a 402 endpoint, so a no-arg run safely demonstrates the
// index's probe + graceful rejection instead of creating a real listing. Pass your own
// deployed 402 URL to actually list it.
const URL = process.env.URL ?? 'https://example.com'

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: '0x' + '1'.repeat(64) }, // registration signs nothing on 402 Index
})

console.log(`register(${JSON.stringify(URL)}) → 402 Index (no auth, any chain)…\n`)

const outcomes = await client.register(URL, { name: 'Market report', priceUsd: 0.05 })

for (const o of outcomes) {
  if (o.ok) {
    console.log(`✓ ${o.source}: ${o.detail ?? 'listed'}`)
  } else {
    console.log(`✗ ${o.source}: ${o.detail ?? `HTTP ${o.status}`}`)
    console.log('  (expected for a non-402 URL — 402 Index probes it and only lists real 402 endpoints.)')
  }
}
