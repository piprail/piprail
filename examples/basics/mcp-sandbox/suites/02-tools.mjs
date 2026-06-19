// Suite 02 — the tool surface: every behavior the 3 tools expose from the SDK.
// quote/plan/pay full I/O shapes, POST+body, native asset, the quote-throws vs
// plan-degrades-gracefully asymmetry for an off-chain rail, multi-rail selection,
// a bad wallet key, and a malformed challenge envelope.

import { startMerchant, MERCHANT_ADDRESS } from '../lib/merchant.mjs'
import {
  startHostileMerchant, USDC_BASE, BASE, SOLANA, USDC_SOLANA, SOLANA_PAYTO,
} from '../lib/hostile-merchant.mjs'
import { connectServer, callTool } from '../lib/harness.mjs'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD_RPC = 'http://127.0.0.1:1'

const HOSTILE_ROUTES = {
  // base in-policy rail + an off-chain solana rail — base client must pick base.
  '/x-multi': {
    accepts: [
      { network: BASE, asset: USDC_BASE, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
      { network: SOLANA, asset: USDC_SOLANA, payTo: SOLANA_PAYTO, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
    ],
  },
  // only an off-chain rail — the base client has NO compatible rail.
  '/x-solana-only': {
    accepts: [{ network: SOLANA, asset: USDC_SOLANA, payTo: SOLANA_PAYTO, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' }],
  },
  // a structurally-broken amount — must become a typed envelope error, not a crash.
  '/malformed-amount': { asset: USDC_BASE, amount: 'abc', amountFormatted: '?', symbol: 'USDC' },
}

export async function run() {
  const honest = await startMerchant()
  const evil = await startHostileMerchant(HOSTILE_ROUTES)
  const h = (p) => `${honest.url}${p}`
  const x = (p) => `${evil.url}${p}`

  const s = await connectServer({
    PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC,
    PIPRAIL_MAX_AMOUNT: '0.10', PIPRAIL_TOKENS: 'USDC',
  })
  const quote = (url) => callTool(s.client, 'piprail_quote_payment', { url })
  const plan = (url) => callTool(s.client, 'piprail_plan_payment', { url })
  const pay = (url, extra = {}) => callTool(s.client, 'piprail_pay_request', { url, ...extra })

  try {
    group('02 · quote_payment — full PipRailQuote shape')
    {
      const free = await quote(h('/free'))
      check('free URL → { gated:false, url }', free.json.gated === false && typeof free.json.url === 'string')

      const q = (await quote(h('/cheap'))).json
      check('gated:true', q.gated === true)
      check('asset = canonical Base USDC', q.asset === USDC_BASE)
      check('network = eip155:8453', q.network === BASE)
      check('amount (base units) = 50000', q.amount === '50000')
      check('amountFormatted = 0.05', q.amountFormatted === '0.05')
      check('decimals = 6', q.decimals === 6)
      check('symbol = USDC', q.symbol === 'USDC')
      check('payTo = merchant address', q.payTo === MERCHANT_ADDRESS)
      check('description passed through', q.description === 'Quarterly report')
      check('maxTimeoutSeconds default 600', q.maxTimeoutSeconds === 600)
      check('recognized = true', q.recognized === true)
      check('symbolMismatch = false', q.symbolMismatch === false)
      check('withinPolicy = true (0.05 ≤ 0.10)', q.withinPolicy === true)
      check('no policyReason when allowed', q.policyReason === undefined)
    }

    group('02 · quote_payment — native coin is recognized & priced')
    {
      const n = (await quote(h('/native'))).json
      check('native asset recognized', n.recognized === true && n.asset === 'native')
      check('native decimals = 18, symbol present', n.decimals === 18 && typeof n.symbol === 'string')
      check('native amountFormatted = 0.00001', n.amountFormatted === '0.00001')
      note(`native coin on Base = ${n.symbol}; allow it with PIPRAIL_TOKENS=native (chain-agnostic) or =${n.symbol} (ticker)`)
    }

    group('02 · plan_payment — full PaymentPlan shape (dead RPC ⇒ degrades, never throws)')
    {
      const free = await plan(h('/free'))
      check('free URL → { gated:false }', free.json.gated === false)

      const p = (await plan(h('/cheap'))).json
      check('gated:true', p.gated === true)
      check('exactly one rail (this client is one chain)', Array.isArray(p.options) && p.options.length === 1)
      const o = p.options[0]
      check('rail: network/symbol/amount populated', o.network === BASE && o.symbol === 'USDC' && o.amount === '0.05')
      check('in-policy rail has NO OUTSIDE_POLICY blocker', !o.blockers.includes('OUTSIDE_POLICY'))
      check('dead RPC ⇒ state "unknown" (affordability unconfirmable), not a false "blocked"', o.state === 'unknown')
      check('dead RPC ⇒ warnings include BALANCE_UNREADABLE + GAS_HEURISTIC',
        o.warnings.includes('BALANCE_UNREADABLE') && o.warnings.includes('GAS_HEURISTIC'), JSON.stringify(o.warnings))
      check('EVM recipient readiness = n/a (no receive prerequisite)', o.recipientReady === 'n/a')
      check('payable:false + status mirrors the rail', p.payable === false && p.status === 'unknown')
      check('a fundingHint is offered', typeof p.fundingHint === 'string' && p.fundingHint.length > 0)
    }

    group('02 · pay_request — GET, POST+body, and the not-gated path')
    {
      const free = (await pay(h('/free'))).json
      check('GET free URL → 200, body, no receipt', free.status === 200 && free.ok === true && !free.receipt)

      const echo = (await pay(h('/echo'), { method: 'POST', body: { hello: 'world', n: 42 } })).json
      check('POST + object body → 200 and the server received the JSON', echo.status === 200 && echo.body?.echoed?.hello === 'world' && echo.body?.echoed?.n === 42,
        JSON.stringify(echo.body))
      check('POST method propagated', echo.body?.method === 'POST')
    }

    group('02 · Multi-rail & off-chain rails')
    {
      const multi = (await quote(x('/x-multi'))).json
      check('multi-rail 402: client quotes its OWN chain rail (base), ignores the off-chain one',
        multi.network === BASE && multi.withinPolicy === true && multi.amountFormatted === '0.05')
      const mplan = (await plan(x('/x-multi'))).json
      check('multi-rail plan: only the base rail is analysed', mplan.options.length === 1 && mplan.options[0].network === BASE)

      // No compatible rail: quote returns a STRUCTURED { ok:false, code } (an expected SDK
      // error, funnelled like pay_request — not an opaque isError); plan degrades gracefully.
      const qSol = await quote(x('/x-solana-only'))
      check('off-chain-only 402: quote → structured { ok:false, code } (no rail on this client\'s chain)',
        !qSol.isError && qSol.json?.ok === false && /NO_COMPATIBLE|COMPATIBLE/i.test(String(qSol.json?.code)), JSON.stringify(qSol.json).slice(0, 140))
      const pSol = (await plan(x('/x-solana-only'))).json
      check('off-chain-only 402: plan → graceful { gated:true, payable:false } + a hint',
        pSol.gated === true && pSol.payable === false && /isn't offered on your chain/i.test(pSol.fundingHint ?? ''),
        pSol.fundingHint)
    }

    group('02 · Defensive parsing & wallet validation (reached via the tools)')
    {
      const mal = await quote(x('/malformed-amount'))
      check('malformed amount → structured { ok:false, code:INVALID_ENVELOPE }, not a raw crash',
        !mal.isError && mal.json?.ok === false && /INVALID_ENVELOPE/i.test(String(mal.json?.code)) && /integer|amount/i.test(String(mal.json?.reason)),
        JSON.stringify(mal.json).slice(0, 140))
    }
  } finally {
    await s.close()
    await honest.close()
    await evil.close()
  }

  group('02 · Native-coin allowlist: the chain-agnostic "native" alias (consistent with the accept side)')
  {
    // PIPRAIL_TOKENS=native allows the chain's coin on any family — the SAME word
    // the merchant uses (token: 'native') — without naming the ticker. The real
    // ticker (ETH on Base) still works; a USDC-only list still refuses native.
    const honestN = await startMerchant()
    const withNative = await connectServer({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, PIPRAIL_TOKENS: 'native' })
    const withTicker = await connectServer({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, PIPRAIL_TOKENS: 'ETH' })
    const usdcOnly = await connectServer({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, PIPRAIL_TOKENS: 'USDC' })
    try {
      const nativeUrl = `${honestN.url}/native`
      const a = (await callTool(withNative.client, 'piprail_quote_payment', { url: nativeUrl })).json
      const b = (await callTool(withTicker.client, 'piprail_quote_payment', { url: nativeUrl })).json
      const c = (await callTool(usdcOnly.client, 'piprail_quote_payment', { url: nativeUrl })).json
      check('PIPRAIL_TOKENS=native allows the chain coin (alias, chain-agnostic)', a.withinPolicy === true, a.policyReason)
      check('PIPRAIL_TOKENS=ETH also allows it (real ticker still works)', b.withinPolicy === true, b.policyReason)
      check('PIPRAIL_TOKENS=USDC still refuses native (alias does not loosen a stablecoin list)',
        c.withinPolicy === false && /not in the allowed set/i.test(c.policyReason ?? ''), c.policyReason)
    } finally {
      await withNative.close()
      await withTicker.close()
      await usdcOnly.close()
      await honestN.close()
    }
  }

  group('02 · discovery tools over MCP — discover (live) + register (graceful)')
  {
    const ds = await connectServer({ PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, PIPRAIL_TOKENS: 'USDC' })
    try {
      const d = await callTool(ds.client, 'piprail_discover', { network: 'any', limit: 5 })
      check('piprail_discover → { count, resources[] }, no error (live open indexes)',
        !d.isError && typeof d.json?.count === 'number' && Array.isArray(d.json.resources), d.text?.slice(0, 140))
      note(`discover over MCP (live): ${d.json?.count ?? '?'} resource(s)`)
      const r = await callTool(ds.client, 'piprail_register', { url: 'https://example.com', name: 'mcp sandbox test' })
      check('piprail_register → { outcomes[] }, gracefully rejects a non-402 URL (no throw, no junk listed)',
        !r.isError && r.json?.outcomes?.[0]?.ok === false && /402|verification/i.test(r.json.outcomes[0].detail || ''),
        JSON.stringify(r.json?.outcomes?.[0] ?? r.text?.slice(0, 140)))
    } finally {
      await ds.close()
    }
  }

  group('02 · A malformed wallet key fails at first use (bind is lazy)')
  {
    const honest2 = await startMerchant()
    const bad = await connectServer({
      PIPRAIL_PRIVATE_KEY: '0xnotavalidkey', PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC, PIPRAIL_TOKENS: 'USDC',
    })
    try {
      const res = await callTool(bad.client, 'piprail_quote_payment', { url: `${honest2.url}/cheap` })
      check('bad key → structured { ok:false, code:WRONG_FAMILY } (SDK wallet validation surfaced through MCP)',
        !res.isError && /WRONG_FAMILY/.test(res.text) && /EVM/.test(res.text), res.text.slice(0, 120))
    } finally {
      await bad.close()
      await honest2.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
