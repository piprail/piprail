/**
 * Reliable receipt delivery — the durable webhook a stateless gate can't be.
 *
 * `deliverReceipt(receipt, { url, secret })` POSTs a settled {@link PaidReceipt} to
 * YOUR OWN endpoint, with retries + exponential backoff, an HMAC-SHA256 signature,
 * and an idempotency key. It is the recommended body of an `onPaid` hook when you
 * want at-least-once delivery to a webhook instead of a fire-and-forget callback:
 *
 *   createPaymentGate({
 *     chain, token, amount, payTo,
 *     awaitOnPaid: true,                                  // record before serving
 *     onPaid: (r) => deliverReceipt(r, {
 *       url: process.env.RECEIPTS_WEBHOOK,
 *       secret: process.env.RECEIPTS_SECRET,              // signs the body
 *     }),
 *   })
 *
 * Charter note: PipRail hosts nothing — `url` is **your** endpoint. This is a pure
 * transport primitive (no chain libraries), isomorphic (global `fetch` + Web Crypto),
 * and it **never throws**: failures come back as `{ delivered: false, … }`, because a
 * delivery helper that threw would reintroduce the very crash `onPaid` isolation
 * prevents. The receiver verifies the signature and dedupes on the idempotency key.
 */

import type { PaidReceipt } from './x402.js'

export interface DeliverReceiptOptions {
  /** Your receiving endpoint. PipRail hosts nothing — this is your server. */
  url: string
  /**
   * Shared secret. When set, the raw JSON body is signed HMAC-SHA256 and sent as
   * `<signatureHeader>: sha256=<hex>` so the receiver can verify authenticity. Signing uses Web
   * Crypto (`crypto.subtle`) — always present on the supported runtimes (Node ≥ 20, modern
   * browsers). On a runtime that lacks it the body is sent **unsigned, with no signature header**,
   * so a receiver must treat a *missing* signature as unauthenticated (reject it), never silently
   * accept an unsigned body.
   */
  secret?: string
  /** Extra retry attempts after the first send (default 5 → up to 6 POSTs total). */
  retries?: number
  /** Per-attempt timeout in ms (default 10000). An attempt that exceeds it is aborted + retried. */
  timeoutMs?: number
  /** Extra request headers (merged; never override the signature/idempotency headers). */
  headers?: Record<string, string>
  /** Header carrying the signature. Default `piprail-signature`. */
  signatureHeader?: string
  /** Header carrying the dedupe key (= `receipt.idempotencyKey`). Default `idempotency-key`. */
  idempotencyHeader?: string
  /** Backoff before retry N (1-based) in ms. Default jittered exponential (cap 30s). */
  backoff?: (attempt: number) => number
  /** Injected `fetch` (tests / non-global-fetch runtimes). Defaults to the global. */
  fetchImpl?: typeof fetch
  /** Observe each attempt (logging/metrics). Its own throws are ignored. */
  onAttempt?: (info: DeliverAttempt) => void
}

/** One delivery attempt's outcome (passed to `onAttempt`). */
export interface DeliverAttempt {
  /** 1-based attempt number. */
  attempt: number
  /** Did the endpoint return a 2xx? */
  ok: boolean
  /** HTTP status, when a response was received. */
  status?: number
  /** Transport/abort error message, when no response was received. */
  error?: string
  /** Will another attempt follow? */
  willRetry: boolean
}

/** The terminal result of `deliverReceipt` — it never throws, so always inspect this. */
export interface DeliverResult {
  /** True iff the endpoint returned a 2xx within the attempt budget. */
  delivered: boolean
  /** Total POSTs made (1 + retries used). */
  attempts: number
  /** Final HTTP status, when the last attempt got a response. */
  status?: number
  /** Final error, when delivery failed (last transport error or a non-2xx summary). */
  error?: string
}

const DEFAULT_RETRIES = 5
const DEFAULT_TIMEOUT_MS = 10_000

/** Jittered exponential backoff: ~0.5–1.5 × 2^(n-1) × 500ms, capped at 30s. */
function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 2 ** (attempt - 1) * 500)
  return Math.round(base * (0.5 + Math.random()))
}

/** A status is retryable if it's a 408/429 or any 5xx; other 4xx are permanent. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/** HMAC-SHA256 the body → `sha256=<hex>`. Returns null if the runtime lacks Web Crypto. */
async function signBody(secret: string, body: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const enc = new TextEncoder()
    const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    const sig = await subtle.sign('HMAC', key, enc.encode(body))
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `sha256=${hex}`
  } catch {
    return null
  }
}

/**
 * POST a settled receipt to your endpoint with retries, a timeout, an HMAC signature,
 * and an idempotency key. Never throws — returns a {@link DeliverResult}.
 */
export async function deliverReceipt(
  receipt: PaidReceipt,
  options: DeliverReceiptOptions
): Promise<DeliverResult> {
  const {
    url,
    secret,
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    signatureHeader = 'piprail-signature',
    idempotencyHeader = 'idempotency-key',
    backoff = defaultBackoff,
    fetchImpl = globalThis.fetch,
    onAttempt,
  } = options

  if (typeof fetchImpl !== 'function') {
    return { delivered: false, attempts: 0, error: 'no fetch implementation available' }
  }

  const body = JSON.stringify(receipt)
  const signature = secret ? await signBody(secret, body) : null

  // User headers first, then ours — ours always win (never let a caller clobber the
  // idempotency key or signature).
  const baseHeaders: Record<string, string> = {
    ...headers,
    'content-type': 'application/json',
    [idempotencyHeader]: receipt.idempotencyKey,
    ...(signature ? { [signatureHeader]: signature } : {}),
  }

  const maxAttempts = Math.max(1, retries + 1)
  let lastStatus: number | undefined
  let lastError: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ok = false
    let status: number | undefined
    let error: string | undefined
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: baseHeaders,
        body,
        signal: controller.signal,
      })
      status = res.status
      lastStatus = status
      ok = res.ok
      if (!ok) {
        error = `HTTP ${status}`
        lastError = error
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      lastError = error
    } finally {
      clearTimeout(timer)
    }

    // 2xx → done. A non-2xx that's permanent (most 4xx) → stop, no point retrying.
    const retryable = status === undefined ? true : isRetryableStatus(status)
    const willRetry = !ok && retryable && attempt < maxAttempts

    try {
      onAttempt?.({ attempt, ok, ...(status !== undefined ? { status } : {}), ...(error ? { error } : {}), willRetry })
    } catch {
      /* an observer must never break delivery */
    }

    if (ok) return { delivered: true, attempts: attempt, status }
    if (!willRetry) {
      return {
        delivered: false,
        attempts: attempt,
        ...(lastStatus !== undefined ? { status: lastStatus } : {}),
        ...(lastError ? { error: lastError } : {}),
      }
    }
    await sleep(backoff(attempt))
  }

  // Unreachable in practice (the loop returns), but keep the contract total.
  return {
    delivered: false,
    attempts: maxAttempts,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
    ...(lastError ? { error: lastError } : {}),
  }
}
