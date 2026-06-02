// Live ERC-20 payment test. Same flow as e2e.mjs, but the agent pays in a
// real ERC-20 token (deployed to Anvil), and the merchant verifies by
// parsing the on-chain Transfer log. Token address comes in via TOKEN env.
//
//   anvil
//   forge create MockUSDC.sol:MockUSDC --rpc-url http://127.0.0.1:8545 \
//     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
//     --broadcast --constructor-args 1000000000000
//   TOKEN=<deployed address> node e2e-erc20.mjs

import express from 'express'
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { requirePayment, PipRailClient } from '@piprail/sdk'

const RPC = 'http://127.0.0.1:8545'
const TOKEN = process.env.TOKEN
if (!TOKEN) throw new Error('TOKEN env var (deployed MockUSDC address) is required')

const CHAIN = { id: 31337, rpcUrl: RPC, name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }
const AGENT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // account 0 (deployer, holds USDC)
const MERCHANT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // account 1

const pub = createPublicClient({ transport: http(RPC) })
const usdc = (address) => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [address] })

const line = (s = '') => console.log(s)
const ok = (s) => console.log('  \x1b[32m✓\x1b[0m ' + s)
const info = (s) => console.log('  \x1b[2m' + s + '\x1b[0m')
let failures = 0
const check = (label, cond) => { if (cond) ok(label); else { failures++; console.log('  \x1b[31m✗ ' + label + '\x1b[0m') } }

const app = express()
app.get(
  '/data',
  requirePayment({
    chain: CHAIN,
    token: { address: TOKEN, decimals: 6, symbol: 'USDC' }, // a real ERC-20, by address
    amount: '0.05',
    payTo: MERCHANT,
    onPaid: (r) => info(`merchant verified ${r.asset.slice(0, 10)}… payment from ${r.payer}`),
  }),
  (_req, res) => res.json({ rows: [1, 2, 3] }),
)
const server = app.listen(0)
const url = `http://127.0.0.1:${server.address().port}/data`

try {
  line()
  line('\x1b[1mPipRail SDK — live ERC-20 (USDC) payment on Anvil\x1b[0m')
  line('────────────────────────────────────────────')
  line(`token   : ${TOKEN} (6 decimals)`)
  line(`price   : 0.05 USDC → ${MERCHANT}`)
  line()

  const before = await usdc(MERCHANT)

  line('1) Unpaid request')
  const unpaid = await fetch(url)
  check(`402 challenge (got ${unpaid.status})`, unpaid.status === 402)
  const ch = await unpaid.json()
  check('challenge asset = the token address', ch?.accepts?.[0]?.asset?.toLowerCase() === TOKEN.toLowerCase())
  line()

  line('2) Agent pays 0.05 USDC automatically')
  const client = new PipRailClient({
    wallet: { privateKey: AGENT_KEY },
    chain: CHAIN,
    onEvent: (e) => { if (e.kind === 'payment-broadcast') info(`ERC-20 transfer tx: ${e.ref}`) },
  })
  const paid = await client.fetch(url)
  const body = await paid.json()
  check(`200 OK (got ${paid.status})`, paid.status === 200)
  check('gated content returned', JSON.stringify(body) === JSON.stringify({ rows: [1, 2, 3] }))

  const after = await usdc(MERCHANT)
  check('merchant received 0.05 USDC on-chain', after - before === 50000n) // 0.05 * 10^6
  info(`merchant USDC: ${formatUnits(before, 6)} → ${formatUnits(after, 6)}  (+${formatUnits(after - before, 6)})`)
  line()

  line('────────────────────────────────────────────')
  if (failures === 0) line('\x1b[32m\x1b[1mERC-20 PATH PASSED\x1b[0m — token transfer verified via on-chain log.')
  else line(`\x1b[31m\x1b[1m${failures} CHECK(S) FAILED\x1b[0m`)
} catch (err) {
  failures++
  console.error('\x1b[31mERROR:\x1b[0m', err)
} finally {
  server.close()
  process.exit(failures === 0 ? 0 : 1)
}
