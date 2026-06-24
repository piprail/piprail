/**
 * Built-in framework adapters — turn a {@link PaymentGate} into a request handler for any
 * WHATWG-`fetch` runtime. There are only TWO real shapes among fetch runtimes, so there are two
 * adapters: a plain handler **function** (Next.js, Netlify, Bun, Deno, Vercel Edge, Hono, Lambda),
 * and the `{ fetch }` **export object** (Cloudflare / Service Workers). Both run the same contract:
 * read the proof header, switch on the {@link VerifyPaymentResult} `kind`, write the right status +
 * headers back out — so a merchant's route is a single call instead of a switch.
 *
 *   import { createPaywall, toFetchHandler, toWorker } from '@piprail/sdk'
 *   const gate = createPaywall({ chain: 'base', amount: '0.05', payTo: '0xYourWallet' })
 *
 *   export const GET = toFetchHandler(gate, () => Response.json({ secret: 42 }))  // Next / Netlify / Bun / Deno / Hono …
 *   export default  toWorker(gate, () => Response.json({ secret: 42 }))           // a Cloudflare Worker
 *
 * Pure + browser-safe — Web `Request`/`Response`/`Headers` only (no viem, no `node:`). Express keeps
 * its dedicated {@link requirePayment} middleware; a Node-native framework with its own `req`/`reply`
 * (Fastify, …) drives `gate.verify()` directly (see the framework-adapters docs). {@link proxyTo} is a
 * ready-made `serve` that forwards paid requests to an existing backend — gate any API, any language.
 */
import type { PaymentGate, VerifyPaymentResult } from './server.js'
import { SettlementError } from './errors.js'
import {
  HEADER_SIGNATURE,
  HEADER_SIGNATURE_V1,
  HEADER_RESPONSE,
  HEADER_RESPONSE_V1,
  HEADER_REQUIRED,
} from './x402.js'

/**
 * What to serve once a payment is verified — your protected resource, as a Web `Response`. It
 * receives the original `request` **plus whatever extra arguments the runtime passed the handler**
 * (a Cloudflare Worker's `env`/`ctx`, a Next.js route `context` with `params`, …), forwarded
 * untouched — so a protected handler can reach framework context without a second wrapper.
 */
export type Serve = (request: Request, ...rest: unknown[]) => Response | Promise<Response>

/** A JSON response with an explicit content-type — portable across every fetch runtime (no reliance
 *  on the newer `Response.json` static method, which some older runtimes lack). */
function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  })
}

/**
 * Re-wrap a served `Response` with the `payment-response` settlement headers added — a `Response`'s
 * own headers are immutable, so the only way to add a header is to reconstruct. The subtlety is
 * **`Set-Cookie`**: iterating a `Headers` object COMBINES same-name headers into one `", "`-joined
 * value, which corrupts multiple cookies (and a single cookie can legitimately contain a comma — an
 * `Expires` date). So copy every OTHER header normally, then re-append each cookie INDIVIDUALLY from
 * `getSetCookie()`. That preserves N cookies on every runtime that exposes it (Node 18.14+,
 * Cloudflare Workers, Deno, Bun); on an older runtime it falls back to the single combined value
 * (best effort — at least one cookie survives, never a crash). The body, status, and statusText pass
 * through untouched.
 */
function withSettlementHeaders(res: Response, receiptHeader: string): Response {
  const headers = new Headers()
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') headers.append(key, value) // set-cookie handled below
  })
  const src = res.headers as Headers & { getSetCookie?: () => string[] }
  const cookies =
    typeof src.getSetCookie === 'function'
      ? src.getSetCookie()
      : (() => {
          const combined = res.headers.get('set-cookie')
          return combined ? [combined] : []
        })()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  headers.set(HEADER_RESPONSE, receiptHeader)
  headers.set(HEADER_RESPONSE_V1, receiptHeader)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * The universal adapter: wrap a gate as a `fetch` handler `(request, ...rest) => Response`. Drop the
 * result into **any** runtime that hands a handler a `Request` and wants a `Response` back — Next.js
 * route handlers (`export const GET = …`), Netlify Functions, `Bun.serve({ fetch })`,
 * `Deno.serve(…)`, Vercel Edge, Hono (`(c) => handler(c.req.raw)`), an AWS Lambda Web adapter, Fastly
 * Compute. Any extra runtime arguments are forwarded to `serve` untouched.
 *
 * - **settled payment** → calls `serve`, returns its `Response` with the `payment-response` headers (v2 + v1) added;
 * - **missing / rejected proof** → a conformant `402` carrying the full challenge (so a standard x402 client can retry);
 * - **server-side settle failure** ({@link SettlementError}) → `502` — NEVER `402` (the buyer's authorization is still valid + unused).
 */
export function toFetchHandler(
  gate: PaymentGate,
  serve: Serve
): (request: Request, ...rest: unknown[]) => Promise<Response> {
  return async (request, ...rest) => {
    let result: VerifyPaymentResult
    try {
      // Accept the v2 `PAYMENT-SIGNATURE` header, falling back to the legacy v1 `X-PAYMENT` header.
      const sig =
        request.headers.get(HEADER_SIGNATURE) ?? request.headers.get(HEADER_SIGNATURE_V1) ?? undefined
      result = await gate.verify(sig)
    } catch (err) {
      if (err instanceof SettlementError) {
        return jsonResponse(
          {
            x402Version: 2,
            error: 'settlement_failed',
            detail: err.message,
            fallback:
              'The gasless `exact` settlement failed. This resource also accepts `onchain-proof` — ' +
              'retry by paying that rail yourself (you broadcast the transfer and pay the gas).',
          },
          502
        )
      }
      throw err
    }

    if (result.kind === 'paid') {
      // `gate.verify` read only the proof HEADER, never the body, so `serve` can still read a POST
      // body. `withSettlementHeaders` adds the receipt headers while preserving the served body,
      // status, and ALL headers (including multiple Set-Cookie — see its doc).
      const res = await serve(request, ...rest)
      return withSettlementHeaders(res, result.receiptHeader)
    }
    // 'challenge' | 'invalid' → a conformant 402 (full PaymentRequired so a standard client retries).
    return jsonResponse(result.challenge, 402, { [HEADER_REQUIRED]: result.requiredHeader })
  }
}

/**
 * The `{ fetch }` export object for runtimes that take one — Cloudflare Workers / Service Workers:
 * `export default toWorker(gate, serve)`. Identical behaviour to {@link toFetchHandler}; the
 * runtime's `fetch(request, env, ctx)` arguments are forwarded to `serve` (so it can read bindings /
 * `ctx.waitUntil`). (Other runtimes that take an object — `Bun.serve`, `Deno.serve` — can use either
 * this or `toFetchHandler` in their `fetch` field.)
 */
export function toWorker(
  gate: PaymentGate,
  serve: Serve
): { fetch: (request: Request, ...rest: unknown[]) => Promise<Response> } {
  return { fetch: toFetchHandler(gate, serve) }
}

/**
 * A {@link Serve} that forwards the (already-paid) request to an upstream `origin`, untouched — so you
 * can put a payment gate in FRONT of an existing API in any language, without changing it. Preserves
 * the method, path, query, body, and headers; strips the x402 proof headers so they don't leak
 * upstream. The origin NEVER sees an unpaid request — the gate rejects those before `serve` runs.
 * Compose with the adapters: `toWorker(gate, proxyTo('https://my-api.example.com'))`.
 */
export function proxyTo(origin: string): Serve {
  const base = origin.replace(/\/+$/, '')
  return (request) => {
    const inUrl = new URL(request.url)
    const target = base + inUrl.pathname + inUrl.search
    const headers = new Headers(request.headers)
    headers.delete(HEADER_SIGNATURE) // don't forward the payment proof to the origin
    headers.delete(HEADER_SIGNATURE_V1)
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: 'manual',
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
      init.duplex = 'half' // required to stream a request body through fetch
    }
    return fetch(target, init)
  }
}
