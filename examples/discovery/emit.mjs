// EMIT — turn your payment gate into the machine-readable files crawlers + agents read.
//
//   npm run emit
//
// Pure functions, no network: gate.describe() produces a nonce-free description of
// what you charge, and the three emitters serialize it. Serve the output as static
// files on YOUR OWN origin — that's how the open x402 indexes find you.

import { createPaymentGate, buildOpenApi, buildWellKnownX402, buildX402DnsTxt } from '@piprail/sdk'

const ORIGIN = process.env.ORIGIN ?? 'https://api.example.com'
const PAY_TO = process.env.PAY_TO ?? '0x1111111111111111111111111111111111111111'

// The same gate you'd use to charge for the route (Base + USDC, 0.05).
const gate = createPaymentGate({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo: PAY_TO,
  description: 'Market report',
})

// A nonce-free description of the resource (safe to publish — it's not a challenge).
const resource = await gate.describe(`${ORIGIN}/report`)

// 1) OpenAPI 3.1 — the convention the open indexes parse. Each priced operation
//    carries an `x-payment-info` block; the document carries an `x-generator` stamp.
const openapi = buildOpenApi({ origin: ORIGIN, resources: [resource] })

// 2) /.well-known/x402 — a simple list of your payable resource URLs.
const wellKnown = buildWellKnownX402({ origin: ORIGIN, resources: [resource] })

// 3) _x402 DNS TXT — points crawlers at your discovery document.
const dns = buildX402DnsTxt({ host: 'api.example.com', discoveryUrl: `${ORIGIN}/openapi.json` })

console.log('— serve at  GET %s/openapi.json —', ORIGIN)
console.log(JSON.stringify(openapi, null, 2))
console.log('\n— serve at  GET %s/.well-known/x402 —', ORIGIN)
console.log(JSON.stringify(wellKnown, null, 2))
console.log('\n— add a DNS TXT record —')
console.log(`${dns.name}  TXT  "${dns.value}"`)
console.log('\nx-generator stamp:', openapi['x-generator'] ?? '(none — attribution:false)')
