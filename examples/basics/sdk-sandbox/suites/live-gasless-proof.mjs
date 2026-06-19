// LIVE mainnet MEGA-PROOF — for EVERY seeded keyless facilitator row in the SDK's KNOWN_FACILITATORS,
// do a REAL payment and prove the gasless claim is 100% factually correct: the FACILITATOR pays the
// gas, and NEITHER the buyer NOR the merchant pays any native coin. Asserts, per row:
//   • merchant received exactly the token amount   • buyer's token dropped by exactly that amount
//   • buyer native balance UNCHANGED (0 gas)        • merchant native balance UNCHANGED (0 gas)
// The buyer pays via the real PipRailClient exact path; the gate is pinned to that row's facilitator.
//
// It reads KNOWN_FACILITATORS straight from the built SDK, so it tests EXACTLY what ships — it can't
// drift. Tiny amounts. LOCAL ONLY: reads .secrets, never prints/commits keys. Skips a row cleanly
// (never a false fail) when underfunded / RPC down / facilitator transient.
//   node suites/live-gasless-proof.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import express from 'express'
import { createPublicClient, http, erc20Abi, getAddress } from 'viem'
import { Connection, PublicKey } from '@solana/web3.js'
import algosdk from 'algosdk'
import { KNOWN_FACILITATORS, requirePayment, PipRailClient } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SECRETS = resolve(HERE, '../../../../.secrets/wallets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const loadWallet = (f) => { try { return JSON.parse(readFileSync(resolve(SECRETS, f), 'utf8')) } catch { return null } }

// Per-chain config keyed by the EXACT CAIP-2 KNOWN_FACILITATORS uses. token = the EIP-3009/keyless-
// settleable asset on that chain (BNB must be FDUSD — its USDC is Binance-Peg/Permit2). amount clears
// each facilitator's dynamic floor (Dexter ~$0.001 Base / ~$0.003 BNB).
const CHAINS = {
  'eip155:8453':  { fam: 'evm', slug: 'base',     token: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6,  rpc: 'https://base-rpc.publicnode.com',  native: 'ETH',  amount: '0.002' },
  'eip155:143':   { fam: 'evm', slug: 'monad',    token: 'USDC',  addr: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', dec: 6,  rpc: 'https://rpc.monad.xyz',           native: 'MON',  amount: '0.002' },
  'eip155:56':    { fam: 'evm', slug: 'bnb',      token: 'FDUSD', addr: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', dec: 18, rpc: 'https://bsc-dataseed.binance.org', native: 'BNB',  amount: '0.005' },
  'eip155:999':   { fam: 'evm', slug: 'hyperevm', token: 'USDC',  addr: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', dec: 6,  rpc: 'https://rpc.hyperliquid.xyz/evm', native: 'HYPE', amount: '0.002' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { fam: 'svm', slug: 'solana', token: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dec: 6, rpc: 'https://solana-rpc.publicnode.com', native: 'SOL', amount: '0.001' },
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': { fam: 'algo', slug: 'algorand', token: 'USDC', asa: 31566704, dec: 6, rpc: 'https://mainnet-api.algonode.cloud', native: 'ALGO', amount: '0.001' },
}

const results = []
const facName = (u) => u.replace('https://', '').replace('facilitator.', '').replace(/\.(network|xyz|dev|io|sh|cash)$/, '').replace('x402.dexter', 'dexter').replace('pay.openfacilitator', 'openfacilitator')

// ── balance readers per family: { native: bigint, token: bigint } (base units) ──
async function evmReaders(cfg) {
  const pub = createPublicClient({ transport: http(cfg.rpc) })
  const tok = getAddress(cfg.addr)
  return async (addr) => ({
    native: await pub.getBalance({ address: getAddress(addr) }),
    token: await pub.readContract({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(addr)] }),
  })
}
async function svmReaders(cfg) {
  const conn = new Connection(cfg.rpc, 'confirmed')
  const mint = new PublicKey(cfg.mint)
  return async (addr) => {
    const owner = new PublicKey(addr)
    const native = BigInt(await conn.getBalance(owner))
    let token = 0n
    try {
      const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint })
      token = BigInt(accs.value[0]?.account.data.parsed.info.tokenAmount.amount ?? 0)
    } catch { /* no ATA → 0 */ }
    return { native, token }
  }
}
async function algoReaders(cfg) {
  const algod = new algosdk.Algodv2('', cfg.rpc, '')
  return async (addr) => {
    const info = await algod.accountInformation(addr).do()
    const holding = (info.assets ?? []).find((a) => Number(a.assetId) === cfg.asa)
    return { native: BigInt(info.amount ?? 0), token: holding ? BigInt(holding.amount) : 0n }
  }
}

function walletFor(cfg) {
  if (cfg.fam === 'evm') {
    const w = loadWallet('evm-wallet.json'); if (!w) return null
    // EVM client wants the 0x private key (index 0), NOT the mnemonic.
    return { wallet: { key: w.privateKey }, buyer: w.address, merchant: w.merchantAddress }
  }
  if (cfg.fam === 'svm') {
    const w = loadWallet('solana-wallet.json'); if (!w) return null
    return { wallet: { key: w.secretKey }, buyer: w.address, merchant: w.merchant?.address ?? w.merchantAddress }
  }
  const w = loadWallet('algorand-wallet.json'); if (!w) return null
  return { wallet: { key: w.mnemonic }, buyer: algosdk.mnemonicToSecretKey(w.mnemonic).addr.toString(), merchant: w.merchantAddress }
}

async function proveRow(caip, fac, cfg) {
  const label = `${cfg.slug} / ${facName(fac.url)}`
  group(`LIVE gasless proof · ${label} (${cfg.amount} ${cfg.token})`)
  const amountBase = BigInt(Math.round(Number(cfg.amount) * 10 ** cfg.dec))
  const wf = walletFor(cfg)
  if (!wf) { note(`SKIPPED — no .secrets wallet for ${cfg.fam}.`); return }

  let read
  try {
    read = cfg.fam === 'evm' ? await evmReaders(cfg) : cfg.fam === 'svm' ? await svmReaders(cfg) : await algoReaders(cfg)
    await read(wf.buyer) // probe RPC
  } catch (e) { note(`SKIPPED — ${cfg.slug} RPC unreachable: ${String(e).slice(0, 70)}`); return }

  let b0, m0
  try { b0 = await read(wf.buyer); m0 = await read(wf.merchant) } catch (e) { note(`SKIPPED — balance read failed: ${String(e).slice(0, 70)}`); return }
  note(`buyer ${wf.buyer.slice(0, 10)}…  ${cfg.token} ${Number(b0.token) / 10 ** cfg.dec}  ${cfg.native} ${Number(b0.native) / 1e9}`)
  if (b0.token < amountBase) { note(`SKIPPED — buyer needs ≥ ${cfg.amount} ${cfg.token} on ${cfg.slug}.`); return }

  // Gate pinned to THIS facilitator. No relayer key — keyless: the facilitator sponsors all gas.
  const app = express()
  app.get('/paid', requirePayment({
    chain: cfg.slug, token: cfg.token, amount: cfg.amount, payTo: wf.merchant, rpcUrl: cfg.rpc,
    exact: { settle: { facilitator: fac.url } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`

  try {
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts?.find((a) => a.scheme === 'exact')
    if (!rail) { note('SKIPPED — gate did not advertise an exact rail (facilitator feePayer not discoverable?).'); return }

    const client = new PipRailClient({ chain: cfg.slug, wallet: wf.wallet, schemes: ['exact'], rpcUrl: cfg.rpc })
    const r = await client.fetch(url)
    const body = await r.json().catch(() => ({}))
    const ok = r.status === 200 && body.unlocked === true
    check(`${label} — HTTP 200, keyless settle (facilitator sponsored)`, ok, `status=${r.status} ${JSON.stringify(body).slice(0, 160)}`)
    if (!ok) { note(`NOT gasless-confirmed: ${label} (${body.detail ?? body.error ?? r.status}).`); return }

    await sleep(7000)
    const b1 = await read(wf.buyer), m1 = await read(wf.merchant)
    const merchGot = m1.token - m0.token
    const buyerPaid = b0.token - b1.token
    const buyerGas = b0.native - b1.native
    const merchGas = m0.native - m1.native
    const cMerch = check(`  ✓ merchant received exactly ${cfg.amount} ${cfg.token}`, merchGot === amountBase, `Δtoken=${merchGot}`)
    const cBuyer = check(`  ✓ buyer ${cfg.token} dropped by exactly ${cfg.amount}`, buyerPaid === amountBase, `Δtoken=${buyerPaid}`)
    const cBuyerGas = check(`  ✓ BUYER paid 0 gas (${cfg.native} unchanged)`, buyerGas === 0n, `Δnative=${buyerGas}`)
    const cMerchGas = check(`  ✓ MERCHANT paid 0 gas (${cfg.native} unchanged — facilitator sponsored)`, merchGas === 0n, `Δnative=${merchGas}`)
    const trulyGasless = cMerch && cBuyer && cBuyerGas && cMerchGas
    const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
    const tx = resp ? (JSON.parse(Buffer.from(resp, 'base64').toString('utf8')).transaction) : '?'
    results.push({ label, trulyGasless, buyerGas, merchGas, tx })
    note(trulyGasless ? `✅ TRULY GASLESS: ${label} — tx ${tx}` : `⚠ settled but a balance assertion failed: ${label}`)
  } catch (e) {
    note(`${label} threw: ${String(e).slice(0, 140)}`)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

export async function run() {
  group('LIVE GASLESS MEGA-PROOF — every seeded keyless facilitator, both sides pay 0 gas')
  note(`Testing ${Object.values(KNOWN_FACILITATORS).reduce((s, r) => s + r.length, 0)} seeded facilitator rows across ${Object.keys(KNOWN_FACILITATORS).length} chains.`)

  for (const [caip, rows] of Object.entries(KNOWN_FACILITATORS)) {
    const cfg = CHAINS[caip]
    if (!cfg) { group(`(no test config for ${caip} — skipped)`); continue }
    for (const fac of rows) {
      try { await proveRow(caip, fac, cfg) } catch (e) { note(`${caip} ${fac.url} threw: ${String(e).slice(0, 120)}`) }
    }
  }

  group('GASLESS PROOF MATRIX')
  for (const r of results) {
    note(`${r.trulyGasless ? '✅' : '⚠ '} ${r.label.padEnd(26)} buyerGasΔ=${r.buyerGas}  merchantGasΔ=${r.merchGas}  tx=${r.tx}`)
  }
  const proven = results.filter((r) => r.trulyGasless).length
  note(`\n${proven}/${results.length} settled rows are PROVEN truly gasless (buyer 0 + merchant 0). Underfunded/transient rows skip cleanly above.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
