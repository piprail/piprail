/**
 * Receipts R1 — the wire keystone. Proves the additive `X402Receipt.nonce?` field
 * and the pure `buildReceiptExtension` / `parseReceiptExtension` codec round-trip,
 * stay byte-identical when receipts are off, and remain byte-COMPATIBLE with a stock
 * `@x402/extensions` reader (which reads `extensions['offer-receipt'].info.receipt`).
 * Companion to `x402-extension-points.test.ts` (the scheme-union harness) and
 * `x402-exact-wire.test.ts` (the exact-wire parser).
 */
import { describe, it, expect } from 'vitest'
import {
  buildReceiptHeader,
  parseReceipt,
  buildReceiptExtension,
  parseReceiptExtension,
  EXT_OFFER_RECEIPT,
  HEADER_RESPONSE,
  type X402Receipt,
  type PipRailReceipt,
} from '../src/x402.js'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'))

const baseReceipt: X402Receipt = {
  scheme: 'onchain-proof',
  success: true,
  network: 'eip155:8453',
  transaction: `0x${'ab'.repeat(32)}`,
  asset: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
  amount: '50000',
  payer: '0xpayer',
  payTo: '0xmerchant',
  verifiedAt: '2026-06-20T00:00:00.000Z',
}

/** A settled response whose PAYMENT-RESPONSE header carries the SettlementResponse
 *  (the receipt) merged with the offer-receipt extension — exactly as the gate emits. */
const settledResponse = (bundle: {
  receipt: X402Receipt
  resource: { url: string }
  decimals?: number
}) =>
  new Response('ok', {
    status: 200,
    headers: { [HEADER_RESPONSE]: b64({ ...bundle.receipt, extensions: buildReceiptExtension(bundle) }) },
  })

describe('receipt-wire · X402Receipt.nonce? is additive and default-omitted', () => {
  it('a receipt WITHOUT nonce is byte-identical to today (no `nonce` key emitted)', () => {
    const decoded = decode(buildReceiptHeader(baseReceipt))
    expect('nonce' in decoded).toBe(false)
  })

  it('a receipt WITH nonce round-trips the challenge nonce through buildReceiptHeader/parseReceipt', () => {
    const withNonce: X402Receipt = { ...baseReceipt, nonce: 'challenge-nonce-1' }
    const res = new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(withNonce) } })
    const parsed = parseReceipt(res)
    expect(parsed).toEqual(withNonce)
    expect(parsed!.nonce).toBe('challenge-nonce-1')
  })
})

describe('receipt-wire · buildReceiptExtension / parseReceiptExtension round-trip a PipRailReceipt', () => {
  it('reconstructs the self-contained PipRailReceipt (receipt + resource + decimals)', () => {
    const res = settledResponse({
      receipt: { ...baseReceipt, nonce: 'n-1' },
      resource: { url: 'https://api.example.com/report' },
      decimals: 6,
    })
    const got = parseReceiptExtension(res)
    const want: PipRailReceipt = {
      piprail: '1',
      receipt: { ...baseReceipt, nonce: 'n-1' },
      resource: { url: 'https://api.example.com/report' },
      decimals: 6,
    }
    expect(got).toEqual(want)
  })

  it('Tier-1 (unsigned): the chain-grounded record is at info.settlement; the spec slot info.receipt is ABSENT', () => {
    const res = settledResponse({ receipt: baseReceipt, resource: { url: 'https://x.test/r' } })
    const info = decode(res.headers.get(HEADER_RESPONSE)!).extensions[EXT_OFFER_RECEIPT].info
    expect(info.settlement).toEqual(baseReceipt)
    // A stock @x402 reader reads info.receipt → finds nothing (there is no SIGNED receipt for Tier-1).
    expect(info.receipt).toBeUndefined()
  })

  it('Tier-2 (signed): the official SignedReceipt sits at the spec slot info.receipt (stock-reader byte-compatible)', () => {
    const attestation = { format: 'eip712', signature: '0xsig', signer: '0xmerchant', payload: { version: 1 } }
    const ext = buildReceiptExtension({ receipt: baseReceipt, resource: { url: 'https://x.test/r' }, attestation: attestation as never })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (ext[EXT_OFFER_RECEIPT] as any).info
    // The stock @x402/extensions extractor path: extensions['offer-receipt'].info.receipt = the SignedReceipt.
    expect(info.receipt).toEqual(attestation)
    expect(info.receipt.format).toBe('eip712') // {format,payload,signature} — what a stock reader expects
    expect(info.settlement).toEqual(baseReceipt) // PipRail's chain-grounded record at its own sibling
    // …and parseReceiptExtension round-trips it: receipt ← settlement, attestation ← info.receipt.
    const res = new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: b64({ ...baseReceipt, extensions: ext }) } })
    const got = parseReceiptExtension(res)
    expect(got!.receipt).toEqual(baseReceipt)
    expect(got!.attestation).toEqual(attestation)
  })

  it('returns null when there is no offer-receipt extension', () => {
    const res = new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(baseReceipt) } })
    expect(parseReceiptExtension(res)).toBeNull()
  })
})

describe('receipt-wire · tolerate + ignore the spec `{ info, schema }` sibling (close-out wire-completeness)', () => {
  it('extracts info.receipt and ignores a `schema` sibling without failing', () => {
    // The official envelope: extensions['offer-receipt'] = { info: { receipt }, schema: {…} }
    const header = b64({
      ...baseReceipt,
      extensions: {
        [EXT_OFFER_RECEIPT]: {
          info: { receipt: baseReceipt, resource: { url: 'https://x.test/r' } },
          schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
        },
      },
    })
    const res = new Response('ok', { status: 200, headers: { [HEADER_RESPONSE]: header } })
    const got = parseReceiptExtension(res)
    expect(got).not.toBeNull()
    expect(got!.receipt).toEqual(baseReceipt)
    expect(got!.resource.url).toBe('https://x.test/r')
  })
})
