import { describe, it, expect, vi } from 'vitest'
import { deliverReceipt } from '../src/receipts.js'
import type { PaidReceipt } from '../src/x402.js'

const RECEIPT: PaidReceipt = {
  scheme: 'onchain-proof',
  success: true,
  network: 'eip155:56',
  transaction: `0x${'ab'.repeat(32)}`,
  asset: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
  amount: '50000',
  payer: '0xpayer',
  payTo: '0xmerchant',
  verifiedAt: '2026-06-11T00:00:00.000Z',
  decimals: 6,
  symbol: 'USDC',
  amountFormatted: '0.05',
  idempotencyKey: `0x${'ab'.repeat(32)}`,
}

const ok = (status = 200): Response => new Response('ok', { status })

/** A fetch stub that returns/throws a scripted sequence, recording every call. */
function scriptedFetch(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    if (step instanceof Error) throw step
    return step
  }) as unknown as typeof fetch
  return { impl, calls }
}

const NOW = () => 0 // no real backoff in tests

describe('deliverReceipt — happy path', () => {
  it('POSTs once and reports delivered on a 2xx', async () => {
    const { impl, calls } = scriptedFetch([ok(200)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    expect(res).toEqual({ delivered: true, attempts: 1, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string).transaction).toBe(RECEIPT.transaction)
  })

  it('sets content-type and the idempotency-key header (= the receipt key)', async () => {
    const { impl, calls } = scriptedFetch([ok()])
    await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['idempotency-key']).toBe(RECEIPT.idempotencyKey)
  })
})

describe('deliverReceipt — retries', () => {
  it('retries a 500 then succeeds', async () => {
    const { impl, calls } = scriptedFetch([ok(500), ok(200)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    expect(res.delivered).toBe(true)
    expect(res.attempts).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('retries a 429 (rate limit)', async () => {
    const { impl } = scriptedFetch([ok(429), ok(200)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    expect(res.delivered).toBe(true)
    expect(res.attempts).toBe(2)
  })

  it('retries a transport error then succeeds', async () => {
    const { impl } = scriptedFetch([new Error('ECONNRESET'), ok(200)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    expect(res.delivered).toBe(true)
    expect(res.attempts).toBe(2)
  })

  it('gives up after retries on a persistent 500, surfacing the status', async () => {
    const { impl, calls } = scriptedFetch([ok(500)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, retries: 2, backoff: NOW })
    expect(res.delivered).toBe(false)
    expect(res.attempts).toBe(3) // 1 + 2 retries
    expect(res.status).toBe(500)
    expect(calls).toHaveLength(3)
  })
})

describe('deliverReceipt — permanent failures are not retried', () => {
  it('stops immediately on a 4xx (e.g. 400 / 401)', async () => {
    const { impl, calls } = scriptedFetch([ok(400), ok(200)])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, retries: 5, backoff: NOW })
    expect(res.delivered).toBe(false)
    expect(res.attempts).toBe(1) // no retry on a permanent client error
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(1)
  })
})

describe('deliverReceipt — never throws', () => {
  it('returns a failure result even when fetch always throws', async () => {
    const { impl } = scriptedFetch([new Error('network down')])
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, retries: 1, backoff: NOW })
    expect(res.delivered).toBe(false)
    expect(res.attempts).toBe(2)
    expect(res.error).toContain('network down')
  })

  it('returns a failure (not a throw) when no fetch is available', async () => {
    // `null` survives the destructuring default (which only fills `undefined`), so it
    // reaches the `typeof fetchImpl !== 'function'` guard — the real no-fetch path.
    const res = await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: null as unknown as typeof fetch })
    expect(res.delivered).toBe(false)
    expect(res.attempts).toBe(0)
    expect(res.error).toMatch(/fetch/i)
  })
})

describe('deliverReceipt — HMAC signature', () => {
  it('signs the body when a secret is set, and the signature verifies', async () => {
    const { impl, calls } = scriptedFetch([ok()])
    const secret = 'shhh-super-secret'
    await deliverReceipt(RECEIPT, { url: 'https://hook.test', secret, fetchImpl: impl, backoff: NOW })
    const headers = calls[0]!.init.headers as Record<string, string>
    const sig = headers['piprail-signature']
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)

    // Recompute HMAC-SHA256 over the exact body and compare.
    const body = calls[0]!.init.body as string
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body))
    const expected =
      'sha256=' + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(sig).toBe(expected)
  })

  it('omits the signature header when no secret is given', async () => {
    const { impl, calls } = scriptedFetch([ok()])
    await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['piprail-signature']).toBeUndefined()
  })
})

describe('deliverReceipt — headers + observability', () => {
  it('merges custom headers but never lets them clobber idempotency / signature', async () => {
    const { impl, calls } = scriptedFetch([ok()])
    await deliverReceipt(RECEIPT, {
      url: 'https://hook.test',
      secret: 's',
      fetchImpl: impl,
      backoff: NOW,
      headers: { 'x-custom': 'yes', 'idempotency-key': 'HACKED', 'piprail-signature': 'HACKED' },
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-custom']).toBe('yes')
    expect(headers['idempotency-key']).toBe(RECEIPT.idempotencyKey) // ours wins
    expect(headers['piprail-signature']).not.toBe('HACKED') // ours wins
  })

  it('calls onAttempt for every attempt with willRetry flags', async () => {
    const onAttempt = vi.fn()
    const { impl } = scriptedFetch([ok(500), ok(200)])
    await deliverReceipt(RECEIPT, { url: 'https://hook.test', fetchImpl: impl, backoff: NOW, onAttempt })
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ attempt: 1, ok: false, status: 500, willRetry: true })
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({ attempt: 2, ok: true, status: 200, willRetry: false })
  })
})

describe('deliverReceipt — timeout', () => {
  it('aborts a hung attempt and retries it', async () => {
    let aborted = false
    // First call: never resolves, but rejects when the timeout aborts the signal.
    // Second call: succeeds.
    let n = 0
    const impl = vi.fn((_url: string, init: RequestInit) => {
      n++
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      return Promise.resolve(ok(200))
    }) as unknown as typeof fetch

    const res = await deliverReceipt(RECEIPT, {
      url: 'https://hook.test',
      fetchImpl: impl,
      timeoutMs: 10,
      backoff: NOW,
    })
    expect(aborted).toBe(true)
    expect(res.delivered).toBe(true)
    expect(res.attempts).toBe(2)
  })
})
