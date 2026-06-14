// Suite 10 — the agent toolkit (paymentTools). Invokes ALL 7 tools and asserts
// each returns the right structured shape (never throws) — on BOTH a single-chain
// PipRailClient AND a MultiChainPayer, proving they wrap the same PayingClient
// interface byte-identically. Fake EVM driver + stubbed 402 → deterministic.

import {
  PipRailClient,
  MultiChainPayer,
  paymentTools,
  registerDriver,
  buildChallengeHeader,
} from '@piprail/sdk'
import { check, group, note } from '../lib/report.mjs'

const BASE = 'eip155:8453'
const URL = 'https://api.example.com/r'
const EXPECTED_TOOLS = [
  'piprail_discover', 'piprail_quote_payment', 'piprail_plan_payment',
  'piprail_pay_request', 'piprail_register', 'piprail_budget', 'piprail_guide',
]

function mkNet(over = {}) {
  return {
    family: 'evm', network: BASE,
    supports: (n) => n === BASE,
    resolveToken: () => ({ asset: 'native', decimals: 6, symbol: 'ETH' }),
    describeAsset: (a) => (a === 'native' ? { symbol: 'ETH', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${BASE}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 6, fee: '100', feeFormatted: '0.0001', basis: 'estimated' }),
    balanceOf: async () => ({ token: 100_000_000n, native: 100_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' }),
    verify: async () => ({ ok: true, receipt: { scheme: 'onchain-proof', success: true, network: BASE, transaction: `ref-${BASE}`, asset: 'native', amount: '500000', payer: 'P', payTo: 'M', verifiedAt: '2026-01-01T00:00:00.000Z' } }),
    ...over,
  }
}
// Register the fake driver INSIDE run() (run-all imports every suite up front, so a
// top-level registerDriver would pollute the registry before the real-driver suites run).
let net = mkNet()
const registerFake = () => registerDriver({ family: 'evm', resolve: () => net })

const accept = () => ({ scheme: 'onchain-proof', network: BASE, amount: '500000', asset: 'native', payTo: 'M', maxTimeoutSeconds: 600, extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.5', symbol: 'ETH' } })
function stub402(onProof) {
  globalThis.fetch = async (_u, init) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature') && onProof) return onProof()
    const b = { x402Version: 2, error: null, resource: { url: URL }, accepts: [accept()] }
    return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
  }
}
const paid200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]))

// Stub the two index-touching reads so the toolkit test stays network-free.
function stubIndexes(client) {
  client.discover = async () => [{ resource: 'https://x/a', name: 'A', source: '402index', priceUsd: 0.001, rails: [{ network: BASE }] }]
  client.register = async () => [{ source: '402index', ok: true, url: 'https://x/a' }]
  return client
}

async function exerciseTools(label, client) {
  group(`10 agent toolkit · ${label}`)
  stubIndexes(client)
  const tools = byName(paymentTools(client))
  check('exposes exactly the 7 tools', EXPECTED_TOOLS.every((n) => tools[n]) && Object.keys(tools).length === 7, Object.keys(tools).join(', '))
  check('every tool has a name + description + object input schema', EXPECTED_TOOLS.every((n) => tools[n].description && tools[n].parameters?.type === 'object'))

  const guide = await tools.piprail_guide.invoke({})
  check('piprail_guide → returns the agent contract', !!guide && JSON.stringify(guide).length > 100)

  const budget = await tools.piprail_budget.invoke({})
  check('piprail_budget → { spent, remaining, session, report }', budget && 'spent' in budget && 'remaining' in budget && 'report' in budget)

  const disc = await tools.piprail_discover.invoke({ query: 'x' })
  check('piprail_discover → { count, resources }', disc && disc.count === 1 && Array.isArray(disc.resources))

  const reg = await tools.piprail_register.invoke({ url: 'https://x/a', network: 'base', asset: 'USDC' })
  check('piprail_register → { outcomes } (accepts network/asset)', reg && Array.isArray(reg.outcomes))

  stub402(paid200)
  const q = await tools.piprail_quote_payment.invoke({ url: URL })
  check('piprail_quote_payment → gated quote', q && q.gated === true && 'amountFormatted' in q)

  const plan = await tools.piprail_plan_payment.invoke({ url: URL })
  check('piprail_plan_payment → { gated, payable, best, options, fundingHint }', plan && plan.gated && plan.payable && Array.isArray(plan.options))

  const pay = await tools.piprail_pay_request.invoke({ url: URL })
  check('piprail_pay_request → { status, ok, body, receipt } on success', pay && pay.status === 200 && pay.ok === true)

  // Decline path: cap below price → structured refusal, never a throw.
  const declined = paymentTools(stubIndexes(new PipRailClient({ chain: 'base', wallet: { privateKey: '0x' + '1'.repeat(64) }, policy: { maxAmount: '0.0001', tokens: ['ETH'] } })))
  stub402(paid200)
  const dr = await byName(declined).piprail_pay_request.invoke({ url: URL })
  check('piprail_pay_request decline → structured { ok:false, declined/code, explain } (no throw)', dr && dr.ok === false && (dr.declined || dr.code) && !!dr.explain, dr?.code ?? dr?.reason)
}

export async function run() {
  const realFetch = globalThis.fetch
  registerFake() // register the fake EVM driver now (run time), after the real-driver suites
  try {
    await exerciseTools('PipRailClient (single chain)', new PipRailClient({ chain: 'base', wallet: { privateKey: '0x' + '1'.repeat(64) } }))
    net = mkNet()
    await exerciseTools('MultiChainPayer (one wallet per chain)', MultiChainPayer.fromWallets({ wallets: { base: { privateKey: '0x' + '1'.repeat(64) } } }))
    note('all 7 tools exercised identically on PipRailClient AND MultiChainPayer')
  } finally {
    globalThis.fetch = realFetch
    net = mkNet()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { summarize } = await import('../lib/report.mjs')
  await run()
  process.exit(summarize())
}
