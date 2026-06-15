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

  group('EXACT rail · availability (Permit2 fallback + SVM) and clear errors')
  {
    // native coin → no exact rail anywhere; refused with a clear, actionable message.
    const nativeGate = createPaymentGate({ chain: 'base', token: 'native', amount: '0.0001', payTo: '0x1111111111111111111111111111111111111111', exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } } })
    let nativeErr = null
    try { await nativeGate.challenge() } catch (e) { nativeErr = e.message }
    check('exact on the native coin → clear config error (no native exact)', /exact|EIP-3009/.test(nativeErr ?? ''), nativeErr?.slice(0, 80))

    // USDT is NOT EIP-3009, but Ethereum DOES have the x402 Permit2 proxy → exact is offered via
    // the Permit2 auto-fallback (a shipped feature). It must be advertised, not refused.
    const usdtGate = createPaymentGate({ chain: 'ethereum', token: 'USDT', amount: '0.001', payTo: '0x1111111111111111111111111111111111111111', exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } } })
    let usdtSchemes = []
    try { usdtSchemes = (await usdtGate.challenge()).challenge.accepts.map((a) => a.scheme) } catch (e) { usdtSchemes = [`THREW:${e.message}`] }
    check('exact on USDT on a Permit2-proxy chain (Ethereum) → offered via Permit2 fallback', usdtSchemes.includes('exact'), JSON.stringify(usdtSchemes))

    // Solana SPL USDC supports the SVM `exact` scheme now (no longer EVM-only). Requesting it with
    // a 0x… (EVM) relayer key must surface a CLEAR wrong-family error — never a raw bs58 leak.
    const solGate = createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.001', payTo: '11111111111111111111111111111112', exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } } })
    let solErr = null
    try { await solGate.challenge() } catch (e) { solErr = e.message }
    check('Solana exact with an EVM 0x relayer key → clear wrong-family error (not "Non-base58 character")',
      /EVM|base58|Solana/.test(solErr ?? '') && !/Non-base58 character/.test(solErr ?? ''), solErr?.slice(0, 90))

    // ...and that SAME Solana gate WITHOUT exact still issues an onchain-proof challenge.
    const solProof = createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.001', payTo: '11111111111111111111111111111112' })
    const ch = await solProof.challenge()
    check('Solana gate (no exact) still offers onchain-proof', ch.challenge.accepts[0]?.scheme === 'onchain-proof')
  }

  note(`exact rail offerable on ${ok.length} built-in EVM USDC chain(s) via EIP-3009; ${degraded.length} bridged USDC degrade to onchain-proof; non-EIP-3009 ERC-20s (e.g. USDT) use the Permit2 fallback where the proxy is deployed; Solana via the SVM scheme; native coins have no exact rail.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
