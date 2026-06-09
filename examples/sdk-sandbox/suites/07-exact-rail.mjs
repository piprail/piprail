// Suite 07 — the STANDARD x402 `exact` rail (EIP-3009) under REAL on-chain
// settlement, ZERO real money. Forks Base into Anvil, deals fake USDC to a payer,
// funds a SEPARATE relayer with ETH, stands up a DUAL-RAIL gate (exact self-settle
// + onchain-proof), and smashes every edge case of getting PAID by a standard x402
// client: the merchant's relayer broadcasts transferWithAuthorization and the payer
// spends ZERO gas.
//
// Imports the LOCAL SDK build (../../../sdk/dist) so it tests THIS code, not the
// published package. Run: node suites/07-exact-rail.mjs  (after `npm run build` in sdk/).
// SKIPS cleanly if Foundry's `anvil` or the fork RPC is unavailable.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import express from 'express'
import {
  createPublicClient, createWalletClient, createTestClient, http, erc20Abi,
  encodeAbiParameters, keccak256, parseAbi, getAddress, toHex, pad,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { requirePayment, PipRailClient, buildExactAuthorization } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const FORK_RPC = process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org'
const PORT = Number(process.env.ANVIL_PORT ?? 8553)
const ANVIL_URL = `http://127.0.0.1:${PORT}`
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const randNonce = () => `0x${randomBytes(32).toString('hex')}`

const anvilAvailable = () => new Promise((res) => {
  const p = spawn('anvil', ['--version'], { stdio: 'ignore' })
  p.on('error', () => res(false)); p.on('close', (c) => res(c === 0))
})

async function startAnvil() {
  const child = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(PORT), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => (err += c.toString()))
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${err}`)
    try {
      const r = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      const j = await r.json(); if (j.result) return { child, chainId: Number(j.result) }
    } catch { /* not up */ }
    await sleep(500)
  }
  child.kill('SIGKILL'); throw new Error(`anvil never became ready (fork RPC ${FORK_RPC} unreachable?): ${err}`)
}

async function dealUsdc(test, pub, holder, amount) {
  const SENTINEL = 0x424242n
  for (let i = 0; i < 31; i++) {
    const index = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(i)]))
    const prev = await pub.request({ method: 'eth_getStorageAt', params: [USDC, index, 'latest'] })
    await test.setStorageAt({ address: USDC, index, value: pad(toHex(SENTINEL)) })
    if ((await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [holder] })) === SENTINEL) {
      await test.setStorageAt({ address: USDC, index, value: pad(toHex(amount)) }); return
    }
    await test.setStorageAt({ address: USDC, index, value: prev })
  }
  throw new Error('could not locate USDC balance slot')
}

/**
 * Hand-rolled STANDARD x402 `exact` client (what a third-party client does): fetch the
 * 402, sign an EIP-3009 authorization over the gate's exact rail, send PAYMENT-SIGNATURE.
 * `tamper` lets us forge inputs to prove the gate rejects them. Returns the 2nd response.
 */
async function payExact(url, payerKey, { chainId = 8453, tamper = {} } = {}) {
  const r1 = await fetch(url)
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`)
  const challenge = await r1.json()
  const rail = challenge.accepts.find((a) => a.scheme === 'exact')
  if (!rail) throw new Error('no exact rail in challenge')

  const account = privateKeyToAccount(payerKey)
  const now = tamper.now ?? Math.floor(Date.now() / 1000)
  const accept = {
    scheme: 'exact', network: rail.network,
    maxAmountRequired: tamper.value ?? rail.amount,
    asset: rail.asset, payTo: rail.payTo,
    maxTimeoutSeconds: tamper.ttl ?? rail.maxTimeoutSeconds,
    extra: { name: rail.extra.name, version: rail.extra.version },
  }
  const nonce = tamper.nonce ?? randNonce()
  let { authorization, signature } = await buildExactAuthorization({ account, accept, chainId, now, nonce })
  if (tamper.badSig) signature = signature.slice(0, -4) + '0000'
  if (tamper.afterSign) authorization = { ...authorization, ...tamper.afterSign }
  const header = b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })
  const r2 = await fetch(url, { headers: { 'payment-signature': header } })
  return { r2, authorization, rail, account }
}

export async function run() {
  if (!(await anvilAvailable())) {
    group('07 · EXACT rail (Anvil fork)')
    note('SKIPPED — Foundry\'s `anvil` not on PATH. The offline exact unit suites already prove the logic.')
    return
  }
  let anvil
  try { anvil = await startAnvil() } catch (e) {
    group('07 · EXACT rail (Anvil fork)'); note(`SKIPPED — ${e.message}`); return
  }

  const servers = []
  try {
    group(`07 · STANDARD exact rail — Base fork (chainId ${anvil.chainId})`)
    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: base, transport })
    const test = createTestClient({ chain: base, mode: 'anvil', transport })
    const usdcBal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })
    const ethBal = (a) => pub.getBalance({ address: a })

    const payerKey = '0x' + 'e1'.repeat(32)
    const payer = privateKeyToAccount(payerKey)
    const relayerKey = '0x' + 'f2'.repeat(32)
    const relayer = privateKeyToAccount(relayerKey)
    const merchant = privateKeyToAccount('0x' + 'c3'.repeat(32)).address

    // The PAYER holds USDC but NO ETH (the whole point: they don't pay gas).
    await dealUsdc(test, pub, payer.address, 100_000000n)
    // The RELAYER (merchant's hot key) holds ETH for gas, but isn't the payTo.
    await test.setBalance({ address: relayer.address, value: 10n ** 18n })
    check('payer dealt 100 USDC and holds 0 ETH', (await usdcBal(payer.address)) === 100_000000n && (await ethBal(payer.address)) === 0n)

    // DUAL-RAIL gate: standard `exact` (self-settled by the relayer) + onchain-proof.
    const app = express()
    app.get('/paid', requirePayment({
      chain: 'base', token: 'USDC', amount: '0.01', payTo: merchant, rpcUrl: ANVIL_URL,
      exact: { settle: 'self', relayer: { privateKey: relayerKey } },
    }), (_q, r) => r.json({ unlocked: true }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) }); servers.push(srv)
    const url = `http://127.0.0.1:${srv.address().port}/paid`

    group('07 · the challenge dual-advertises exact + onchain-proof')
    {
      const ch = await (await fetch(url)).json()
      const schemes = ch.accepts.map((a) => a.scheme)
      check('challenge offers BOTH exact and onchain-proof', schemes.includes('exact') && schemes.includes('onchain-proof'), schemes.join(','))
      const exact = ch.accepts.find((a) => a.scheme === 'exact')
      check('exact rail domain was READ from USDC: name "USD Coin", version "2"', exact.extra.name === 'USD Coin' && exact.extra.version === '2', JSON.stringify(exact.extra))
      check('exact rail carries assetTransferMethod eip3009', exact.extra.assetTransferMethod === 'eip3009')
    }

    group('07 · HAPPY PATH — standard exact client pays, RELAYER settles, payer spends 0 gas')
    {
      const m0 = await usdcBal(merchant), p0 = await usdcBal(payer.address), r0 = await ethBal(relayer.address)
      const { r2 } = await payExact(url, payerKey)
      const body = await r2.json().catch(() => ({}))
      check('HTTP 200, resource unlocked', r2.status === 200 && body.unlocked === true, `status=${r2.status}`)
      const resp = r2.headers.get('payment-response') || r2.headers.get('x-payment-response')
      check('settlement receipt header present (scheme exact)', Boolean(resp) && JSON.parse(Buffer.from(resp, 'base64')).scheme === 'exact')
      check('merchant received EXACTLY 0.01 USDC', (await usdcBal(merchant)) - m0 === 10_000n)
      check('payer USDC dropped by 0.01', p0 - (await usdcBal(payer.address)) === 10_000n)
      check('payer STILL holds 0 ETH (paid no gas)', (await ethBal(payer.address)) === 0n)
      check('relayer paid the gas (ETH balance dropped)', (await ethBal(relayer.address)) < r0)
    }

    group('07 · REPLAY — the same EIP-3009 authorization can\'t settle twice')
    {
      const account = privateKeyToAccount(payerKey)
      const nonce = randNonce()
      const r1 = await payExact(url, payerKey, { tamper: { nonce } })
      check('first settlement of a fresh nonce → 200', r1.r2.status === 200)
      // Re-send the SAME nonce (gate set + on-chain authorizationState both guard it).
      const r2 = await payExact(url, payerKey, { tamper: { nonce } })
      const body = await r2.r2.json().catch(() => ({}))
      check('SAME authorization again → 402 (tx_already_used), no double-charge',
        r2.r2.status === 402 && (body.extensions?.piprail?.code === 'tx_already_used' || /already/.test(body.error ?? '')),
        `status=${r2.r2.status} code=${body.extensions?.piprail?.code}`)
      void account
    }

    group('07 · REJECTIONS are conformant 402s — payer keeps their funds')
    {
      const m0 = await usdcBal(merchant)

      const low = await payExact(url, payerKey, { tamper: { value: '5000' } }) // 0.005 < 0.01
      const lowBody = await low.r2.json().catch(() => ({}))
      check('underpayment → 402 amount_too_low', low.r2.status === 402 && lowBody.extensions?.piprail?.code === 'amount_too_low', JSON.stringify(lowBody.extensions))
      check('underpayment 402 is a full re-challenge (has accepts[]) a standard client can retry', Array.isArray(lowBody.accepts) && lowBody.accepts.length >= 1)

      const expired = await payExact(url, payerKey, { tamper: { now: Math.floor(Date.now() / 1000) - 10_000, ttl: 60 } })
      const expBody = await expired.r2.json().catch(() => ({}))
      check('expired authorization → 402 payment_expired', expired.r2.status === 402 && expBody.extensions?.piprail?.code === 'payment_expired', JSON.stringify(expBody.extensions))

      const badsig = await payExact(url, payerKey, { tamper: { badSig: true } })
      const bsBody = await badsig.r2.json().catch(() => ({}))
      check('tampered signature → 402 signature_invalid', badsig.r2.status === 402 && bsBody.extensions?.piprail?.code === 'signature_invalid', JSON.stringify(bsBody.extensions))

      const forged = await payExact(url, payerKey, { tamper: { afterSign: { value: '999999' } } })
      const fBody = await forged.r2.json().catch(() => ({}))
      check('authorization mutated after signing → 402 signature_invalid', forged.r2.status === 402 && fBody.extensions?.piprail?.code === 'signature_invalid')

      check('merchant received NOTHING from any rejected attempt', (await usdcBal(merchant)) - m0 === 0n)
    }

    group('07 · INSUFFICIENT payer balance → simulate catches it, no broadcast, no gas wasted')
    {
      const brokeKey = '0x' + 'a7'.repeat(32)
      const broke = privateKeyToAccount(brokeKey) // 0 USDC, 0 ETH
      const r0 = await ethBal(relayer.address)
      const res = await payExact(url, brokeKey)
      const body = await res.r2.json().catch(() => ({}))
      check('0-USDC payer → 402 tx_reverted (simulate caught it)', res.r2.status === 402 && body.extensions?.piprail?.code === 'tx_reverted', JSON.stringify(body.extensions))
      check('relayer spent ~no gas (broadcast skipped after failed simulate)', (r0 - (await ethBal(relayer.address))) < 10n ** 13n)
      void broke
    }

    group('07 · RELAYER out of gas → SettlementError → 502, NOT a 402 (payer authorization stays valid)')
    {
      const merchant2 = privateKeyToAccount('0x' + 'd8'.repeat(32)).address
      const relayer2Key = '0x' + 'b9'.repeat(32)
      const relayer2 = privateKeyToAccount(relayer2Key)
      await test.setBalance({ address: relayer2.address, value: 0n }) // no gas
      const app2 = express()
      app2.get('/paid', requirePayment({
        chain: 'base', token: 'USDC', amount: '0.01', payTo: merchant2, rpcUrl: ANVIL_URL,
        exact: { settle: 'self', relayer: { privateKey: relayer2Key } },
      }), (_q, r) => r.json({ unlocked: true }))
      const s2 = await new Promise((res) => { const s = app2.listen(0, '127.0.0.1', () => res(s)) }); servers.push(s2)
      const url2 = `http://127.0.0.1:${s2.address().port}/paid`
      const res = await payExact(url2, payerKey)
      const body = await res.r2.json().catch(() => ({}))
      check('relayer-can\'t-broadcast → HTTP 502 (server error), not 402', res.r2.status === 502, `status=${res.r2.status}`)
      check('502 body marks settlement_failed', body.error === 'settlement_failed', JSON.stringify(body))
    }

    group('07 · the SAME gate still settles onchain-proof (PipRail client) — dual-rail coexists')
    {
      // Give a fresh payer USDC + ETH (onchain-proof: the PAYER broadcasts and pays gas).
      const cpKey = '0x' + 'aa'.repeat(32)
      const cp = privateKeyToAccount(cpKey)
      await test.setBalance({ address: cp.address, value: 10n ** 18n })
      await dealUsdc(test, pub, cp.address, 50_000000n)
      const m0 = await usdcBal(merchant)
      const client = new PipRailClient({ chain: 'base', wallet: { privateKey: cpKey }, rpcUrl: ANVIL_URL, policy: { maxAmount: '0.05', tokens: ['USDC'] } })
      const res = await client.fetch(url)
      check('PipRail client pays the onchain-proof rail on the dual-rail gate → 200', res.status === 200)
      check('merchant received another 0.01 via onchain-proof', (await usdcBal(merchant)) - m0 === 10_000n)
    }

    note('STANDARD exact rail proven on-chain: dual-advertise, relayer-settled (payer 0 gas), replay-safe, every rejection a conformant 402, server-fault → 502, and onchain-proof coexists on the same gate.')
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r))
    anvil.child.kill('SIGKILL')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
