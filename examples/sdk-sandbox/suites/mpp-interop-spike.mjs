// SPIKE — Can an `mppx` (MPP / Machine Payments Protocol, Wevm) CLIENT pay a
// STANDARD PipRail `exact` x402 gate out of the box? This is the empirical test
// behind the "PipRail is already payable by MPP clients" interop claim.
//
// A/B on ONE PipRail gate (forked Base, self-settled by the merchant's relayer):
//   A) the `mppx` client          (mppx@0.7.0)
//   B) the official @x402 client   (@x402/fetch + @x402/evm)  — the control
//
// If A throws but B succeeds, the gate's wire is standard and the gap is mppx-side.
// Run: node suites/mpp-interop-spike.mjs    (needs Foundry `anvil` + the deps installed)

import { spawn } from 'node:child_process'
import express from 'express'
import {
  createPublicClient, createTestClient, http,
  encodeAbiParameters, keccak256, parseAbi, getAddress, toHex, pad,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { requirePayment } from '../../../sdk/dist/index.js'

const FORK_RPC = process.env.BASE_FORK_RPC ?? 'https://mainnet.base.org'
const PORT = Number(process.env.ANVIL_PORT ?? 8557)
const ANVIL_URL = `http://127.0.0.1:${PORT}`
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const banner = (s) => console.log(`\n${'='.repeat(74)}\n${s}\n${'='.repeat(74)}`)

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

async function main() {
  banner('MPP ⇄ PipRail interop spike — can an mppx client pay a PipRail exact gate?')

  // Load both clients.
  let mppxClient, mppxEvm, x402
  try {
    const c = await import('mppx/client')
    mppxClient = c.Mppx; mppxEvm = c.evm
  } catch (e) { console.log(`ABORT — mppx not installed: ${e.message}`); process.exit(2) }
  try {
    const [fetchMod, evmMod] = await Promise.all([import('@x402/fetch'), import('@x402/evm')])
    x402 = { ...fetchMod, ...evmMod }
  } catch (e) { console.log(`ABORT — @x402/* not installed: ${e.message}`); process.exit(2) }
  if (!(await anvilAvailable())) { console.log('ABORT — Foundry `anvil` not on PATH.'); process.exit(2) }

  let anvil
  try { anvil = await startAnvil() } catch (e) { console.log(`ABORT — ${e.message}`); process.exit(2) }
  const servers = []
  const result = { gate402: null, mppx: null, control: null }
  try {
    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: base, transport })
    const test = createTestClient({ chain: base, mode: 'anvil', transport })
    const usdcBal = (a) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [a] })

    // Two independent payers so the control payment can't affect the mppx attempt.
    const mppxPayer = privateKeyToAccount('0x' + 'c4'.repeat(32))
    const ctrlPayer = privateKeyToAccount('0x' + 'f7'.repeat(32))
    const relayer = privateKeyToAccount('0x' + '2d'.repeat(32))
    const merchant = privateKeyToAccount('0x' + '3e'.repeat(32)).address
    for (const [label, addr] of [['mppxPayer', mppxPayer.address], ['ctrlPayer', ctrlPayer.address], ['relayer', relayer.address], ['merchant', merchant]]) {
      const code = await pub.getCode({ address: addr }).catch(() => undefined)
      if (code && code !== '0x') { console.log(`ABORT — ${label} ${addr} has code (smart wallet); pick a clean-EOA key.`); process.exit(2) }
    }
    await dealUsdc(test, pub, mppxPayer.address, 100_000000n)
    await dealUsdc(test, pub, ctrlPayer.address, 100_000000n)
    await test.setBalance({ address: relayer.address, value: 10n ** 18n })

    // The PipRail gate — IDENTICAL to suite 08's standard exact rail. No mppx awareness.
    const app = express()
    app.get('/paid', requirePayment({
      chain: 'base', token: 'USDC', amount: '0.01', payTo: merchant, rpcUrl: ANVIL_URL,
      exact: { settle: 'self', relayer: { key: '0x' + '2d'.repeat(32) } },
    }), (_q, r) => r.json({ unlocked: true }))
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) }); servers.push(srv)
    const url = `http://127.0.0.1:${srv.address().port}/paid`

    // ---- Show exactly what PipRail emits on the 402 (the wire mppx must consume) ----
    banner('STEP 0 — the raw PipRail 402 (what any client sees)')
    const r0 = await fetch(url)
    const body0 = await r0.json().catch(() => ({}))
    const exactAccept = (body0.accepts ?? []).find((a) => a.scheme === 'exact')
    const bodyStr = JSON.stringify(body0)
    result.gate402 = {
      status: r0.status,
      schemes: (body0.accepts ?? []).map((a) => a.scheme),
      exactNetwork: exactAccept?.network,
      exactExtraKeys: exactAccept ? Object.keys(exactAccept.extra ?? {}) : null,
      hasMppxExtension: bodyStr.includes('"mppx"'),
    }
    console.log(`HTTP ${r0.status}`)
    console.log(`accepts[] schemes: ${result.gate402.schemes.join(', ')}`)
    console.log(`exact rail: network=${result.gate402.exactNetwork} extra=${JSON.stringify(exactAccept?.extra)}`)
    console.log(`challenge contains an "mppx" route-binding extension?  ${result.gate402.hasMppxExtension}`)

    // ---- A) the mppx client ----
    banner('STEP A — mppx client attempts to pay the PipRail exact gate')
    const m0 = await usdcBal(merchant)
    try {
      const mpp = mppxClient.create({
        methods: [mppxEvm.charge({
          account: mppxPayer,
          currencies: [mppxEvm.assets.base.USDC],
          maxAmount: '0.01',
          networks: [8453],
        })],
        polyfill: false,
      })
      const res = await mpp.fetch(url)
      const rbody = await res.json().catch(() => ({}))
      const delta = (await usdcBal(merchant)) - m0
      result.mppx = { paid: res.status === 200 && rbody.unlocked === true, status: res.status, delta: delta.toString(), error: rbody.error ?? null }
      console.log(`mppx fetch returned HTTP ${res.status}  unlocked=${rbody.unlocked === true}  merchant Δ=${delta} (base units)`)
    } catch (e) {
      result.mppx = { paid: false, threw: e.message, cause: e.cause?.message ?? null }
      console.log(`mppx THREW before/at signing:`)
      console.log(`   message: ${e.message}`)
      if (e.cause?.message) console.log(`   cause:   ${e.cause.message}`)
    }

    // ---- B) the official @x402 reference client (control, same gate) ----
    banner('STEP B (control) — official @x402 client pays the SAME gate')
    const c0 = await usdcBal(merchant)
    try {
      const signer = x402.toClientEvmSigner(ctrlPayer)
      const client = new x402.x402Client().register('eip155:8453', new x402.ExactEvmScheme(signer))
      const fetchWithPay = x402.wrapFetchWithPayment(fetch, client)
      const res = await fetchWithPay(url)
      const rbody = await res.json().catch(() => ({}))
      const delta = (await usdcBal(merchant)) - c0
      result.control = { paid: res.status === 200 && rbody.unlocked === true, status: res.status, delta: delta.toString() }
      console.log(`@x402 fetch returned HTTP ${res.status}  unlocked=${rbody.unlocked === true}  merchant Δ=${delta} (base units = ${Number(delta) / 1e6} USDC)`)
    } catch (e) {
      result.control = { paid: false, threw: e.message }
      console.log(`@x402 THREW: ${e.message}`)
    }
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r))
    anvil.child.kill('SIGKILL')
  }

  // ---- Verdict ----
  banner('VERDICT')
  console.log(JSON.stringify(result, null, 2))
  const gateStandard = result.control?.paid === true
  const mppxPaid = result.mppx?.paid === true
  console.log('')
  console.log(`PipRail gate is standard-x402-payable (control @x402 client): ${gateStandard ? 'YES' : 'NO'}`)
  console.log(`mppx client paid the PipRail gate out of the box:             ${mppxPaid ? 'YES' : 'NO'}`)
  if (gateStandard && !mppxPaid) {
    console.log('\n=> CLAIM REFUTED: a stock mppx client CANNOT pay a standard PipRail exact 402.')
    console.log('   The gate IS industry-standard (the @x402 reference client pays it); the gap is mppx-side')
    console.log('   (mppx requires its own extensions.mppx route-binding block in the challenge).')
  } else if (gateStandard && mppxPaid) {
    console.log('\n=> CLAIM CONFIRMED: a stock mppx client paid a standard PipRail exact gate, no code changes.')
  } else {
    console.log('\n=> INCONCLUSIVE — see the JSON above (the control client did not pay, so the harness/fork is suspect).')
  }
  process.exit(0)
}

await main()
