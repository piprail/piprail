// End-to-end test of @piprail/sdk against a REAL local blockchain (Anvil).
//
// Stands up a real merchant server with requirePayment and has a real agent
// (PipRailClient) make a real on-chain payment. Proves the full loop:
// 402 -> on-chain transfer -> local verify -> 200, plus the unpaid path and
// the replay-protection path.
//
//   anvil            # in one terminal
//   node e2e.mjs     # in another

import express from 'express'
import { createPublicClient, http, formatEther } from 'viem'
import { requirePayment, PipRailClient } from '@piprail/sdk'

const RPC = 'http://127.0.0.1:8545'

// A custom chain, defined entirely by a parameter — the "any EVM chain" path.
const CHAIN = {
  id: 31337,
  rpcUrl: RPC,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
}

// Anvil's deterministic, pre-funded accounts (10000 ETH each).
const AGENT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // account 0
const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // account 1 — receives payment

const pub = createPublicClient({ transport: http(RPC) })

const line = (s = '') => console.log(s)
const ok = (s) => console.log('  \x1b[32m✓\x1b[0m ' + s)
const info = (s) => console.log('  \x1b[2m' + s + '\x1b[0m')

let failures = 0
function check(label, cond) {
  if (cond) ok(label)
  else { failures++; console.log('  \x1b[31m✗ ' + label + '\x1b[0m') }
}

const app = express()
app.get(
  '/report',
  requirePayment({
    chain: CHAIN,
    token: 'native', // pay in the chain's native coin (ETH on Anvil)
    amount: '0.01',
    payTo: MERCHANT,
    onPaid: (r) => info(`merchant verified payment from ${r.payer} (tx ${r.transaction.slice(0, 12)}…)`),
  }),
  (_req, res) => res.json({ secret: 'the answer is 42' }),
)
const server = app.listen(0)
const url = `http://127.0.0.1:${server.address().port}/report`

try {
  line()
  line('\x1b[1mPipRail SDK — live end-to-end test on Anvil\x1b[0m')
  line('────────────────────────────────────────────')
  line(`merchant route : ${url}`)
  line(`accepting      : 0.01 ETH (native) → ${MERCHANT}`)
  line()

  const before = await pub.getBalance({ address: MERCHANT })

  line('1) Agent calls the route with NO payment')
  const unpaid = await fetch(url)
  const challenge = await unpaid.json()
  check(`responds 402 Payment Required (got ${unpaid.status})`, unpaid.status === 402)
  check('challenge advertises the price + payTo', challenge?.accepts?.[0]?.payTo?.toLowerCase() === MERCHANT.toLowerCase())
  info(`quote: ${challenge?.accepts?.[0]?.extra?.amountFormatted} ${challenge?.accepts?.[0]?.extra?.symbol ?? 'native'} on ${challenge?.accepts?.[0]?.network}`)
  line()

  line('2) Agent pays automatically with PipRailClient.fetch()')
  let paidTxHash
  const client = new PipRailClient({
    wallet: { privateKey: AGENT_KEY },
    chain: CHAIN,
    onEvent: (e) => {
      if (e.kind === 'payment-broadcast') { paidTxHash = e.ref; info(`broadcast on-chain: ${e.ref}`) }
      if (e.kind === 'payment-confirmed') info(`confirmed in block ${e.blockNumber}`)
    },
  })
  const paid = await client.fetch(url)
  const body = await paid.json()
  check(`responds 200 OK (got ${paid.status})`, paid.status === 200)
  check('returns the gated content', body?.secret === 'the answer is 42')
  info(`content: ${JSON.stringify(body)}`)

  const after = await pub.getBalance({ address: MERCHANT })
  const delta = after - before
  check('merchant actually received 0.01 ETH on-chain', delta === 10000000000000000n)
  info(`merchant balance: ${formatEther(before)} → ${formatEther(after)} ETH  (+${formatEther(delta)})`)
  line()

  line('3) Attacker replays the same tx hash as proof')
  const forgedSig = Buffer.from(
    JSON.stringify({ x402Version: 2, scheme: 'onchain-proof', network: 'eip155:31337', payload: { nonce: 'replay-attempt', txHash: paidTxHash } }),
  ).toString('base64')
  const replay = await fetch(url, { headers: { 'payment-signature': forgedSig } })
  const replayBody = await replay.json()
  check(`replay rejected with 402 (got ${replay.status})`, replay.status === 402)
  check(`reason is tx_already_used (got "${replayBody?.error}")`, replayBody?.error === 'tx_already_used')
  line()

  line('────────────────────────────────────────────')
  if (failures === 0) line('\x1b[32m\x1b[1mALL CHECKS PASSED\x1b[0m — real payment settled and verified on-chain.')
  else line(`\x1b[31m\x1b[1m${failures} CHECK(S) FAILED\x1b[0m`)
} catch (err) {
  failures++
  console.error('\x1b[31mERROR:\x1b[0m', err)
} finally {
  server.close()
  process.exit(failures === 0 ? 0 : 1)
}
