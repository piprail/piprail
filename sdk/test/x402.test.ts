import { describe, it, expect } from 'vitest'
import {
  buildChallengeHeader,
  buildReceiptHeader,
  buildSignatureHeader,
  chainIdFromNetwork,
  networkForChain,
  parseChallenge,
  parseReceipt,
  parseSignatureHeader,
  pickAccept,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  type X402AcceptEntry,
  type X402Challenge,
  type X402PaymentSignature,
  type X402Receipt,
} from '../src/x402.js'

const accept: X402AcceptEntry = {
  scheme: 'onchain-proof',
  network: 'eip155:56',
  amount: '50000000000000000',
  asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 600,
  extra: {
    nonce: 'nonce-1',
    decimals: 18,
    minConfirmations: 1,
    amountFormatted: '0.05',
    symbol: 'USDC',
  },
}

const challenge: X402Challenge = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/report', description: 'A report' },
  accepts: [accept],
}

describe('base64 envelope codec is UTF-8 safe (no Latin1 btoa breakage)', () => {
  it('round-trips a challenge whose error/detail contains non-ASCII (chain error, …, symbols)', () => {
    const c: X402Challenge = {
      x402Version: 2,
      error: 'tx_reverted: would revert — gas required exceeds allowance… (€, ✓, 日本語)',
      resource: { url: 'https://api.example.com/r', description: 'café — premium ✓' },
      accepts: [accept],
      extensions: { piprail: { code: 'tx_reverted', detail: 'Out of gas…' } },
    }
    const header = buildChallengeHeader(c)
    const res = new Response(null, { status: 402, headers: { 'payment-required': header } })
    // parseChallenge reads the header and JSON.parses the UTF-8 body back intact.
    return parseChallenge(res).then((parsed) => {
      expect(parsed).not.toBeNull()
      expect(parsed!.error).toBe(c.error)
      expect(parsed!.resource.description).toBe('café — premium ✓')
      expect((parsed!.extensions as { piprail: { detail: string } }).piprail.detail).toBe('Out of gas…')
    })
  })
})

describe('network id helpers', () => {
  it('round-trips chain id ⇄ eip155 network', () => {
    expect(networkForChain(56)).toBe('eip155:56')
    expect(chainIdFromNetwork('eip155:56')).toBe(56)
  })

  it('rejects malformed networks', () => {
    expect(chainIdFromNetwork('solana:1')).toBeNull()
    expect(chainIdFromNetwork('eip155:')).toBeNull()
    expect(chainIdFromNetwork('eip155:0')).toBeNull()
  })
})

describe('challenge round-trip', () => {
  it('encodes to a header and parses back from it', async () => {
    const header = buildChallengeHeader(challenge)
    const res = new Response(null, {
      status: 402,
      headers: { [HEADER_REQUIRED]: header },
    })
    const parsed = await parseChallenge(res)
    expect(parsed).not.toBeNull()
    expect(parsed!.accepts[0]!.amount).toBe(accept.amount)
    expect(parsed!.accepts[0]!.payTo).toBe(accept.payTo)
  })

  it('falls back to the JSON body when no header is present', async () => {
    const res = new Response(JSON.stringify(challenge), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    })
    const parsed = await parseChallenge(res)
    expect(parsed?.accepts[0]!.network).toBe('eip155:56')
  })
})

describe('pickAccept', () => {
  it('selects the entry whose network satisfies the predicate', () => {
    expect(pickAccept(challenge, (n) => chainIdFromNetwork(n) === 56)).toEqual(accept)
  })
  it('returns null when no entry matches', () => {
    expect(pickAccept(challenge, (n) => chainIdFromNetwork(n) === 8453)).toBeNull()
  })
})

describe('signature round-trip', () => {
  it('builds and parses a payment-signature header', () => {
    const sig: X402PaymentSignature = {
      x402Version: 2,
      accepted: accept,
      payload: { nonce: 'nonce-1', txHash: `0x${'a'.repeat(64)}` },
    }
    const parsed = parseSignatureHeader(buildSignatureHeader(sig))
    expect(parsed).toEqual(sig)
  })

  it('rejects garbage', () => {
    expect(parseSignatureHeader('not-base64-json')).toBeNull()
  })

  it('still tolerates the legacy top-level `scheme` shape (transitional)', () => {
    const legacy = {
      x402Version: 2,
      scheme: 'onchain-proof',
      network: 'eip155:56',
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    }
    const parsed = parseSignatureHeader(
      buildSignatureHeader(legacy as unknown as X402PaymentSignature)
    )
    expect(parsed?.payload.txHash).toBe(`0x${'a'.repeat(64)}`)
  })
})

describe('receipt round-trip', () => {
  it('encodes + parses the receipt header on a 200', () => {
    const receipt: X402Receipt = {
      scheme: 'onchain-proof',
      success: true,
      network: 'eip155:56',
      transaction: `0x${'b'.repeat(64)}`,
      asset: 'native',
      amount: '1000',
      payer: '0x2222222222222222222222222222222222222222',
      payTo: '0x1111111111111111111111111111111111111111',
      verifiedAt: '2026-06-01T00:00:00.000Z',
    }
    const res = new Response(null, {
      status: 200,
      headers: { [HEADER_RESPONSE]: buildReceiptHeader(receipt) },
    })
    expect(parseReceipt(res)).toEqual(receipt)
  })
})
