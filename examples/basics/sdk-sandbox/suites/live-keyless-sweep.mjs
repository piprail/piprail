// LIVE mainnet SWEEP — probe every (funded EVM chain × keyless facilitator) pair to find which
// ones a keyless facilitator will actually SETTLE (sponsor gas for BOTH sides). Each pair that
// settles a real payment (buyer signs EIP-3009, ZERO gas; facilitator broadcasts + pays gas) is
// SEEDABLE into KNOWN_FACILITATORS per THE RULE. Tiny amounts. NOT a unit test — a clean failure
// just means "don't seed that pair."
//
// LOCAL ONLY. Reads the EVM wallet from ../../../../.secrets — never prints keys. Skips a pair cleanly
// when underfunded / RPC down / the facilitator can't sponsor it.
//   Run: node suites/live-keyless-sweep.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createPublicClient, http, erc20Abi, getAddress, formatUnits } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { requirePayment, buildExactAuthorization } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AMOUNT = '0.001'

// (EVM chain × keyless facilitator) candidates. token+addr+decimals pick the EIP-3009 asset the
// facilitator must broadcast (BNB uses FDUSD — its USDC is Binance-Peg/Permit2, not facilitator-settleable).
// Underfunded chains SKIP cleanly. To expand keyless coverage: fund the buyer wallet (index 0) with
// tiny USDC (~$0.05, NO native — the facilitator covers gas) on a chain below, then re-run — a clean
// settle prints "✅ SEEDABLE" with the tx to add to KNOWN_FACILITATORS.
//
// ✅ ALREADY SEEDED (live-settled 2026-06-17): Base (PayAI·xpay·UVD·Dexter·Corbits·GoPlausible),
//    BNB (Dexter·Pieverse / FDUSD), Monad (Corbits·UVD·Pieverse), HyperEVM (UVD),
//    Solana (PayAI·OpenFacilitator·Corbits — separate SVM harness),
//    Algorand (GoPlausible — separate harness: live-algorand-goplausible.mjs). = 6 keyless chains.
// ⏳ FUNDING WORKLIST below — each is covered by a validated keyless facilitator; just needs USDC.
const TARGETS = [
  // ── EXTRA facilitators on ALREADY-KEYLESS funded chains (more facilitators per chain = automatic
  //    failover). These add redundancy, not new chains; each still needs a live keyless settle to seed. ──
  { name: 'Base / Corbits',       chain: 'base',     token: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453,  decimals: 6,  rpc: 'https://base-rpc.publicnode.com',         facilitator: 'https://facilitator.corbits.dev' },
  { name: 'Base / GoPlausible',   chain: 'base',     token: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453,  decimals: 6,  rpc: 'https://base-rpc.publicnode.com',         facilitator: 'https://facilitator.goplausible.xyz' },
  { name: 'Monad / Pieverse',     chain: 'monad',    token: 'USDC',  addr: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', chainId: 143,   decimals: 6,  rpc: 'https://rpc.monad.xyz',                   facilitator: 'https://facilitator.pieverse.io' },
  { name: 'BNB / Pieverse',       chain: 'bnb',      token: 'FDUSD', addr: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', chainId: 56,    decimals: 18, rpc: 'https://bsc-dataseed.binance.org',        facilitator: 'https://facilitator.pieverse.io', amount: '0.005' },
  // ── re-validate the proven EVM rails (idempotent; needs the funded chains) ──
  { name: 'Base / Dexter',        chain: 'base',     token: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453,  decimals: 6,  rpc: 'https://base-rpc.publicnode.com',         facilitator: 'https://x402.dexter.cash' },
  { name: 'BNB / Dexter',         chain: 'bnb',      token: 'FDUSD', addr: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', chainId: 56,    decimals: 18, rpc: 'https://bsc-dataseed.binance.org',        facilitator: 'https://x402.dexter.cash', amount: '0.005' },
  // ── FUNDING WORKLIST → fund tiny USDC on these to unlock keyless (UVD validated on 3 chains) ──
  { name: 'Polygon / Ultravioleta',  chain: 'polygon',  token: 'USDC', addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', chainId: 137,    decimals: 6, rpc: 'https://polygon-rpc.com',                facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Arbitrum / Ultravioleta', chain: 'arbitrum', token: 'USDC', addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161,  decimals: 6, rpc: 'https://arb1.arbitrum.io/rpc',           facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Optimism / Ultravioleta', chain: 'optimism', token: 'USDC', addr: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', chainId: 10,     decimals: 6, rpc: 'https://mainnet.optimism.io',             facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Avalanche / Ultravioleta',chain: 'avalanche',token: 'USDC', addr: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', chainId: 43114,  decimals: 6, rpc: 'https://api.avax.network/ext/bc/C/rpc', facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Celo / Ultravioleta',     chain: 'celo',     token: 'USDC', addr: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', chainId: 42220,  decimals: 6, rpc: 'https://forno.celo.org',                 facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Unichain / Ultravioleta', chain: 'unichain', token: 'USDC', addr: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', chainId: 130,    decimals: 6, rpc: 'https://mainnet.unichain.org',           facilitator: 'https://facilitator.ultravioletadao.xyz' },
  { name: 'Ethereum / Primev',       chain: 'ethereum', token: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1,      decimals: 6, rpc: 'https://ethereum-rpc.publicnode.com',     facilitator: 'https://facilitator.primev.xyz' },
  { name: 'Sei / PayAI',             chain: 'sei',      token: 'USDC', addr: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', chainId: 1329,   decimals: 6, rpc: 'https://evm-rpc.sei-apis.com',           facilitator: 'https://facilitator.payai.network' },
  { name: 'Scroll / Ultravioleta',   chain: 'scroll',   token: 'USDC', addr: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', chainId: 534352, decimals: 6, rpc: 'https://rpc.scroll.io',                  facilitator: 'https://facilitator.ultravioletadao.xyz' },
]

const seedable = []

async function probe(t, payer, merchant) {
  const amount = t.amount ?? AMOUNT
  group(`LIVE keyless · ${t.name} (${t.token}, ${amount})`)
  const amountBase = BigInt(Math.round(Number(amount) * 10 ** t.decimals))
  let pub
  try {
    pub = createPublicClient({ transport: http(t.rpc) })
    await pub.getChainId()
  } catch (e) {
    note(`SKIPPED — ${t.chain} RPC unreachable: ${String(e).slice(0, 70)}`); return
  }
  const tok = getAddress(t.addr)
  const bal = (a) => pub.readContract({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  let p0
  try { p0 = await bal(payer.address) } catch (e) { note(`SKIPPED — couldn't read ${t.token}: ${String(e).slice(0, 70)}`); return }
  note(`payer ${payer.address.slice(0, 10)}…  ${t.token} ${formatUnits(p0, t.decimals)}`)
  if (p0 < amountBase) { note(`SKIPPED — payer needs ≥ ${amount} ${t.token} on ${t.chain}.`); return }

  const app = express()
  app.get('/paid', requirePayment({
    chain: t.chain, token: t.token, amount: amount, payTo: merchant, rpcUrl: t.rpc,
    exact: { settle: { facilitator: t.facilitator } },
  }), (_q, r) => r.json({ unlocked: true }))
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/paid`
  try {
    const ch = await (await fetch(url)).json()
    const rail = ch.accepts?.find((a) => a.scheme === 'exact')
    check(`${t.chain} gate advertised an EIP-3009 exact rail`, rail?.extra?.assetTransferMethod === 'eip3009', JSON.stringify(rail?.extra ?? ch.accepts?.map((a) => a.scheme)))
    if (rail?.extra?.assetTransferMethod !== 'eip3009') { note('No eip3009 rail — not facilitator-settleable. Skip.'); return }

    const m0 = await bal(merchant)
    const accept = { scheme: 'exact', network: rail.network, maxAmountRequired: rail.amount, asset: rail.asset, payTo: rail.payTo, maxTimeoutSeconds: rail.maxTimeoutSeconds, extra: { name: rail.extra.name, version: rail.extra.version } }
    const { authorization, signature } = await buildExactAuthorization({ account: payer, accept, chainId: t.chainId, now: Math.floor(Date.now() / 1000), nonce: `0x${randomBytes(32).toString('hex')}` })
    const header = b64({ x402Version: 2, accepted: rail, payload: { signature, authorization } })

    const r = await fetch(url, { headers: { 'payment-signature': header } })
    const body = await r.json().catch(() => ({}))
    const ok200 = r.status === 200 && body.unlocked === true
    check(`HTTP 200 — ${t.name} GASLESS keyless settle (facilitator sponsored)`, ok200, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`)
    if (!ok200) { note(`NOT seedable: ${t.name} (${body.detail ?? body.error ?? r.status}).`); return }

    const resp = r.headers.get('payment-response') || r.headers.get('x-payment-response')
    const receipt = resp ? JSON.parse(Buffer.from(resp, 'base64').toString('utf8')) : {}
    await sleep(6000)
    const got = (await bal(merchant)) - m0
    check(`merchant received exactly ${amount} ${t.token}`, got === amountBase, `delta=${got}`)
    if (got === amountBase) {
      seedable.push({ ...t, tx: receipt.transaction })
      note(`✅ SEEDABLE: ${t.name} — tx ${receipt.transaction}`)
    }
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

export async function run() {
  group('LIVE keyless facilitator SWEEP — find every both-sides-gasless (chain × facilitator) pair')
  let w
  try { w = JSON.parse(readFileSync(resolve(HERE, '../../../../.secrets/wallets/evm-wallet.json'), 'utf8')) }
  catch { note('SKIPPED — no .secrets/wallets/evm-wallet.json.'); return }
  const payer = mnemonicToAccount(w.mnemonic, { addressIndex: 0 })
  const merchant = mnemonicToAccount(w.mnemonic, { addressIndex: 1 }).address

  for (const t of TARGETS) {
    try { await probe(t, payer, merchant) } catch (e) { note(`${t.name} threw: ${String(e).slice(0, 120)}`) }
  }

  group('SWEEP RESULT — seedable (chain × facilitator) pairs')
  if (seedable.length === 0) note('None settled — nothing new to seed this run.')
  for (const s of seedable) note(`✅ ${s.name}  → KNOWN_FACILITATORS['eip155:${s.chainId}']  facilitator=${s.facilitator}  tx=${s.tx}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
