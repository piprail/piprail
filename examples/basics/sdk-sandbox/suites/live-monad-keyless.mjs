// LIVE mainnet smoke — EVM `exact` keyless on MONAD via Corbits (a NEW gasless chain probe).
// Same proven flow as live-exact-keyless (Base/PayAI), pointed at Monad (eip155:143, native
// Circle USDC) + the keyless Corbits facilitator. Buyer signs an EIP-3009 authorization (ZERO
// gas); Corbits broadcasts + sponsors. If this settles, Monad is seedable (THE RULE: a real
// keyless settle, not just a /supported read).
//
// LOCAL ONLY. Reads keys from ../../../../.secrets — never prints them. Skips cleanly if underfunded
// or the facilitator can't sponsor Monad. This is a PROBE — a clean failure just means "don't seed".

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, http, erc20Abi, getAddress, formatUnits, formatEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { requirePayment, buildExactAuthorization } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RPC = process.env.MONAD_RPC ?? 'https://rpc.monad.xyz'
const USDC = getAddress('0x754704Bc059F8C67012fEd69BC8A327a5aafb603')
const CHAIN_ID = 143
const FACILITATOR = 'https://facilitator.corbits.dev'
const AMOUNT = '0.001'
const AMOUNT_BASE = 1000n
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildPayHeader(url, payerAccount) {
  const challenge = await (await fetch(url)).json()
  const rail = challenge.accepts.find((a) => a.scheme === 'exact')
  if (!rail) return null
  const accept = { scheme: 'exact', network: rail.network, maxAmountRequired: rail.amount, asset: rail.asset, payTo: rail.payTo, maxTimeoutSeconds: rail.maxTimeoutSeconds, extra: { name: rail.extra.name, version: rail.extra.version } }
  const { authorization, signature } = await buildExactAuthorization({ account: payerAccount, accept, chainId: CHAIN_ID, now: Math.floor(Date.now() / 1000), nonce: `0x${randomBytes(32).toString('hex')}` })
  return b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })
}

export async function run() {
  group('LIVE · Monad exact keyless via Corbits — mainnet USDC (NEW-chain probe)')

  let w
  try {
    w = JSON.parse(readFileSync(resolve(HERE, '../../../../.secrets/wallets/evm-wallet.json'), 'utf8'))
  } catch {
    note('SKIPPED — no .secrets/wallets/evm-wallet.json.')
    return
  }
  const payer = mnemonicToAccount(w.mnemonic, { addressIndex: 0 })
  const merchant = mnemonicToAccount(w.mnemonic, { addressIndex: 1 }).address
  let pub
  try {
    pub = createPublicClient({ transport: http(RPC) })
    await pub.getChainId()
  } catch (e) {
    note(`SKIPPED — Monad RPC unreachable (${RPC}): ${String(e).slice(0, 80)}`)
    return
  }
  const usdc = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })

  let payerUsdc
  try { payerUsdc = await usdc(payer.address) } catch (e) { note(`SKIPPED — couldn't read Monad USDC: ${String(e).slice(0, 80)}`); return }
  note(`payer ${payer.address}  USDC ${formatUnits(payerUsdc, 6)}`)
  if (payerUsdc < AMOUNT_BASE) { note(`SKIPPED — payer needs ≥ ${AMOUNT} USDC on Monad.`); return }

  const app = express()
  app.get('/paid', requirePayment({
    chain: 'monad', token: 'USDC', amount: AMOUNT, payTo: merchant, rpcUrl: RPC,
    exact: { settle: { facilitator: FACILITATOR } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts.find((a) => a.scheme === 'exact')
    check('Monad gate advertised an exact rail (native USDC is EIP-3009)', rail?.extra?.assetTransferMethod === 'eip3009', JSON.stringify(rail?.extra ?? ch.accepts?.map((a) => a.scheme)))
    if (!rail) { note('No exact rail — Monad USDC may not be EIP-3009 here, or resolve failed. Not seedable.'); return }

    const m0 = await usdc(merchant), p0 = await usdc(payer.address)
    const header = await buildPayHeader(url, payer)
    const r = await fetch(url, { headers: { 'payment-signature': header } })
    const body = await r.json().catch(() => ({}))
    check('HTTP 200 — Monad resource unlocked by a GASLESS keyless payment (Corbits sponsored)', r.status === 200 && body.unlocked === true, `status=${r.status} ${JSON.stringify(body).slice(0, 240)}`)
    if (r.status === 200) {
      const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
      const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
      note(`settled tx (Corbits-broadcast): ${receipt.transaction}`)
      await sleep(5000)
      check(`merchant received ${AMOUNT} USDC on Monad mainnet`, (await usdc(merchant)) - m0 === AMOUNT_BASE, `delta=${(await usdc(merchant)) - m0}`)
      check('payer USDC dropped by exactly the amount', p0 - (await usdc(payer.address)) === AMOUNT_BASE)
      note('✅ SEEDABLE: Corbits keyless-settled Monad (eip155:143). Add it to KNOWN_FACILITATORS with this tx.')
    } else {
      note(`Corbits did not settle Monad (status ${r.status}: ${body.detail ?? body.error ?? ''}). NOT seedable — leave Monad unseeded.`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
