/**
 * Minimal, DUCK-TYPED MCP message shapes — the structural surface the PipRail MCP transport
 * reads/writes, and NOTHING more. Like `a2a-types.ts`, these declare only the fields the adapter
 * touches, so any MCP runtime's objects (the `@modelcontextprotocol/sdk` low-level `Server`, a
 * hand-rolled tool handler) satisfy them structurally — **with ZERO `@modelcontextprotocol/sdk`
 * dependency** (the SDK transport stays chain- AND runtime-agnostic; the `@piprail/mcp` wiring may
 * use the real MCP types).
 *
 * x402-over-MCP carries PipRail's EXISTING `X402Challenge` / PaymentPayload / `SettleOutcome`
 * envelopes over MCP **tool calls**: a 402 challenge as an `isError` tool result (the
 * PaymentRequired in `structuredContent` AND a byte-equal `content[0].text`), the payment under
 * the call's `params._meta["x402/payment"]`, the settlement under the result's
 * `_meta["x402/payment-response"]`. Verified against the x402-foundation
 * `specs/transports-v2/mcp.md` binding.
 */
import type { SettleOutcome } from '../x402.js'

/** The `_meta` key strings — EXACTLY as the spec defines them (a SLASH, not a dot — distinct from
 *  A2A's `x402.payment.*` dotted keys). Exported so the conformance test pins them. */
export const MCP_PAYMENT_META_KEY = 'x402/payment'
export const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response'

/** A single MCP content block (only the text block the binding uses). */
export interface McpContentBlock {
  type: 'text' | string
  text?: string
  [extra: string]: unknown
}

/** An inbound tool-call's params — only the fields the seller reads. `_meta["x402/payment"]`
 *  carries the raw PaymentPayload object (fed straight to `gate.verifyObject`). */
export interface McpToolCallParams {
  name?: string
  arguments?: Record<string, unknown>
  _meta?: { 'x402/payment'?: unknown; [extra: string]: unknown }
  [extra: string]: unknown
}

/** A tool result — the seller produces it; the buyer reads it. The 402 challenge is an `isError`
 *  result with `structuredContent` + a byte-equal `content[0].text`; a settlement carries
 *  `_meta["x402/payment-response"]`. */
export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
  _meta?: { 'x402/payment-response'?: SettleOutcome; [extra: string]: unknown }
  [extra: string]: unknown
}

/** The PaymentPayload value carried under `params._meta["x402/payment"]` (raw JSON, not base64) —
 *  `{ x402Version, resource?, accepted, payload }`, where `accepted` is the chosen `accepts[]`
 *  entry and `payload` is the scheme payload (both consumed by `gate.verifyObject`). */
export interface McpPaymentMeta {
  x402Version: number
  resource?: { url: string; description?: string; mimeType?: string }
  accepted: unknown
  payload: unknown
}
