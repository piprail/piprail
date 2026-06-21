// LIVE mainnet smoke — PipRail's OWN buyer pays the public piprail.com/x402/demo endpoint across
// EVERY rail it implements, for real, against the INSTALLED `@piprail/sdk` (the published artifact —
// bump the pin in package.json to test a new release). This is the buyer-side companion to
// `live-endpoint.mjs`: that one drives the EXACT rail with the @x402 *reference* client; this one
// drives it with PipRail's OWN `payExactRail` — so it directly exercises the code that ships.
//
//   • exact ×2   — PipRail signs EIP-3009, the gate's PayAI facilitator settles (buyer pays ZERO gas)
//   • onchain-proof — PipRail broadcasts on Base + the gate reads it (buyer pays gas)
//   • autoRoute  — PipRail picks the cheapest settleable rail (the gasless exact one)
//
// The demo's payTo is a test merchant, $0.01 USDC each — tiny. Reads the payer key from
// ../../../../.secrets/wallets/evm-wallet.json; SKIPS cleanly (never fails) if it's absent.
//
//   node suites/live-piprail-rails.mjs            # default https://piprail.com/x402/demo
//   X402_URL=… BASE_RPC=… node suites/live-piprail-rails.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PipRailClient } from '@piprail/sdk'
import { group, check, note, summarize } from '../lib/report.mjs'

const URL = process.env.X402_URL || 'https://piprail.com/x402/demo'
const RPC = process.env.BASE_RPC || 'https://mainnet.base.org'
const here = path.dirname(fileURLToPath(import.meta.url))
const secretsPath = path.resolve(here, '../../../../.secrets/wallets/evm-wallet.json')
const readBody = async (res) => { try { return await res.json() } catch { return { _text: await res.text() } } }

// Pay the demo once on the given scheme set; assert it settled cleanly through PipRail's client.
async function pay(label, schemes, { autoRoute = false } = {}, PAYER) {
  group(`live · ${label}`)
  const events = []
  const client = new PipRailClient({ chain: 'base', wallet: { key: PAYER }, rpcUrl: RPC, schemes, onEvent: (e) => events.push(e.kind) })
  try {
    const res = await client.fetch(URL, autoRoute ? { autoRoute: true } : undefined)
    const body = await readBody(res)
    const spent = client.spent()
    const rec = spent.records[0]
    check('HTTP 200 — resource unlocked', res.status === 200, `status=${res.status}`)
    check('settled exactly once', spent.count === 1, `count=${spent.count}`)
    check('no payment-failed / payment-declined event', !events.some((k) => k === 'payment-failed' || k === 'payment-declined'), events.join(' → '))
    check('the receipt carries a real ref', !!rec?.ref, `ref=${rec?.ref}`)
    check('the body confirms payment', body && body.paid === true, JSON.stringify(body).slice(0, 70))
    note(`events: ${events.join(' → ')}`)
  } catch (err) {
    check('paid without throwing', false, err?.message ?? String(err))
  }
}

export async function run() {
  group(`live · PipRail buyer → ${URL}`)
  if (!fs.existsSync(secretsPath)) { note('SKIPPED — no .secrets/wallets/evm-wallet.json'); return summarize() }
  const PAYER = JSON.parse(fs.readFileSync(secretsPath, 'utf8')).privateKey

  // Preflight (read-only): SKIP cleanly — never fail — if the payer is underfunded or the RPC is
  // down. A live suite must not turn an empty test wallet or a flaky public RPC into a red CI run.
  try {
    const plan = await new PipRailClient({ chain: 'base', wallet: { key: PAYER }, rpcUrl: RPC }).planPayment(URL)
    if (!plan?.payable) { note(`SKIPPED — payer not ready on Base: ${plan?.fundingHint ?? 'top up USDC (+ a little ETH for onchain-proof)'}`); return summarize() }
  } catch (err) {
    note(`SKIPPED — preflight read failed (RPC down/throttled?): ${err?.message ?? err}`)
    return summarize()
  }

  await pay('exact #1 — PipRail signs, PayAI settles (buyer gasless)', ['exact'], {}, PAYER)
  await pay('exact #2 — fresh nonce (no replay / re-pay)', ['exact'], {}, PAYER)
  await pay('onchain-proof — PipRail broadcasts + pays gas', ['onchain-proof'], {}, PAYER)
  await pay('autoRoute — cheapest settleable rail', ['onchain-proof', 'exact'], { autoRoute: true }, PAYER)
  return summarize()
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await run())
