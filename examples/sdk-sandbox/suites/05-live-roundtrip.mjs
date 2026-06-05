// Suite 05 — the full SDK round-trip under REAL on-chain settlement, ZERO real
// money. Forks Base into Anvil, deals fake USDC, and exercises the complete loop:
// requirePayment gate ↔ PipRailClient.fetch (USDC + native), the spend ledger,
// planPayment with real balances, gate-level replay rejection, InsufficientFunds,
// and the lifetime cap across real settlements.
//
// Defaults to forking via https://mainnet.base.org (override BASE_FORK_RPC).
// SKIPS cleanly if Foundry's `anvil` or the fork RPC is unavailable.

import { spawn } from 'node:child_process'
import express from 'express'
import {
  createPublicClient, createWalletClient, createTestClient, http, erc20Abi,
  encodeAbiParameters, keccak256, parseAbi, getAddress, toHex, pad,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  requirePayment, createPaymentGate, PipRailClient, buildSignatureHeader, InsufficientFundsError,
} from '@piprail/sdk'
import { group, check, note, summarize } from '../lib/report.mjs'

const FORK_RPC = process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org'
const PORT = Number(process.env.ANVIL_PORT ?? 8551)
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

export async function run() {
  if (!(await anvilAvailable())) {
    group('05 · LIVE round-trip (Anvil fork)')
    note('SKIPPED — Foundry\'s `anvil` not on PATH. The offline suites already prove the logic.')
    return
  }
  let anvil
  try { anvil = await startAnvil() } catch (e) {
    group('05 · LIVE round-trip (Anvil fork)'); note(`SKIPPED — ${e.message}`); return
  }

  const servers = []
  try {
    group(`05 · LIVE SDK round-trip — Base fork (chainId ${anvil.chainId})`)
    check('forked Base preserves chain id 8453', anvil.chainId === 8453, `got ${anvil.chainId}`)
    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: base, transport })
    const test = createTestClient({ chain: base, mode: 'anvil', transport })

    const payerKey = '0x' + 'a1'.repeat(32)
    const payer = privateKeyToAccount(payerKey)
    const merchantAddr = privateKeyToAccount('0x' + 'b2'.repeat(32)).address
    const usdcBal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })
    const ethBal = (a) => pub.getBalance({ address: a })

    await test.setBalance({ address: payer.address, value: 10n ** 18n })
    await dealUsdc(test, pub, payer.address, 100_000000n)
    check('payer dealt 100 USDC + 1 ETH on the fork', (await usdcBal(payer.address)) === 100_000000n)

    const app = express()
    app.get('/usdc', requirePayment({ chain: 'base', token: 'USDC', amount: '0.01', payTo: merchantAddr, rpcUrl: ANVIL_URL }), (_q, r) => r.json({ unlocked: 'usdc' }))
    app.get('/native', requirePayment({ chain: 'base', token: 'native', amount: '0.0001', payTo: merchantAddr, rpcUrl: ANVIL_URL }), (_q, r) => r.json({ unlocked: 'native' }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) }); servers.push(srv)
    const url = (p) => `http://127.0.0.1:${srv.address().port}${p}`

    const client = new PipRailClient({ chain: 'base', wallet: { privateKey: payerKey }, rpcUrl: ANVIL_URL, policy: { maxAmount: '0.05', maxTotal: '0.10', tokens: ['USDC', 'native'] } })

    group('05 · USDC round-trip: fetch → real transfer → gate verifies → 200')
    {
      const m0 = await usdcBal(merchantAddr)
      const res = await client.fetch(url('/usdc'))
      const body = await res.json()
      check('HTTP 200, resource unlocked', res.status === 200 && body.unlocked === 'usdc')
      check('merchant received EXACTLY 0.01 USDC on-chain', (await usdcBal(merchantAddr)) - m0 === 10_000n)
      check('spent() ledger records the USDC payment', client.spent().count === 1)
    }

    group('05 · planPayment with REAL balances → payable')
    {
      const plan = await client.planPayment(url('/usdc'))
      check('a real-balance plan is payable, status ready, best rail present', plan.payable === true && plan.status === 'ready' && Boolean(plan.best))
      check('no BALANCE_UNREADABLE warning (RPC is live now)', !plan.options[0].warnings.includes('BALANCE_UNREADABLE'))
    }

    group('05 · native-coin round-trip on-chain')
    {
      const m0 = await ethBal(merchantAddr)
      const res = await client.fetch(url('/native'))
      check('HTTP 200', res.status === 200)
      check('merchant received EXACTLY 0.0001 ETH (1e14 wei)', (await ethBal(merchantAddr)) - m0 === 100_000_000_000_000n)
      check('ledger now has 2 payments across 2 assets', client.spent().count === 2 && client.spent().byAsset.length === 2)
    }

    group('05 · gate-level replay rejection (used-proof set)')
    {
      const replayPayTo = privateKeyToAccount('0x' + 'c3'.repeat(32)).address
      const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo: replayPayTo, rpcUrl: ANVIL_URL })
      const { challenge } = await gate.challenge('u')
      const a = challenge.accepts[0]
      const wallet = createWalletClient({ account: payer, chain: base, transport })
      const txHash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [replayPayTo, 10_000n] })
      await pub.waitForTransactionReceipt({ hash: txHash })
      const sig = buildSignatureHeader({ x402Version: 2, accepted: a, payload: { nonce: a.extra.nonce, txHash } })
      const first = await gate.verify(sig)
      const second = await gate.verify(sig)
      check('first redemption of a real proof → paid', first.kind === 'paid' && first.receipt.transaction === txHash)
      check('SAME proof again → invalid (tx_already_used) — no double-spend', second.kind === 'invalid' && second.error === 'tx_already_used')
    }

    group('05 · InsufficientFundsError when the wallet can\'t cover it')
    {
      const broke = privateKeyToAccount('0x' + 'd4'.repeat(32))
      await test.setBalance({ address: broke.address, value: 10n ** 18n }) // ETH for gas, but 0 USDC
      const brokeClient = new PipRailClient({ chain: 'base', wallet: { privateKey: '0x' + 'd4'.repeat(32) }, rpcUrl: ANVIL_URL, policy: { maxAmount: '0.05', tokens: ['USDC'] } })
      let code = null
      try { await brokeClient.fetch(url('/usdc')) } catch (e) { code = e.code ?? e.name }
      check('paying 0.01 USDC with a 0-USDC wallet → InsufficientFundsError', code === 'INSUFFICIENT_FUNDS' || code === InsufficientFundsError.name, `code=${code}`)
    }

    group('05 · lifetime cap holds across REAL settlements')
    {
      const capped = new PipRailClient({ chain: 'base', wallet: { privateKey: payerKey }, rpcUrl: ANVIL_URL, policy: { maxAmount: '0.01', maxTotal: '0.02', tokens: ['USDC'] } })
      const m0 = await usdcBal(merchantAddr)
      const r1 = await capped.fetch(url('/usdc')); check('payment #1 settles', r1.status === 200)
      const r2 = await capped.fetch(url('/usdc')); check('payment #2 settles (total 0.02 == cap)', r2.status === 200)
      let code = null
      try { await capped.fetch(url('/usdc')) } catch (e) { code = e.code }
      check('payment #3 REFUSED by maxTotal (PAYMENT_DECLINED)', code === 'PAYMENT_DECLINED', `code=${code}`)
      check('merchant received EXACTLY 0.02 from this client — the 3rd moved nothing', (await usdcBal(merchantAddr)) - m0 === 20_000n)
    }
    note('full SDK loop proven on-chain: accept ↔ pay, USDC + native, replay-safe, fund-checked, lifetime-capped')
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r))
    anvil.child.kill('SIGKILL')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
