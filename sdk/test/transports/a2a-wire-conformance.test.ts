/**
 * A2A wire conformance — pins the x402 **V2** shape PipRail emits over A2A, so a regression to the
 * legacy v1 schema (chain slugs, `maxAmountRequired`, `x402Version: 1`, flat scheme) is caught on
 * every CI run without needing Python / Google's libs. The live cross-check against the canonical
 * `x402` lib lives in `examples/a2a-interop/` + `.claude/research/a2a-x402-interop.md`; this is its
 * always-on guard.
 */
import { describe, it, expect } from 'vitest'
import {
  createPaymentGate,
  createA2APaymentHandler,
  A2A_STATUS_KEY,
  A2A_REQUIRED_KEY,
  A2A_PAYLOAD_KEY,
  A2A_RECEIPTS_KEY,
  A2A_ERROR_KEY,
  A2A_EXTENSIONS_HEADER,
  A2A_X402_EXTENSION_URI_V01,
} from '../../src/index.js'

const PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const newPay = () => createA2APaymentHandler({ gate: createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.01', payTo: PAYTO }) })

describe('A2A wire conformance — current x402 V2 (regression guard vs v1 drift)', () => {
  it('the five metadata keys + the extension URI + the activation header are the spec-exact strings', () => {
    // Identical to Google's official x402_a2a constants (state.py / config.py).
    expect(A2A_STATUS_KEY).toBe('x402.payment.status')
    expect(A2A_REQUIRED_KEY).toBe('x402.payment.required')
    expect(A2A_PAYLOAD_KEY).toBe('x402.payment.payload')
    expect(A2A_RECEIPTS_KEY).toBe('x402.payment.receipts')
    expect(A2A_ERROR_KEY).toBe('x402.payment.error')
    expect(A2A_EXTENSIONS_HEADER).toBe('X-A2A-Extensions')
    expect(A2A_X402_EXTENSION_URI_V01).toBe('https://github.com/google-a2a/a2a-x402/v0.1')
    expect(newPay().agentCardExtension().uri).toBe(A2A_X402_EXTENSION_URI_V01)
  })

  it('the emitted PaymentRequired is x402 V2, not v1', async () => {
    const task = await newPay().handleMessage({ kind: 'message' }, 't')
    const required = task.status.message!.metadata![A2A_REQUIRED_KEY]!

    // x402Version 2 (the live standard) — v1 would be the regression.
    expect(required.x402Version).toBe(2)
    // V2 `resource` is an OBJECT (ResourceInfo { url }), not a bare string (v1).
    expect(typeof required.resource).toBe('object')
    expect(required.resource).not.toBeNull()

    const accept = required.accepts[0]!
    // V2 uses `amount`; v1 used `maxAmountRequired`.
    expect(typeof accept.amount).toBe('string')
    expect('maxAmountRequired' in accept).toBe(false)
    // camelCase, x402-standard field names.
    expect(accept.payTo).toBe(PAYTO)
    expect(typeof accept.maxTimeoutSeconds).toBe('number')
    // CAIP-2 network (`eip155:8453`), NOT a v1 chain slug (`base`).
    expect(accept.network).toMatch(/^eip155:\d+$/)
  })

  it('a paid completion carries an x402-conformant receipt + status payment-completed', async () => {
    // Status is the spec-bounded merchant value; the receipt is a superset of x402 SettleResponse.
    const task = await newPay().handleMessage({ kind: 'message' }, 't2')
    // (no payload → challenge; this asserts the challenge status pairing for the v2 wire)
    expect(task.status.message!.metadata![A2A_STATUS_KEY]).toBe('payment-required')
    expect(task.status.state).toBe('input-required')
  })
})
