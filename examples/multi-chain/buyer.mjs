// One buyer, many wallets — pay whatever chain the merchant asks for.
//
//   EVM_KEY=0xYourKey node buyer.mjs http://127.0.0.1:3000/api/report          # plan only (read-only)
//   EVM_KEY=0xYourKey node buyer.mjs http://127.0.0.1:3000/api/report --pay     # actually settle
//
// A PipRailClient is bound to ONE chain + ONE wallet (an EVM key can't sign a
// Solana tx, and vice-versa). MultiChainPayer carries a WALLET PER CHAIN and, on
// a 402, surveys every chain you hold a key for, then pays the FIRST chain you
// listed that can actually settle (your preference order — there's no oracle to
// compare gas across coins; within a chain it picks the cheapest-gas rail), with
// no manual "which client owns this rail?" routing.
//
// Add a chain by adding its key (one EVM key covers every EVM chain; non-EVM
// families each need their own key + that family's peer libs installed):
//   EVM_KEY (base/polygon/arbitrum)  ·  SOLANA_KEY  ·  XRPL_SEED  ·  …

import { MultiChainPayer } from '@piprail/sdk'

const url = process.argv[2] ?? process.env.URL ?? 'http://127.0.0.1:3000/api/report'
const doPay = process.argv.includes('--pay')

// 1) Assemble the wallet bundle from whatever keys are in the env. One EVM key
//    works on EVERY EVM chain (same address); non-EVM families each need their own.
const wallets = {}
if (process.env.EVM_KEY) {
  wallets.base = { key: process.env.EVM_KEY }
  wallets.polygon = { key: process.env.EVM_KEY }
  wallets.arbitrum = { key: process.env.EVM_KEY }
}
if (process.env.SOLANA_KEY) wallets.solana = { key: process.env.SOLANA_KEY } // needs @solana/web3.js + @solana/spl-token + bs58
if (process.env.XRPL_SEED) wallets.xrpl = { key: process.env.XRPL_SEED } // needs xrpl
// (every chain takes the same field: { key } — near also needs accountId: { accountId, key })

if (Object.keys(wallets).length === 0) {
  console.error(
    'No wallet keys found. Set at least one, e.g.:\n' +
      '  EVM_KEY=0xYourKey node buyer.mjs <url>\n' +
      'Add SOLANA_KEY / XRPL_SEED (+ their peer libs) to pay those chains too.'
  )
  process.exit(1)
}

// 2) One payer over all of them. ONE spend policy guards every chain — the buyer
//    can never exceed it, whichever chain it ends up paying on. Order = preference.
//    NOTE: maxAmount/maxTotal are in the PAID token's own units — ≈ dollars for USDC/USDT,
//    but native units for a coin (so '1.00' here = 1 USDC OR 1 whole native coin). Keep
//    `tokens` to stablecoins if you want the cap to read as ~dollars.
const payer = MultiChainPayer.fromWallets({
  wallets,
  policy: { maxAmount: '1.00', maxTotal: '5.00', tokens: ['USDC', 'USDT', 'native'] },
})

console.log(`Buyer wallets : ${Object.keys(wallets).join(', ')}`)
console.log(`Target URL    : ${url}\n`)

// 3) PLAN across every funded chain — read-only, moves nothing. This is the
//    cross-chain brain: it checks each chain's balance + gas + recipient-readiness
//    and ranks the rails the merchant offers, payable-first in YOUR listed order
//    (best = the first funded chain that can settle; within a chain, cheapest gas).
const plan = await payer.planPayment(url)
if (plan === null) {
  console.log('That URL needs no payment (no 402). Nothing to do.')
  process.exit(0)
}
renderPlan(plan)

// 4) PAY — only with --pay. Settles the chosen rail on its own chain, through the
//    shared spend policy, and returns the unlocked response + a receipt.
if (!doPay) {
  console.log('\n(Read-only plan above. Re-run with --pay to settle the chosen rail.)')
  process.exit(0)
}
if (!plan.payable) {
  console.log(`\nNot settleable on any funded chain — ${plan.fundingHint}\nNot paying.`)
  process.exit(1)
}
console.log(`\nPaying on the first funded chain that can settle (${plan.best.accept.network})…`)
const res = await payer.get(url)
console.log(`HTTP ${res.status}`)
console.log('Body :', (await res.text()).slice(0, 200))
const spent = payer.spent()
const last = spent.records.at(-1)
if (last) console.log(`\n💸 Settled ${last.amountFormatted} ${last.symbol ?? ''} on ${last.network} — tx ${last.ref}`)

/** Pretty-print the merged cross-chain plan as a table — the visual heart of the demo.
 *  Columns stay aligned even for long network ids (Solana's CAIP-2 is clipped to fit). */
function renderPlan(plan) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  console.log(`PLAN: ${plan.status.toUpperCase()}${plan.payable ? '' : `  (${plan.fundingHint ?? 'no rail settleable'})`}`)
  console.log(`  ${'rail (network · token)'.padEnd(34)} ${'state'.padEnd(8)} ${'gas'.padEnd(18)} amount`)
  console.log('  ' + '─'.repeat(78))
  for (const o of plan.options) {
    const rail = clip(`${o.accept.network} · ${o.quote.symbol ?? o.accept.asset}`, 34).padEnd(34)
    const state = o.state.padEnd(8)
    const gas = `${o.cost.feeFormatted} ${o.cost.feeSymbol}`.padEnd(18)
    const amt = `${o.quote.amountFormatted} ${o.quote.symbol ?? ''}`
    const best = plan.best && o === plan.best ? '  ◀ best' : ''
    console.log(`  ${rail} ${state} ${gas} ${amt}${best}`)
  }
  if (plan.options.length === 0) console.log('  (none — the 402 offers no rail on a chain you hold a wallet for)')
}
