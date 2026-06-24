import { describe, it, expect } from 'vitest'
import {
  toFetchHandler,
  toWorker,
  SettlementError,
  HEADER_SIGNATURE,
  HEADER_SIGNATURE_V1,
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

describe('toFetchHandler — the contract', () => {
  it('paid → 200, serves the body, stamps the v2 + v1 settlement headers', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () => Response.json({ secret: 42 }))
    const res = await handler(new Request('https://x', { headers: { [HEADER_SIGNATURE]: 'sig' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
    expect(res.headers.get(HEADER_RESPONSE_V1)).toBe('RCPT')
    expect(await res.json()).toEqual({ secret: 42 })
  })

  it('challenge → 402 + PAYMENT-REQUIRED + JSON content-type + the challenge body, serve NOT called', async () => {
    let served = false
    const handler = toFetchHandler(fakeGate(async () => challenge('REQ')), () => {
      served = true
      return new Response('x')
    })
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_REQUIRED)).toBe('REQ')
    expect(res.headers.get('content-type')).toContain('application/json')
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
    const res = await toFetchHandler(fakeGate(async () => result), () => new Response('x'))(
      new Request('https://x')
    )
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_REQUIRED)).toBe('REQ2')
  })
})

describe('toFetchHandler — adversarial / edge cases', () => {
  it('preserves the served status, statusText, and the merchant’s own headers', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () =>
      new Response('hi', {
        status: 201,
        statusText: 'Created',
        headers: { 'x-custom': 'yes', 'content-type': 'text/plain' },
      })
    )
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(201)
    expect(res.headers.get('x-custom')).toBe('yes')
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
    expect(await res.text()).toBe('hi')
  })

  it('handles a null-body (204) served response without crashing', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () => new Response(null, { status: 204 }))
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(204)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
  })

  it('does NOT consume the request body — serve can still read a POST body', async () => {
    let seen: unknown
    const handler = toFetchHandler(fakeGate(async () => paid()), async (req) => {
      seen = await req.json()
      return new Response('ok')
    })
    await handler(
      new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ a: 1 }),
        headers: { 'content-type': 'application/json' },
      })
    )
    expect(seen).toEqual({ a: 1 })
  })

  it('a binary body passes through byte-identical', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const handler = toFetchHandler(fakeGate(async () => paid()), () => new Response(bytes))
    const res = await handler(new Request('https://x'))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it('forwards extra runtime args to serve (Next ctx / Netlify context)', async () => {
    let rest: unknown[] = []
    const handler = toFetchHandler(fakeGate(async () => paid()), (_req, ...r) => {
      rest = r
      return new Response('ok')
    })
    await handler(new Request('https://x'), { params: { id: '7' } }, 'EXTRA')
    expect(rest).toEqual([{ params: { id: '7' } }, 'EXTRA'])
  })

  it('reads the v1 X-PAYMENT header when the v2 header is absent', async () => {
    let seen: unknown
    const handler = toFetchHandler(
      fakeGate(async (h) => {
        seen = h
        return challenge()
      }),
      () => new Response('ok')
    )
    await handler(new Request('https://x', { headers: { [HEADER_SIGNATURE_V1]: 'v1-proof' } }))
    expect(seen).toBe('v1-proof')
  })

  it('prefers the v2 header over v1 when both are present', async () => {
    let seen: unknown
    const handler = toFetchHandler(
      fakeGate(async (h) => {
        seen = h
        return challenge()
      }),
      () => new Response('ok')
    )
    await handler(new Request('https://x', { headers: { [HEADER_SIGNATURE]: 'v2', [HEADER_SIGNATURE_V1]: 'v1' } }))
    expect(seen).toBe('v2')
  })

  it('no proof header → gate.verify receives undefined (→ challenge)', async () => {
    let seen: unknown = 'unset'
    const handler = toFetchHandler(
      fakeGate(async (h) => {
        seen = h
        return challenge()
      }),
      () => new Response('ok')
    )
    await handler(new Request('https://x'))
    expect(seen).toBeUndefined()
  })

  it('SettlementError → 502 JSON (never a 402), serve NOT called', async () => {
    let served = false
    const handler = toFetchHandler(
      fakeGate(async () => {
        throw new SettlementError('relayer out of gas')
      }),
      () => {
        served = true
        return new Response('x')
      }
    )
    const res = await handler(new Request('https://x'))
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('settlement_failed')
    expect(body.detail).toContain('relayer out of gas')
    expect(served).toBe(false)
  })

  it('a non-SettlementError from verify propagates (a real bug, not swallowed)', async () => {
    const handler = toFetchHandler(
      fakeGate(async () => {
        throw new TypeError('boom')
      }),
      () => new Response('x')
    )
    await expect(handler(new Request('https://x'))).rejects.toThrow('boom')
  })

  it('awaits an async serve', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), async () => {
      await Promise.resolve()
      return new Response('late')
    })
    expect(await (await handler(new Request('https://x'))).text()).toBe('late')
  })
})

describe('toWorker — the { fetch } export object', () => {
  it('exposes { fetch } and behaves like toFetchHandler', async () => {
    const worker = toWorker(fakeGate(async () => paid()), () => new Response('ok'))
    expect(typeof worker.fetch).toBe('function')
    const res = await worker.fetch(new Request('https://x'))
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
  })

  it('forwards the Worker (request, env, ctx) args to serve', async () => {
    let env: unknown
    let ctx: unknown
    const worker = toWorker(fakeGate(async () => paid()), (_req, e, c) => {
      env = e
      ctx = c
      return new Response('ok')
    })
    await worker.fetch(new Request('https://x'), { KV: 1 }, { waitUntil() {} })
    expect(env).toEqual({ KV: 1 })
    expect(ctx).toMatchObject({})
  })

  it('a SettlementError through the worker → 502', async () => {
    const worker = toWorker(
      fakeGate(async () => {
        throw new SettlementError('down')
      }),
      () => new Response('x')
    )
    const res = await worker.fetch(new Request('https://x'))
    expect(res.status).toBe(502)
  })
})
