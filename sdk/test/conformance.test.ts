/**
 * x402 v2 envelope conformance — locks the wire field names so a regression to
 * the pre-v2 shape (or a drift away from spec) fails loudly. The settlement
 * SCHEME stays our own `onchain-proof`; only the ENVELOPE is asserted here.
 * Reference: github.com/coinbase/x402 specs/x402-specification-v2.md + transports-v2/http.md.
 */
import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import {
  buildSignatureHeader,
  parseSignatureHeader,
  buildReceiptHeader,
  parseReceipt,
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  HEADER_RESPONSE,
  type X402AcceptEntry,
  type X402Receipt,
} from '../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'

describe('x402 v2 envelope conformance', () => {
  it('uses the lowercase v2 header names (no X- prefix)', () => {
    expect(HEADER_REQUIRED).toBe('payment-required')
    expect(HEADER_SIGNATURE).toBe('payment-signature')
    expect(HEADER_RESPONSE).toBe('payment-response')
  })

  it('challenge + PaymentRequirements carry the v2 field names', async () => {
    const gate = createPaymentGate({
      chain: { id: 56, rpcUrl: 'https://bsc.example/rpc' },
      token: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, symbol: 'USDC' },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const { challenge, requiredHeader } = await gate.challenge('https://api.example.com/x')
    expect(challenge.x402Version).toBe(2)
    expect(typeof requiredHeader).toBe('string') // base64 PAYMENT-REQUIRED body
    expect(challenge.resource.url).toBe('https://api.example.com/x')

    const a = challenge.accepts[0]!
    for (const k of ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'] as const) {
      expect(a).toHaveProperty(k)
    }
    expect(a.scheme).toBe('onchain-proof')
    // v2 names the atomic amount `amount`; v1 used `maxAmountRequired`.
    expect('maxAmountRequired' in a).toBe(false)
    expect(a.amount).toBe('50000000000000000')
  })

  it('PaymentPayload carries `accepted` (v2), round-trips, no legacy top-level scheme/network', () => {
    const accepted: X402AcceptEntry = {
      scheme: 'onchain-proof',
      network: 'eip155:56',
      amount: '1',
      asset: 'native',
      payTo: PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals: 18, minConfirmations: 1, amountFormatted: '0.000000000000000001' },
    }
    const header = buildSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { nonce: 'n', txHash: `0x${'a'.repeat(64)}` },
    })
    const parsed = parseSignatureHeader(header)
    expect(parsed).not.toBeNull()
    expect(parsed!.accepted.scheme).toBe('onchain-proof')
    expect(parsed!.accepted.network).toBe('eip155:56')
    expect(parsed!.payload.txHash).toBe(`0x${'a'.repeat(64)}`)
    const obj = parsed as unknown as Record<string, unknown>
    expect('scheme' in obj).toBe(false)
    expect('network' in obj).toBe(false)
  })

  it('SettlementResponse uses `success` + `transaction` (v2), not `txHash`', () => {
    const receipt: X402Receipt = {
      scheme: 'onchain-proof',
      success: true,
      network: 'eip155:56',
      transaction: `0x${'b'.repeat(64)}`,
      asset: 'native',
      amount: '1000',
      payer: '0x2222222222222222222222222222222222222222',
      payTo: PAY_TO,
      verifiedAt: '2026-06-01T00:00:00.000Z',
    }
    const res = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(receipt) } })
    const parsed = parseReceipt(res)
    expect(parsed).toEqual(receipt)
    expect(parsed!.success).toBe(true)
    expect(parsed!.transaction).toBe(`0x${'b'.repeat(64)}`)
    expect('txHash' in (parsed as unknown as Record<string, unknown>)).toBe(false)
  })

  it('rejects a receipt that has neither `transaction` nor legacy `txHash`', () => {
    const bad = {
      scheme: 'onchain-proof',
      success: true,
      network: 'eip155:56',
      payer: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1',
    }
    const res = new Response(null, { status: 200, headers: { [HEADER_RESPONSE]: buildReceiptHeader(bad as never) } })
    expect(parseReceipt(res)).toBeNull()
  })
})
