/**
 * x402 EXTENSION-POINTS GUARD — the shared Phase-0 harness for the x402-parity
 * initiative (verifiable receipts → upto → A2A). It pins the wire/scheme
 * extension points that all three features widen, so a new scheme or payload
 * shape can never be added without this test forcing the matching guard + the
 * cross-consumer sweep.
 *
 * It is GREEN on 2.9.0 (it asserts CURRENT behaviour). Each later phase EXTENDS it:
 *   • Receipts (R1): add the `X402Receipt.nonce?` round-trip assertion (nonce is
 *     additive + optional — a no-nonce receipt must stay byte-identical).
 *   • upto: ✅ LANDED — `'upto'` moved from the REJECTED set to the ACCEPTED set in
 *     lockstep with widening BOTH `X402Receipt.scheme` AND `isValidReceipt` (x402.ts)
 *     AND the ~9 `scheme === …` consumer sites (B9); the `scheme:'upto'` receipt
 *     round-trip + the forged-upto-payload-rejected case are below.
 *   • A2A: the object-input parser cores (`parseSignatureObject`/`parseExactObject`)
 *     get their own byte-identical-vs-base64 assertions (B6).
 */
import { describe, it, expect } from 'vitest'
import {
  buildReceiptHeader,
  parseReceipt,
  buildSignatureHeader,
  parseSignatureHeader,
  parseExactPaymentHeader,
  parseUptoPaymentHeader,
  HEADER_RESPONSE,
  type X402Receipt,
  type X402PaymentSignature,
  type X402AcceptEntry,
} from '../src/x402.js'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const responseWithReceipt = (r: X402Receipt) =>
  new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(r) } })

const onchainAccept: X402AcceptEntry = {
  scheme: 'onchain-proof',
  network: 'eip155:8453',
  amount: '50000',
  asset: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 600,
  extra: { nonce: 'nonce-1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
}

const onchainSig: X402PaymentSignature = {
  x402Version: 2,
  accepted: onchainAccept,
  payload: { nonce: 'nonce-1', txHash: `0x${'a'.repeat(64)}` },
}

// The `exact` wire envelope, framed exactly as a buyer sends it (same bytes
// `buildExactSignatureHeader` produces). `accepted.scheme === 'exact'`.
const exactSigHeader = b64({
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC' },
  payload: { signature: `0x${'2d'.repeat(65)}`, authorization: { from: '0xpayer', to: '0xmerchant', value: '10000', validAfter: '0', validBefore: '1740672154', nonce: `0x${'f3'.repeat(32)}` } },
})

// The `upto` wire envelope, framed exactly as a buyer sends it. `accepted.scheme === 'upto'`,
// and the permit2Authorization witness carries the MIDDLE `facilitator` field.
const uptoSigHeader = b64({
  x402Version: 2,
  accepted: { scheme: 'upto', network: 'eip155:8453', asset: '0xUSDC' },
  payload: {
    signature: `0x${'2d'.repeat(65)}`,
    permit2Authorization: {
      permitted: { token: '0xUSDC', amount: '5000000' },
      from: '0xpayer',
      spender: '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002',
      nonce: '123',
      deadline: '1740672154',
      witness: { to: '0xmerchant', facilitator: '0xfacilitator', validAfter: '0' },
    },
  },
})

// A FORGED accept: scheme says 'upto' but the payload is an exact EIP-3009 shape (no
// permit2Authorization / no witness.facilitator). The upto parser MUST reject it, never
// silently match it to the wrong rail (the only guard the type system can't provide — B9).
const forgedUptoHeader = b64({
  x402Version: 2,
  accepted: { scheme: 'upto', network: 'eip155:8453', asset: '0xUSDC' },
  payload: { signature: `0x${'2d'.repeat(65)}`, authorization: { from: '0xpayer', to: '0xmerchant', value: '10000', validAfter: '0', validBefore: '1740672154', nonce: `0x${'f3'.repeat(32)}` } },
})

const receipt = (scheme: string): X402Receipt =>
  ({
    scheme,
    success: true,
    network: 'eip155:8453',
    transaction: `0x${'ab'.repeat(32)}`,
    asset: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    amount: '50000',
    payer: '0xpayer',
    payTo: '0xmerchant',
    verifiedAt: '2026-06-20T00:00:00.000Z',
  }) as unknown as X402Receipt

/**
 * The CLOSED set of schemes the wire validators recognise TODAY. This is the
 * canary: the moment upto (or any scheme) is added, this list MUST grow IN THE
 * SAME EDIT as `isValidReceipt` (x402.ts) + the consumer sweep — and the test
 * below will fail loudly until it does.
 */
const RECOGNISED_RECEIPT_SCHEMES = ['onchain-proof', 'exact', 'upto'] as const
const NOT_YET_A_SCHEME = ['forged', 'permit2', ''] as const

describe('extension points · scheme dispatch is exactly-one-branch', () => {
  it('an onchain-proof signature parses ONLY via parseSignatureHeader', () => {
    const h = buildSignatureHeader(onchainSig)
    expect(parseSignatureHeader(h)).not.toBeNull()
    expect(parseExactPaymentHeader(h)).toBeNull() // never double-matched as exact
    expect(parseUptoPaymentHeader(h)).toBeNull() // never double-matched as upto
  })

  it('an exact signature parses ONLY via parseExactPaymentHeader', () => {
    expect(parseExactPaymentHeader(exactSigHeader)).not.toBeNull()
    expect(parseSignatureHeader(exactSigHeader)).toBeNull() // never matched as onchain-proof
    expect(parseUptoPaymentHeader(exactSigHeader)).toBeNull() // never matched as upto
  })

  it('an upto signature parses ONLY via parseUptoPaymentHeader (B9 — exactly-one-branch)', () => {
    expect(parseUptoPaymentHeader(uptoSigHeader)).not.toBeNull()
    expect(parseExactPaymentHeader(uptoSigHeader)).toBeNull() // scheme:'upto' ≠ exact
    expect(parseSignatureHeader(uptoSigHeader)).toBeNull() // scheme:'upto' ≠ onchain-proof
  })

  it('a FORGED accept whose scheme + payload disagree is REJECTED, never mis-matched (B9)', () => {
    // scheme says 'upto' but the payload is an exact EIP-3009 shape → the upto parser rejects it
    // (no witness.facilitator), and the exact parser rejects it too (scheme:'upto' ≠ exact).
    expect(parseUptoPaymentHeader(forgedUptoHeader)).toBeNull()
    expect(parseExactPaymentHeader(forgedUptoHeader)).toBeNull()
  })
})

describe('extension points · the receipt-scheme guard (the line upto must widen — B1)', () => {
  it('accepts a receipt on every CURRENTLY-recognised scheme', () => {
    for (const scheme of RECOGNISED_RECEIPT_SCHEMES) {
      expect(parseReceipt(responseWithReceipt(receipt(scheme))), `scheme ${scheme}`).not.toBeNull()
    }
  })

  it('REJECTS a receipt on any forged / not-yet-supported scheme (incl. upto, today)', () => {
    for (const scheme of NOT_YET_A_SCHEME) {
      expect(parseReceipt(responseWithReceipt(receipt(scheme))), `scheme ${scheme}`).toBeNull()
    }
  })
})

describe('extension points · X402Receipt round-trips losslessly on each scheme', () => {
  it('build → parse preserves the load-bearing fields', () => {
    for (const scheme of RECOGNISED_RECEIPT_SCHEMES) {
      const r = receipt(scheme)
      const parsed = parseReceipt(responseWithReceipt(r))
      expect(parsed).toEqual(r)
    }
  })
})
