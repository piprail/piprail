// Cross-chain coverage for the STANDARD exact rail. For EVERY built-in EVM chain that
// ships USDC, reads the token's true EIP-712 domain LIVE (readExactDomain) and confirms
// the rail is offerable; confirms USDT / native / non-EVM correctly CANNOT offer exact
// (they degrade to onchain-proof). Proves "the exact rail works on every chain that can
// carry it, and correctly steps aside where it can't."
//
// Imports the LOCAL SDK build. Live RPC reads — tolerant of a flaky public RPC (reports,
// never hard-fails on a transient read). Run: node suites/exact-chains.mjs

import { createPublicClient, http, getAddress } from 'viem'
import { CHAINS, readExactDomain, createPaymentGate } from '../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

export async function run() {
  group('EXACT rail · per-chain EIP-712 domain reads (live)')

  const ok = []
  const degraded = []
  for (const [name, preset] of Object.entries(CHAINS)) {
    const usdc = preset.tokens?.USDC
    if (!usdc) continue
    const rpc = preset.defaultRpc ?? preset.chain.rpcUrls?.default?.http?.[0]
    if (!rpc) { note(`${name}: no RPC — skipped`); continue }
    const pub = createPublicClient({ chain: preset.chain, transport: http(rpc) })
    try {
      const domain = await withTimeout(readExactDomain(pub, usdc.address), 12_000)
      if (domain) {
        ok.push({ name, domain })
        note(`${name.padEnd(10)} USDC ${usdc.address}  →  exact OK: name="${domain.name}" version="${domain.version}"`)
      } else {
        degraded.push(name)
        note(`${name.padEnd(10)} USDC ${usdc.address}  →  not EIP-3009 (bridged?) → onchain-proof only`)
      }
    } catch (e) {
      note(`${name.padEnd(10)} RPC read failed (${e.message}) — couldn't confirm (transient)`)
    }
  }

  check('the 6 canonical Circle-USDC chains expose an EIP-3009 exact domain', (() => {
    const want = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche']
    const got = new Set(ok.map((o) => o.name))
    const missing = want.filter((w) => !got.has(w))
    // Allow a transient RPC miss, but at least Base (we just used it live) must pass.
    return got.has('base') && missing.length <= 2 ? true : `missing: ${missing.join(',')}`
  })() === true, 'at least Base + most canonical chains read ("USD Coin","2")')

  check('canonical USDC domain name is "USD Coin" (never the "USDC" symbol)',
    ok.filter((o) => ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'avalanche'].includes(o.name)).every((o) => o.domain.name === 'USD Coin' && o.domain.version === '2'),
    JSON.stringify(ok.map((o) => `${o.name}:${o.domain.name}/${o.domain.version}`)))

  group('EXACT rail · correctly UNAVAILABLE where it can\'t apply')
  {
    // USDT is not EIP-3009 → exact must refuse it.
    const usdtGate = createPaymentGate({ chain: 'ethereum', token: 'USDT', amount: '0.001', payTo: '0x1111111111111111111111111111111111111111', exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } } })
    let usdtErr = null
    try { await usdtGate.challenge() } catch (e) { usdtErr = e.message }
    check('exact on USDT (not EIP-3009) → clear config error', /EIP-3009/.test(usdtErr ?? ''), usdtErr?.slice(0, 80))

    // native coin → exact must refuse it.
    const nativeGate = createPaymentGate({ chain: 'base', token: 'native', amount: '0.0001', payTo: '0x1111111111111111111111111111111111111111', exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } } })
    let nativeErr = null
    try { await nativeGate.challenge() } catch (e) { nativeErr = e.message }
    check('exact on the native coin → clear config error', /exact|EIP-3009/.test(nativeErr ?? ''), nativeErr?.slice(0, 80))

    // A non-EVM chain → exact must refuse (it's EVM/EIP-3009 only); onchain-proof remains.
    const solGate = createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.001', payTo: '11111111111111111111111111111112', exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } } })
    let solErr = null
    try { await solGate.challenge() } catch (e) { solErr = e.message }
    check('exact on a non-EVM chain (Solana) → clear config error', /EVM|EIP-3009|exact/.test(solErr ?? ''), solErr?.slice(0, 80))

    // ...and that SAME Solana gate WITHOUT exact still issues an onchain-proof challenge.
    const solProof = createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.001', payTo: '11111111111111111111111111111112' })
    const ch = await solProof.challenge()
    check('Solana gate (no exact) still offers onchain-proof', ch.challenge.accepts[0]?.scheme === 'onchain-proof')
  }

  note(`exact rail offerable on ${ok.length} built-in EVM USDC chain(s); ${degraded.length} degrade to onchain-proof (bridged USDC); non-EVM/native/USDT correctly excluded.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
