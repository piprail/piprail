// Suite 03 — the spend policy under attack, via PipRailClient directly.
// A lying merchant tries to make the client overspend; the approval hook is the
// final say; and evaluatePolicy (the guard) is hammered across every dimension.
// No funds move — every payment attempted is one the policy/hook declines.

import { PipRailClient, evaluatePolicy, PaymentDeclinedError } from '@piprail/sdk'
import { startMerchant } from '../lib/merchant.mjs'
import { startHostile, USDC_BASE, UNKNOWN_ASSET, BASE } from '../lib/hostile.mjs'
import { group, check, note, summarize } from '../lib/report.mjs'

const KEY = '0x' + '1'.repeat(64)
const DEAD = 'http://127.0.0.1:1'

const ROUTES = {
  '/lie-decimals': { asset: USDC_BASE, amount: 5_000_000, decimals: 9, amountFormatted: '0.005', symbol: 'USDC' },
  '/lie-display': { asset: USDC_BASE, amount: 1_000_000, decimals: 6, amountFormatted: '0.01', symbol: 'USDC' },
  '/at-cap': { asset: USDC_BASE, amount: 100_000, decimals: 6, amountFormatted: '0.10', symbol: 'USDC' },
  '/just-over': { asset: USDC_BASE, amount: 100_001, decimals: 6, amountFormatted: '0.100001', symbol: 'USDC' },
  '/unknown-asset': { asset: UNKNOWN_ASSET, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
  '/spoof-symbol': { asset: USDC_BASE, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'DAI' },
  '/trap-mixed': { accepts: [
    { asset: USDC_BASE, amount: 5_000_000, decimals: 6, amountFormatted: '5.0', symbol: 'USDC' },
    { asset: USDC_BASE, amount: 50_000, decimals: 6, amountFormatted: '0.05', symbol: 'USDC' },
  ] },
}

export async function run() {
  const evil = await startHostile(ROUTES)
  const honest = await startMerchant()
  const client = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: DEAD, policy: { maxAmount: '0.10', tokens: ['USDC'] } })
  const x = (p) => `${evil.url}${p}`

  try {
    group('03 · Lying merchant vs PipRailClient — the cap binds to the TRUE amount')
    {
      const ld = await client.quote(x('/lie-decimals'))
      check('decimals-lie: re-derived at TRUE decimals (5.0) → REFUSED', Number(ld.amountFormatted) === 5 && ld.withinPolicy === false && /maxAmount/i.test(ld.policyReason ?? ''))
      const lp = await client.quote(x('/lie-display'))
      check('display-lie: server "0.01" ignored, real 1.0 used → REFUSED', Number(lp.amountFormatted) === 1 && lp.withinPolicy === false)
      check('exactly at cap (0.10) ALLOWED', (await client.quote(x('/at-cap'))).withinPolicy === true)
      check('one base unit over cap REFUSED', (await client.quote(x('/just-over'))).withinPolicy === false)
      const unk = await client.quote(x('/unknown-asset'))
      check('unpriceable asset (spoofed badge) → recognized:false + REFUSED', unk.recognized === false && unk.withinPolicy === false && /price/i.test(unk.policyReason ?? ''))
      const sp = await client.quote(x('/spoof-symbol'))
      check('symbol spoof: TRUE symbol governs; mismatch flagged', sp.symbol === 'USDC' && sp.withinPolicy === true && sp.symbolMismatch === true)
      const trap = await client.quote(x('/trap-mixed'))
      check('multi-rail trap: picks the in-policy 0.05 rail, not the 5.0', trap.withinPolicy === true && Number(trap.amountFormatted) === 0.05)
    }

    group('03 · fetch() refuses BEFORE any send (PaymentDeclinedError)')
    {
      let code = null
      try { await client.fetch(x('/just-over')) } catch (e) { code = e.code }
      check('over-cap fetch throws PaymentDeclinedError (PAYMENT_DECLINED)', code === 'PAYMENT_DECLINED', `code=${code}`)
      check('nothing settled (ledger empty)', client.spent().count === 0)
    }

    group('03 · onBeforePay hook is the final say')
    {
      const denier = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: DEAD, policy: { maxAmount: '0.10', tokens: ['USDC'] }, onBeforePay: () => false })
      let r1 = null
      try { await denier.fetch(`${honest.url}/cheap`) } catch (e) { r1 = e instanceof PaymentDeclinedError }
      check('onBeforePay → false declines an in-policy payment', r1 === true)

      const thrower = new PipRailClient({ chain: 'base', wallet: { key: KEY }, rpcUrl: DEAD, policy: { maxAmount: '0.10', tokens: ['USDC'] }, onBeforePay: () => { throw new Error('nope') } })
      let r2 = null
      try { await thrower.fetch(`${honest.url}/cheap`) } catch (e) { r2 = e instanceof PaymentDeclinedError }
      check('a THROWING onBeforePay fails safe (declines, never pays)', r2 === true)
    }

    group('03 · Policy core — evaluatePolicy hammered across every dimension')
    {
      const intent = (over = {}) => ({ host: 'api.example.com', chain: 'base', network: BASE, asset: USDC_BASE, amountBase: 1n, decimals: 6, symbol: 'USDC', recognized: true, ...over })
      const ok = (policy, it, spent = 0n) => evaluatePolicy(it, policy, spent).allowed

      check('6dp: == cap ok, +1 denied', ok({ maxAmount: '0.10' }, intent({ amountBase: 100_000n })) && !ok({ maxAmount: '0.10' }, intent({ amountBase: 100_001n })))
      check('18dp: == cap ok, +1 denied', ok({ maxAmount: '0.10' }, intent({ decimals: 18, amountBase: 10n ** 17n })) && !ok({ maxAmount: '0.10' }, intent({ decimals: 18, amountBase: 10n ** 17n + 1n })))
      check('sub-unit cap FLOORS (0.0000019 → 1 ok, 2 denied)', ok({ maxAmount: '0.0000019' }, intent({ amountBase: 1n })) && !ok({ maxAmount: '0.0000019' }, intent({ amountBase: 2n })))
      check('maxTotal accumulation boundary (== cap ok, +1 denied)', ok({ maxTotal: '0.10' }, intent({ amountBase: 40_000n }), 60_000n) && !ok({ maxTotal: '0.10' }, intent({ amountBase: 40_001n }), 60_000n))
      check('host exact + suffix-spoof denied', ok({ hosts: ['api.example.com'] }, intent()) && !ok({ hosts: ['api.example.com'] }, intent({ host: 'api.example.com.evil.com' })))
      check('host wildcard apex ok, "example.com.evil.com" denied', ok({ hosts: ['*.example.com'] }, intent({ host: 'example.com' })) && !ok({ hosts: ['*.example.com'] }, intent({ host: 'example.com.evil.com' })))
      check('token allowlist: case-insensitive, refuses others', ok({ tokens: ['usdc'] }, intent()) && !ok({ tokens: ['USDT'] }, intent()))
      check("token 'native' alias: allows native, refuses for non-native, ticker works",
        ok({ tokens: ['native'] }, intent({ asset: 'native', symbol: 'ETH' })) && ok({ tokens: ['ETH'] }, intent({ asset: 'native', symbol: 'ETH' })) && !ok({ tokens: ['native'] }, intent()))
      check('unknown token: denied by default, allowed only with allowUnknownTokens', !ok({}, intent({ recognized: false, symbol: undefined })) && ok({ allowUnknownTokens: true }, intent({ recognized: false, symbol: undefined })))
      check('chains allowlist: string + object selectors', ok({ chains: ['base'] }, intent()) && !ok({ chains: ['solana'] }, intent()) && ok({ chains: [{ id: 8453 }] }, intent()) && !ok({ chains: [{ id: 1 }] }, intent()))
      note('the native alias is matched on the ASSET, so it works on every family and never loosens a stablecoin list')
    }
  } finally {
    await evil.close()
    await honest.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
  process.exit(summarize())
}
