/**
 * A facilitator's 4xx is the BUYER's problem; its 5xx is the SERVER's.
 *
 * `settleViaFacilitator` treated every non-200 from `/verify` as a transport failure and threw
 * `SettlementError`, which the adapter turns into a 5xx. For a 400 — a forged or malformed
 * authorization — that is the wrong answer twice over: it tells the buyer "our fault, retry" for
 * a payment that can never succeed, and it shows up in the merchant's metrics as an outage they
 * do not have.
 *
 * Found live: a deliberately tampered authorization on Base drew an HTTP 400 from the
 * facilitator, and the gate answered with a settlement error instead of a re-challenge.
 *
 * The split: 4xx (except 429) → a rejection the buyer can act on. 429, 5xx and transport
 * failures → SettlementError, because those really are "not your fault, try later".
 */
import { describe, it, expect, afterEach } from 'vitest'
import { settleViaFacilitator } from '../src/facilitator.js'
import { SettlementError } from '../src/errors.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Answer /verify with `status`, and /settle with success (never reached in these tests). */
function facilitatorReturning(status: number, body: unknown = {}) {
  const seen: string[] = []
  globalThis.fetch = (async (url: string) => {
    const u = String(url)
    seen.push(u)
    if (u.endsWith('/verify')) return new Response(JSON.stringify(body), { status })
    return new Response(JSON.stringify({ success: true, transaction: `0x${'1'.repeat(64)}`, network: 'eip155:8453', payer: `0x${'9'.repeat(40)}` }), { status: 200 })
  }) as typeof fetch
  return seen
}

const input = {
  url: 'https://facilitator.example',
  x402Version: 2,
  paymentRequirements: {
    scheme: 'exact' as const,
    network: 'eip155:8453',
    asset: `0x${'a'.repeat(40)}`,
    amount: '10000',
    payTo: `0x${'3'.repeat(40)}`,
    maxTimeoutSeconds: 600,
  },
  paymentPayload: { signature: '0xsig', authorization: {} },
  // The receipt fields the settled path re-derives from the TRUSTED requirements.
  receipt: {
    network: 'eip155:8453',
    asset: `0x${'a'.repeat(40)}`,
    amount: '10000',
    payTo: `0x${'3'.repeat(40)}`,
  },
} as never

describe('a facilitator 4xx is a rejection the buyer can act on', () => {
  // ONLY the payload-error codes. 401/403/404 are the merchant's misconfiguration and 429 is
  // retry-later; a buyer can do nothing about any of them, so they stay 5xx.
  for (const status of [400, 422]) {
    it(`HTTP ${status} rejects rather than throwing`, async () => {
      facilitatorReturning(status, { invalidReason: 'invalid_signature', invalidMessage: 'bad sig' })
      const r = await settleViaFacilitator(input)
      expect(r.ok).toBe(false)
      expect(String((r as { detail: string }).detail)).toMatch(new RegExp(String(status)))
    })
  }

  it('carries the facilitator\'s own reason through, so the buyer learns WHY', async () => {
    facilitatorReturning(400, { invalidReason: 'invalid_exact_evm_signature', invalidMessage: 'recover failed' })
    const r = await settleViaFacilitator(input)
    expect(String((r as { detail: string }).detail)).toMatch(/invalid_exact_evm_signature/)
    expect(String((r as { detail: string }).detail)).toMatch(/recover failed/)
  })

  it('never reaches /settle after a 4xx (no point broadcasting a bad payload)', async () => {
    const seen = facilitatorReturning(400)
    await settleViaFacilitator(input)
    expect(seen.some((u) => u.endsWith('/settle'))).toBe(false)
  })
})

describe("a facilitator's auth, rate-limit and 5xx failures stay the SERVER's problem", () => {
  for (const status of [401, 403, 404, 500, 502, 503, 504]) {
    it(`HTTP ${status} throws SettlementError`, async () => {
      facilitatorReturning(status)
      await expect(settleViaFacilitator(input)).rejects.toThrow(SettlementError)
    })
  }

  it('429 stays a SettlementError — "too many requests" really is retry-later', async () => {
    facilitatorReturning(429)
    await expect(settleViaFacilitator(input)).rejects.toThrow(SettlementError)
  })

  it('a network failure throws SettlementError', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await expect(settleViaFacilitator(input)).rejects.toThrow(SettlementError)
  })
})

describe('the 200 path is unchanged', () => {
  it('isValid:false is still a rejection', async () => {
    facilitatorReturning(200, { isValid: false, invalidReason: 'insufficient_funds' })
    const r = await settleViaFacilitator(input)
    expect(r.ok).toBe(false)
    expect(String((r as { detail: string }).detail)).toMatch(/insufficient_funds/)
  })

  it('a valid payment still settles', async () => {
    facilitatorReturning(200, { isValid: true })
    const r = await settleViaFacilitator(input)
    expect(r.ok).toBe(true)
  })
})
