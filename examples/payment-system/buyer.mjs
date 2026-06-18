// The buyer side of the payment system — notified on SUCCESS *and* FAILURE.
//
//   npm install && AGENT_KEY=0x… npm run buyer
//
// A PipRailClient pays the merchant's 402 automatically, inside a spend policy it
// cannot exceed. onEvent() streams every step (especially `payment-settled` and
// `payment-failed`, whose `code` is the SAME one the merchant's onFailed received);
// the try/catch shows the typed error fetch() ALSO throws on any failure.
//
// Env: AGENT_KEY (a funded Base key — USDC + a little ETH for gas),
//      MERCHANT_URL (default http://127.0.0.1:3000), RPC (optional Base RPC).

import {
  PipRailClient,
  PaymentDeclinedError,
  MaxRetriesExceededError,
  InsufficientFundsError,
} from '@piprail/sdk'

const MERCHANT_URL = process.env.MERCHANT_URL ?? 'http://127.0.0.1:3000'
const URL = `${MERCHANT_URL}/api/report`

const client = new PipRailClient({
  chain: 'base',
  wallet: { key: process.env.AGENT_KEY }, // a funded Base key: USDC + a little ETH for gas
  rpcUrl: process.env.RPC, // optional; omit to use a public Base RPC
  // A spend cap, enforced BEFORE any on-chain send — safety lives in code, not a prompt.
  policy: {
    maxAmount: '0.10', // never pay more than $0.10 for one call
    maxTotal: '5.00', // never spend more than $5 total (per token)
    tokens: ['USDC'], // only USDC
    hosts: ['*'], // accept any host (tighten to your merchant's domain in production)
  },
  // The buyer's notification stream — the mirror of the merchant's onPaid / onFailed.
  onEvent: (e) => {
    switch (e.kind) {
      case 'payment-required':
        return console.log(`• 402 — price ${e.accept.extra.amountFormatted} ${e.accept.extra.symbol ?? ''}`)
      case 'payment-broadcast':
        return console.log(`• paying — ${e.ref}`)
      case 'payment-confirmed':
        return console.log(`• confirmed in block ${e.blockNumber}`)
      case 'payment-unconfirmed':
        return console.log(`• not yet confirmed: ${e.reason}`)
      case 'payment-settled':
        // ✅ SUCCESS — the merchant accepted the proof (its onPaid fired too).
        return console.log(`✅ settled — server accepted the proof${e.receipt ? ` (tx ${e.receipt.transaction.slice(0, 10)}…)` : ''}`)
      case 'payment-failed':
        // ⚠️  FAILURE — `e.code` is the SAME code the merchant's onFailed got (when the
        //     server rejected it), or a client decline reason ('BUDGET'/'APPROVAL'/'POLICY').
        return console.log(`⚠️  failed${e.code ? ` [${e.code}]` : ''}: ${e.detail ?? e.reason}`)
    }
  },
})

console.log(`GET ${URL}  (auto-pays if it returns 402)\n`)

try {
  const res = await client.fetch(URL)
  console.log(`\n→ ${res.status} ${res.statusText}`)
  console.log('→', await res.json())
} catch (err) {
  // fetch() BOTH emits `payment-failed` (above) AND throws a typed error on any failure.
  if (err instanceof PaymentDeclinedError) {
    console.log(`\n✗ declined before any send (no funds moved): ${err.message}`)
  } else if (err instanceof MaxRetriesExceededError) {
    // The server kept rejecting the proof. `.ref` lets you recover, don't re-pay.
    console.log(`\n✗ server kept rejecting the proof: ${err.message}${err.ref ? ` (ref ${err.ref})` : ''}`)
  } else if (err instanceof InsufficientFundsError) {
    console.log(`\n✗ not enough funds to pay: ${err.message}`)
  } else {
    throw err
  }
}

console.log('\n📊 spent so far:', client.spent())
