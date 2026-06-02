// A *safe* agent — a spend budget + an approval hook, enforced BEFORE any send.
//
//   AGENT_KEY=0x… npm run pay:policy
//
// Safety lives in the policy/hook, not the prompt: an over-budget 402 is refused
// with PaymentDeclinedError and no funds move.

import { PipRailClient, PaymentDeclinedError } from '@piprail/sdk'

const URL = process.env.URL ?? 'https://api.example.com/report'

const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  policy: {
    maxAmount: '0.10', // never pay more than $0.10 for one call
    maxTotal: '5.00', // never spend more than $5 total (per token)
    tokens: ['USDC'], // only USDC
    hosts: ['*.example.com'], // only these hosts
  },
  onBeforePay: (quote) => {
    console.log(`• about to pay ${quote.amountFormatted} ${quote.symbol}`)
    return true // final say — return false (or throw) to decline this one
  },
})

try {
  const res = await client.fetch(URL)
  console.log(`→ ${res.status}`, await res.json())
} catch (err) {
  if (err instanceof PaymentDeclinedError) console.log(`✗ declined by policy: ${err.message}`)
  else throw err
}

console.log('\n📊 spent:', client.spent())
