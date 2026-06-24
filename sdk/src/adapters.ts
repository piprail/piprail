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
 * (Fastify, …) drives `gate.verify()` directly (see the framework-adapters docs).
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
      const res = await serve(request, ...rest)
      // Copy the served response and ADD the settlement headers. A `Response`'s own headers are
      // immutable, so re-wrap (the canonical "add a header to a Response" idiom) — the body stream,
      // status, statusText, and the merchant's own headers all pass through untouched. `gate.verify`
      // read only the proof HEADER, never the body, so `serve` can still read a POST body.
      const headers = new Headers(res.headers)
      headers.set(HEADER_RESPONSE, result.receiptHeader)
      headers.set(HEADER_RESPONSE_V1, result.receiptHeader)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
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
