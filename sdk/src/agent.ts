/**
 * Agent toolkit — hand an LLM the ability to quote and pay, with the client's
 * spend policy already baked in. Framework-agnostic and ZERO-dependency: this
 * ships plain tool *descriptors* (name + description + JSON Schema + invoke),
 * which adapt to MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling, or
 * LangChain in a couple of lines (see examples/agent-tools.mjs).
 *
 * The model can't bypass the budget — `policy` / `onBeforePay` live on the
 * PipRailClient these tools wrap, so every payment goes through the same guard.
 */
import { parseReceipt } from './x402.js'
import { PaymentDeclinedError } from './errors.js'
import type { PipRailClient } from './client.js'

/** A framework-agnostic tool definition an agent runtime can register. */
export interface AgentTool {
  /** Unique tool name (snake_case, namespaced `piprail_…`). */
  name: string
  /** What the tool does — written for an LLM to read. */
  description: string
  /** JSON Schema (draft-07 object) describing the arguments. */
  parameters: Record<string, unknown>
  /** Execute the tool. Returns a JSON-serialisable result. */
  invoke: (args: Record<string, unknown>) => Promise<unknown>
}

/** Read a Response body as JSON when possible, else as text. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Two tools wrapping a configured {@link PipRailClient}:
 *   - `piprail_quote_payment(url)` — price a gated URL WITHOUT paying.
 *   - `piprail_pay_request(url, method?, body?)` — pay if needed and return the result.
 *
 * A policy/approval refusal comes back as a structured `{ declined: true, reason }`
 * (not a thrown error), so the model can reason about it instead of crashing.
 */
export function paymentTools(client: PipRailClient): AgentTool[] {
  return [
    {
      name: 'piprail_quote_payment',
      description:
        'Get the price of an x402 payment-gated URL WITHOUT paying. Returns the amount, ' +
        'token, chain, recipient, and whether it is within the spend policy. Returns ' +
        '{ gated: false } when the URL needs no payment. Call this first to decide whether ' +
        'a resource is worth buying.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the gated resource.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const quote = await client.quote(String(args.url))
        return quote ? { gated: true, ...quote } : { gated: false, url: String(args.url) }
      },
    },
    {
      name: 'piprail_pay_request',
      description:
        'Fetch an x402 payment-gated URL, automatically paying the required on-chain ' +
        'payment if needed (subject to the spend policy + approval hook). Returns the HTTP ' +
        'status, the response body, and a payment receipt if one settled. If the payment is ' +
        'refused by policy or the approval hook, returns { declined: true, reason } — no funds moved.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch.' },
          method: { type: 'string', description: "HTTP method, default 'GET'." },
          body: {
            type: ['object', 'string'],
            description: 'Optional request body for POST/PUT (a JSON object or a string).',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const url = String(args.url)
        const method = (args.method ? String(args.method) : 'GET').toUpperCase()
        try {
          let res: Response
          if (method === 'GET') {
            res = await client.get(url)
          } else {
            // Serialise the body (object → JSON) so it's replayable through the 402 flow.
            const headers: Record<string, string> = {}
            let body: string | undefined
            if (args.body !== undefined && args.body !== null) {
              if (typeof args.body === 'string') {
                body = args.body
              } else {
                body = JSON.stringify(args.body)
                headers['content-type'] = 'application/json'
              }
            }
            res = await client.fetch(url, { method, headers, body })
          }
          return {
            status: res.status,
            ok: res.ok,
            body: await readBody(res),
            receipt: parseReceipt(res),
          }
        } catch (err) {
          if (err instanceof PaymentDeclinedError) {
            return { declined: true, reason: err.message }
          }
          throw err
        }
      },
    },
  ]
}
