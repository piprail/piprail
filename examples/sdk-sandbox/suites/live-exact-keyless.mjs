// LIVE mainnet smoke — `exact: true` ZERO-CONFIG GASLESS on real Base USDC, TINY amounts.
// Proves the headline end-to-end with real money: the gate is configured with a SINGLE LINE
// (`exact: true`, NO relayer key), auto-picks a known KEYLESS facilitator (PayAI) for Base,
// the payer signs an EIP-3009 authorization (spends ZERO gas), the FACILITATOR broadcasts +
// pays the gas, USDC moves on Base mainnet, and BOTH the payer AND the merchant spend ZERO
// gas (no relayer — the facilitator sponsors everything). Then a replay is rejected.
//
// This is the proof that the gasless keyless path works 100%, not just self-settle.
//
// LOCAL ONLY. Reads keys from ../../../.secrets — never prints or commits them. Imports the
// LOCAL SDK build. Run: node suites/live-exact-keyless.mjs   (after `npm run build` in sdk/).
// Skips cleanly (never fails) if the wallet is underfunded or the facilitator is unavailable.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, http, erc20Abi, getAddress, formatUnits, formatEther } from 'viem'
import { base } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { requirePayment, buildExactAuthorization, firstKeylessFacilitator } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.BASE_RPC ?? 'https://base-rpc.publicnode.com'
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const AMOUNT = '0.001' // 1000 base units — tiny
const AMOUNT_BASE = 1000n
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildPayHeader(url, payerAccount) {
  const challenge = await (await fetch(url)).json()
  const rail = challenge.accepts.find((a) => a.scheme === 'exact')
  const accept = { scheme: 'exact', network: rail.network, maxAmountRequired: rail.amount, asset: rail.asset, payTo: rail.payTo, maxTimeoutSeconds: rail.maxTimeoutSeconds, extra: { name: rail.extra.name, version: rail.extra.version } }
  const { authorization, signature } = await buildExactAuthorization({ account: payerAccount, accept, chainId: 8453, now: Math.floor(Date.now() / 1000), nonce: `0x${randomBytes(32).toString('hex')}` })
  return b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })
}

export async function run() {
  group('LIVE · exact: true keyless gasless — Base mainnet USDC (real money, tiny)')

  let w
  try {
    w = JSON.parse(readFileSync(resolve(HERE, '../../../.secrets/wallets/evm-wallet.json'), 'utf8'))
  } catch {
    note('SKIPPED — no .secrets/wallets/evm-wallet.json (local-only test).')
    return
  }

  const payer = mnemonicToAccount(w.mnemonic, { addressIndex: 0 })   // signs; needs USDC, NO gas
  const merchant = mnemonicToAccount(w.mnemonic, { addressIndex: 1 }).address // payTo; NO relayer key used
  const pub = createPublicClient({ chain: base, transport: http(RPC) })
  const usdc = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  const eth = (a) => pub.getBalance({ address: a })

  const fac = firstKeylessFacilitator('eip155:8453')
  note(`exact: true will auto-pick keyless facilitator: ${fac?.url ?? '(none seeded!)'}`)
  if (!fac) { note('SKIPPED — no keyless facilitator seeded for Base.'); return }

  const payerUsdc = await usdc(payer.address)
  note(`payer ${payer.address}  USDC ${formatUnits(payerUsdc, 6)}  ETH ${formatEther(await eth(payer.address))}`)
  note(`merchant/payTo ${merchant}  (NO relayer — the facilitator pays all gas)`)
  if (payerUsdc < AMOUNT_BASE) {
    note(`SKIPPED — payer needs ≥ ${AMOUNT} USDC on Base (fund ${payer.address}). It can hold ZERO ETH — that's the point.`)
    return
  }

  // The gate: ONE LINE of gasless config. No relayer, no facilitator URL — `exact: true` auto-picks.
  const app = express()
  app.get('/paid', requirePayment({
    chain: 'base', token: 'USDC', amount: AMOUNT, payTo: merchant, rpcUrl: RPC,
    exact: true,
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts.find((a) => a.scheme === 'exact')
    check('exact: true auto-advertised a gasless exact rail (real USDC domain, no relayer configured)', rail?.extra?.name === 'USD Coin' && rail?.extra?.version === '2', JSON.stringify(rail?.extra))
    check('onchain-proof floor is also advertised', ch.accepts.some((a) => a.scheme === 'onchain-proof'))

    group('LIVE · gasless keyless round-trip (facilitator sponsors ALL gas)')
    const m0 = await usdc(merchant), p0 = await usdc(payer.address)
    const pe0 = await eth(payer.address), me0 = await eth(merchant)
    const header = await buildPayHeader(url, payer)
    const r = await fetch(url, { headers: { 'payment-signature': header } })
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — resource unlocked by a real GASLESS keyless payment', r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 240)}`)
    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      check('receipt scheme is exact + has a real settle tx hash', receipt.scheme === 'exact' && /^0x[0-9a-f]{64}$/i.test(receipt.transaction || ''), receipt.transaction)
      note(`settled tx (facilitator-broadcast): https://basescan.org/tx/${receipt.transaction}`)
      await sleep(4000)
      check(`merchant received exactly ${AMOUNT} USDC on mainnet`, (await usdc(merchant)) - m0 === AMOUNT_BASE, `delta=${(await usdc(merchant)) - m0}`)
      check(`payer USDC dropped by exactly ${AMOUNT}`, p0 - (await usdc(payer.address)) === AMOUNT_BASE)
      check('payer spent ZERO gas (ETH unchanged)', (await eth(payer.address)) === pe0)
      check('merchant spent ZERO gas (ETH unchanged — NO relayer; the FACILITATOR paid)', (await eth(merchant)) === me0)

      group('LIVE · replay rejection')
      const replay = await fetch(url, { headers: { 'payment-signature': header } })
      const rb = await replay.json().catch(() => ({}))
      check('replaying the SAME authorization → 402 tx_already_used',
        replay.status === 402 && (rb.extensions?.piprail?.code === 'tx_already_used' || /already/.test(rb.error ?? '')),
        `status=${replay.status} code=${rb.extensions?.piprail?.code}`)
    } else if (r.status === 502) {
      note(`facilitator settle failed (502) — fallback hint: ${body.fallback ?? body.detail}`)
      note('This is the graceful path: a buyer would retry the onchain-proof rail (paying gas).')
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
