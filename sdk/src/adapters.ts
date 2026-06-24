/**
 * Built-in framework adapters — the one-liner that turns a {@link PaymentGate} into a request
 * handler for any `fetch`-based runtime (Cloudflare Workers, Next.js route handlers, Netlify
 * Functions, Bun, Deno, Hono). They hand-roll, once, the three things every adapter does: read the
 * inbound proof header, switch on the {@link VerifyPaymentResult} `kind`, and write the right
 * status + headers back out — so a merchant's route is a single call instead of a switch.
 *
 *   import { createPaywall, toWorker } from '@piprail/sdk'
 *   const gate = createPaywall({ chain: 'base', amount: '0.05', payTo: '0xYourWallet' })
 *   export default toWorker(gate, () => Response.json({ secret: 42 }))   // a Cloudflare Worker
 *
 * Pure + browser-safe — Web `Request`/`Response`/`Headers` only (no viem, no `node:`). The Express
 * case keeps its dedicated {@link requirePayment} middleware.
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

/** What to serve once a payment is verified — your protected resource, as a Web `Response`. */
export type Serve = (request: Request) => Response | Promise<Response>

/**
 * Wrap a gate as a Fetch handler `(request) => Response`. On a settled payment it calls `serve`
 * and stamps the settlement headers (v2 + v1); on a missing/rejected proof it returns a conformant
 * `402` carrying the full challenge (so a standard x402 client can retry); on a server-side settle
 * failure (a {@link SettlementError} from a relayer/facilitator) it returns `502` — never a `402`,
 * which would wrongly tell the buyer to re-pay (their signed authorization stays valid + unused).
 */
export function toFetchHandler(
  gate: PaymentGate,
  serve: Serve
): (request: Request) => Promise<Response> {
  return async (request) => {
    let result: VerifyPaymentResult
    try {
      // Accept the v2 `PAYMENT-SIGNATURE` header OR the legacy v1 `X-PAYMENT` header.
      const sig =
        request.headers.get(HEADER_SIGNATURE) ?? request.headers.get(HEADER_SIGNATURE_V1) ?? undefined
      result = await gate.verify(sig)
    } catch (err) {
      if (err instanceof SettlementError) {
        return Response.json(
          {
            x402Version: 2,
            error: 'settlement_failed',
            detail: err.message,
            fallback:
              'The gasless `exact` settlement failed. This resource also accepts `onchain-proof` — ' +
              'retry by paying that rail yourself (you broadcast the transfer and pay the gas).',
          },
          { status: 502 }
        )
      }
      throw err
    }

    if (result.kind === 'paid') {
      const res = await serve(request)
      // Clone to attach the settlement headers (a returned Response's headers may be immutable).
      const headers = new Headers(res.headers)
      headers.set(HEADER_RESPONSE, result.receiptHeader)
      headers.set(HEADER_RESPONSE_V1, result.receiptHeader)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    // 'challenge' | 'invalid' → a conformant 402 (full PaymentRequired so a standard client retries).
    return Response.json(result.challenge, {
      status: 402,
      headers: { [HEADER_REQUIRED]: result.requiredHeader },
    })
  }
}

/** Next.js App Router — a route handler IS a Fetch handler: `export const GET = toNextRoute(gate, serve)`. */
export function toNextRoute(
  gate: PaymentGate,
  serve: Serve
): (request: Request) => Promise<Response> {
  return toFetchHandler(gate, serve)
}

/** Cloudflare Workers — an `ExportedHandler` with a `fetch` method: `export default toWorker(gate, serve)`. */
export function toWorker(
  gate: PaymentGate,
  serve: Serve
): { fetch: (request: Request) => Promise<Response> } {
  const handler = toFetchHandler(gate, serve)
  return { fetch: (request) => handler(request) }
}

/** Netlify Functions (Web-API style) — `(request, context) => Response`: `export default toNetlifyHandler(gate, serve)`. */
export function toNetlifyHandler(
  gate: PaymentGate,
  serve: Serve
): (request: Request, context?: unknown) => Promise<Response> {
  const handler = toFetchHandler(gate, serve)
  return (request) => handler(request)
}
