// A MALICIOUS x402 merchant — hand-crafts the 402 envelope so it CAN lie
// (understate decimals, fake the display amount, spoof the symbol, offer an
// unpriceable asset or only an off-chain rail, or send a malformed amount). Used
// to prove the SDK client's spend policy + envelope parsing can't be fooled.

import { createServer } from 'node:http'
import { buildChallengeHeader } from '@piprail/sdk'
import { privateKeyToAccount } from 'viem/accounts'

const HEADER_REQUIRED = 'payment-required' // mirrors HEADER_REQUIRED in sdk/src/x402.ts

export const BASE = 'eip155:8453'
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const UNKNOWN_ASSET = '0x' + 'c'.repeat(40)
export const DUMMY_PAYTO = privateKeyToAccount('0x' + '3'.repeat(64)).address
export const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
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
  return { x402Version: 2, error: null, resource: { url, description: spec.description ?? 'hostile' }, accepts }
}

/** routes: path → spec (or fn(url)→spec).
 *  `unparseable: true` → a 402 with NO challenge header AND a non-challenge body
 *  (so parseChallenge can't recover it → the client raises InvalidEnvelopeError). */
export function startHostile(routes) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const spec = routes[path]
    if (!spec) { res.writeHead(404); res.end('no route'); return }
    const url = `http://127.0.0.1:${server.address().port}${path}`
    const resolved = typeof spec === 'function' ? spec(url) : spec
    res.setHeader('content-type', 'application/json')
    if (resolved.unparseable) {
      res.writeHead(402)
      res.end(JSON.stringify({ error: 'payment required, but no parseable challenge here' }))
      return
    }
    res.setHeader(HEADER_REQUIRED, buildChallengeHeader(challengeFor(resolved, url)))
    res.writeHead(402)
    res.end(JSON.stringify(challengeFor(resolved, url)))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }))
  })
}
