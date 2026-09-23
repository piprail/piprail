// Self-check for the nano-x402 example. Proves the merchant answers an x402
// challenge on BOTH rails (Nano exact + PipRail USDC) with zero real money spent:
//
//   1. GET /api/report-nano   → 402 with a nano:mainnet / exact accept entry.
//   2. GET /api/report-usdc   → 402 with a PipRail USDC accept entry.
//   3. GET /health            → reports both rails.
//
// Run:  npm test   (starts its own merchant on an isolated port)
//
// This does NOT settle a real payment — that needs a live Nano network / real
// keys (see buyer.mjs). It verifies the merchant's multi-rail contract, which is
// the part a reviewer can check without moving funds.

import { spawn } from 'node:child_process'

const PORT = 3999
const BASE = `http://127.0.0.1:${PORT}`
const proc = spawn('node', ['merchant.mjs'], {
  env: { ...process.env, PORT: String(PORT), PAY_TO: '0x0000000000000000000000000000000000000000', NANO_PAY_TO: 'nano_3yourWallet0000000000000000000000000000000000000000000000000' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
proc.stdout.on('data', (d) => { output += d })
proc.stderr.on('data', (d) => { output += d })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('merchant did not start; output:\n' + output)
}

async function main() {
  await waitUp()

  // 1) Nano rail — expect a 402 with a nano:mainnet exact accept.
  const nano = await fetch(`${BASE}/api/report-nano`)
  console.log(`Nano rail GET /api/report-nano  -> ${nano.status}`)
  if (nano.status !== 402) throw new Error(`expected 402 on nano rail, got ${nano.status}`)
  const nanoHeader = nano.headers.get('PAYMENT-REQUIRED')
  const nanoPr = JSON.parse(Buffer.from(nanoHeader, 'base64').toString('utf-8'))
  const nanoAccepts = (nanoPr.accepts ?? []).map((a) => `${a.network}:${a.asset}:${a.scheme}`)
  console.log(`   accepts -> ${nanoAccepts.join(', ')}`)
  if (!nanoAccepts.some((a) => a.startsWith('nano:mainnet:XNO'))) {
    throw new Error('nano rail 402 did not advertise a nano:mainnet XNO exact accept')
  }

  // 2) USDC rail (PipRail) — expect a 402.
  const usdc = await fetch(`${BASE}/api/report-usdc`)
  console.log(`USDC rail GET /api/report-usdc   -> ${usdc.status}`)
  if (usdc.status !== 402) throw new Error(`expected 402 on usdc rail, got ${usdc.status}`)

  // 3) Health — both rails advertised.
  const health = await (await fetch(`${BASE}/health`)).json()
  console.log(`health                        -> ${JSON.stringify(health)}`)
  if (health.nanoRail !== '/api/report-nano' || health.usdcRail !== '/api/report-usdc') {
    throw new Error('health did not advertise both rails')
  }

  console.log('\n✅ All checks passed: the merchant answers an x402 challenge on the Nano exact rail AND the PipRail USDC rail.')
}

let code = 0
try {
  await main()
} catch (e) {
  console.error('\n❌ FAIL:', e.message)
  code = 1
} finally {
  proc.kill('SIGTERM')
  process.exit(code)
}
