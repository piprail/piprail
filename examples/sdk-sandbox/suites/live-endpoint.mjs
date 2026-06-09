// Suite: pay the LIVE piprail.com/x402/demo endpoint via BOTH rails, for real.
//   • onchain-proof — the PipRail client (backendless; broadcasts on Base, server reads it)
//   • exact         — the @x402/fetch reference client (signs EIP-3009; PayAI settles)
//
// Real Base-mainnet money, TINY ($0.01 each). Reads the payer key from
// ../../../.secrets/wallets/evm-wallet.json. SKIPS cleanly if that or @x402/* is absent.
//
//   node suites/live-endpoint.mjs            # default https://piprail.com/x402/demo
//   X402_URL=… node suites/live-endpoint.mjs # override target

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { PipRailClient } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const URL = process.env.X402_URL || 'https://piprail.com/x402/demo'
const here = path.dirname(fileURLToPath(import.meta.url))
const secretsPath = path.resolve(here, '../../../.secrets/wallets/evm-wallet.json')

const readBody = async (res) => { try { return await res.json() } catch { return { _text: await res.text() } } }

async function run() {
  group(`live · paying ${URL}`)

  if (!fs.existsSync(secretsPath)) { note('SKIPPED — no .secrets/wallets/evm-wallet.json'); return summarize() }
  const PAYER = JSON.parse(fs.readFileSync(secretsPath, 'utf8')).privateKey

  // ── Rail 1: onchain-proof (PipRail backendless client) ─────────────────────
  group('live · rail 1 — onchain-proof (PipRail client)')
  try {
    const client = new PipRailClient({
      chain: 'base',
      wallet: { privateKey: PAYER },
      rpcUrl: 'https://mainnet.base.org',
      onEvent: (e) => note(`  · ${e.type}${e.detail ? ' — ' + e.detail : ''}`),
    })
    const res = await client.fetch(URL)
    const body = await readBody(res)
    check('onchain-proof → HTTP 200', res.status === 200, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`)
    check('receipt scheme is onchain-proof', body?.receipt?.scheme === 'onchain-proof', `scheme=${body?.receipt?.scheme}`)
    check('receipt carries a Base tx hash', /^0x[0-9a-fA-F]{64}$/.test(body?.receipt?.transaction || ''), `tx=${body?.receipt?.transaction}`)
    if (body?.receipt?.transaction) note(`  tx: https://basescan.org/tx/${body.receipt.transaction}`)
  } catch (e) {
    check('onchain-proof payment completed', false, `threw: ${e.message}`)
  }

  // ── Rail 2: exact (the official @x402 reference client → PayAI facilitator) ─
  group('live · rail 2 — exact (@x402/fetch → PayAI)')
  let x402
  try {
    const [fetchMod, evmMod] = await Promise.all([import('@x402/fetch'), import('@x402/evm')])
    x402 = { ...fetchMod, ...evmMod }
  } catch {
    note('SKIPPED — @x402/fetch / @x402/evm not installed')
    return summarize()
  }
  try {
    const account = privateKeyToAccount(PAYER)
    const signer = x402.toClientEvmSigner(account)
    const client = new x402.x402Client().register('eip155:8453', new x402.ExactEvmScheme(signer))
    const fetchWithPay = x402.wrapFetchWithPayment(fetch, client)
    const res = await fetchWithPay(URL)
    const body = await readBody(res)
    check('exact → HTTP 200 (a stock x402 client unlocked it)', res.status === 200, `status=${res.status} body=${JSON.stringify(body).slice(0, 300)}`)
    check('receipt scheme is exact', body?.receipt?.scheme === 'exact', `scheme=${body?.receipt?.scheme}`)
    check('receipt carries a Base tx hash (PayAI settled)', /^0x[0-9a-fA-F]{64}$/.test(body?.receipt?.transaction || ''), `tx=${body?.receipt?.transaction}`)
    if (body?.receipt?.transaction) note(`  tx: https://basescan.org/tx/${body.receipt.transaction}`)
  } catch (e) {
    check('exact payment completed', false, `threw: ${e.message}`)
  }

  return summarize()
}

run().then((ok) => process.exit(ok ? 0 : 1))
