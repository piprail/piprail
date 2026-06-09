// CROSS-CHAIN buyer proof — PipRailClient({ schemes:['exact'] }) pays a dual-rail gate's
// standard `exact` rail under REAL on-chain settlement, on Base, Arbitrum AND Polygon
// (Anvil forks — ZERO real money). Proves the buyer re-derives each chain's true EIP-712
// USDC domain on-chain and settles gaslessly per chain. Imports the LOCAL SDK build.
// Run: node suites/cross-chain-exact-buyer.mjs   (needs Foundry `anvil` + fork RPC reachable).
// SKIPS cleanly when anvil or a fork RPC is unavailable.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, createTestClient, http, parseAbi, getAddress, toHex, pad, keccak256, encodeAbiParameters } from 'viem'
import { base, arbitrum, polygon } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { requirePayment, PipRailClient } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHAINS = [
  { preset: 'base', vc: base, port: 8561, rpc: process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { preset: 'arbitrum', vc: arbitrum, port: 8562, rpc: process.env.ARB_FORK_RPC ?? 'https://arb1.arbitrum.io/rpc', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { preset: 'polygon', vc: polygon, port: 8563, rpc: process.env.POLY_FORK_RPC ?? 'https://polygon-bor-rpc.publicnode.com', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
]

const anvilAvailable = () => new Promise((res) => {
  const p = spawn('anvil', ['--version'], { stdio: 'ignore' }); p.on('error', () => res(false)); p.on('close', (c) => res(c === 0))
})
async function startAnvil(forkRpc, port) {
  const child = spawn('anvil', ['--fork-url', forkRpc, '--port', String(port), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.on('data', (c) => (err += c.toString()))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err}`)
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      const j = await r.json(); if (j.result) return { child, url }
    } catch { /* not up */ }
    await sleep(500)
  }
  child.kill('SIGKILL'); throw new Error(`anvil never ready (fork ${forkRpc} unreachable?)`)
}
async function dealUsdc(test, pub, usdc, holder, amount) {
  const SENTINEL = 0x424242n
  for (let i = 0; i < 31; i++) {
    const index = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(i)]))
    const prev = await pub.request({ method: 'eth_getStorageAt', params: [usdc, index, 'latest'] })
    await test.setStorageAt({ address: usdc, index, value: pad(toHex(SENTINEL)) })
    if ((await pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [holder] })) === SENTINEL) {
      await test.setStorageAt({ address: usdc, index, value: pad(toHex(amount)) }); return
    }
    await test.setStorageAt({ address: usdc, index, value: prev })
  }
  throw new Error('could not locate USDC balance slot')
}

export async function run() {
  if (!(await anvilAvailable())) { group('cross-chain exact buyer'); note('SKIPPED — Foundry `anvil` not on PATH.'); return }
  for (const c of CHAINS) {
    const servers = []
    let anvil
    try { anvil = await startAnvil(c.rpc, c.port) } catch (e) { group(`x-chain · ${c.preset}`); note(`SKIPPED — ${e.message}`); continue }
    try {
      const usdc = getAddress(c.usdc)
      const transport = http(anvil.url)
      const pub = createPublicClient({ chain: c.vc, transport })
      const test = createTestClient({ chain: c.vc, mode: 'anvil', transport })
      const usdcBal = (a) => pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [a] })
      const onchainName = await pub.readContract({ address: usdc, abi: ERC20, functionName: 'name' })

      group(`x-chain · ${c.preset} (chainId ${c.vc.id}) — on-chain USDC domain name "${onchainName}"`)
      // FRESH random keys → guaranteed EOAs (a fixed key can collide with a deployed
      // contract on a forked mainnet, which the EOA guard correctly refuses).
      const payerKey = '0x' + randomBytes(32).toString('hex')
      const payer = privateKeyToAccount(payerKey)
      const relayerKey = '0x' + randomBytes(32).toString('hex')
      const relayer = privateKeyToAccount(relayerKey)
      const merchant = privateKeyToAccount('0x' + 'c3'.repeat(32)).address
      await dealUsdc(test, pub, usdc, payer.address, 100_000000n) // 100 USDC, 0 native
      await test.setBalance({ address: relayer.address, value: 10n ** 18n })

      const app = express()
      app.get('/paid', requirePayment({
        chain: c.preset, token: 'USDC', amount: '0.02', payTo: merchant, rpcUrl: anvil.url,
        exact: { settle: 'self', relayer: { privateKey: relayerKey } },
      }), (_q, r) => r.json({ unlocked: true }))
      const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) }); servers.push(srv)
      const url = `http://127.0.0.1:${srv.address().port}/paid`

      const m0 = await usdcBal(merchant)
      const buyer = new PipRailClient({ chain: c.preset, wallet: { privateKey: payerKey }, schemes: ['exact'], rpcUrl: anvil.url })
      const res = await buyer.fetch(url).catch((e) => e)
      const ok = !(res instanceof Error) && res.status === 200
      check(`PipRailClient({schemes:['exact']}) settled on ${c.preset} → 200`, ok, res instanceof Error ? res.message : `status=${res.status}`)
      check(`merchant received 0.02 USDC on ${c.preset}`, (await usdcBal(merchant)) - m0 === 20_000n)
      check(`payer paid 0 native gas on ${c.preset} (gasless buyer)`, (await pub.getBalance({ address: payer.address })) === 0n)
      check(`spend recorded once on ${c.preset}`, buyer.spent().count === 1, `count=${buyer.spent().count}`)
    } catch (e) {
      check(`${c.preset} buyer round-trip`, false, e.message)
    } finally {
      for (const s of servers) s.close()
      anvil?.child.kill('SIGKILL')
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
