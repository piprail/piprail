/**
 * parseExactPaymentHeader — the inbound `exact` wire parser. Must accept BOTH the
 * v2 (`PAYMENT-SIGNATURE`, `{accepted, payload}`, CAIP-2) and v1 (`X-PAYMENT`, flat
 * `{scheme,network,payload}`, slug) shapes, and reject everything else.
 */
import { describe, it, expect } from 'vitest'
import { parseExactPaymentHeader, parseSettleResponse, buildExactSignatureHeader } from '../src/x402.js'
import { encodeXPaymentHeader } from '../src/drivers/evm/exact.js'

const AUTH = {
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  value: '10000',
  validAfter: '0',
  validBefore: '1740672154',
  nonce: '0x' + 'f3'.repeat(32),
}
const SIG = '0x' + '2d'.repeat(65)
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

describe('parseExactPaymentHeader — v2 (PAYMENT-SIGNATURE)', () => {
  it('parses the v2 shape with `accepted` (CAIP-2 network + asset)', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC' }, payload: { signature: SIG, authorization: AUTH } })
    const p = parseExactPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.x402Version).toBe(2)
    expect(p!.network).toBe('eip155:8453')
    expect(p!.asset).toBe('0xUSDC')
    if (p && (p.method === 'eip3009' || p.method === 'permit2')) expect(p.payload.signature).toBe(SIG)
    expect(p!.method).toBe('eip3009')
    if (p && p.method === 'eip3009') expect(p.payload.authorization.value).toBe('10000')
    expect(p!.raw).toMatchObject({ x402Version: 2 })
  })
})

describe('parseExactPaymentHeader — v1 (X-PAYMENT)', () => {
  it('parses the v1 flat shape (scheme/network at top, slug network, no asset)', () => {
    const h = b64({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: SIG, authorization: AUTH } })
    const p = parseExactPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.x402Version).toBe(1)
    expect(p!.network).toBe('base')
    expect(p!.asset).toBeUndefined()
    expect(p!.method).toBe('eip3009')
    if (p && p.method === 'eip3009') expect(p.payload.authorization.nonce).toBe(AUTH.nonce)
  })

  it('defaults x402Version to 2 when absent', () => {
    const h = b64({ scheme: 'exact', network: 'base', payload: { signature: SIG, authorization: AUTH } })
    expect(parseExactPaymentHeader(h)!.x402Version).toBe(2)
  })
})

describe('parseExactPaymentHeader — SVM (Solana, { transaction })', () => {
  const TX = Buffer.alloc(64, 9).toString('base64') // a stand-in base64 tx blob
  it('parses the v2 SVM shape as method:"svm" (payload.transaction, no signature field)', () => {
    const accepted = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
    const h = b64({ x402Version: 2, accepted, payload: { transaction: TX } })
    const p = parseExactPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.method).toBe('svm')
    expect(p!.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    if (p && p.method === 'svm') expect(p.payload.transaction).toBe(TX)
  })

  it('round-trips through buildExactSignatureHeader', () => {
    const accepted = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'mint', payTo: 'p', amount: '1', maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'svm', feePayer: 'fp' } }
    const h = buildExactSignatureHeader({ accepted: accepted as never, payload: { transaction: TX } })
    const p = parseExactPaymentHeader(h)
    expect(p!.method).toBe('svm')
    if (p && p.method === 'svm') expect(p.payload.transaction).toBe(TX)
  })
})

describe('parseExactPaymentHeader — rejects non-exact / malformed', () => {
  it('returns null for an onchain-proof proof (scheme mismatch)', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453' }, payload: { nonce: 'n', txHash: '0xabc' } })
    expect(parseExactPaymentHeader(h)).toBeNull()
  })

  it('returns null when payload.authorization is missing', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:8453' }, payload: { signature: SIG } })
    expect(parseExactPaymentHeader(h)).toBeNull()
  })

  it('returns null when an authorization field is non-string', () => {
    const h = b64({ scheme: 'exact', network: 'base', payload: { signature: SIG, authorization: { ...AUTH, value: 10000 } } })
    expect(parseExactPaymentHeader(h)).toBeNull()
  })

  it('returns null when signature is missing', () => {
    const h = b64({ scheme: 'exact', network: 'base', payload: { authorization: AUTH } })
    expect(parseExactPaymentHeader(h)).toBeNull()
  })

  it('returns null on non-base64 / non-JSON garbage', () => {
    expect(parseExactPaymentHeader('@@@not-base64@@@')).toBeNull()
    expect(parseExactPaymentHeader(Buffer.from('not json', 'utf8').toString('base64'))).toBeNull()
  })

  it('returns null when network is absent', () => {
    const h = b64({ scheme: 'exact', payload: { signature: SIG, authorization: AUTH } })
    expect(parseExactPaymentHeader(h)).toBeNull()
  })
})

describe('encodeXPaymentHeader — emits the v1 flat shape (intentional, not a bug)', () => {
  const input = { network: 'base', authorization: AUTH, signature: SIG } as Parameters<typeof encodeXPaymentHeader>[0]

  it('defaults x402Version to 1, consistent with the flat {scheme,network,payload} shape', () => {
    const decoded = JSON.parse(Buffer.from(encodeXPaymentHeader(input), 'base64').toString('utf8'))
    expect(decoded.x402Version).toBe(1) // NOT 2 — see the version-posture note in x402.ts
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe('base')
    expect('accepted' in decoded).toBe(false) // flat, not the v2 nested envelope
  })

  it('round-trips: the inbound parser accepts exactly what it emits', () => {
    const p = parseExactPaymentHeader(encodeXPaymentHeader(input))
    expect(p).not.toBeNull()
    expect(p!.x402Version).toBe(1)
    if (p && (p.method === 'eip3009' || p.method === 'permit2')) expect(p.payload.signature).toBe(SIG)
    expect(p!.method).toBe('eip3009')
    if (p && p.method === 'eip3009') expect(p.payload.authorization.value).toBe(AUTH.value)
  })
})

describe('parseSettleResponse — the buyer reads a SettleResponse', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

  it('reads a BARE foreign SettleResponse {success,transaction,network} (no scheme/payer)', () => {
    const res = new Response('{}', {
      status: 200,
      headers: { 'payment-response': enc({ success: true, transaction: '0xabc', network: 'eip155:8453' }) },
    })
    expect(parseSettleResponse(res)).toEqual({ success: true, transaction: '0xabc', network: 'eip155:8453' })
  })

  it('flags an EXPLICIT success:false (a rejection — never a settlement)', () => {
    const res = new Response('{}', {
      status: 200,
      headers: { 'payment-response': enc({ success: false, errorReason: 'insufficient_funds', transaction: '' }) },
    })
    expect(parseSettleResponse(res)).toMatchObject({ success: false, errorReason: 'insufficient_funds' })
  })

  it('falls back to the v1 x-payment-response header', () => {
    const res = new Response('{}', {
      status: 200,
      headers: { 'x-payment-response': enc({ success: true, transaction: '0xdef', network: 'eip155:8453' }) },
    })
    expect(parseSettleResponse(res)!.transaction).toBe('0xdef')
  })

  it('returns null with NO settle header (a receipt-less 2xx ⇒ the buyer treats it as affirmative)', () => {
    expect(parseSettleResponse(new Response('{}', { status: 200 }))).toBeNull()
  })

  it('returns null when the body carries no boolean `success`', () => {
    const res = new Response('{}', { status: 200, headers: { 'payment-response': enc({ transaction: '0xabc' }) } })
    expect(parseSettleResponse(res)).toBeNull()
  })
})
