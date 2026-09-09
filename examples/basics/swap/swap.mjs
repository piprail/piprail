// Swapping is OPTIONAL. Nothing here happens unless you ask for it.
//
//   npm install
//   npm run quote      # read-only: price it, sign nothing, spend nothing
//   npm run swap       # actually execute the quote you just saw
//
// The point of this example is the SHAPE: look first, then commit. `quoteSwap()`
// reads and never throws; `swap()` is the only call that moves anything.
//
// Env:
//   CHAIN         default 'stellar'  (try: solana, base, bnb, xrpl, aptos, ton, tron, sui, near, algorand)
//   WALLET_KEY    your private key / seed for that chain     (required)
//   FROM / TO     token symbols or 'native'    default native -> USDC
//   WANT          how much of TO you need, human units       default '0.05'
//
// 🔴 Two things to know before you use this in anger:
//   1. Your spend POLICY DOES NOT GOVERN SWAPS. Every budget cap governs paying a
//      merchant; a swap moves your own funds between denominations instead.
//   2. There is no MCP tool for this, deliberately. See the note in the docs:
//      https://docs.piprail.com/making-payments/swapping/

import { PipRailClient, summarizeSwap } from '@piprail/sdk'

const CHAIN = process.env.CHAIN ?? 'stellar'
const FROM = process.env.FROM ?? 'native'
const TO = process.env.TO ?? 'USDC'
const WANT = process.env.WANT ?? '0.05'
const EXECUTE = process.argv.includes('--execute')

if (!process.env.WALLET_KEY) {
  console.error('Set WALLET_KEY to a private key / seed for the chain you picked.')
  process.exit(1)
}

const client = new PipRailClient({ chain: CHAIN, wallet: { key: process.env.WALLET_KEY } })

// ── 1. Read. Nothing is signed, nothing is spent, nothing is committed to. ──
const quote = await client.quoteSwap({ from: FROM, to: TO, wantAmount: WANT })

// `null` means "no quote" — no route, no liquidity, a read failed, or this chain has
// no swap support. It NEVER means "you are broke".
if (!quote) {
  console.log(`No quote for ${FROM} -> ${TO} on ${CHAIN}.`)
  console.log('Either this chain has no swap support, or the pair could not be routed.')
  process.exit(2)
}

console.log(summarizeSwap(quote))
console.log()
console.log(`  priced by : ${quote.source.name}  (${quote.source.kind})`)
console.log(`  ${quote.source.note}`)
console.log()
console.log(`  you spend : up to ${quote.maxSpendFormatted} ${quote.from.symbol}`)
console.log(`  you get   : ${quote.to.amountFormatted} ${quote.to.symbol}`)
console.log(`  slippage  : ${quote.slippageBps / 100}%, enforced ON-CHAIN`)

// 🔴 Read `source.kind` and mean it. 'protocol' = the ledger itself swapped and no third
// party was involved. 'provider' = a named router did, and you are trusting it too.
if (quote.source.kind === 'provider') {
  console.log(`\n  NOTE: a third party (${quote.source.name}) routes this one.`)
}

if (!EXECUTE) {
  console.log('\nQuote only. Re-run with --execute to actually swap.\n')
  process.exit(0)
}

// ── 2. Commit. One transaction, signed by your own key. ──
// Pass the quote back UNMODIFIED, and do not reuse an old one: a stale route is how
// you get a worse price than the one you were shown.
const receipt = await client.swap(quote)
console.log(`\nSwapped. tx ${receipt.transaction}\n`)
