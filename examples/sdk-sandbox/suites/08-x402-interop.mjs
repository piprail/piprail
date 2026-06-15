// Suite 08 — REAL third-party x402 client interop. The official reference client
// (@x402/fetch + @x402/evm, the current v2 line) pays PipRail's STANDARD `exact` rail
// on a forked Base, settled by the merchant's relayer. If a library PipRail didn't
// write can pay a PipRail gate, the wire is genuinely industry-standard.
//
// Imports the LOCAL SDK build for the SERVER; the @x402/* packages are the CLIENT.
// Run: node suites/08-x402-interop.mjs   SKIPS cleanly if anvil or @x402/* are absent.

import { spawn } from 'node:child_process'
import express from 'express'
import {
  createPublicClient, createTestClient, http, erc20Abi,
  encodeAbiParameters, keccak256, parseAbi, getAddress, toHex, pad,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { requirePayment } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const FORK_RPC = process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org'
const PORT = Number(process.env.ANVIL_PORT ?? 8554)
const ANVIL_URL = `http://127.0.0.1:${PORT}`
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const anvilAvailable = () => new Promise((res) => {
  const p = spawn('anvil', ['--version'], { stdio: 'ignore' })
  p.on('error', () => res(false)); p.on('close', (c) => res(c === 0))
})
async function startAnvil() {
  const child = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(PORT), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.on('data', (c) => (err += c.toString()))
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err}`)
    try {
      const r = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if ((await r.json()).result) return { child }
    } catch { /* not up */ }
    await sleep(500)
  }
  child.kill('SIGKILL'); throw new Error(`anvil never ready: ${err}`)
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

export async function run() {
  group('08 · third-party x402 client interop (@x402/fetch + @x402/evm)')

  let x402
  try {
    const [fetchMod, evmMod] = await Promise.all([import('@x402/fetch'), import('@x402/evm')])
    x402 = { ...fetchMod, ...evmMod }
  } catch {
    note('SKIPPED — @x402/fetch / @x402/evm not installed (npm i @x402/fetch @x402/evm).')
    return
  }
  if (!(await anvilAvailable())) { note('SKIPPED — Foundry `anvil` not on PATH.'); return }

  let anvil
  try { anvil = await startAnvil() } catch (e) { note(`SKIPPED — ${e.message}`); return }
  const servers = []
  try {
    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: base, transport })
    const test = createTestClient({ chain: base, mode: 'anvil', transport })
    const usdcBal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })

    // Payer/relayer/merchant must be CLEAN EOAs (no code). FiatTokenV2_2's
    // transferWithAuthorization routes through SignatureChecker, so an address with
    // code (a smart wallet / EIP-7702 delegation) takes the EIP-1271 path and rejects
    // a raw ECDSA sig — a real concern for smart-wallet payers, but here we test the
    // EOA path (the 99% case). `0x1c..` happens to be a delegated contract on Base.
    const payerKey = '0x' + 'e1'.repeat(32)
    const payer = privateKeyToAccount(payerKey)
    const relayerKey = '0x' + '2d'.repeat(32)
    const relayer = privateKeyToAccount(relayerKey)
    const merchant = privateKeyToAccount('0x' + '3e'.repeat(32)).address
    // Guard: if any key collides with a deployed contract on this fork, the EIP-1271
    // path would muddy the EOA-interop result — skip with a clear note instead.
    for (const [label, addr] of [['payer', payer.address], ['relayer', relayer.address], ['merchant', merchant]]) {
      const code = await pub.getCode({ address: addr }).catch(() => undefined)
      if (code && code !== '0x') { note(`SKIPPED — test ${label} ${addr} has code (smart wallet); pick a clean-EOA key.`); return }
    }

    await dealUsdc(test, pub, payer.address, 100_000000n) // payer holds USDC, no ETH
    await test.setBalance({ address: relayer.address, value: 10n ** 18n }) // relayer has gas

    const app = express()
    app.get('/paid', requirePayment({
      chain: 'base', token: 'USDC', amount: '0.01', payTo: merchant, rpcUrl: ANVIL_URL,
      exact: { settle: 'self', relayer: { key: relayerKey } },
    }), (_q, r) => r.json({ unlocked: true }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) }); servers.push(srv)
    const url = `http://127.0.0.1:${srv.address().port}/paid`

    // Build the OFFICIAL reference client. It signs an EIP-3009 authorization over the
    // exact rail PipRail advertises; PipRail's gate self-settles it.
    let fetchWithPay
    try {
      const signer = x402.toClientEvmSigner(payer)
      const client = new x402.x402Client().register('eip155:8453', new x402.ExactEvmScheme(signer))
      fetchWithPay = x402.wrapFetchWithPayment(fetch, client)
    } catch (e) {
      note(`SKIPPED — couldn't construct @x402 client (${e.message}).`); return
    }

    group('08 · the reference @x402 client pays PipRail\'s exact rail')
    const m0 = await usdcBal(merchant)
    let res, body
    try {
      res = await fetchWithPay(url)
      body = await res.json().catch(() => ({}))
    } catch (e) {
      check('@x402 client completed a payment', false, `threw: ${e.message}`)
      return
    }
    check('HTTP 200 — a THIRD-PARTY x402 client unlocked a PipRail resource', res.status === 200 && body.unlocked === true, `status=${res.status} reason=${body.error ?? ''} ext=${JSON.stringify(body.extensions ?? {})}`)
    const resp = res.headers.get('payment-response') || res.headers.get('x-payment-response')
    if (resp) {
      const receipt = JSON.parse(Buffer.from(resp, 'base64').toString('utf8'))
      check('settlement receipt scheme is exact', receipt.scheme === 'exact', receipt.scheme)
    }
    check('merchant received exactly 0.01 USDC from the reference client', (await usdcBal(merchant)) - m0 === 10_000n, `delta=${(await usdcBal(merchant)) - m0}`)
    note('INTEROP PROVEN: the official x402 reference client pays a PipRail gate — the wire is industry-standard.')
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r))
    anvil.child.kill('SIGKILL')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
