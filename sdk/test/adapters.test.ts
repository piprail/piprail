import { describe, it, expect } from 'vitest'
import {
  toFetchHandler,
  toWorker,
  proxyTo,
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

  it('preserves MULTIPLE Set-Cookie headers (not comma-combined) alongside the settlement header', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () => {
      const h = new Headers()
      h.append('set-cookie', 'a=1; Path=/; HttpOnly')
      // A cookie whose Expires value contains a COMMA — the exact case naive ", " splitting breaks.
      h.append('set-cookie', 'b=2; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT')
      return new Response('ok', { headers: h })
    })
    const res = await handler(new Request('https://x'))
    expect(res.headers.getSetCookie()).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT',
    ])
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
  })

  it('preserves a single Set-Cookie next to other headers', async () => {
    const handler = toFetchHandler(fakeGate(async () => paid()), () =>
      new Response('ok', { headers: { 'set-cookie': 'session=abc; Path=/', 'x-custom': 'y' } })
    )
    const res = await handler(new Request('https://x'))
    expect(res.headers.getSetCookie()).toEqual(['session=abc; Path=/'])
    expect(res.headers.get('x-custom')).toBe('y')
    expect(res.headers.get(HEADER_RESPONSE)).toBe('RCPT')
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

describe('proxyTo — gate any existing backend', () => {
  it('forwards method, path, query, and app headers to the origin; strips the proof headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('origin-body', { status: 200, headers: { 'x-origin': '1' } })
    }) as unknown as typeof fetch
    try {
      const serve = proxyTo('https://origin.example.com/') // trailing slash trimmed
      const req = new Request('https://proxy.example.com/v1/data?q=7', {
        method: 'POST',
        body: 'payload',
        headers: { [HEADER_SIGNATURE]: 'PROOF', 'content-type': 'text/plain', 'x-app': 'a' },
      })
      const res = await serve(req)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe('https://origin.example.com/v1/data?q=7')
      expect(calls[0]!.init.method).toBe('POST')
      const fwd = calls[0]!.init.headers as Headers
      expect(fwd.get(HEADER_SIGNATURE)).toBeNull() // proof stripped, not leaked upstream
      expect(fwd.get('x-app')).toBe('a') // app header forwarded faithfully
      expect(await res.text()).toBe('origin-body')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('end-to-end via toFetchHandler: unpaid → 402 and the origin is NEVER called; paid → forwarded + receipt header', async () => {
    let originCalls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      originCalls++
      return new Response('the secret', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const unpaid = toFetchHandler(fakeGate(async () => challenge()), proxyTo('https://origin'))
      const r1 = await unpaid(new Request('https://x/data'))
      expect(r1.status).toBe(402)
      expect(originCalls).toBe(0) // the origin never sees an unpaid request

      const paidH = toFetchHandler(fakeGate(async () => paid()), proxyTo('https://origin'))
      const r2 = await paidH(new Request('https://x/data'))
      expect(r2.status).toBe(200)
      expect(await r2.text()).toBe('the secret')
      expect(r2.headers.get(HEADER_RESPONSE)).toBe('RCPT')
      expect(originCalls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
