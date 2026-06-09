/**
 * Mode-B settlement: settleViaFacilitator — the chain-agnostic verify→settle HTTP
 * flow against a third-party x402 facilitator. Stubs `fetch`; asserts the request
 * shape, the reason mapping, and the throw-vs-return split.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { settleViaFacilitator, type SettleViaFacilitatorInput } from '../src/facilitator.js'
import { SettlementError } from '../src/errors.js'

const baseInput = (over: Partial<SettleViaFacilitatorInput> = {}): SettleViaFacilitatorInput => ({
  url: 'https://x402.org/facilitator/',
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: { scheme: 'exact' }, payload: { signature: '0xabc', authorization: { from: '0xPAYER', to: '0xMERCHANT', value: '50000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32) } } },
  paymentRequirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '50000', payTo: '0xMERCHANT', maxTimeoutSeconds: 600, extra: { name: 'USD Coin', version: '2' } },
  receipt: { network: 'eip155:8453', asset: '0xUSDC', payTo: '0xMERCHANT', amount: '50000' },
  payerHint: '0xPAYER',
  ...over,
})

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real; vi.restoreAllMocks() })

/** Queue responses for sequential fetch calls (verify, then settle). */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = (responses[i++] ?? responses[responses.length - 1])!
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

describe('settleViaFacilitator — happy path', () => {
  it('POSTs /verify then /settle and returns an exact receipt', async () => {
    const calls = stubFetch([
      { body: { isValid: true, payer: '0xPAYER' } },
      { body: { success: true, transaction: '0xSETTLED', network: 'eip155:8453', payer: '0xPAYER' } },
    ])
    const res = await settleViaFacilitator(baseInput())
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('exact')
      expect(res.receipt.transaction).toBe('0xSETTLED')
      expect(res.receipt.payer).toBe('0xPAYER')
    }
    // Trailing slash stripped; both endpoints hit in order with the standard body.
    expect(calls[0]!.url).toBe('https://x402.org/facilitator/verify')
    expect(calls[1]!.url).toBe('https://x402.org/facilitator/settle')
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent).toMatchObject({ x402Version: 2, paymentPayload: { x402Version: 2 }, paymentRequirements: { scheme: 'exact', amount: '50000' } })
  })

  it('includes merchant-supplied auth headers on both calls', async () => {
    const calls = stubFetch([
      { body: { isValid: true } },
      { body: { success: true, transaction: '0xS', network: 'eip155:8453' } },
    ])
    await settleViaFacilitator(baseInput({ authHeaders: async () => ({ authorization: 'Bearer JWT' }) }))
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer JWT')
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer JWT')
  })

  it('falls back to payerHint when settle omits payer', async () => {
    stubFetch([{ body: { isValid: true } }, { body: { success: true, transaction: '0xS', network: 'eip155:8453' } }])
    const res = await settleViaFacilitator(baseInput())
    expect(res.ok && res.receipt.payer).toBe('0xPAYER')
  })
})

describe('settleViaFacilitator — client-fixable rejections (→ 402, no /settle on verify-fail)', () => {
  it('returns invalid (no /settle) when /verify says isValid:false', async () => {
    const calls = stubFetch([{ body: { isValid: false, invalidReason: 'insufficient_funds' } }])
    const res = await settleViaFacilitator(baseInput())
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
    expect(calls).toHaveLength(1) // never called /settle
  })

  it('returns invalid when /settle says success:false', async () => {
    stubFetch([{ body: { isValid: true } }, { body: { success: false, errorReason: 'unexpected_settle_error', transaction: '', network: 'eip155:8453' } }])
    const res = await settleViaFacilitator(baseInput())
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it.each([
    ['invalid_exact_evm_payload_signature', 'signature_invalid'],
    ['invalid_exact_evm_payload_recipient_mismatch', 'wrong_recipient'],
    ['invalid_exact_evm_payload_value_mismatch', 'amount_too_low'],
    ['invalid_exact_evm_payload_authorization_valid_before', 'payment_expired'],
    ['invalid_transaction_state', 'tx_already_used'],
  ])('maps facilitator reason %s → %s', async (reason, code) => {
    stubFetch([{ body: { isValid: false, invalidReason: reason } }])
    const res = await settleViaFacilitator(baseInput())
    expect(res).toMatchObject({ ok: false, error: code })
  })
})

describe('settleViaFacilitator — transport/auth failure (→ throws SettlementError)', () => {
  it('throws when /verify returns a non-200', async () => {
    stubFetch([{ status: 401, body: { error: 'unauthorized' } }])
    await expect(settleViaFacilitator(baseInput())).rejects.toBeInstanceOf(SettlementError)
  })

  it('throws when /settle returns a non-200', async () => {
    stubFetch([{ body: { isValid: true } }, { status: 502, body: { error: 'bad gateway' } }])
    await expect(settleViaFacilitator(baseInput())).rejects.toBeInstanceOf(SettlementError)
  })

  it('throws when fetch itself rejects (network down)', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await expect(settleViaFacilitator(baseInput())).rejects.toBeInstanceOf(SettlementError)
  })
})
