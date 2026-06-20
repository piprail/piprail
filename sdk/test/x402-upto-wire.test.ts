/**
 * parseUptoPaymentHeader — the inbound `upto` (metered) wire parser. The metered sibling of
 * x402-exact-wire.test.ts. It MUST be gated strictly on `scheme === 'upto'` + a
 * `witness.facilitator` STRING, so an upto payload never matches the exact parser and an exact
 * Permit2 payload never matches this one. Also pins: the B1 `scheme:'upto'` receipt round-trip
 * (the regression guard that the buyer records the ACTUAL, not the MAX), the SettleOutcome.amount
 * passthrough, and the buildUptoSignatureHeader round-trip.
 */
import { describe, it, expect } from 'vitest'
import {
  parseUptoPaymentHeader,
  parseExactPaymentHeader,
  buildUptoSignatureHeader,
  buildReceiptHeader,
  parseReceipt,
  parseSettleResponse,
  HEADER_RESPONSE,
  type X402Receipt,
  type X402UptoAcceptEntry,
  type Permit2UptoPaymentPayload,
} from '../src/x402.js'

const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
const PAYTO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
const FACILITATOR = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002'
const SIG = '0x' + '2d'.repeat(65)
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

const PA = (over: Record<string, unknown> = {}) => ({
  permitted: { token: USDC, amount: '5000000' },
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  spender: UPTO_PROXY,
  nonce: '123456789',
  deadline: '1740672154',
  witness: { to: PAYTO, facilitator: FACILITATOR, validAfter: '0' },
  ...over,
})

describe('parseUptoPaymentHeader — v2 (PAYMENT-SIGNATURE)', () => {
  it('parses a well-formed upto payload (witness.facilitator present)', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:56', asset: USDC }, payload: { signature: SIG, permit2Authorization: PA() } })
    const p = parseUptoPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.method).toBe('permit2-upto')
    expect(p!.network).toBe('eip155:56')
    expect(p!.asset).toBe(USDC)
    expect(p!.payload.signature).toBe(SIG)
    expect(p!.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR)
    expect(p!.payload.permit2Authorization.permitted.amount).toBe('5000000') // the signed MAX
    expect(p!.raw).toMatchObject({ x402Version: 2 })
  })

  it('parses the v1 flat shape (scheme/network at top, slug network, no asset)', () => {
    const h = b64({ x402Version: 1, scheme: 'upto', network: 'bnb', payload: { signature: SIG, permit2Authorization: PA() } })
    const p = parseUptoPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.x402Version).toBe(1)
    expect(p!.network).toBe('bnb')
    expect(p!.asset).toBeUndefined()
  })
})

describe('parseUptoPaymentHeader — discriminant isolation vs the exact parser (B9)', () => {
  it('REJECTS a payload missing witness.facilitator (the exact Permit2 shape)', () => {
    // The exact Permit2 witness is { to, validAfter } — no facilitator. Even with scheme:'upto'
    // it must NOT parse as upto (the facilitator field is the load-bearing discriminant).
    const noFac = { ...PA(), witness: { to: PAYTO, validAfter: '0' } }
    const h = b64({ x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:56', asset: USDC }, payload: { signature: SIG, permit2Authorization: noFac } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })

  it("REJECTS an `exact`-scheme payload (scheme mismatch) — never cross-matched", () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:56', asset: USDC }, payload: { signature: SIG, permit2Authorization: PA() } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })

  it('an upto payload is NOT mis-parsed by parseExactPaymentHeader (scheme:upto ≠ exact)', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:56', asset: USDC }, payload: { signature: SIG, permit2Authorization: PA() } })
    expect(parseExactPaymentHeader(h)).toBeNull()
    expect(parseUptoPaymentHeader(h)).not.toBeNull()
  })

  it('an exact Permit2 payload is NOT mis-parsed by parseUptoPaymentHeader (no facilitator)', () => {
    const exactPa = { permitted: { token: USDC, amount: '5000000' }, from: '0xpayer', spender: UPTO_PROXY, nonce: '1', deadline: '2', witness: { to: PAYTO, validAfter: '0' } }
    const h = b64({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:56', asset: USDC }, payload: { signature: SIG, permit2Authorization: exactPa } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
    expect(parseExactPaymentHeader(h)).not.toBeNull() // it IS a valid exact permit2 payload
  })
})

describe('parseUptoPaymentHeader — rejects malformed', () => {
  it('returns null when permit2Authorization is missing', () => {
    const h = b64({ x402Version: 2, accepted: { scheme: 'upto', network: 'eip155:56' }, payload: { signature: SIG } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })
  it('returns null when signature is missing', () => {
    const h = b64({ scheme: 'upto', network: 'bnb', payload: { permit2Authorization: PA() } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })
  it('returns null when a permitted field is non-string', () => {
    const h = b64({ scheme: 'upto', network: 'bnb', payload: { signature: SIG, permit2Authorization: { ...PA(), permitted: { token: USDC, amount: 5000000 } } } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })
  it('returns null when witness.facilitator is non-string', () => {
    const h = b64({ scheme: 'upto', network: 'bnb', payload: { signature: SIG, permit2Authorization: { ...PA(), witness: { to: PAYTO, facilitator: 123, validAfter: '0' } } } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })
  it('returns null when network is absent', () => {
    const h = b64({ scheme: 'upto', payload: { signature: SIG, permit2Authorization: PA() } })
    expect(parseUptoPaymentHeader(h)).toBeNull()
  })
  it('returns null on non-base64 / non-JSON garbage', () => {
    expect(parseUptoPaymentHeader('@@@not-base64@@@')).toBeNull()
    expect(parseUptoPaymentHeader(Buffer.from('not json', 'utf8').toString('base64'))).toBeNull()
  })
})

describe('buildUptoSignatureHeader — round-trips through the parser', () => {
  it('build → parse yields method:permit2-upto + the permit2Authorization', () => {
    const accepted: X402UptoAcceptEntry = {
      scheme: 'upto',
      network: 'eip155:56',
      amount: '5000000',
      asset: USDC,
      payTo: PAYTO,
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: FACILITATOR, decimals: 6 },
    }
    const payload: Permit2UptoPaymentPayload = { signature: SIG, permit2Authorization: PA() as Permit2UptoPaymentPayload['permit2Authorization'] }
    const h = buildUptoSignatureHeader({ accepted, payload })
    const p = parseUptoPaymentHeader(h)
    expect(p).not.toBeNull()
    expect(p!.method).toBe('permit2-upto')
    expect(p!.network).toBe('eip155:56')
    expect(p!.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR)
  })
})

describe('B1 — a scheme:"upto" receipt validates + round-trips (records ACTUAL, not MAX)', () => {
  const uptoReceipt = (over: Partial<X402Receipt> = {}): X402Receipt => ({
    scheme: 'upto',
    success: true,
    network: 'eip155:56',
    transaction: '',
    asset: USDC,
    amount: '0',
    payer: '0xpayer',
    payTo: PAYTO,
    verifiedAt: '2026-06-20T00:00:00.000Z',
    ...over,
  })
  const responseWith = (r: X402Receipt) =>
    new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(r) } })

  it('a $0 upto receipt (amount:"0", transaction:"") PASSES isValidReceipt + survives parseReceipt (NOT null)', () => {
    const r = uptoReceipt()
    const parsed = parseReceipt(responseWith(r))
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(r) // deep-equal round-trip — the empty transaction string survives
  })

  it('a non-zero upto receipt round-trips with the ACTUAL settled amount', () => {
    const r = uptoReceipt({ amount: '1858', transaction: `0x${'fe'.repeat(32)}` })
    expect(parseReceipt(responseWith(r))).toEqual(r)
  })
})

describe('SettleOutcome.amount — the buyer reads the actual settled amount', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  it('reads the REQUIRED upto `amount` field off the SettleResponse', () => {
    const res = new Response('{}', { status: 200, headers: { 'payment-response': enc({ success: true, transaction: `0x${'fe'.repeat(32)}`, network: 'eip155:56', amount: '1858' }) } })
    expect(parseSettleResponse(res)).toMatchObject({ success: true, amount: '1858' })
  })
  it('reads a $0 settle (amount:"0", transaction:"")', () => {
    const res = new Response('{}', { status: 200, headers: { 'payment-response': enc({ success: true, transaction: '', network: 'eip155:56', amount: '0' }) } })
    expect(parseSettleResponse(res)).toMatchObject({ success: true, amount: '0', transaction: '' })
  })
  it('omits `amount` for an exact/onchain-proof SettleResponse (no amount field)', () => {
    const res = new Response('{}', { status: 200, headers: { 'payment-response': enc({ success: true, transaction: '0xabc', network: 'eip155:56' }) } })
    expect(parseSettleResponse(res)!.amount).toBeUndefined()
  })
})
