// Merchant that answers an x402 challenge on TWO rails: EVM-USDC (via PipRail)
// and Nano / XNO (via the @x402nano/exact scheme). One logical /api/report resource;
// a caller pays whichever rail it holds a wallet for.
//
// Run:
//   npm install
//   NANO_PAY_TO=nano_3yourWallet… node merchant.mjs        # Nano rail
//   PAY_TO=0xYourWallet… node merchant.mjs                  # USDC rail on /api/report-usdc
//
// Env: PORT (default 3000), PAY_TO (USDC wallet, 0x…), NANO_PAY_TO (nano_3…),
//      NANO_RPC_URL / NANO_WORK_GENERATION_URL (default public rpc.nano.to).
//
// The Nano rail is served by @x402nano/exact's Resource Server, which returns a
// real 402 challenge payable on nano:mainnet. See test.mjs for a self-check that
// exercises the two-rail flow against a stub (no live Nano money spent).

import express from 'express'
import { requirePayment } from '@piprail/sdk'
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { ExactNanoScheme } from '@x402nano/exact/server'
import { startStubFacilitator } from './facilitator-stub.mjs'

const PORT = Number(process.env.PORT ?? 3000)
const app = express()

// ---------------------------------------------------------------------------
// Rail 1 — EVM-USDC, gated by PipRail (existing behavior, unchanged)
// ---------------------------------------------------------------------------
const payTo = process.env.PAY_TO ?? '0xYourWallet…'
app.get('/api/report-usdc', requirePayment({
  chain: 'base',
  token: 'USDC',
  amount: '0.05',
  payTo,
  onPaid: (r) => console.log(`USDC rail paid: ${r.amountFormatted} ${r.symbol}`),
}))

// ---------------------------------------------------------------------------
// Rail 2 — Nano / XNO, gated by the x402 exact scheme (feeless, sub-second)
// ---------------------------------------------------------------------------
const nanoPayTo = process.env.NANO_PAY_TO ?? 'nano_3yourWallet…'
// If no real facilitator is configured, start a local stub so the merchant can
// run keyless and return 402 challenges immediately. Point FACILITATOR_URL at a
// real x402 Nano facilitator for actual verify/settle (see README Keyless note).
let externalFacilitatorUrl = process.env.FACILITATOR_URL
let stubFacilitator
if (!externalFacilitatorUrl) {
  stubFacilitator = await startStubFacilitator()
  externalFacilitatorUrl = stubFacilitator.url
}
const facilitator = new HTTPFacilitatorClient({ url: externalFacilitatorUrl })
const nanoServer = new x402ResourceServer(facilitator)
const exactNano = new ExactNanoScheme()
nanoServer.register('nano:mainnet', exactNano)

const NANO_ENDPOINT = '/api/report-nano'
const nanoConfig = {
  scheme: 'exact',
  network: 'nano:mainnet',
  price: process.env.PAYMENT_REQUIREMENT_AMOUNT ?? '0.001', // XNO
  payTo: nanoPayTo,
  description: 'Paid report — settles on the Nano rail',
  mimeType: 'application/json',
}

async function nanoMiddleware(req, res, next) {
  if (req.method !== 'GET' || req.path !== NANO_ENDPOINT) return next()
  const headers = req.headers
  const payment = headers['payment-signature'] || headers['PAYMENT-SIGNATURE'] || headers['x-payment']

  if (!payment) {
    const [pr] = await nanoServer.buildPaymentRequirements(nanoConfig)
    const paymentRequired = await nanoServer.createPaymentRequiredResponse([pr], {
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      description: nanoConfig.description,
      mimeType: nanoConfig.mimeType,
    })
    res.status(402)
    res.set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'))
    res.json({ error: 'Payment Required', message: 'Pay the Nano rail to unlock /api/report-nano' })
    return
  }

  try {
    const payload = JSON.parse(Buffer.from(payment, 'base64').toString('utf-8'))
    const verify = await nanoServer.verifyPayment(payload, (await nanoServer.buildPaymentRequirements(nanoConfig))[0])
    if (!verify.isValid) {
      res.status(402).json({ error: 'Invalid Payment', reason: verify.invalidReason })
      return
    }
    const settle = await nanoServer.settlePayment(payload, (await nanoServer.buildPaymentRequirements(nanoConfig))[0])
    if (!settle.success) {
      res.status(402).json({ error: 'Invalid Payment', reason: settle.errorReason })
      return
    }
    res.set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settle)).toString('base64'))
    next()
  } catch (e) {
    res.status(500).json({ error: 'Payment Processing Error', message: e?.message ?? String(e) })
  }
}
app.use(nanoMiddleware)
app.get(NANO_ENDPOINT, (req, res) => {
  res.json({ data: 'Here is your paid report (settled on the Nano rail)', timestamp: new Date().toISOString() })
})

app.get('/health', (req, res) => res.json({ ok: true, nanoRail: '/api/report-nano', usdcRail: '/api/report-usdc' }))

await nanoServer.initialize()
app.listen(PORT, () => {
  console.log(`Merchant listening on http://127.0.0.1:${PORT}`)
  console.log(`  Nano rail : GET /api/report-nano  (x402 exact, nano:mainnet, feeless)`)
  console.log(`  USDC rail : GET /api/report-usdc  (PipRail onchain-proof, base)`)
  console.log(`  health    : GET /health`)
  console.log(`  facilitator: ${stubFacilitator ? `${externalFacilitatorUrl} (local stub — set FACILITATOR_URL for a real one)` : externalFacilitatorUrl}`)
})
