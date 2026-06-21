// Suite 09 — multi-chain buying: MultiChainPayer + planAcross + fetchAcross.
// One buyer holding a wallet per chain pays whichever chain a 402 asks for. Uses
// FAKE heterogeneous drivers (EVM + Solana + XRPL) so every variation runs
// deterministically — no network, no funds. Mirrors the SDK's own contract tests
// as a runnable, readable demo + bug hunt.

import {
  PipRailClient,
  MultiChainPayer,
  planAcross,
  fetchAcross,
  paymentTools,
  registerDriver,
  buildChallengeHeader,
  PaymentDeclinedError,
} from '@piprail/sdk'
import { check, group, note } from '../lib/report.mjs'

const BASE = 'eip155:8453'
const SOL = 'solana:mainnet'
const XRPL = 'xrpl:mainnet'
const URL = 'https://api.example.com/r'

// A full fake ResolvedNetwork (native-asset rail) — `over` swaps any field per test.
function mkNet(family, network, symbol, fee, over = {}) {
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: () => ({ asset: 'native', decimals: 6, symbol }),
    describeAsset: (a) => (a === 'native' ? { symbol, decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${network}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: symbol, feeDecimals: 6, fee, feeFormatted: '0.0001', basis: 'estimated' }),
    balanceOf: async () => ({ token: 100_000_000n, native: 100_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' }),
    verify: async () => ({
      ok: true,
      receipt: {
        scheme: 'onchain-proof', success: true, network, transaction: `ref-${network}`,
        asset: 'native', amount: '500000', payer: 'P', payTo: 'M', verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    ...over,
  }
}

// Live closures so a test can swap a chain's behaviour before acting. The resolve
// callbacks capture these LET bindings, so reassigning in reset() rebinds the driver.
let baseN = mkNet('evm', BASE, 'ETH', '100')
let solN = mkNet('solana', SOL, 'SOL', '50')
let xrplN = mkNet('xrpl', XRPL, 'XRP', '80')
// Register INSIDE run() (not at module top-level): run-all imports every suite up
// front, so a top-level registerDriver would pollute the registry with these fakes
// BEFORE the real-driver suites (01–06) run. Registering in run() keeps it last-wins.
function registerFakes() {
  registerDriver({ family: 'evm', resolve: () => baseN })
  registerDriver({ family: 'solana', resolve: () => solN })
  registerDriver({ family: 'xrpl', resolve: () => xrplN })
}
function reset() {
  baseN = mkNet('evm', BASE, 'ETH', '100')
  solN = mkNet('solana', SOL, 'SOL', '50')
  xrplN = mkNet('xrpl', XRPL, 'XRP', '80')
  registerFakes()
}

function accept(network, symbol, o = {}) {
  return {
    scheme: 'onchain-proof', network, amount: '500000', asset: 'native', payTo: 'M', maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.5', symbol }, ...o,
  }
}
function stub402(accepts, onProof) {
  globalThis.fetch = async (_u, init) => {
    const proof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (proof && onProof) return onProof()
    const b = { x402Version: 2, error: null, resource: { url: URL }, accepts }
    return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
  }
}
const paid200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const wallets = (chains) =>
  Object.fromEntries(chains.map((c) => [c, c === 'solana' ? { key: 'x' } : c === 'xrpl' ? { key: 'sx' } : { key: '0x' + '1'.repeat(64) }]))
const payer = (chains = ['base', 'solana', 'xrpl'], over = {}) =>
  MultiChainPayer.fromWallets({ wallets: wallets(chains), ...over })

export async function run() {
  const realFetch = globalThis.fetch
  registerFakes() // register fake drivers now (run time), after the real-driver suites
  try {
    group('09 multi-chain · fromWallets + routing')
    {
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      const p = payer(['base', 'solana'])
      check('fromWallets builds one client per chain', p.clients.length === 2, `${p.clients.length} clients`)
      const res = await p.get(URL)
      check('get() pays + returns 200', res.status === 200)
      check('paid the FIRST-listed chain (base), not the cheaper-fee one', p.spent().records[0]?.network === BASE, p.spent().records[0]?.network)
      check('spent() counts the payment', p.spent().count === 1)
    }
    reset()
    {
      // base is cheaper but BROKE → must route to the funded solana.
      baseN = mkNet('evm', BASE, 'ETH', '10', { balanceOf: async () => ({ token: 0n, native: 0n }) })
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      const p = payer(['base', 'solana'])
      const res = await p.get(URL)
      check('skips a BLOCKED chain, pays the funded one', res.status === 200 && p.spent().records[0]?.network === SOL, p.spent().records[0]?.network)
    }
    reset()
    {
      // POST with a JSON body + a primitive body (NonReplayableBody guard).
      stub402([accept(BASE, 'ETH')], paid200)
      const p = payer(['base'])
      check('post(object) → 200 (JSON-serialised)', (await p.post(URL, { hi: 1 })).status === 200)
      check('post(primitive) → 200 (String() fallback, no NonReplayableBodyError)', (await p.post(URL, 42)).status === 200)
    }

    reset()
    group('09 multi-chain · planAcross / fetchAcross primitives')
    {
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      const clients = [
        new PipRailClient({ chain: 'base', wallet: { key: '0x' + '1'.repeat(64) } }),
        new PipRailClient({ chain: 'solana', wallet: { key: 'x' } }),
      ]
      const plan = await planAcross(clients, URL)
      check('planAcross merges rails across chains', plan?.options.length === 2, `${plan?.options.length} options`)
      check('planAcross best = first-listed payable (base)', plan?.best?.accept.network === BASE)
      check('planAcross payable=true when a rail settles', plan?.payable === true)
      const res = await fetchAcross(clients, URL)
      check('fetchAcross pays + returns 200', res.status === 200)
      check('fetchAcross empty-client guard throws', await fetchAcross([], URL).then(() => false).catch((e) => e?.name === 'TypeError'))
    }

    reset()
    group('09 multi-chain · read surface (plan / quote / canAfford / spent / budget / discover)')
    {
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
      const p = payer(['base', 'solana'])
      const plan = await p.planPayment(URL)
      check('planPayment merges + ranks payable-first', plan?.payable && plan.best?.accept.network === BASE)
      const q = await p.quote(URL)
      check('quote() returns the chosen chain quote', q?.network === BASE, q?.network)
      check('canAfford() true when a chain can pay', (await p.canAfford(URL)) === true)
      const b = p.budget()
      check('budget() returns a session + byAsset view', !!b && Array.isArray(b.byAsset))
    }
    reset()
    {
      // No funded chain can settle → canAfford false + merged decline names BOTH chains.
      baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => ({ token: 100n, native: 100n }) })
      solN = mkNet('solana', SOL, 'SOL', '50', { balanceOf: async () => ({ token: 200n, native: 200n }) })
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      const p = payer(['base', 'solana'])
      check('canAfford() false when no chain can pay', (await p.canAfford(URL)) === false)
      const plan = await p.planPayment(URL)
      const hint = plan?.fundingHint ?? ''
      check('merged decline names BOTH funded chains', /base/i.test(hint) && /solana|sol/i.test(hint) && hint.includes('·'), hint)
      const err = await p.get(URL).catch((e) => e)
      check('fetch throws PaymentDeclinedError before any send', err instanceof PaymentDeclinedError)
    }
    reset()
    {
      // discover merges + dedupes across chains (stub each client's discover).
      const p = payer(['base', 'solana'])
      for (const c of p.clients) c.discover = async () => [{ resource: 'https://x/a', network: BASE }, { resource: 'https://x/b', network: SOL }]
      const found = await p.discover()
      check('discover() merges + dedupes by URL across chains', found.length === 2, `${found.length} unique`)
    }

    reset()
    group('09 multi-chain · schemes propagate (gasless exact opt-in)')
    {
      // schemes:['exact'] excludes onchain-proof on EVERY client → a proof-only 402 isn't payable.
      stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      const exactOnly = await payer(['base', 'solana'], { schemes: ['exact'] }).planPayment(URL)
      check('schemes:[exact] reaches every client (proof-only 402 not payable)', exactOnly?.payable === false)
      reset(); stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
      check('default schemes → same 402 IS payable', (await payer(['base', 'solana']).planPayment(URL))?.payable === true)
    }

    reset()
    group('09 multi-chain · guards + agent toolkit wrap')
    {
      check('new MultiChainPayer([]) throws (needs ≥1 client)', (() => { try { new MultiChainPayer([]); return false } catch { return true } })())
      check('fromWallets({}) throws (needs ≥1 wallet)', (() => { try { MultiChainPayer.fromWallets({ wallets: {} }); return false } catch { return true } })())
      stub402([accept(BASE, 'ETH')], paid200)
      const tools = paymentTools(payer(['base', 'solana']))
      check('paymentTools wraps a MultiChainPayer → 8 tools', tools.length === 8, `${tools.length} tools`)
    }
    note('all multi-chain variations exercised against fake heterogeneous drivers')
  } finally {
    globalThis.fetch = realFetch
    reset()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { summarize } = await import('../lib/report.mjs')
  await run()
  process.exit(summarize())
}
