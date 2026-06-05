// Suite 02 — the PAY side, read-only: PipRailClient's no-funds-move surface.
// quote / estimateCost / planPayment / canAfford / spent / get / post — full
// shapes against a real HTTP merchant, with a dead RPC so it stays offline.

import { PipRailClient } from '@piprail/sdk'
import { startMerchant, MERCHANT_ADDRESS } from '../lib/merchant.mjs'
import { startHostile, SOLANA, USDC_SOLANA, SOLANA_PAYTO } from '../lib/hostile.mjs'
import { group, check, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD = 'http://127.0.0.1:1'
const BASE = 'eip155:8453'

export async function run() {
  const m = await startMerchant()
  const evil = await startHostile({
    '/solana-only': { accepts: [{ network: SOLANA, asset: USDC_SOLANA, payTo: SOLANA_PAYTO, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' }] },
  })
  const client = new PipRailClient({ chain: 'base', wallet: { privateKey: KEY }, rpcUrl: DEAD, policy: { maxAmount: '0.10', tokens: ['USDC'] } })
  const u = (p) => `${m.url}${p}`

  try {
    group('02 · quote() — price without paying')
    {
      check('a non-gated URL → null', (await client.quote(u('/free'))) === null)
      const q = await client.quote(u('/cheap'))
      check('full quote: amount/symbol/decimals/payTo/desc/recognized/withinPolicy',
        q.amountFormatted === '0.05' && q.symbol === 'USDC' && q.decimals === 6 && q.payTo === MERCHANT_ADDRESS &&
          q.description === 'Quarterly report' && q.recognized === true && q.withinPolicy === true,
        JSON.stringify(q))
      check('quote.network + asset + base-unit amount', q.network === BASE && q.amount === '50000')
      const over = await client.quote(u('/pricey'))
      check('over-policy quote → withinPolicy:false + policyReason', over.withinPolicy === false && /maxAmount/i.test(over.policyReason ?? ''))
    }

    group('02 · estimateCost() — quote + gas, never throws')
    {
      check('non-gated → null', (await client.estimateCost(u('/free'))) === null)
      const est = await client.estimateCost(u('/cheap'))
      check('returns { quote, cost }', est?.quote?.amountFormatted === '0.05' && Boolean(est.cost))
      check('cost is native-coin gas; dead RPC ⇒ basis "heuristic"; never throws',
        est.cost.feeSymbol === 'ETH' && typeof est.cost.feeFormatted === 'string' && est.cost.basis === 'heuristic',
        JSON.stringify(est.cost))
    }

    group('02 · planPayment() / canAfford() — affordability preflight')
    {
      check('non-gated → null', (await client.planPayment(u('/free'))) === null)
      const p = await client.planPayment(u('/cheap'))
      check('one rail, in-policy (no OUTSIDE_POLICY)', p.options.length === 1 && !p.options[0].blockers.includes('OUTSIDE_POLICY'))
      check('dead RPC ⇒ state "unknown" + degraded warnings, never a false "broke"',
        p.options[0].state === 'unknown' && p.options[0].warnings.includes('BALANCE_UNREADABLE') && p.options[0].warnings.includes('GAS_HEURISTIC'))
      check('EVM recipient readiness = n/a', p.options[0].recipient.ready === 'n/a')
      check('payable:false + a fundingHint', p.payable === false && typeof p.fundingHint === 'string')
      const over = await client.planPayment(u('/pricey'))
      check('over-policy → OUTSIDE_POLICY blocker', over.options[0].blockers.includes('OUTSIDE_POLICY'))
      check('canAfford(free) → true (not gated)', (await client.canAfford(u('/free'))) === true)
      check('canAfford(pricey) → false', (await client.canAfford(u('/pricey'))) === false)
    }

    group('02 · get/post on a non-402 + the spend ledger')
    {
      check('spent() starts empty', client.spent().count === 0)
      const free = await client.get(u('/free'))
      check('get() on a 200 returns the response', free.status === 200 && (await free.json()).ok === true)
      const echo = await client.post(u('/echo'), { hello: 'world' })
      check('post(obj) serializes JSON + sets content-type (server echoes it)', (await echo.json()).echoed.hello === 'world')
      check('spent() still empty (no payment settled)', client.spent().count === 0)
    }

    group('02 · no compatible rail → NoCompatibleAcceptError')
    {
      let code = null
      try { await client.quote(`${evil.url}/solana-only`) } catch (e) { code = e.code ?? e.name }
      check('quote() on an off-chain-only 402 throws NO_COMPATIBLE_ACCEPT', code === 'NO_COMPATIBLE_ACCEPT', `code=${code}`)
      const plan = await client.planPayment(`${evil.url}/solana-only`)
      check('planPayment() degrades gracefully (blocked + hint), never throws', plan.payable === false && /isn't offered on your chain/i.test(plan.fundingHint ?? ''))
    }
  } finally {
    await m.close()
    await evil.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
