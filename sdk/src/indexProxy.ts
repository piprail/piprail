/**
 * The one-line forwarder that makes `discover()` work in a browser.
 *
 * ## Why anything is needed at all
 *
 * The open x402 indexes send no usable CORS header. 402 Index and CDP Bazaar send none;
 * Circle sends `Access-Control-Allow-Origin` twice (`'*, *'`), which browsers reject. CORS is
 * enforced by the BROWSER, so this is not something a library can shape its way around: a page
 * cannot read those catalogues directly, and no option, header or request mode changes that.
 *
 * Server-side there is no problem and never was. Node, an MCP server, a worker, an agent
 * framework: `discover()` reads the indexes directly with zero configuration. This file is
 * only for the case where your code runs in someone's browser.
 *
 * ## Using it
 *
 * Mount the handler on any route your app already serves, then do nothing on the client:
 *
 * ```ts
 * // Any Request → Response runtime: Netlify, Cloudflare, Deno, Bun, Hono, Next route handler…
 * import { indexProxyHandler, INDEX_PROXY_PATH } from '@piprail/sdk'
 * export default indexProxyHandler()
 * export const config = { path: INDEX_PROXY_PATH }   // '/api/x402-index'
 * ```
 *
 * The browser client finds it on its own: it probes that conventional path once, uses it if
 * something answers, and reads the indexes directly if nothing does. There is no client
 * option to set, and nothing to remember.
 *
 * Serve it somewhere else, or want it explicit? Pass your own transport instead:
 *
 * ```ts
 * new PipRailClient({
 *   chain: 'base',
 *   fetchImpl: (url, init) => fetch(`/my/route?url=${encodeURIComponent(String(url))}`, init),
 * })
 * ```
 *
 * ## What it deliberately is not
 *
 * PipRail hosts none of this and the SDK never calls a PipRail server. It would have been
 * easier to point the default at a proxy we run, and that is exactly the shape this project
 * exists to avoid: it would put us in the path of every user's searches, and make a rail that
 * works without us depend on us. You run the forwarder, or you run server-side and need none.
 */

/** The hosts a forwarder will talk to. An open forwarder becomes someone else's abuse problem,
 *  so this is a fixed allowlist of the indexes the SDK actually reads. */
export const INDEX_PROXY_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'api.cdp.coinbase.com',
  'api.circle.com',
  '402index.io',
  'www.x402scan.com',
])

export interface IndexProxyOptions {
  /**
   * Extra hosts this forwarder may reach, beyond {@link INDEX_PROXY_ALLOWED_HOSTS}. Only add a
   * host you are willing to let any visitor make GET requests to through your origin.
   */
  allowHosts?: readonly string[]
  /** Upstream timeout in ms. Default 15000. */
  timeoutMs?: number
  /** `cache-control` on a successful response. Default a short shared cache. */
  cacheControl?: string
}

const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
})

const problem = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })

/**
 * Build a `(Request) => Promise<Response>` handler that forwards ONE index read.
 *
 * Read-only and deliberately boring: GET only, a fixed host allowlist, no credentials, no
 * request body, and the upstream status passed through unchanged so a dead index still reads
 * as dead rather than as "nothing matched".
 */
export function indexProxyHandler(
  options: IndexProxyOptions = {}
): (request: Request) => Promise<Response> {
  const allowed = new Set<string>([...INDEX_PROXY_ALLOWED_HOSTS, ...(options.allowHosts ?? [])])
  const timeoutMs = options.timeoutMs ?? 15_000
  const cacheControl = options.cacheControl ?? 'public, max-age=60, s-maxage=300'

  return async function handleIndexProxy(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (request.method !== 'GET') return problem(405, { error: 'method_not_allowed' })

    const target = new URL(request.url).searchParams.get('url')
    // No `url` is how the SDK's probe asks "is a forwarder here?" — 400 answers yes, and a
    // static host with no handler answers 404. Keep the distinction.
    if (!target) {
      return problem(400, {
        error: 'missing_url',
        detail: 'Pass ?url=<index endpoint>. This route forwards x402 index reads.',
        allowed: [...allowed],
      })
    }

    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return problem(400, { error: 'bad_url' })
    }
    // https only, and an exact host match: a prefix test would accept `api.circle.com.evil.test`.
    if (parsed.protocol !== 'https:') return problem(400, { error: 'https_only' })
    if (!allowed.has(parsed.hostname)) {
      return problem(403, { error: 'host_not_allowed', allowed: [...allowed] })
    }

    try {
      const upstream = await fetch(parsed.toString(), {
        headers: { accept: 'application/json', 'user-agent': '@piprail/sdk (+https://piprail.com)' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await upstream.text()
      return new Response(body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': cacheControl,
          ...CORS_HEADERS,
        },
      })
    } catch (err) {
      return problem(502, {
        error: 'upstream_unreachable',
        detail: String(err instanceof Error ? err.message : err),
      })
    }
  }
}
