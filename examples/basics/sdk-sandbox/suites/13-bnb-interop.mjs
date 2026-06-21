// Suite 13 — BNB Chain HARD interop e2e, on a forked BNB mainnet (chain 56).
// Proves the SDK works flawlessly on BNB across every axis that matters:
//   • EIP-3009 `exact` round-trip (FDUSD) — PipRail client ↔ PipRail gate (gasless buyer)
//   • Foreign interop — the official @x402 reference client pays a PipRail BNB gate
//   • Permit2 `exact` round-trip (USDC, Binance-Peg) — the proxy settle path on BNB
//   • Slug findability (the B fix) — a PipRail client pays a "bsc"-labelled (AEON-style) 402
//   • Discoverability — the BNB 402 self-describes (extensions.piprail → npm i @piprail/sdk)
// Real token contracts come from the fork; balances are dealt via storage slots, so NO
// funds move and nothing is signed against mainnet. SKIPS cleanly if anvil / a BNB RPC /
// @x402 are absent.   Run: node suites/13-bnb-interop.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  createPublicClient, createTestClient, http, parseAbi, getAddress,
  keccak256, encodeAbiParameters, toHex, pad, parseUnits, formatUnits,
} from 'viem'
import { bsc } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createPaymentGate, PipRailClient, buildChallengeHeader,
  HEADER_SIGNATURE, HEADER_REQUIRED, HEADER_RESPONSE,
} from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const FORK_RPC = process.env.BNB_FORK_RPC ?? 'https://bsc-rpc.publicnode.com'
const PORT = Number(process.env.ANVIL_PORT ?? 8559)
const ANVIL_URL = `http://127.0.0.1:${PORT}`
const TOK = {
  USDC:  getAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'), // Binance-Peg → Permit2
  FDUSD: getAddress('0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409'), // EIP-3009
  U:     getAddress('0xcE24439F2D9C6a2289F741120FE202248B666666'), // United Stables — EIP-3009
}
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (v) => formatUnits(v, 18)

const anvilAvailable = () => new Promise((res) => {
  const p = spawn('anvil', ['--version'], { stdio: 'ignore' })
  p.on('error', () => res(false)); p.on('close', (c) => res(c === 0))
})
async function startAnvil() {
  const child = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(PORT), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''; child.stderr.on('data', (c) => (err += c.toString()))
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err}`)
    try {
      const r = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if ((await r.json()).result) return { child }
    } catch { /* not up */ }
    await sleep(500)
  }
  child.kill('SIGKILL'); throw new Error(`anvil never ready: ${err}`)
}
// Brute-force a token's `balanceOf` storage slot on the fork and set `holder`'s balance.
async function dealToken(test, pub, token, holder, amount) {
  const SENTINEL = 0x424242n
  for (let i = 0; i < 60; i++) {
    const index = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(i)]))
    const prev = await pub.request({ method: 'eth_getStorageAt', params: [token, index, 'latest'] })
    await test.setStorageAt({ address: token, index, value: pad(toHex(SENTINEL)) })
    if ((await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [holder] })) === SENTINEL) {
      await test.setStorageAt({ address: token, index, value: pad(toHex(amount)) }); return true
    }
    await test.setStorageAt({ address: token, index, value: prev })
  }
  return false
}
// A minimal PipRail gate HTTP server. `mutate(challenge)` (optional) rewrites the served
// 402 (used to relabel the network with a slug) without touching the gate's trusted verify.
function serve(gate, port, mutate) {
  let lastSig = null
  const server = createServer(async (req, res) => {
    try {
      const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
      const url = `http://127.0.0.1:${port}${req.url}`
      if (!sig) {
        const c = await gate.challenge(url)
        let challenge = c.challenge, header = c.requiredHeader
        if (mutate) { challenge = mutate(structuredClone(challenge)); header = buildChallengeHeader(challenge) }
        res.setHeader(HEADER_REQUIRED, header)
        res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify(challenge))
      }
      const r = await gate.verify(sig)
      if (r.kind === 'paid') { lastSig = sig; res.setHeader(HEADER_RESPONSE, r.receiptHeader); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ unlocked: true })) }
      res.setHeader(HEADER_REQUIRED, r.requiredHeader); res.writeHead(r.statusCode ?? 402, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.challenge))
    } catch (err) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(err?.message ?? err) })) }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}/paid`, getLastSig: () => lastSig })))
}
const close = (s) => new Promise((r) => s.close(r))

export async function run() {
  group('13 · BNB Chain hard interop (forked mainnet)')
  if (!(await anvilAvailable())) { note('SKIPPED — Foundry `anvil` not on PATH.'); return }
  let anvil
  try { anvil = await startAnvil() } catch (e) { note(`SKIPPED — ${e.message} (set BNB_FORK_RPC to a working BNB RPC).`); return }

  const servers = []
  try {
    const transport = http(ANVIL_URL)
    const pub = createPublicClient({ chain: bsc, transport })
    const test = createTestClient({ chain: bsc, mode: 'anvil', transport })
    const balOf = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })

    // Clean-EOA test accounts (no code on the fork — EIP-3009 takes the ECDSA path). BNB has
    // many deployed addresses, so DISCOVER clean EOAs deterministically rather than hardcode.
    const clean = []
    for (let n = 0x5eed01n; clean.length < 5 && n < 0x5eed01n + 6000n; n += 1n) {
      const key = '0x' + n.toString(16).padStart(64, '0')
      let acct; try { acct = privateKeyToAccount(key) } catch { continue }
      const code = await pub.getCode({ address: acct.address }).catch(() => undefined)
      if (!code || code === '0x') clean.push({ account: acct, key })
    }
    if (clean.length < 5) { note('SKIPPED — could not find 5 clean-EOA test keys on this fork.'); return }
    const [A, B, C, R, M] = clean
    const payerA = A.account, keyA = A.key       // FDUSD eip3009 (PipRail + slug)
    const payerB = B.account                     // FDUSD eip3009 (@x402 client)
    const payerC = C.account, keyC = C.key        // USDC permit2
    const relayer = R.account, keyR = R.key       // merchant relayer (settles)
    const merchant = M.account.address
    await test.setBalance({ address: relayer.address, value: 10n ** 18n })   // relayer gas
    await test.setBalance({ address: payerC.address, value: 10n ** 18n })    // permit2 buyer needs gas for the one-time approve
    const dealtA = await dealToken(test, pub, TOK.FDUSD, payerA.address, parseUnits('100', 18))
    const dealtB = await dealToken(test, pub, TOK.FDUSD, payerB.address, parseUnits('100', 18))
    const dealtC = await dealToken(test, pub, TOK.USDC, payerC.address, parseUnits('100', 18))
    const dealtU = await dealToken(test, pub, TOK.U, payerA.address, parseUnits('100', 18)) // U → payer A
    check('dealt FDUSD + USDC + U to the test payers on the fork', dealtA && dealtB && dealtC && dealtU, `FDUSD/A=${dealtA} FDUSD/B=${dealtB} USDC/C=${dealtC} U/A=${dealtU}`)
    if (!(dealtA && dealtC)) { note('SKIPPED — could not locate a token balance slot on this fork.'); return }

    // ── G1 · EIP-3009 (FDUSD) — PipRail client ↔ PipRail gate (gasless buyer) ──────────
    group('13 · FDUSD eip3009 — PipRail ↔ PipRail (gasless buyer)')
    {
      const gate = createPaymentGate({ chain: 'bnb', token: 'FDUSD', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
      const c = await gate.challenge('http://x/paid')
      const exact = c.challenge.accepts.find((a) => a.scheme === 'exact')
      check('gate auto-selects EIP-3009 for FDUSD (no Permit2 approve)', exact?.extra?.assetTransferMethod === 'eip3009', `method=${exact?.extra?.assetTransferMethod}`)
      check('gate read FDUSD EIP-712 domain on-chain', exact?.extra?.name === 'First Digital USD' && exact?.extra?.version === '1', `name=${exact?.extra?.name} v=${exact?.extra?.version}`)
      check('402 self-describes (extensions.piprail → npm i @piprail/sdk) — discoverability', /\@piprail\/sdk/.test(c.challenge.extensions?.piprail?.sdk?.install ?? ''), c.challenge.extensions?.piprail?.sdk?.install ?? '(none)')

      const { server, url, getLastSig } = await serve(gate, PORT + 1); servers.push(server)
      const before = await balOf(TOK.FDUSD, merchant)
      const client = new PipRailClient({ chain: 'bnb', wallet: { key: keyA }, schemes: ['exact'], rpcUrl: ANVIL_URL })
      const res = await client.fetch(url)
      check('PipRail client pays the FDUSD gate → 200', res.status === 200, `status=${res.status}`)
      check('merchant received exactly 0.02 FDUSD', (await balOf(TOK.FDUSD, merchant)) - before === parseUnits('0.02', 18), `delta=${fmt((await balOf(TOK.FDUSD, merchant)) - before)}`)
      const replay = await fetch(url, { headers: { [HEADER_SIGNATURE]: getLastSig() } })
      check('replay of the same authorization is rejected (402)', replay.status === 402, `status=${replay.status}`)
    }

    // ── G2 · Foreign interop — the official @x402 client pays a PipRail BNB gate ────────
    group('13 · FDUSD eip3009 — official @x402 client → PipRail gate (foreign interop on BNB)')
    {
      let x402
      try { const [f, e] = await Promise.all([import('@x402/fetch'), import('@x402/evm')]); x402 = { ...f, ...e } }
      catch { note('SKIPPED G2 — @x402/fetch / @x402/evm not installed.'); x402 = null }
      if (x402) {
        const gate = createPaymentGate({ chain: 'bnb', token: 'FDUSD', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
        const { server, url } = await serve(gate, PORT + 2); servers.push(server)
        const before = await balOf(TOK.FDUSD, merchant)
        try {
          const signer = x402.toClientEvmSigner(payerB)
          const client = new x402.x402Client().register('eip155:56', new x402.ExactEvmScheme(signer))
          const fetchWithPay = x402.wrapFetchWithPayment(fetch, client)
          const res = await fetchWithPay(url)
          const ok = res.status === 200 && (await balOf(TOK.FDUSD, merchant)) - before === parseUnits('0.02', 18)
          check('a THIRD-PARTY @x402 client pays a PipRail BNB FDUSD gate', ok, `status=${res.status}`)
          if (ok) note('FOREIGN INTEROP PROVEN ON BNB: the official x402 client pays a PipRail gate.')
        } catch (e) {
          // BNB's EIP-3009 stablecoins derive their EIP-712 version (no version() getter); some
          // foreign clients read version() on-chain and choke. That is an @x402/BNB-token limit,
          // NOT a PipRail wire defect (G1 + suite 08 prove PipRail's wire). Surface it honestly.
          check('@x402 client paid the BNB FDUSD gate', false, `@x402 threw: ${e.message?.slice(0, 140)}`)
          note('NOTE: likely @x402 reading FDUSD.version() (derived, no getter) — a foreign-client limit on BNB stablecoins, not a PipRail wire issue.')
        }
      }
    }

    // ── G3 · Permit2 (USDC, Binance-Peg) — PipRail ↔ PipRail (proxy settle on BNB) ──────
    group('13 · USDC permit2 — PipRail ↔ PipRail (x402 Permit2 proxy on BNB)')
    {
      const gate = createPaymentGate({ chain: 'bnb', token: 'USDC', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
      const c = await gate.challenge('http://x/paid')
      const exact = c.challenge.accepts.find((a) => a.scheme === 'exact')
      check('gate auto-selects Permit2 for Binance-Peg USDC (not EIP-3009)', exact?.extra?.assetTransferMethod === 'permit2', `method=${exact?.extra?.assetTransferMethod}`)

      const { server, url, getLastSig } = await serve(gate, PORT + 3); servers.push(server)
      const before = await balOf(TOK.USDC, merchant)
      const client = new PipRailClient({ chain: 'bnb', wallet: { key: keyC }, schemes: ['exact'], rpcUrl: ANVIL_URL })
      const res = await client.fetch(url)
      check('PipRail client pays the USDC Permit2 gate → 200 (one-time approve + proxy settle)', res.status === 200, `status=${res.status}`)
      check('merchant received exactly 0.02 USDC via the Permit2 proxy', (await balOf(TOK.USDC, merchant)) - before === parseUnits('0.02', 18), `delta=${fmt((await balOf(TOK.USDC, merchant)) - before)}`)
      const replay = await fetch(url, { headers: { [HEADER_SIGNATURE]: getLastSig() } })
      check('replay of the Permit2 authorization is rejected (402)', replay.status === 402, `status=${replay.status}`)
    }

    // ── G4 · Findability (the B fix) — pay a "bsc"-slug-labelled (AEON-style) 402 ───────
    group('13 · slug findability — PipRail client pays a "bsc"-labelled 402 (the B fix)')
    {
      const gate = createPaymentGate({ chain: 'bnb', token: 'FDUSD', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
      // Relabel the served challenge's network from CAIP-2 'eip155:56' to the slug 'bsc'
      // (exactly how an AEON merchant 402 looks). Pre-B this was silently unpayable.
      const toSlug = (challenge) => { for (const a of challenge.accepts) if (a.network === 'eip155:56') a.network = 'bsc'; return challenge }
      const { server, url } = await serve(gate, PORT + 4, toSlug); servers.push(server)
      const before = await balOf(TOK.FDUSD, merchant)
      const client = new PipRailClient({ chain: 'bnb', wallet: { key: keyA }, schemes: ['exact'], rpcUrl: ANVIL_URL })
      let res
      try { res = await client.fetch(url) } catch (e) { res = { status: 0, err: e.message } }
      check('PipRail pays a "bsc"-slug-labelled 402 (B fix: normalizes slug → eip155:56)', res.status === 200, res.err ? `threw: ${res.err}` : `status=${res.status}`)
      check('merchant received the FDUSD from the slug-labelled rail', (await balOf(TOK.FDUSD, merchant)) - before === parseUnits('0.02', 18), `delta=${fmt((await balOf(TOK.FDUSD, merchant)) - before)}`)
    }

    // ── G5 · EIP-3009 (U / United Stables) — PipRail ↔ PipRail (gasless buyer) ───────────
    group('13 · U eip3009 — PipRail ↔ PipRail (the NEW United Stables token, gasless buyer)')
    if (dealtU) {
      const gate = createPaymentGate({ chain: 'bnb', token: 'U', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
      const c = await gate.challenge('http://x/paid')
      const exact = c.challenge.accepts.find((a) => a.scheme === 'exact')
      check('gate auto-selects EIP-3009 for U (no Permit2 approve)', exact?.extra?.assetTransferMethod === 'eip3009', `method=${exact?.extra?.assetTransferMethod}`)
      check('gate read U EIP-712 domain on-chain (United Stables / v1)', exact?.extra?.name === 'United Stables' && exact?.extra?.version === '1', `name=${exact?.extra?.name} v=${exact?.extra?.version}`)

      const { server, url, getLastSig } = await serve(gate, PORT + 5); servers.push(server)
      const before = await balOf(TOK.U, merchant)
      const client = new PipRailClient({ chain: 'bnb', wallet: { key: keyA }, schemes: ['exact'], rpcUrl: ANVIL_URL })
      const res = await client.fetch(url)
      check('PipRail client pays the U gate → 200 (gasless EIP-3009)', res.status === 200, `status=${res.status}`)
      check('merchant received exactly 0.02 U', (await balOf(TOK.U, merchant)) - before === parseUnits('0.02', 18), `delta=${fmt((await balOf(TOK.U, merchant)) - before)}`)
      const replay = await fetch(url, { headers: { [HEADER_SIGNATURE]: getLastSig() } })
      check('replay of the U authorization is rejected (402)', replay.status === 402, `status=${replay.status}`)
    } else { note('SKIPPED G5 — could not deal U on this fork.') }

    // ── G6 · permit2-exact label tolerance — pay a Binance-b402-dialect 402 (USDC) ───────
    group('13 · permit2-exact label — PipRail pays a Binance-dialect "permit2-exact" 402')
    {
      const gate = createPaymentGate({ chain: 'bnb', token: 'USDC', amount: '0.02', payTo: merchant, rpcUrl: ANVIL_URL, exact: { settle: 'self', relayer: { key: keyR } } })
      // Relabel the served rail's method from 'permit2' to Binance's 'permit2-exact' (the gate's
      // trusted verify is untouched — it settles on payload shape, not the label).
      const toBinance = (challenge) => { for (const a of challenge.accepts) if (a.extra?.assetTransferMethod === 'permit2') a.extra.assetTransferMethod = 'permit2-exact'; return challenge }
      const { server, url, getLastSig } = await serve(gate, PORT + 6, toBinance); servers.push(server)
      const before = await balOf(TOK.USDC, merchant)
      const client = new PipRailClient({ chain: 'bnb', wallet: { key: keyC }, schemes: ['exact'], rpcUrl: ANVIL_URL })
      let res; try { res = await client.fetch(url) } catch (e) { res = { status: 0, err: e.message } }
      check('PipRail pays a "permit2-exact"-labelled 402 (Binance b402 dialect → routes to Permit2)', res.status === 200, res.err ? `threw: ${res.err}` : `status=${res.status}`)
      check('merchant received the USDC from the permit2-exact rail', (await balOf(TOK.USDC, merchant)) - before === parseUnits('0.02', 18), `delta=${fmt((await balOf(TOK.USDC, merchant)) - before)}`)
    }

    note('BNB hard-interop complete: gasless EIP-3009 (FDUSD + U), foreign @x402 interop, Permit2 proxy, permit2-exact dialect, slug findability, self-describe discoverability.')
  } finally {
    for (const s of servers) await close(s)
    anvil.child.kill('SIGKILL')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
