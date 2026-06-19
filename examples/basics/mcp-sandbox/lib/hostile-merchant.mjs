// A MALICIOUS x402 merchant — the adversary in the threat model.
//
// The honest merchant (merchant.mjs) uses the SDK's requirePayment, so it CAN'T
// lie. This one hand-crafts the 402 envelope so it can: understate decimals, fake
// the human-readable amount, spoof the token symbol, offer an unpriceable asset,
// bury an over-budget rail among cheap ones, offer only an off-chain rail, or send
// a malformed amount. The point is to prove the client's spend policy + envelope
// parsing can't be fooled by any of it.
//
// Hand-built challenges need NO driver on the merchant side, and a base-configured
// client filters out non-EVM rails WITHOUT mounting them — so this stays EVM-only
// and installs with just `viem`.

import { createServer } from 'node:http'
import { buildChallengeHeader } from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'

// Challenge envelope header name — mirrors HEADER_REQUIRED in sdk/src/x402.ts
// (not re-exported from the package index, so pinned here).
const HEADER_REQUIRED = 'payment-required'

export const BASE = 'eip155:8453'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // recognized → TRUE decimals 6
export const UNKNOWN_ASSET = '0x' + 'c'.repeat(40) // no SDK preset → unpriceable
export const DUMMY_PAYTO = privateKeyToAccount('0x' + '3'.repeat(64)).address

// Realistic off-chain rail values (the base-configured client never parses these
// past "not my network", so the exact values only need to be well-formed strings).
export const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' // CAIP-2 Solana mainnet
export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC mint
export const SOLANA_PAYTO = '11111111111111111111111111111111'

function accept(o) {
  return {
    scheme: 'onchain-proof',
    network: o.network ?? BASE,
    amount: String(o.amount),
    asset: o.asset ?? USDC_BASE,
    payTo: o.payTo ?? DUMMY_PAYTO,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 600,
    extra: {
      nonce: o.nonce ?? 'fixed-nonce-0001',
      decimals: o.decimals ?? 6,
      minConfirmations: o.minConfirmations ?? 1,
      amountFormatted: o.amountFormatted ?? '0',
      ...(o.symbol !== undefined ? { symbol: o.symbol } : {}),
    },
  }
}

function challengeFor(spec, url) {
  const accepts = spec.accepts ? spec.accepts.map(accept) : [accept(spec)]
  return {
    x402Version: 2,
    error: null,
    resource: { url, description: spec.description ?? 'hostile resource' },
    accepts,
  }
}

/**
 * Start the hostile merchant. `routes` maps path → spec (or fn(url)→spec). Each
 * mapped path returns a 402 with a crafted challenge; others 404. → { url, close }.
 */
export function startHostileMerchant(routes) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const spec = routes[path]
    if (!spec) {
      res.writeHead(404)
      res.end('no such route')
      return
    }
    const fullUrl = `http://127.0.0.1:${server.address().port}${path}`
    const resolved = typeof spec === 'function' ? spec(fullUrl) : spec
    const challenge = challengeFor(resolved, fullUrl)
    res.setHeader(HEADER_REQUIRED, buildChallengeHeader(challenge))
    res.setHeader('content-type', 'application/json')
    res.writeHead(402)
    res.end(JSON.stringify(challenge))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
