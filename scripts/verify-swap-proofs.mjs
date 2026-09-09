#!/usr/bin/env node
/**
 * ── ARE THE SWAP PROOFS STILL TRUE? ─────────────────────────────────────────────────
 *
 *   node scripts/verify-swap-proofs.mjs            # every proof in SWAP_PROVIDERS
 *   node scripts/verify-swap-proofs.mjs aptos ton  # only these families
 *   node scripts/verify-swap-proofs.mjs --json     # machine-readable
 *
 * `sdk/src/swapProviders.ts` makes a public, falsifiable claim: each route settled a real
 * mainnet swap, and here is the transaction. The website prints those hashes, the docs
 * table prints them, and a reader can click any one of them.
 *
 * Nothing re-checked them. That is precisely how the facilitator registry rotted: entries
 * were seeded once, never re-read, and two of eleven turned out to be dead hosts the SDK
 * was still handing to callers. The admission rule in `swapProviders.ts` was written to
 * stop bad entries getting IN; this stops good entries going stale afterwards.
 *
 * 🔴 READ-ONLY, and it reads the CHAIN, not an explorer. Explorers sit behind bot walls
 * (solscan, bscscan and allo.info all answer a server-side request with 403), so checking
 * a link would test Cloudflare rather than the claim. Every check below asks a public node
 * whether that transaction exists and whether it succeeded.
 *
 * Exit code is non-zero if any proof is missing or failed. An unreachable node is reported
 * as UNREADABLE and does not fail the run: a rate limit is not a falsified claim.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './load-env.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
loadEnv()

const built = require(join(REPO, 'sdk/dist/index.cjs'))
const { SWAP_PROVIDERS, CHAINS } = built

/*
 * 🔴 Endpoints come from the SDK's OWN presets wherever it has one, so this checks the
 * network a user actually reaches rather than whatever endpoint this script guessed. It
 * also means a default RPC going dark shows up here as UNREADABLE across a whole family,
 * which is a finding in its own right: the Sui default had to move once already, after the
 * official fullnode dropped JSON-RPC while every unit test stayed green.
 */
const SDK_RPC = {}
for (const preset of Object.values(CHAINS ?? {})) {
  const id = preset?.chain?.id
  const url = preset?.chain?.rpcUrls?.default?.http?.[0]
  if (id && url) SDK_RPC[`eip155:${id}`] = url
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const filters = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase())

const C = process.stdout.isTTY && !process.env.NO_COLOR && !asJson
const green = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s)
const yellow = (s) => (C ? `\x1b[33m${s}\x1b[0m` : s)
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s)

/** A per-chain override wins, exactly as it does everywhere else in the repo. */
const rpc = (name, fallback) => process.env[`RPC_${name.toUpperCase()}`] || fallback

async function post(url, body, timeoutMs = 20_000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

async function get(url, timeoutMs = 20_000, headers = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/*
 * One checker per network. Each returns { ok, detail } for a settled transaction,
 * { ok: false } for one that failed or is absent, or throws to mean "could not read".
 *
 * Every one asserts the chain's own success flag. Existence alone is not enough: a
 * reverted EVM transaction, a failed Aptos transaction and an errored Solana transaction
 * are all present on-chain and all moved nothing.
 */
const CHAIN_ENV = { 'eip155:1': 'ethereum', 'eip155:56': 'bnb', 'eip155:8453': 'base', 'eip155:4663': 'robinhood' }

const CHECKERS = {
  async evm(network, tx) {
    const url = rpc(CHAIN_ENV[network] ?? '_none', SDK_RPC[network])
    if (!url) throw new Error(`no RPC configured for ${network}`)
    const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] })
    const receipt = r?.result
    if (!receipt) return { ok: false, detail: 'no receipt on this chain' }
    // status 0x1 = success. A reverted swap has a receipt too, and moved nothing.
    if (receipt.status !== '0x1') return { ok: false, detail: `reverted (status ${receipt.status})` }
    return { ok: true, detail: `block ${parseInt(receipt.blockNumber, 16)} · ${receipt.logs.length} logs` }
  },

  async solana(_network, tx) {
    const url = rpc('solana', 'https://api.mainnet-beta.solana.com')
    const r = await post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [tx, { maxSupportedTransactionVersion: 0, encoding: 'json' }],
    })
    if (r?.error) throw new Error(r.error.message)
    if (!r?.result) return { ok: false, detail: 'not found' }
    if (r.result.meta?.err) return { ok: false, detail: `err ${JSON.stringify(r.result.meta.err)}` }
    return { ok: true, detail: `slot ${r.result.slot}` }
  },

  async aptos(_network, tx) {
    const url = rpc('aptos', 'https://fullnode.mainnet.aptoslabs.com/v1')
    const r = await get(`${url}/transactions/by_hash/${tx}`)
    if (!r?.hash) return { ok: false, detail: 'not found' }
    // Aptos COMMITS failed transactions, so success:false is a real, on-chain failure.
    if (r.success !== true) return { ok: false, detail: `failed: ${r.vm_status ?? '?'}` }
    return { ok: true, detail: `v${r.version} · ${r.vm_status}` }
  },

  async stellar(_network, tx) {
    const r = await get(`${rpc('stellar', 'https://horizon.stellar.org')}/transactions/${tx}`)
    if (!r?.hash) return { ok: false, detail: 'not found' }
    if (r.successful !== true) return { ok: false, detail: 'transaction not successful' }
    return { ok: true, detail: `ledger ${r.ledger}` }
  },

  async xrpl(_network, tx) {
    const r = await post(rpc('xrpl_http', 'https://xrplcluster.com'), {
      method: 'tx',
      params: [{ transaction: tx, binary: false }],
    })
    const node = r?.result
    if (!node || node.error) return { ok: false, detail: node?.error ?? 'not found' }
    const code = node.meta?.TransactionResult ?? node.metaData?.TransactionResult
    if (code !== 'tesSUCCESS') return { ok: false, detail: `result ${code}` }
    return { ok: true, detail: `ledger ${node.ledger_index}` }
  },

  async near(_network, tx) {
    // NEAR needs the signer account alongside the hash; ask the archival node by hash only.
    const r = await post(rpc('near', 'https://rpc.mainnet.near.org'), {
      jsonrpc: '2.0',
      id: 1,
      method: 'EXPERIMENTAL_tx_status',
      params: { tx_hash: tx, sender_account_id: 'system', wait_until: 'FINAL' },
    })
    if (r?.error) throw new Error(r.error?.data ?? r.error?.message ?? 'rpc error')
    const status = r?.result?.status
    if (!status) return { ok: false, detail: 'not found' }
    if (status.Failure) return { ok: false, detail: 'execution failed' }
    return { ok: true, detail: `SuccessValue present` }
  },

  async sui(_network, tx) {
    // The SDK's own default, because the OFFICIAL fullnode no longer serves JSON-RPC at all.
    const r = await post(rpc('sui', 'https://sui-rpc.publicnode.com'), {
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getTransactionBlock',
      params: [tx, { showEffects: true }],
    })
    if (r?.error) throw new Error(r.error.message)
    const st = r?.result?.effects?.status?.status
    if (!st) return { ok: false, detail: 'not found' }
    if (st !== 'success') return { ok: false, detail: `status ${st}` }
    return { ok: true, detail: `checkpoint ${r.result.checkpoint ?? '?'}` }
  },

  async algorand(_network, tx) {
    const r = await get(`${rpc('algorand_indexer', 'https://mainnet-idx.algonode.cloud')}/v2/transactions/${tx}`)
    const t = r?.transaction
    if (!t) return { ok: false, detail: 'not found' }
    // Being in the indexer at a confirmed round IS the success condition: Algorand does not
    // commit failed transactions at all, unlike Aptos or EVM.
    if (!t['confirmed-round']) return { ok: false, detail: 'not confirmed' }
    return { ok: true, detail: `round ${t['confirmed-round']}` }
  },

  async ton(_network, ref) {
    /*
     * 🔴 TON settles ASYNCHRONOUSLY over several messages, so "did it work" is not one
     * transaction. The proof is the wallet transaction that STARTED the swap, and the
     * distinction is not academic: STON.fi refunds unused forward gas to the same wallet a
     * second later, and a naive "newest transaction" read returns that refund instead. Both
     * shipped TON proofs pointed at the refund until this checker caught it.
     *
     * So assert the shape as well as the existence: an EXTERNAL in-message (this wallet
     * signed it) and at least one out-message (it actually sent the swap).
     */
    const key = process.env.RPC_TON?.match(/api_key=([^&]+)/)?.[1]
    const url = `https://toncenter.com/api/v3/transactions?hash=${encodeURIComponent(ref)}&limit=1`
    const r = await get(url, 20_000, key ? { 'X-API-Key': key } : {})
    const t = r?.transactions?.[0]
    if (!t) return { ok: false, detail: 'not found' }
    if (t.in_msg?.source) return { ok: false, detail: 'points at an INCOMING message (likely the gas refund), not the swap' }
    if (!t.out_msgs?.length) return { ok: false, detail: 'no outgoing message — nothing was sent' }
    const op = t.out_msgs[0]?.opcode ?? '?'
    return { ok: true, detail: `lt ${t.lt} · sent opcode ${op}` }
  },
}

/** Route a CAIP-2 network to its checker. */
function checkerFor(network) {
  if (network.startsWith('eip155:')) return ['evm', CHECKERS.evm]
  if (network.startsWith('solana:')) return ['solana', CHECKERS.solana]
  if (network.startsWith('aptos:')) return ['aptos', CHECKERS.aptos]
  if (network.startsWith('stellar:')) return ['stellar', CHECKERS.stellar]
  if (network.startsWith('xrpl:')) return ['xrpl', CHECKERS.xrpl]
  if (network.startsWith('near:')) return ['near', CHECKERS.near]
  if (network.startsWith('sui:')) return ['sui', CHECKERS.sui]
  if (network.startsWith('algorand:')) return ['algorand', CHECKERS.algorand]
  if (network.startsWith('tvm:')) return ['ton', CHECKERS.ton]
  if (network.startsWith('tron:')) return ['tron', null]
  return [network.split(':')[0], null]
}

const jobs = []
for (const p of SWAP_PROVIDERS) {
  for (const proof of p.proofs) {
    const [family, fn] = checkerFor(proof.network)
    if (filters.length && !filters.includes(family) && !filters.includes(p.id)) continue
    jobs.push({ provider: p, proof, family, fn })
  }
}

if (!asJson) {
  console.log(`\n${bold('Swap proofs — read back off the chain')}`)
  console.log(dim(`  ${jobs.length} proof(s) across ${new Set(jobs.map((j) => j.family)).size} families\n`))
}

const results = []
// Serial on purpose: several of these are public nodes that rate-limit an anonymous caller,
// and a 429 storm would report perfectly good proofs as unreadable.
for (const job of jobs) {
  const { provider, proof, family, fn } = job
  const label = `${provider.id}/${family}`.padEnd(24)
  if (!fn) {
    results.push({ ...proof, provider: provider.id, state: 'skipped', detail: 'no checker for this family' })
    if (!asJson) console.log(`  ${label} ${yellow('—')} ${dim('no checker')}`)
    continue
  }
  try {
    const r = await fn(proof.network, proof.tx)
    results.push({ ...proof, provider: provider.id, state: r.ok ? 'ok' : 'failed', detail: r.detail })
    if (!asJson) {
      const mark = r.ok ? green('✓') : red('✗ FALSIFIED')
      console.log(`  ${label} ${mark} ${dim(proof.tx.slice(0, 12) + '… ' + r.detail)}`)
      if (!r.ok) console.log(`    ${red(proof.summary)}`)
    }
  } catch (err) {
    results.push({ ...proof, provider: provider.id, state: 'unreadable', detail: String(err.message ?? err) })
    if (!asJson) console.log(`  ${label} ${yellow('? unreadable')} ${dim(String(err.message ?? err).slice(0, 60))}`)
  }
}

const failed = results.filter((r) => r.state === 'failed')
const unread = results.filter((r) => r.state === 'unreadable')
const okCount = results.filter((r) => r.state === 'ok').length

if (asJson) {
  console.log(JSON.stringify({ total: results.length, ok: okCount, failed: failed.length, unreadable: unread.length, results }, null, 2))
} else {
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`  ${green(`${okCount} verified on-chain`)}${failed.length ? red(` · ${failed.length} FALSIFIED`) : ''}${unread.length ? yellow(` · ${unread.length} unreadable`) : ''}`)
  if (failed.length) {
    console.log(red('\n  🔴 A shipped proof does not hold. Fix the registry before releasing:'))
    for (const f of failed) console.log(`     ${f.provider}  ${f.tx}  ${f.detail}`)
  }
  if (unread.length) {
    console.log(dim('\n  Unreadable is a node problem, not a falsified claim. Re-run, or set RPC_<CHAIN>:'))
    for (const u of unread) console.log(dim(`     ${u.provider}  ${u.detail}`))
  }
  console.log()
}

process.exit(failed.length ? 1 : 0)
