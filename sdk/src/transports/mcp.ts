/**
 * x402-over-MCP — the third official x402 transport (after HTTP and A2A), carrying PipRail's
 * EXISTING x402 envelopes over MCP **tool calls** instead of HTTP headers or A2A task metadata:
 *
 *   - a 402 challenge is an `isError` tool result with the `X402Challenge` (the spec's
 *     PaymentRequired) in `structuredContent` AND a byte-equal `content[0].text`;
 *   - the payment rides in the call's `params._meta["x402/payment"]`;
 *   - the settlement rides in the result's `_meta["x402/payment-response"]`.
 *
 * It is the conspicuous missing twin of the A2A transport. A thin re-keying of the SDK's verify
 * onto the MCP message shape — the SELLER calls the EXISTING `gate.verifyObject` (shared replay
 * set, re-derive-every-field-from-the-trusted-accept), so this transport writes NO crypto and
 * touches NO driver: every family rides it for free, exactly as over HTTP/A2A.
 *
 * PURE protocol layer (STANDARDS §1): imports only `server.ts`/`x402.ts`/`errors.ts` + the
 * duck-typed `./mcp-types.js` + the A2A error map — ZERO chain libs, ZERO `@modelcontextprotocol/sdk`.
 *
 * Scope: this ships the SELLER (`createMcpPaymentTool`) + the full pure codec + the buyer-side
 * READ/FRAME helpers (`fromMcpPaymentRequired` / `fromMcpPaymentResponse` / `buildMcpPaymentMeta`).
 * A buyer pays the challenge via the existing policy-gated client/gate machinery and frames the
 * result with `buildMcpPaymentMeta`; a fully-automatic `McpPayer` (driving the client pay path) is
 * a documented fast-follow, exactly as A2A shipped seller-first.
 */
import type { PaymentGate, RequirePaymentOptions, VerifyPaymentResult } from '../server.js'
import { createPaymentGate } from '../server.js'
import type { X402Challenge, X402Receipt, SettleOutcome } from '../x402.js'
import { SettlementError } from '../errors.js'
import { toA2AErrorCode } from './a2a.js'
import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  type McpContentBlock,
  type McpToolCallParams,
  type McpToolResult,
  type McpPaymentMeta,
} from './mcp-types.js'

// Re-export the spec key strings so `./transports/mcp.js` is the complete transport surface.
export { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY } from './mcp-types.js'

/* ----------------------------- codec (low-level, pure) ----------------------------- */

/**
 * Build the 402 challenge tool result: `isError: true` + the `X402Challenge` in
 * `structuredContent` AND a **byte-equal** `content[0].text` (`text === JSON.stringify(challenge)`
 * — the spec requires the two to match; a divergence is a silent interop break, guarded by the
 * conformance test). PipRail's `X402Challenge` IS the spec's PaymentRequired object — no transform.
 */
export function toMcpPaymentRequired(challenge: X402Challenge): McpToolResult {
  const text = JSON.stringify(challenge)
  return {
    isError: true,
    structuredContent: challenge as unknown as Record<string, unknown>,
    content: [{ type: 'text', text }],
  }
}

/**
 * Build the settled tool result: the tool's REAL output in `content` + the settlement under
 * `_meta["x402/payment-response"]`, projected to EXACTLY the spec's 4 fields
 * `{ success, transaction, network, payer }` (the richer {@link X402Receipt} is never leaked verbatim).
 */
export function toMcpPaymentResponse(content: McpContentBlock[], receipt: X402Receipt): McpToolResult {
  return {
    content,
    _meta: {
      [MCP_PAYMENT_RESPONSE_META_KEY]: {
        success: true,
        transaction: receipt.transaction,
        network: receipt.network,
        payer: receipt.payer,
      },
    },
  }
}

/**
 * Read the inbound RAW payment-payload object out of a tool call's `params._meta["x402/payment"]`.
 * The value is `{ x402Version, resource?, accepted, payload }`; `gate.verifyObject` reads
 * `accepted`/`payload` and ignores the extra `resource` sibling — so it's handed in as-is. Returns
 * `null` when there's no payment (→ the seller emits a fresh 402 challenge).
 */
export function fromMcpPayment(params: McpToolCallParams): unknown | null {
  const meta = params?._meta?.[MCP_PAYMENT_META_KEY]
  return meta == null ? null : meta
}

/**
 * Read the `X402Challenge` (PaymentRequired) back out of an `isError` tool result — the BUYER side.
 * Reads `structuredContent` first; falls back to parsing `content[0].text`. Returns `null` when the
 * result is not a 402 (a plain tool failure, or a success) so a buyer never mistakes a non-402
 * `isError` for a payment request.
 */
export function fromMcpPaymentRequired(result: McpToolResult): X402Challenge | null {
  if (!result || result.isError !== true) return null
  const sc = result.structuredContent
  if (sc && typeof sc === 'object' && typeof (sc as { x402Version?: unknown }).x402Version === 'number') {
    return sc as unknown as X402Challenge
  }
  const text = result.content?.[0]?.text
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text) as { x402Version?: unknown }
      if (parsed && typeof parsed === 'object' && typeof parsed.x402Version === 'number') {
        return parsed as unknown as X402Challenge
      }
    } catch {
      /* content[0].text is not JSON — not a 402 */
    }
  }
  return null
}

/** Is this tool result a 402 challenge (an `isError` result carrying a parseable PaymentRequired)? */
export function isMcpPaymentRequired(result: McpToolResult): boolean {
  return fromMcpPaymentRequired(result) != null
}

/**
 * Read the settlement {@link SettleOutcome} back out of a settled tool result's
 * `_meta["x402/payment-response"]` — the BUYER side. Returns `null` when absent. The buyer records
 * the spend only on `success: true` (the existing `parseSettleResponse` rule).
 */
export function fromMcpPaymentResponse(result: McpToolResult): SettleOutcome | null {
  const meta = result?._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]
  if (!meta || typeof meta !== 'object') return null
  return meta as SettleOutcome
}

/**
 * Frame an already-produced payment (the SAME `{ accepted, payload }` a PipRail buyer builds for
 * HTTP/A2A, after paying through the policy-gated client/gate machinery) into the
 * `_meta["x402/payment"]` entry to attach to the RETRY tool call's `params._meta`. Pure codec — it
 * mints no signature and grants no spend authority; the buyer signs/broadcasts via the existing
 * client, then frames the result here for the MCP carrier.
 */
export function buildMcpPaymentMeta(input: {
  accepted: unknown
  payload: unknown
  resource?: { url: string; description?: string; mimeType?: string }
  x402Version?: number
}): { 'x402/payment': McpPaymentMeta } {
  return {
    [MCP_PAYMENT_META_KEY]: {
      x402Version: input.x402Version ?? 2,
      ...(input.resource ? { resource: input.resource } : {}),
      accepted: input.accepted,
      payload: input.payload,
    },
  }
}

/* ----------------------------- the seller helper ----------------------------- */

/** Options for {@link createMcpPaymentTool}. */
export interface McpPaymentToolOptions extends Partial<RequirePaymentOptions> {
  /**
   * Pass the SAME {@link PaymentGate} the HTTP/A2A paths use → ONE shared replay set
   * (`localUsed` / injected `isUsed`/`markUsed`), so a proof settled over one transport and
   * replayed over MCP is caught once. If omitted, a fresh gate is built from the inline gate
   * config (`chain`/`token`/`amount`/`payTo`/…) on these same options.
   */
  gate?: PaymentGate
  /** Produce the tool's REAL output AFTER a verified settle — the merchant's own work. */
  fulfill: (ctx: { receipt: X402Receipt; params: McpToolCallParams }) =>
    | Promise<McpContentBlock[]>
    | McpContentBlock[]
  /** Resource URL stamped into the challenge (cosmetic; MCP tools have no inherent URL). */
  resourceUrl?: string
}

/** A paid MCP tool — turns one inbound tool call into the next tool result. */
export interface McpPaymentTool {
  /**
   * Process one inbound tool call → the next tool result:
   *   - no `_meta` payment        → `isError` + a PaymentRequired challenge
   *   - payment, verified+settled → the `fulfill` output + `_meta` payment-response
   *   - settled but `fulfill` threw → STILL a `_meta` payment-response (success) + an error note in
   *                                   content — never a re-challenge (the proof already settled; B7)
   *   - payment, rejected/malformed → `isError` + a FRESH re-challenge PaymentRequired (retry)
   *   - settle threw (relayer)     → `isError` + "settlement failed" (onchain-proof fallback noted)
   */
  handleToolCall(params: McpToolCallParams): Promise<McpToolResult>
  /** The underlying gate (the shared replay set lives here). */
  readonly gate: PaymentGate
}

/**
 * Wrap an x402 {@link PaymentGate} as a paid MCP tool — the MCP analogue of `requirePayment` /
 * `createA2APaymentHandler`. All verify/settle/replay is the gate's `verifyObject` (the same seam
 * A2A uses): the trusted-accept re-derivation, the bounded replay set, self/facilitator settlement
 * — none of it is re-implemented here. Backendless: the merchant self-verifies and self-settles.
 */
export function createMcpPaymentTool(options: McpPaymentToolOptions): McpPaymentTool {
  const gate = options.gate ?? createPaymentGate(options as RequirePaymentOptions)

  /** An `isError` result for a settlement-side failure (the merchant's relayer never moved funds). */
  function settlementFailed(code: string, detail: string): McpToolResult {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `x402 settlement failed (${toA2AErrorCode(code)}): ${detail}. ` +
            `The buyer can retry, or pay the onchain-proof rail directly.`,
        },
      ],
    }
  }

  async function handleToolCall(params: McpToolCallParams): Promise<McpToolResult> {
    const raw = fromMcpPayment(params)
    if (raw == null) {
      // No payment yet → a 402 challenge tool result.
      const { challenge } = await gate.challenge(options.resourceUrl ?? '')
      return toMcpPaymentRequired(challenge)
    }
    let result: VerifyPaymentResult
    try {
      result = await gate.verifyObject(raw)
    } catch (err) {
      // A SettlementError (the relayer/facilitator failed — not the buyer's fault) → an isError
      // result the host turns into a tool failure; any other throw bubbles to the host.
      if (err instanceof SettlementError) return settlementFailed('settlement_failed', err.message)
      throw err
    }
    if (result.kind === 'paid') {
      // B7 (at-most-once): by the time `verifyObject` returns 'paid', the gate has ALREADY committed
      // the proof to the replay set (and, on `exact`, the funds have moved). `fulfill` is the
      // merchant's OWN work and can legitimately throw (disk full, downstream 500). If it does, we
      // must STILL return a settled response carrying the success `_meta` — NEVER re-challenge or let
      // the throw escape, either of which would mislead the buyer into re-paying a proof that already
      // settled (a buyer fund-loss footgun). Mirrors the A2A handler's identical guard.
      try {
        const content = await options.fulfill({ receipt: result.receipt, params })
        return toMcpPaymentResponse(content, result.receipt)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return toMcpPaymentResponse(
          [{ type: 'text', text: `Payment settled (tx ${result.receipt.transaction}), but serving the result failed: ${detail}` }],
          result.receipt
        )
      }
    }
    // 'challenge' (no/malformed payload) OR 'invalid' (rejected) → an isError PaymentRequired the
    // buyer retries (byte-identical shape to the first challenge — exactly as HTTP/A2A re-challenge).
    return toMcpPaymentRequired(result.challenge)
  }

  return { handleToolCall, gate }
}
