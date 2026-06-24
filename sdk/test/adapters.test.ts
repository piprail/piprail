import { describe, it, expect } from 'vitest'
import {
  toFetchHandler,
  toNextRoute,
  toWorker,
  toNetlifyHandler,
  SettlementError,
  HEADER_SIGNATURE,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_RESPONSE_V1,
  type PaymentGate,
  type VerifyPaymentResult,
} from '../src/index.js'

// A minimal fake gate — the adapters only ever call gate.verify(). Cast through `unknown` so we
// don't implement the unused surface (challenge/describe/landingPage/selfTest).
function fakeGate(verify: PaymentGate['verify']): PaymentGate {
  return { verify } as unknown as PaymentGate
}

const CHALLENGE = { x402Version: 2, resource: { url: 'https://x' }, accepts: [] } as const

const paid = (): VerifyPaymentResult =>
  ({ kind: 'paid', receipt: {} as never, receiptHeader: 'RCPT' }) as VerifyPaymentResult
const challenge = (req = 'REQ'): VerifyPaymentResult =>
  ({ kind: 'challenge', challenge: CHALLENGE as never, requiredHeader: req, statusCode: 402 }) as VerifyPaymentResult

describe('toFetchHandler', () => {
  it('paid → 200, serves the body, stamps the v2 + v1 settlement headers', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () => Response.json({ secret: 42 }))
    const res = await handler(new Request('https://x', { headers: { [HEADER_SIGNATURE]: 'sig' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
    expect(res.headers.get(HEADER_RESPONSE_V1)).toBe('RCPT')
    expect(await res.json()).toEqual({ secret: 42 })
  })

  it('challenge → 402 with PAYMENT-REQUIRED + the challenge body, and never calls serve', async () => {
    let served = false
    const handler = toFetchHandler(fakeGate(async () => challenge('REQ')), () => {
      served = true
      return Response.json({})
    })
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_REQUIRED)).toBe('REQ')
    expect(await res.json()).toEqual(CHALLENGE)
    expect(served).toBe(false)
  })

  it('invalid → 402 with the re-challenge so a standard client can retry', async () => {
    const result: VerifyPaymentResult = {
      kind: 'invalid',
      error: 'amount_too_low',
      detail: 'x',
      challenge: CHALLENGE as never,
      requiredHeader: 'REQ2',
      statusCode: 402,
    }
    const res = await toFetchHandler(fakeGate(async () => result), () => Response.json({}))(
      new Request('https://x')
    )
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_REQUIRED)).toBe('REQ2')
  })

  it('a SettlementError → 502 (never a 402 that would tell the buyer to re-pay)', async () => {
    const handler = toFetchHandler(
      fakeGate(async () => {
        throw new SettlementError('relayer out of gas')
      }),
      () => Response.json({})
    )
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('settlement_failed')
    expect(body.detail).toContain('relayer out of gas')
  })

  it('passes the v2 PAYMENT-SIGNATURE header value to gate.verify', async () => {
    let seen: unknown
    const handler = toFetchHandler(
      fakeGate(async (h) => {
        seen = h
        return challenge()
      }),
      () => Response.json({})
    )
    await handler(new Request('https://x', { headers: { [HEADER_SIGNATURE]: 'the-proof' } }))
    expect(seen).toBe('the-proof')
  })

  it('a non-SettlementError from verify propagates (a real bug, not a 402)', async () => {
    const handler = toFetchHandler(
      fakeGate(async () => {
        throw new Error('boom')
      }),
      () => Response.json({})
    )
    await expect(handler(new Request('https://x'))).rejects.toThrow('boom')
  })
})

describe('toNextRoute / toWorker / toNetlifyHandler', () => {
  it('toNextRoute behaves as a Fetch handler', async () => {
    const res = await toNextRoute(fakeGate(async () => paid()), () => Response.json({ ok: true }))(
      new Request('https://x')
    )
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
  })

  it('toWorker exposes a { fetch } ExportedHandler', async () => {
    const worker = toWorker(fakeGate(async () => paid()), () => Response.json({ ok: true }))
    expect(typeof worker.fetch).toBe('function')
    const res = await worker.fetch(new Request('https://x'))
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
  })

  it('toNetlifyHandler accepts (request, context)', async () => {
    const res = await toNetlifyHandler(fakeGate(async () => paid()), () => Response.json({ ok: true }))(
      new Request('https://x'),
      { any: 'ctx' }
    )
    expect(res.status).toBe(200)
  })
})
