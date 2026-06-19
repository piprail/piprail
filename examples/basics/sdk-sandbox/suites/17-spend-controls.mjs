// Suite 17 — the 2.9.0 spend controls, smashed to bits.
//
// This is the living proof for the headline budget feature: the cross-token GRAND
// TOTAL (`maxTotalPerDenom`), payment-COUNT caps, the durable `spendStore`, the new
// observability (onSpend + payment-declined + budget-threshold), AND a hostile-input
// gauntlet (absurd decimals → OOM guard, negative/zero amounts, exact bigint boundaries,
// poisoned persistence) + a memory/perf stress at 100k payments.
//
// It settles payments WITHOUT real funds via a fake driver + a stubbed 402→200, exactly
// like the SDK's own unit tests — so every total, cap, and event is exercised end-to-end.
// Read top-to-bottom: each group narrates what it's proving.

// Import the LOCAL working-tree build (run `npm run build` in sdk/ first) — the
// sandbox's installed @piprail/sdk is an older published version, so these suites
// always test the code in this repo, exactly like suites 07/08/13/14/15/16.
import {
  PipRailClient,
  MultiChainPayer,
  SpendLedger,
  memorySpendStore,
  registerDriver,
  buildChallengeHeader,
  buildReceiptHeader,
  formatSpendReport,
  InvalidEnvelopeError,
  DENOM_PRECISION,
} from '../../../../sdk/dist/index.js'
import { fileSpendStore } from '../../../../sdk/dist/node.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = { key: '0x' + '1'.repeat(64) }
const A = 'eip155:8453' // "chain A" (base)
const B = 'eip155:56' // "chain B" (bnb)
const URL = 'https://api.example.com/r'

// A fake EVM-family driver that recognises a handful of stablecoins (→ USD/EUR denoms)
// plus native (no denomination). resolve() routes the chain selector to a network.
const TOKENS = {
  '0xusdc': { symbol: 'USDC', decimals: 6 },
  '0xusdt': { symbol: 'USDT', decimals: 6 },
  '0xeurc': { symbol: 'EURC', decimals: 6 },
  '0xdai18': { symbol: 'DAI', decimals: 18 }, // an 18dp stablecoin, to prove cross-decimal sums
  native: { symbol: 'ETH', decimals: 18 },
}
const mkNet = (network) => ({
  family: 'evm',
  network,
  supports: (n) => n === network,
  resolveToken: () => ({ asset: '0xusdc', decimals: 6, symbol: 'USDC' }),
  describeAsset: (a) => TOKENS[a] ?? null,
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => `ref-${network}`,
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '1', feeFormatted: '0', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
  recipientReady: async () => ({ ready: 'n/a' }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
})
registerDriver({ family: 'evm', resolve: (opts) => mkNet(opts.chain === 'bnb' ? B : A) })

const realFetch = globalThis.fetch
// Stub a payable endpoint: 402 with the given accept, then 200 + receipt on the proof leg.
function settles({ network = A, asset = '0xusdc', symbol = 'USDC', amount = '50000', decimals = 6, amountFormatted = '0.05' } = {}) {
  globalThis.fetch = async (_u, init) => {
    if (new Headers(init?.headers ?? {}).get('payment-signature')) {
      return new Response('{}', { status: 200, headers: { 'payment-response': buildReceiptHeader({
        scheme: 'onchain-proof', success: true, network, transaction: 'ref', asset, amount,
        payer: 'P', payTo: 'M', verifiedAt: '2026-06-02T00:00:00.000Z' }) } })
    }
    const accept = { scheme: 'onchain-proof', network, amount, asset, payTo: 'M', maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals, minConfirmations: 1, amountFormatted, symbol } }
    const body = { x402Version: 2, error: null, resource: { url: URL }, accepts: [accept] }
    return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
  }
}
const mk = (over = {}) => new PipRailClient({ chain: 'base', wallet: KEY, ...over })

export async function run() {
  const tmp = []
  const tmpFile = () => { const d = mkdtempSync(join(tmpdir(), 'piprail-17-')); tmp.push(d); return join(d, 'spend.jsonl') }

  try {
    group('17 · Cross-token GRAND TOTAL — one cap across every stablecoin (one chain)')
    {
      const c = mk({ policy: { maxTotalPerDenom: { USD: '0.12' } } })
      check('byDenom is previewable BEFORE any spend (cap is a declared number)',
        c.budget().byDenom[0]?.capFormatted === '0.12' && c.budget().byDenom[0]?.spentFormatted === '0')
      settles({ asset: '0xusdc', symbol: 'USDC' }); await c.get(URL) // 0.05 USDC
      settles({ asset: '0xusdt', symbol: 'USDT' }); await c.get(URL) // 0.05 USDT — SAME USD bucket
      check('sums ACROSS tokens: USDC 0.05 + USDT 0.05 = 0.10 USD', c.budget().byDenom[0].spentFormatted === '0.1')
      settles({ asset: '0xusdt', symbol: 'USDT' }) // a 3rd 0.05 would be 0.15 > 0.12
      let declined = false
      try { await c.get(URL) } catch (e) { declined = e.code === 'PAYMENT_DECLINED' && e.reasonCode === 'BUDGET' }
      check('the payment that would breach the USD cap is refused (reasonCode BUDGET)', declined)
      check('nothing extra settled — only the two in-budget payments', c.spent().count === 2)
      note('USDC (6dp) + USDT (6dp) roll into ONE "USD" total — not a price oracle, a 1:1 unit-of-account sum')
    }

    group('17 · Cross-DECIMAL exactness — 6dp + 18dp summed with zero float drift')
    {
      const c = mk({ policy: { maxTotalPerDenom: { USD: '0.10' }, denomFor: { DAI: 'USD' } } })
      settles({ asset: '0xusdc', symbol: 'USDC', amount: '50000', decimals: 6, amountFormatted: '0.05' }); await c.get(URL)
      settles({ asset: '0xdai18', symbol: 'DAI', amount: (5n * 10n ** 16n).toString(), decimals: 18, amountFormatted: '0.05' }); await c.get(URL)
      check('0.05 USDC (6dp) + 0.05 DAI (18dp) = exactly 0.10 USD', c.budget().byDenom[0].spentFormatted === '0.1' && c.budget().byDenom[0].remainingFormatted === '0')
    }

    group('17 · Cross-CHAIN grand total — ONE budget across chains (shared ledger)')
    {
      const payer = MultiChainPayer.fromWallets({ wallets: { base: KEY, bnb: KEY }, policy: { maxTotalPerDenom: { USD: '0.08' } } })
      settles({ network: A, asset: '0xusdc', symbol: 'USDC' }); await payer.clients[0].get(URL) // 0.05 on chain A
      check('the shared budget reflects chain-A spend across the whole payer', payer.budget().byDenom[0].spentFormatted === '0.05')
      settles({ network: B, asset: '0xusdt', symbol: 'USDT' })
      const q = await payer.clients[1].quote(URL) // 0.05 on chain B would be 0.10 > 0.08
      check('a chain-B payment is refused by the SHARED cap (spans chains)', q?.withinPolicy === false && q?.policyCode === 'MAX_TOTAL_DENOM')
      note('fromWallets gives every chain ONE SpendLedger, so $0.08 means $0.08 total — not $0.08 per chain')
    }

    group('17 · Payment-COUNT caps — across every chain + token (no oracle needed)')
    {
      const c = mk({ policy: { maxPayments: 2 } })
      settles(); await c.get(URL); await c.get(URL)
      let declined = false
      try { await c.get(URL) } catch (e) { declined = e.reasonCode === 'BUDGET' }
      check('the 3rd payment is refused once maxPayments=2 is reached', declined)
      check('countStatus reports settled + remaining', c.budget().counts.settled === 2 && c.budget().counts.lifetimeRemaining === 0)

      const w = mk({ policy: { maxPaymentsPerWindow: 1, windowSeconds: 3600 } })
      settles(); await w.get(URL)
      let win = false
      try { await w.get(URL) } catch (e) { win = e.reasonCode === 'OUTSIDE_WINDOW' }
      check('the rolling window count cap refuses with OUTSIDE_WINDOW', win)
    }

    group('17 · Persistence — the budget SURVIVES a restart')
    {
      // (a) in-memory store shared across two client instances
      const store = memorySpendStore()
      const c1 = mk({ policy: { maxTotalPerDenom: { USD: '0.08' } }, spendStore: store })
      settles(); await c1.get(URL) // 0.05 persisted
      const c2 = mk({ policy: { maxTotalPerDenom: { USD: '0.08' } }, spendStore: store }) // "restart"
      check('a fresh client over the same store RESUMES the grand total', c2.budget().byDenom[0].spentFormatted === '0.05')
      settles({ asset: '0xusdt', symbol: 'USDT' })
      let resumed = false
      try { await c2.get(URL) } catch (e) { resumed = e.reasonCode === 'BUDGET' } // 0.05+0.05 > 0.08
      check('the cap is enforced against the RESUMED total', resumed)

      // (b) the built-in local file store (real node:fs round-trip)
      const path = tmpFile()
      const f1 = mk({ policy: { maxPayments: 5 }, spendStore: fileSpendStore(path) })
      settles(); await f1.get(URL); await f1.get(URL)
      const f2 = mk({ policy: { maxPayments: 5 }, spendStore: fileSpendStore(path) }) // restart from disk
      check('fileSpendStore rebuilds count + totals from the JSONL log', f2.budget().counts.settled === 2)
      note('the rolling window + session TTL stay process-scoped; the MONEY + COUNT totals are what persist')
    }

    group('17 · Observability — pull (budget/spent) + push (onEvent/onSpend)')
    {
      const events = []
      const logged = []
      const c = mk({
        policy: { maxTotalPerDenom: { USD: '0.08' }, warnAtFraction: 0.5 },
        onEvent: (e) => events.push(e),
        onSpend: (rec, b) => logged.push({ amt: rec.amountFormatted, denom: rec.denom, usd: b.byDenom[0]?.spentFormatted }),
      })
      settles(); await c.get(URL) // 0.05 of 0.08 = 62.5% → crosses the 50% warn
      check('onSpend fires with the record + post-payment budget', logged.length === 1 && logged[0].denom === 'USD' && logged[0].usd === '0.05')
      check('budget-threshold fired early (≥ warnAtFraction) BEFORE any hard decline',
        events.some((e) => e.kind === 'budget-threshold' && e.scope === 'denom' && e.fraction >= 0.5))
      settles({ asset: '0xusdt', symbol: 'USDT' })
      try { await c.get(URL) } catch { /* over cap */ }
      const declined = events.find((e) => e.kind === 'payment-declined')
      check('payment-declined carries reasonCode + a budget snapshot at refusal',
        declined?.reasonCode === 'BUDGET' && declined?.budget?.byDenom?.[0]?.spentFormatted === '0.05')
      check('payment-failed ALSO fired on the decline (back-compat preserved)', events.some((e) => e.kind === 'payment-failed'))
      check('formatSpendReport appends the cross-token grand total', /grand total:.*USD total/.test(formatSpendReport(c.spent())))
      check('client.policy() reads the configured leash back', c.policy()?.maxTotalPerDenom?.USD === '0.08')
    }

    group('17 · SMASH IT — hostile-server / malformed-input gauntlet')
    {
      // Absurd decimals → OOM guard (would otherwise padEnd a multi-GB string)
      const oom = mk({ policy: { allowUnknownTokens: true } })
      settles({ asset: '0xWUT', symbol: 'WUT', decimals: 1_000_000_000, amount: '1', amountFormatted: '1' })
      let oomCode = null
      try { await oom.quote(URL) } catch (e) { oomCode = e.code }
      check('decimals=1e9 → INVALID_ENVELOPE (no multi-GB allocation, no crash)', oomCode === 'INVALID_ENVELOPE')

      // Negative / non-integer / non-numeric amounts → malformed envelope
      const c = mk()
      let bad = 0
      for (const amount of ['-5', '0.5', '1e6', 'abc', ' 5']) {
        settles({ amount })
        try { await c.quote(URL) } catch (e) { if (e instanceof InvalidEnvelopeError) bad++ }
      }
      check('every negative/decimal/non-integer amount is rejected as a malformed envelope', bad === 5, `${bad}/5`)

      // Zero amount: settles, bumps count, adds nothing to a denom total
      const z = mk({ policy: { maxTotalPerDenom: { USD: '1' }, maxPayments: 5 } })
      settles({ amount: '0', amountFormatted: '0' }); await z.get(URL)
      check('a ZERO-amount payment counts (1) but adds 0 to the USD total', z.budget().counts.settled === 1 && z.budget().byDenom[0].spentFormatted === '0')

      // Native coin is never folded into a USD grand total
      const n = mk({ policy: { maxTotalPerDenom: { USD: '0.0001' } } })
      settles({ asset: 'native', symbol: 'ETH', amount: (10n ** 18n).toString(), decimals: 18, amountFormatted: '1' })
      const nres = await n.get(URL)
      check('a 1 ETH payment is UNTOUCHED by the $0.0001 USD cap (native has no denomination)', nres.status === 200)

      // Construction validation rejects malformed configs loudly
      const throws = (p) => { try { mk({ policy: p }); return false } catch { return true } }
      check('malformed maxTotalPerDenom value throws at construction', throws({ maxTotalPerDenom: { USD: '5abc' } }))
      check('warnAtFraction out of (0,1] throws', throws({ warnAtFraction: 0 }) && throws({ warnAtFraction: 1.5 }))
      check('maxPaymentsPerWindow without windowSeconds throws', throws({ maxPaymentsPerWindow: 5 }))
      check('passing BOTH a shared ledger and a spendStore throws', (() => { try { mk({ ledger: new SpendLedger(), spendStore: memorySpendStore() }); return false } catch { return true } })())
    }

    group('17 · MEMORY / PERF — 100k payments, exact aggregates, bounded time')
    {
      // Stress the ledger's data structures directly: incremental aggregates (buckets,
      // denomTotals, count) must stay O(1) per record and exact across 100k entries.
      const N = 100_000
      const ledger = new SpendLedger()
      const t0 = Date.now()
      for (let i = 0; i < N; i++) {
        ledger.record({ url: URL, host: 'api.example.com', network: A, asset: '0xusdc',
          amountBase: '1', amountFormatted: '0.000001', symbol: 'USDC', ref: `r${i}`, at: '2026-06-02T00:00:00.000Z' }, 6, 'USD')
      }
      const ms = Date.now() - t0
      check(`recorded ${N} payments without OOM`, ledger.count() === N)
      check('per-(network,asset) total is exact (100000 base units)', ledger.totalFor(A, '0xusdc') === BigInt(N))
      check('denom grand total is exact across 100k records', ledger.totalForDenom('USD') === BigInt(N) * 10n ** BigInt(DENOM_PRECISION - 6))
      check(`100k records completed in bounded time (${ms}ms)`, ms < 5000, `${ms}ms`)
      note('lifetime aggregates are incremental (O(1)/record); only the rolling-window scans are O(n) and run solely when a window cap is set')
    }
  } finally {
    globalThis.fetch = realFetch
    for (const d of tmp) rmSync(d, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
