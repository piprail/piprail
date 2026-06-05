// An HONEST x402 merchant — Express + the SDK's own `requirePayment`. Every 402 is
// a genuine challenge from the SDK's accept side. EVM-only, so this example
// installs standalone with just `viem`.

import express from 'express'
import { requirePayment } from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'

export const MERCHANT_ADDRESS = privateKeyToAccount('0x' + '1'.repeat(64)).address
const UNKNOWN_TOKEN = '0x' + 'a'.repeat(40) // no SDK preset → unpriceable

export function createMerchantApp(rpcUrl) {
  const app = express()
  const gate = (o) => requirePayment({ payTo: MERCHANT_ADDRESS, ...(rpcUrl ? { rpcUrl } : {}), ...o })

  app.get('/free', (_req, res) => res.json({ ok: true, note: 'free' }))
  app.get('/cheap', gate({ chain: 'base', token: 'USDC', amount: '0.05', description: 'Quarterly report' }),
    (_req, res) => res.json({ secret: 'cheap report' }))
  app.get('/pricey', gate({ chain: 'base', token: 'USDC', amount: '0.50' }),
    (_req, res) => res.json({ secret: 'pricey report' }))
  app.get('/exotic', gate({ chain: 'base', token: { address: UNKNOWN_TOKEN, decimals: 6 }, amount: '0.01' }),
    (_req, res) => res.json({ secret: 'exotic' }))
  app.get('/native', gate({ chain: 'base', token: 'native', amount: '0.00001' }),
    (_req, res) => res.json({ secret: 'native' }))
  app.post('/echo', express.json(), (req, res) => res.json({ echoed: req.body, method: req.method }))

  return app
}

export function startMerchant(rpcUrl, port = 0) {
  const app = createMerchantApp(rpcUrl)
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMerchant(undefined, Number(process.env.PORT ?? 8403))
  console.log(`honest SDK merchant on ${url} (payTo ${MERCHANT_ADDRESS})`)
}
