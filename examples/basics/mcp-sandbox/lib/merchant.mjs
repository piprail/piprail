// An HONEST x402 merchant — Express + the SDK's own `requirePayment`, so every
// 402 challenge is genuine (not a hand-rolled mock). EVM-only, so this example
// installs standalone with just `viem` (no optional non-EVM peers needed).
//
//   node lib/merchant.mjs        # standalone, on PORT (default 8402)
//
// Issuing a 402 needs no chain access (the USDC preset is built in); the payer
// side — the real @piprail/mcp subprocess — is what reads these challenges.

import express from 'express'
import { requirePayment } from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'

// A valid, checksummed Base address to receive — derived from a throwaway key.
export const MERCHANT_ADDRESS = privateKeyToAccount('0x' + '1'.repeat(64)).address

// A custom token the SDK ships no preset for → describeAsset() returns null →
// recognized:false → refused unless allowUnknownTokens.
const UNKNOWN_TOKEN = '0x' + 'a'.repeat(40)

export function createMerchantApp() {
  const app = express()
  const gate = (o) => requirePayment({ payTo: MERCHANT_ADDRESS, ...o })

  // Free — no payment.
  app.get('/free', (_req, res) => res.json({ ok: true, note: 'free — no payment required' }))

  // Paid routes (all on Base).
  app.get('/cheap', gate({ chain: 'base', token: 'USDC', amount: '0.05', description: 'Quarterly report' }),
    (_req, res) => res.json({ secret: 'cheap report', price: '0.05 USDC' }))
  app.get('/pricey', gate({ chain: 'base', token: 'USDC', amount: '0.50' }),
    (_req, res) => res.json({ secret: 'pricey report' }))
  app.get('/exotic', gate({ chain: 'base', token: { address: UNKNOWN_TOKEN, decimals: 6 }, amount: '0.01' }),
    (_req, res) => res.json({ secret: 'exotic report' }))
  app.get('/native', gate({ chain: 'base', token: 'native', amount: '0.00001' }),
    (_req, res) => res.json({ secret: 'native-coin report' }))

  // Free POST that echoes the JSON body — exercises the pay tool's POST + body
  // serialization (object → JSON + content-type) round-trip through the SDK.
  app.post('/echo', express.json(), (req, res) => res.json({ echoed: req.body, method: req.method }))

  return app
}

export function startMerchant(port = 0) {
  const app = createMerchantApp()
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8402)
  const { url } = await startMerchant(port)
  console.log(`honest merchant on ${url}  (payTo ${MERCHANT_ADDRESS})`)
  console.log('  GET /free  GET /cheap(0.05)  GET /pricey(0.50)  GET /exotic(unknown)  GET /native  POST /echo')
}
