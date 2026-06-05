// Suite 05 — LIVE policy enforcement under REAL on-chain settlement.
// The definitive proof an AI cannot drain the wallet, with ZERO real money.
//
// Forks Base into a local Anvil (real USDC contract, chain id 8453), deals the
// payer a GENEROUS fake balance — so only the POLICY can stop a payment, never
// lack of funds — then drives the REAL @piprail/mcp through a sequence of real
// payments and proves on-chain that:
//   • the PER-CALL cap (maxAmount) refuses oversize charges (exact cap settles)
//   • the LIFETIME cap (maxTotal) halts spend across many in-size calls (exact cap settles)
//   • every declined call settles ZERO on-chain
//   • total wallet outflow == the lifetime cap, to the base unit
//
// Defaults to forking via https://mainnet.base.org (override BASE_FORK_RPC).
// SKIPS cleanly (no failures) if Foundry's `anvil` or the fork RPC is unavailable.

import { spawn } from 'node:child_process'
import express from 'express'
import {
  createPublicClient, createTestClient, http,
  encodeAbiParameters, keccak256, parseAbi, getAddress, toHex, pad,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { requirePayment } from '@piprail/sdk'
import { connectServer, callTool } from '../lib/harness.mjs'
import { group, check, note, summarize } from '../lib/report.mjs'

const FORK_RPC = process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org'
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8550)
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const anvilAvailable = () => new Promise((res) => {
  const p = spawn('anvil', ['--version'], { stdio: 'ignore' })
  p.on('error', () => res(false))
  p.on('close', (code) => res(code === 0))
})

async function startAnvil() {
  const child = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(ANVIL_PORT), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => (err += c.toString()))
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${err}`)
    try {
      const r = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      const j = await r.json()
      if (j.result) return { child, chainId: Number(j.result) }
    } catch { /* not up yet */ }
    await sleep(500)
  }
  child.kill('SIGKILL')
  throw new Error(`anvil never became ready (fork RPC ${FORK_RPC} may be unreachable/throttled): ${err}`)
}

/** Find the ERC-20 balance storage slot for `holder` by probing slots 0..30. */
async function findBalanceSlot(test, pub, holder) {
  const SENTINEL = 0x424242n
  for (let i = 0; i < 31; i++) {
    const index = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(i)]))
    const prev = await pub.request({ method: 'eth_getStorageAt', params: [USDC, index, 'latest'] })
    await test.setStorageAt({ address: USDC, index, value: pad(toHex(SENTINEL)) })
    if ((await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [holder] })) === SENTINEL) return index
    await test.setStorageAt({ address: USDC, index, value: prev })
  }
  throw new Error('could not locate the USDC balance slot')
}

export async function run() {
  if (!(await anvilAvailable())) {
    group('05 · LIVE settlement (Anvil fork)')
    note('SKIPPED — Foundry\'s `anvil` not on PATH. Install Foundry to run the real-settlement caps; the offline suites already prove the policy logic.')
    return
  }
  let anvil
  try {
    anvil = await startAnvil()
  } catch (e) {
    group('05 · LIVE settlement (Anvil fork)')
    note(`SKIPPED — ${e.message}`)
    return
  }

  const merchants = []
  let mcp
  try {
    group(`05 · LIVE caps under real settlement — Base fork (chainId ${anvil.chainId})`)
    check('forked Base preserves chain id 8453', anvil.chainId === 8453, `got ${anvil.chainId}`)

    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: base, transport })
    const test = createTestClient({ chain: base, mode: 'anvil', transport })
    const payerKey = '0x' + 'a1'.repeat(32)
    const payer = privateKeyToAccount(payerKey)
    const merchantAddr = privateKeyToAccount('0x' + 'b2'.repeat(32)).address
    const bal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })

    // Fund gas + deal 100 USDC — so only the POLICY can ever stop a payment.
    await test.setBalance({ address: payer.address, value: 10n ** 18n })
    const slot = await findBalanceSlot(test, pub, payer.address)
    await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(100_000000n)) })
    const payerStart = await bal(payer.address)
    check('payer dealt 100 USDC (balance is never the constraint)', payerStart === 100_000000n, `${payerStart}`)
    const merchantStart = await bal(merchantAddr)

    const app = express()
    const gate = (amount) => requirePayment({ chain: 'base', token: 'USDC', amount, payTo: merchantAddr, rpcUrl: ANVIL_URL })
    for (const a of ['0.06', '0.05', '0.04', '0.01']) app.get(`/p${a.slice(2)}`, gate(a), (_q, r) => r.json({ paid: a }))
    // A NATIVE-coin (ETH) gated route — to prove the `native` allowlist alias end-to-end on-chain.
    app.get('/native', requirePayment({ chain: 'base', token: 'native', amount: '0.0001', payTo: merchantAddr, rpcUrl: ANVIL_URL }), (_q, r) => r.json({ paid: 'native' }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
    merchants.push(srv)
    const url = (p) => `http://127.0.0.1:${srv.address().port}${p}`

    // ONE MCP server, reused so its ledger accumulates. Policy: 0.05/call, 0.10 lifetime.
    mcp = await connectServer({
      PIPRAIL_PRIVATE_KEY: payerKey, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: ANVIL_URL,
      PIPRAIL_MAX_AMOUNT: '0.05', PIPRAIL_MAX_TOTAL: '0.10', PIPRAIL_TOKENS: 'USDC',
    })
    note('policy under test: maxAmount 0.05 / maxTotal 0.10 / USDC — wallet holds 100 USDC')

    async function attempt(label, path, expect, deltaBase = 0n) {
      const before = await bal(merchantAddr)
      const res = await callTool(mcp.client, 'piprail_pay_request', { url: url(path) })
      const moved = (await bal(merchantAddr)) - before
      if (expect === 'settle') {
        check(`${label} → settles (HTTP 200)`, res.json.status === 200, JSON.stringify(res.json).slice(0, 140))
        check(`${label} → moved exactly ${deltaBase} base units on-chain`, moved === deltaBase, `moved ${moved}`)
      } else {
        check(`${label} → DECLINED by policy (no send)`, res.json.declined === true && res.isError === false, JSON.stringify(res.json).slice(0, 180))
        check(`${label} → moved ZERO on-chain`, moved === 0n, `moved ${moved}`)
      }
    }

    // 1. per-call cap: 0.06 > 0.05 → refused.
    await attempt('per-call cap (0.06 > 0.05)', '/p06', 'decline')
    // 2. per-call BOUNDARY under real settlement: 0.05 == cap → settles.
    await attempt('per-call boundary (0.05 == cap)', '/p05', 'settle', 50_000n)
    // 3. another in-size payment (total → 0.09).
    await attempt('payment (0.04 → total 0.09)', '/p04', 'settle', 40_000n)
    // 4. lifetime cap: 0.04 would reach 0.13 > 0.10 → refused.
    await attempt('lifetime cap blocks (0.04 → would be 0.13)', '/p04', 'decline')
    // 5. lifetime BOUNDARY: 0.01 reaches exactly 0.10 → settles.
    await attempt('lifetime boundary (0.01 → exactly 0.10)', '/p01', 'settle', 10_000n)
    // 6. at the cap, even 0.01 more is refused.
    await attempt('at the cap, 0.01 more is refused', '/p01', 'decline')

    const payerEnd = await bal(payer.address)
    const merchantEnd = await bal(merchantAddr)
    check('payer spent EXACTLY the 0.10 lifetime cap (100000 base units)', payerStart - payerEnd === 100_000n, `spent ${payerStart - payerEnd}`)
    check('merchant received EXACTLY 0.10 — not a unit more', merchantEnd - merchantStart === 100_000n, `received ${merchantEnd - merchantStart}`)
    note('3 of 6 calls refused; despite a 100-USDC wallet, total spend is capped at exactly 0.10')

    // ── Native-coin (ETH) settlement end-to-end + the `native` alias on-chain ──
    // Proves the chain-agnostic `native` allowlist works through the FULL pay path
    // (real ETH transfer, gate verifies the native value), and that a USDC-only
    // policy refuses native — both confirmed by reading on-chain ETH balances.
    const ethBal = (a) => pub.getBalance({ address: a })
    const merchantEthStart = await ethBal(merchantAddr)

    const nativeOk = await connectServer({
      PIPRAIL_PRIVATE_KEY: payerKey, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: ANVIL_URL,
      PIPRAIL_MAX_AMOUNT: '0.01', PIPRAIL_MAX_TOTAL: '1', PIPRAIL_TOKENS: 'native',
    })
    const usdcOnly = await connectServer({
      PIPRAIL_PRIVATE_KEY: payerKey, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: ANVIL_URL,
      PIPRAIL_MAX_AMOUNT: '0.01', PIPRAIL_MAX_TOTAL: '1', PIPRAIL_TOKENS: 'USDC',
    })
    try {
      // USDC-only policy refuses a native charge — nothing moves.
      const refused = await callTool(usdcOnly.client, 'piprail_pay_request', { url: url('/native') })
      const afterRefuse = await ethBal(merchantAddr)
      check('PIPRAIL_TOKENS=USDC refuses a native-ETH charge (declined, no send)',
        refused.json.declined === true && afterRefuse - merchantEthStart === 0n, JSON.stringify(refused.json).slice(0, 160))

      // `native` allowlist settles a REAL native-ETH payment on-chain.
      const paid = await callTool(nativeOk.client, 'piprail_pay_request', { url: url('/native') })
      const merchantEthEnd = await ethBal(merchantAddr)
      check('PIPRAIL_TOKENS=native settles a real native-ETH payment (HTTP 200)', paid.json.status === 200, JSON.stringify(paid.json).slice(0, 160))
      check('settlement receipt records the native asset', paid.json.receipt?.asset === 'native', JSON.stringify(paid.json.receipt))
      check('merchant received EXACTLY 0.0001 ETH on-chain (1e14 wei)', merchantEthEnd - merchantEthStart === 100_000_000_000_000n, `Δwei ${merchantEthEnd - merchantEthStart}`)
      note('the `native` alias is proven end-to-end on-chain — same word the accept side uses (token: \'native\')')
    } finally {
      await nativeOk.close()
      await usdcOnly.close()
    }
  } finally {
    if (mcp) await mcp.close()
    for (const s of merchants) await new Promise((r) => s.close(r))
    anvil.child.kill('SIGKILL')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
