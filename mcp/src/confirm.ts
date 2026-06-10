/**
 * Ask-before-pay (Mode B) — wire the SDK's existing `onBeforePay` hook to the MCP
 * `server.elicitInput()` so a SUPERVISED client (Claude Desktop / Cursor) is asked
 * to approve each fund-moving payment at the exact moment of spend.
 *
 * PURE module: no `process.env`, no SDK client, no logging of the quote. The whole
 * feature is one `onBeforePay` implementation + a secret-free form builder.
 *
 * FAIL-SAFE: decline, cancel, timeout, a transport drop, a validation error, or
 * ANY `elicitInput` throw all map to `false` (do not pay). Only an explicit
 * `{ action:'accept', content:{ approve:true } }` authorises. A client that can't
 * elicit silently degrades to Mode A (policy-only) — it is never blocked.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js' // TYPE-only, from the public Zod-inferred barrel
import type { PipRailQuote } from '@piprail/sdk'

/**
 * Default elicitation round-trip timeout. MUST stay BELOW the MCP client's CallTool
 * timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`) so the inner elicitation times
 * out FIRST and the decline reaches the agent as a clean `PaymentDeclinedError`,
 * not an opaque transport error. For longer human-deliberation windows the operator
 * must ALSO raise their MCP client's request timeout (client-side config).
 */
export const CONFIRM_TIMEOUT_MS = 55_000

/** Host-only — never the full URL (it can carry query params / secrets). */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * A pure, NON-SENSITIVE confirmation form built from the quote's own non-secret
 * fields. An unverified / symbol-mismatched token is FLAGGED (and shown by its
 * on-chain asset id, not a server-claimed symbol) — Mode B exists for exactly that
 * human vigilance. No wallet key, no RPC URL, no full URL.
 */
export function buildConfirmRequest(quote: PipRailQuote): ElicitRequestFormParams {
  const unverified = quote.recognized === false || quote.symbolMismatch === true
  const token = unverified ? quote.asset : (quote.symbol ?? quote.asset)
  const warn = unverified
    ? ' ⚠ UNVERIFIED token — the server claims this symbol; the SDK could not confirm it.'
    : ''
  const message =
    `Approve paying ${quote.amountFormatted} ${token} to ${hostOf(quote.url)} on ${quote.network}?${warn}`
  return {
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: 'Approve this payment',
          description:
            'Check to pay now; leave unchecked / decline to refuse. No funds move unless you approve.',
        },
      },
      required: ['approve'],
    },
  }
}

/**
 * The `onBeforePay` implementation, MCP-side. `getServer` is a GETTER so it
 * resolves the late-bound `Server` lazily at pay-time (the hook is on
 * `clientOptions` BEFORE the `Server` exists). Returns `Promise<boolean>` — a
 * valid `onBeforePay`. Capability-detects the granular `.elicitation.form` subkey
 * at pay-time (it's `undefined` until after `server.connect`), degrading silently
 * to Mode A when absent.
 */
export function buildConfirmHook(
  getServer: () => Server,
  timeoutMs: number = CONFIRM_TIMEOUT_MS
): (quote: PipRailQuote) => Promise<boolean> {
  return async (quote: PipRailQuote): Promise<boolean> => {
    const server = getServer()
    // Lazy capability-detect. The SDK already ran + passed its policy gate before
    // calling onBeforePay, so `true` here means "no extra confirmation", NOT
    // "bypass the budget". A client advertising only `.elicitation.url` (or none)
    // must degrade to Mode A, never throw.
    const caps = server.getClientCapabilities()
    if (!caps?.elicitation?.form) return true
    let res: ElicitResult
    try {
      res = await server.elicitInput(buildConfirmRequest(quote), { timeout: timeoutMs })
    } catch (err) {
      // Decline / cancel are returned, not thrown; this catches the non-decisions —
      // timeout, transport drop, validation error — and fails SAFE to not-pay. The
      // SDK's PaymentDeclinedError stays the contract; this stderr line is a
      // non-secret operator diagnostic so a confused approve→decline is debuggable.
      console.error(
        `[piprail] payment confirmation failed (treating as decline): ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
    return res.action === 'accept' && res.content?.approve === true
  }
}
