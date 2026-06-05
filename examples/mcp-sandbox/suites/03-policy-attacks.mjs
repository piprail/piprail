// Suite 03 — ADVERSARIAL: "can an AI break out of the spend policy?"
//
// Threat model: the AI is the attacker AND the merchant may be hostile. We try
// every trick to make the client overspend, pay an unallowed token, or pay an
// unallowed host — and assert each is refused BEFORE any on-chain send.
//
// Part 1: drive the REAL @piprail/mcp against a LYING merchant.
// Part 2: hammer the SDK's evaluatePolicy directly — the exact guard the MCP
//         delegates to — across hosts, decimals scales, accumulation, chains, tokens.
//
// No funds move: every payment attempted here is one the policy declines.

import { evaluatePolicy } from '@piprail/sdk'
import { connectServer, callTool } from '../lib/harness.mjs'
import { startHostileMerchant, USDC_BASE, UNKNOWN_ASSET, BASE } from '../lib/hostile-merchant.mjs'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD_RPC = 'http://127.0.0.1:1'

// USDC = 6 decimals → 0.10 cap = 100_000 base units. Amounts are TRUE base units;
// decimals/amountFormatted/symbol are whatever the (hostile) server CLAIMS.
const ROUTES = {
  '/lie-decimals': { asset: USDC_BASE, amount: 5_000_000, decimals: 9, amountFormatted: '0.005', symbol: 'USDC' },
  '/lie-display': { asset: USDC_BASE, amount: 1_000_000, decimals: 6, amountFormatted: '0.01', symbol: 'USDC' },
  '/at-cap': { asset: USDC_BASE, amount: 100_000, decimals: 6, amountFormatted: '0.10', symbol: 'USDC' },
  '/just-over': { asset: USDC_BASE, amount: 100_001, decimals: 6, amountFormatted: '0.100001', symbol: 'USDC' },
  '/unknown-asset': { asset: UNKNOWN_ASSET, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
  '/spoof-symbol': { asset: USDC_BASE, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'DAI' },
  '/trap-mixed': {
    accepts: [
      { asset: USDC_BASE, amount: 5_000_000, decimals: 6, amountFormatted: '5.0', symbol: 'USDC' },
      { asset: USDC_BASE, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
    ],
  },
  '/trap-allover': {
    accepts: [
      { asset: USDC_BASE, amount: 1_000_000, decimals: 6, amountFormatted: '1.0', symbol: 'USDC' },
      { asset: USDC_BASE, amount: 2_000_000, decimals: 6, amountFormatted: '2.0', symbol: 'USDC' },
    ],
  },
}

export async function run() {
  const evil = await startHostileMerchant(ROUTES)
  const u = (p) => `${evil.url}${p}`

  group('03 · Hostile merchant vs the real MCP — the cap binds to the TRUE amount')
  const s = await connectServer({
    PIPRAIL_PRIVATE_KEY: KEY, PIPRAIL_CHAIN: 'base', PIPRAIL_RPC_URL: DEAD_RPC,
    PIPRAIL_MAX_AMOUNT: '0.10', PIPRAIL_TOKENS: 'USDC',
  })
  try {
    const q = (p) => callTool(s.client, 'piprail_quote_payment', { url: u(p) })
    const pay = (p) => callTool(s.client, 'piprail_pay_request', { url: u(p) })

    const ld = await q('/lie-decimals')
    check('decimals-lie: amount re-derived at TRUE decimals (5.0, not 0.005)',
      Number(ld.json.amountFormatted) === 5 && ld.json.decimals === 6, JSON.stringify(ld.json).slice(0, 140))
    check('decimals-lie: REFUSED by the per-call cap',
      ld.json.withinPolicy === false && /maxAmount/i.test(ld.json.policyReason ?? ''))

    const lp = await q('/lie-display')
    check('display-lie: server "0.01" ignored, real 1.0 used → REFUSED',
      Number(lp.json.amountFormatted) === 1 && lp.json.withinPolicy === false)

    check('exactly at the cap (0.10) is ALLOWED', (await q('/at-cap')).json.withinPolicy === true)
    check('one base unit over the cap is REFUSED', (await q('/just-over')).json.withinPolicy === false)

    const unk = await q('/unknown-asset')
    check('unpriceable asset (spoofed USDC badge) → recognized:false + REFUSED',
      unk.json.recognized === false && unk.json.withinPolicy === false && /price/i.test(unk.json.policyReason ?? ''))

    const sp = await q('/spoof-symbol')
    check('symbol spoof: TRUE symbol (USDC) governs the allowlist', sp.json.symbol === 'USDC' && sp.json.withinPolicy === true)
    check('symbol spoof is FLAGGED (symbolMismatch:true)', sp.json.symbolMismatch === true)

    const trap = await q('/trap-mixed')
    check('multi-rail trap: client selects the in-policy 0.05 rail, not the 5.0 trap',
      trap.json.withinPolicy === true && Number(trap.json.amountFormatted) === 0.05)
    check('multi-rail all-over-budget: nothing within policy', (await q('/trap-allover')).json.withinPolicy === false)

    check('pay_request decimals-lie → { declined:true }, no send', (await pay('/lie-decimals')).json.declined === true)
    check('pay_request one-over-cap → { declined:true }, no send', (await pay('/just-over')).json.declined === true)
    check('pay_request unpriceable asset → { declined:true }, no send', (await pay('/unknown-asset')).json.declined === true)
    note('every declined pay refuses in authorize() BEFORE payAndConfirm — the chain is never touched')
  } finally {
    await s.close()
    await evil.close()
  }

  group('03 · Policy core — evaluatePolicy hammered across every dimension')
  const intent = (over = {}) => ({
    host: 'api.example.com', chain: 'base', network: BASE, asset: USDC_BASE,
    amountBase: 1n, decimals: 6, symbol: 'USDC', recognized: true, ...over,
  })
  const allowed = (policy, it, spent = 0n) => evaluatePolicy(it, policy, spent).allowed

  // per-call cap boundary at several decimal scales (floors, never rounds up).
  check('6dp: amount == cap allowed', allowed({ maxAmount: '0.10' }, intent({ amountBase: 100_000n })) === true)
  check('6dp: amount == cap+1 denied', allowed({ maxAmount: '0.10' }, intent({ amountBase: 100_001n })) === false)
  check('18dp: amount == cap allowed', allowed({ maxAmount: '0.10' }, intent({ decimals: 18, amountBase: 100_000_000_000_000_000n })) === true)
  check('18dp: amount == cap+1 denied', allowed({ maxAmount: '0.10' }, intent({ decimals: 18, amountBase: 100_000_000_000_000_001n })) === false)
  check('0dp: integer cap honored (5 ok, 6 denied)',
    allowed({ maxAmount: '5' }, intent({ decimals: 0, amountBase: 5n })) && !allowed({ maxAmount: '5' }, intent({ decimals: 0, amountBase: 6n })))
  check('sub-unit cap FLOORS (0.0000019 → 1 ok, 2 denied)',
    allowed({ maxAmount: '0.0000019' }, intent({ amountBase: 1n })) && !allowed({ maxAmount: '0.0000019' }, intent({ amountBase: 2n })))

  // lifetime cap accumulation boundary.
  check('maxTotal: spent+amount == cap allowed', allowed({ maxTotal: '0.10' }, intent({ amountBase: 40_000n }), 60_000n) === true)
  check('maxTotal: spent+amount == cap+1 denied', allowed({ maxTotal: '0.10' }, intent({ amountBase: 40_001n }), 60_000n) === false)
  check('maxTotal: one huge call over the lifetime cap denied', allowed({ maxTotal: '0.10' }, intent({ amountBase: 100_001n }), 0n) === false)
  check('maxTotal: already at cap → any further spend denied', allowed({ maxTotal: '0.10' }, intent({ amountBase: 1n }), 100_000n) === false)

  // host allowlist — exact + wildcard, with classic suffix-spoof vectors.
  check('host exact: match allowed', allowed({ hosts: ['api.example.com'] }, intent({ host: 'api.example.com' })) === true)
  check('host exact: different subdomain denied', allowed({ hosts: ['api.example.com'] }, intent({ host: 'evil.example.com' })) === false)
  check('host exact: suffix-spoof "api.example.com.evil.com" denied', allowed({ hosts: ['api.example.com'] }, intent({ host: 'api.example.com.evil.com' })) === false)
  check('host wildcard: subdomain allowed', allowed({ hosts: ['*.example.com'] }, intent({ host: 'a.example.com' })) === true)
  check('host wildcard: apex allowed', allowed({ hosts: ['*.example.com'] }, intent({ host: 'example.com' })) === true)
  check('host wildcard: suffix-spoof "example.com.evil.com" denied', allowed({ hosts: ['*.example.com'] }, intent({ host: 'example.com.evil.com' })) === false)
  check('host wildcard: lookalike "fooexample.com" denied', allowed({ hosts: ['*.example.com'] }, intent({ host: 'fooexample.com' })) === false)

  // token allowlist — true symbol only, case-insensitive, no symbol = no match.
  check('token: allowed symbol passes', allowed({ tokens: ['USDC'] }, intent()) === true)
  check('token: disallowed symbol denied', allowed({ tokens: ['USDT'] }, intent()) === false)
  check('token: match is case-insensitive', allowed({ tokens: ['usdc'] }, intent()) === true)
  check('token: no recognized symbol can never satisfy the allowlist', allowed({ tokens: ['USDC'] }, intent({ recognized: false, symbol: undefined })) === false)

  // unknown-token guard — the opt-in risk is explicit.
  check('unknown token denied by default', allowed({}, intent({ recognized: false, symbol: undefined })) === false)
  check('unknown token allowed ONLY with explicit allowUnknownTokens', allowed({ allowUnknownTokens: true }, intent({ recognized: false, symbol: undefined })) === true)
  note('allowUnknownTokens:true trusts the server\'s decimals — the documented, opt-in risk; default false blocks it')

  // chains allowlist — string + object selectors.
  check('chains: matching string selector allowed', allowed({ chains: ['base'] }, intent()) === true)
  check('chains: non-matching string selector denied', allowed({ chains: ['solana'] }, intent()) === false)
  check('chains: object selector by id allowed', allowed({ chains: [{ id: 8453 }] }, intent()) === true)
  check('chains: wrong object id denied', allowed({ chains: [{ id: 1 }] }, intent()) === false)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
