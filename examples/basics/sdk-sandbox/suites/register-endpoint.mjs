// Register the LIVE piprail.com/x402/demo endpoint on the open x402 directories,
// using the SDK's own client.register():
//   • 402index  — open POST, no auth
//   • x402scan  — SIWX (one wallet signature from the bound EVM wallet)
//
// Idempotent-ish: the directories dedupe by URL, so re-running is harmless.
// Reads the signing wallet from ../../../../.secrets/wallets/evm-wallet.json.
//
//   node suites/register-endpoint.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PipRailClient } from '../../../../sdk/dist/index.js'
import { group, check, note, summarize } from '../lib/report.mjs'

const URL = process.env.X402_URL || 'https://piprail.com/x402/demo'
const here = path.dirname(fileURLToPath(import.meta.url))
const secretsPath = path.resolve(here, '../../../../.secrets/wallets/evm-wallet.json')

group(`register · ${URL}`)
if (!fs.existsSync(secretsPath)) { note('SKIPPED — no .secrets wallet (x402scan needs an EVM signer)'); summarize(); process.exit(0) }
const PAYER = JSON.parse(fs.readFileSync(secretsPath, 'utf8')).privateKey

const client = new PipRailClient({ chain: 'base', wallet: { key: PAYER }, rpcUrl: 'https://mainnet.base.org' })

const outcomes = await client.register(URL, {
  name: 'PipRail x402 demo',
  description:
    'Live x402 paid endpoint on Base (USDC). Pay $0.01 to unlock — dual-rail: PipRail ' +
    'onchain-proof (backendless) or the standard exact (EIP-3009) scheme. Built with @piprail/sdk.',
  priceUsd: 0.01,
  asset: 'USDC',
  network: 'base',
  method: 'GET',
  targets: ['402index', 'x402scan'],
})

for (const o of outcomes) {
  note(`${o.source} → ${JSON.stringify(o)}`)
  check(`registered on ${o.source}`, o.ok, o.detail || '')
}
const ok = summarize()
process.exit(ok ? 0 : 1)
