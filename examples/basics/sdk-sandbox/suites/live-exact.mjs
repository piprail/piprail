// LIVE mainnet smoke — the STANDARD x402 `exact` rail on REAL Base USDC, TINY amounts.
// Proves the rail end-to-end with real money: payer signs an EIP-3009 authorization
// (spends ZERO gas), the merchant's relayer broadcasts transferWithAuthorization, USDC
// moves on Base mainnet, the gate verifies + issues a receipt — and a replay is rejected.
//
// LOCAL ONLY. Reads keys from ../../../../.secrets — never prints or commits them. Imports
// the LOCAL SDK build. Run: node suites/live-exact.mjs   (after `npm run build` in sdk/).
// Skips cleanly (never fails) if the wallets are underfunded.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, http, erc20Abi, getAddress, formatUnits, formatEther } from 'viem'
import { base } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { requirePayment, buildExactAuthorization } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.BASE_RPC ?? 'https://base-rpc.publicnode.com'
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const AMOUNT = '0.0005' // 500 base units — tiny
const AMOUNT_BASE = 500n
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const randNonce = () => `0x${randomBytes(32).toString('hex')}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildPayHeader(url, payerAccount) {
  const challenge = await (await fetch(url)).json()
  const rail = challenge.accepts.find((a) => a.scheme === 'exact')
  const now = Math.floor(Date.now() / 1000)
  const accept = { scheme: 'exact', network: rail.network, maxAmountRequired: rail.amount, asset: rail.asset, payTo: rail.payTo, maxTimeoutSeconds: rail.maxTimeoutSeconds, extra: { name: rail.extra.name, version: rail.extra.version } }
  const nonce = randNonce()
  const { authorization, signature } = await buildExactAuthorization({ account: payerAccount, accept, chainId: 8453, now, nonce })
  return b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })
}

export async function run() {
  group('LIVE · standard exact rail — Base mainnet USDC (real money, tiny)')

  let w
  try {
    w = JSON.parse(readFileSync(resolve(HERE, '../../../../.secrets/wallets/evm-wallet.json'), 'utf8'))
  } catch {
    note('SKIPPED — no .secrets/wallets/evm-wallet.json (local-only test).')
    return
  }

  const payer = mnemonicToAccount(w.mnemonic, { addressIndex: 0 }) // signs; needs USDC, no gas
  const acct1 = mnemonicToAccount(w.mnemonic, { addressIndex: 1 }) // merchant payTo + relayer
  const pub = createPublicClient({ chain: base, transport: http(RPC) })
  const usdc = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  const eth = (a) => pub.getBalance({ address: a })

  const payerUsdc = await usdc(payer.address)
  const payerEth = await eth(payer.address)
  const relayerEth = await eth(acct1.address)
  note(`payer  ${payer.address}  USDC ${formatUnits(payerUsdc, 6)}  ETH ${formatEther(payerEth)}`)
  note(`payTo/relayer ${acct1.address}  ETH ${formatEther(relayerEth)}`)

  if (payerUsdc < AMOUNT_BASE) {
    note(`SKIPPED — payer needs ≥ ${AMOUNT} USDC on Base (fund ${payer.address}).`)
    return
  }
  // Gas pre-check: a transferWithAuthorization on Base is cheap, but the relayer must afford it.
  const minGas = 3_000_000_000_000n // ~0.000003 ETH headroom for L2+L1 fee
  if (relayerEth < minGas) {
    note(`SKIPPED — relayer ${acct1.address} has ${formatEther(relayerEth)} ETH; needs ~${formatEther(minGas)} for gas. Fund it on Base.`)
    return
  }

  // The gate: payTo = acct1 (merchant), relayer = acct1's key (self-settle). Payer = acct0,
  // distinct from the relayer → proves the payer spends NO gas.
  const relayerKey = acct1.getHdKey().privateKey
  const relayerHex = `0x${Buffer.from(relayerKey).toString('hex')}`
  const merchant = acct1.address

  const app = express()
  app.get('/paid', requirePayment({
    chain: 'base', token: 'USDC', amount: AMOUNT, payTo: merchant, rpcUrl: RPC,
    exact: { settle: 'self', relayer: { key: relayerHex } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    // Confirm the gate read the real USDC EIP-712 domain on mainnet.
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts.find((a) => a.scheme === 'exact')
    check('gate read USDC domain live: name "USD Coin", version "2"', rail?.extra?.name === 'USD Coin' && rail?.extra?.version === '2', JSON.stringify(rail?.extra))

    group('LIVE · exact round-trip on Base mainnet')
    const m0 = await usdc(merchant), p0 = await usdc(payer.address), pe0 = await eth(payer.address)
    const header = await buildPayHeader(url, payer)
    const r = await fetch(url, { headers: { 'payment-signature': header } })
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — resource unlocked by a real on-chain exact payment', r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`)
    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      check('receipt scheme is exact + has a real settle tx hash', receipt.scheme === 'exact' && /^0x[0-9a-f]{64}$/i.test(receipt.transaction || ''), receipt.transaction)
      note(`settled tx: https://basescan.org/tx/${receipt.transaction}`)
      // Let the chain settle, then confirm balances moved.
      await sleep(3000)
      check(`merchant received exactly ${AMOUNT} USDC on mainnet`, (await usdc(merchant)) - m0 === AMOUNT_BASE, `delta=${(await usdc(merchant)) - m0}`)
      check(`payer USDC dropped by ${AMOUNT}`, p0 - (await usdc(payer.address)) === AMOUNT_BASE)
      check('payer spent ZERO gas (ETH unchanged — relayer paid)', (await eth(payer.address)) === pe0)

      group('LIVE · replay rejection (no second broadcast, no extra gas)')
      // Re-send the IDENTICAL authorization header → the gate's nonce claim rejects it
      // before any settlement (the on-chain authorizationState is a second guard).
      const replay = await fetch(url, { headers: { 'payment-signature': header } })
      const rb = await replay.json().catch(() => ({}))
      check('replaying the SAME authorization → 402 tx_already_used',
        replay.status === 402 && (rb.extensions?.piprail?.code === 'tx_already_used' || /already/.test(rb.error ?? '')),
        `status=${replay.status} code=${rb.extensions?.piprail?.code}`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
