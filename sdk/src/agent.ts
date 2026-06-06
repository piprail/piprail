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
import type { PipRailClient, DiscoverOptions, RegisterOptions } from './client.js'

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
 * Five tools wrapping a configured {@link PipRailClient}:
 *   - `piprail_discover(query?)` — FIND payable resources on the open x402
 *     indexes, WITHOUT paying (the phone book — solves "what can I buy?").
 *   - `piprail_quote_payment(url)` — price a gated URL WITHOUT paying.
 *   - `piprail_plan_payment(url)` — check you CAN pay (balance + gas + recipient
 *     readiness) across every rail the URL offers, WITHOUT paying.
 *   - `piprail_pay_request(url, method?, body?)` — pay if needed and return the result.
 *   - `piprail_register(url, …)` — LIST a resource you run on the open indexes so
 *     other agents can find it (402 Index, no signature).
 *
 * A policy/approval refusal comes back as a structured `{ declined: true, reason }`
 * (not a thrown error), so the model can reason about it instead of crashing.
 */
export function paymentTools(client: PipRailClient): AgentTool[] {
  return [
    {
      name: 'piprail_discover',
      description:
        'Find x402 payment-gated resources on the OPEN indexes (a phone book of payable APIs) WITHOUT ' +
        'paying. Use it to answer "what can I buy?" — search by topic, then quote/plan/pay a chosen one. ' +
        "By default returns only resources payable on your wallet's chain (network='self'); pass 'any' " +
        'for every chain. Results are cross-scheme: ALWAYS call piprail_quote_payment on a chosen ' +
        'resource (it re-checks the live price) before piprail_pay_request.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text topic to search for (optional).' },
          network: {
            type: 'string',
            description: "CAIP-2 id, 'self' (your chain — default), or 'any' (all chains).",
          },
          maxPrice: { type: 'number', description: 'Drop results advertised above this USD price.' },
          limit: { type: 'number', description: 'Max results per index (default 20).' },
        },
        additionalProperties: false,
      },
      invoke: async (args) => {
        const opts: DiscoverOptions = {}
        if (typeof args.query === 'string') opts.query = args.query
        if (typeof args.network === 'string') opts.network = args.network
        if (typeof args.maxPrice === 'number') opts.maxPrice = args.maxPrice
        if (typeof args.limit === 'number') opts.limit = args.limit
        const found = await client.discover(opts)
        return {
          count: found.length,
          resources: found.map((r) => ({
            resource: r.resource,
            name: r.name,
            description: r.description,
            source: r.source,
            priceUsd: r.priceUsd,
            networks: [...new Set(r.rails.map((rail) => rail.network))],
          })),
        }
      },
    },
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
      name: 'piprail_plan_payment',
      description:
        'Check whether you CAN pay an x402-gated URL before paying. Reads your wallet balance, native ' +
        'gas, and whether the recipient can receive — across every rail the URL offers on your chain — ' +
        'and returns { gated, payable, best, options, fundingHint }. payable:false means do NOT attempt ' +
        'the payment; fundingHint says exactly what to top up. Call this before piprail_pay_request so ' +
        'you never commit to a payment you cannot finish. Returns { gated: false } when no payment is needed.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the gated resource.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const plan = await client.planPayment(String(args.url))
        if (plan == null) return { gated: false, url: String(args.url) }
        return {
          gated: true,
          payable: plan.payable,
          status: plan.status,
          fundingHint: plan.fundingHint,
          best: plan.best
            ? {
                network: plan.best.accept.network,
                symbol: plan.best.quote.symbol,
                amount: plan.best.quote.amountFormatted,
                gasCoin: plan.best.cost.feeSymbol,
                gas: plan.best.cost.feeFormatted,
              }
            : null,
          options: plan.options.map((o) => ({
            network: o.accept.network,
            symbol: o.quote.symbol,
            amount: o.quote.amountFormatted,
            state: o.state,
            blockers: o.blockers,
            warnings: o.warnings,
            recipientReady: o.recipient.ready,
          })),
        }
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
    {
      name: 'piprail_register',
      description:
        'List an x402 payment-gated resource YOU run on the open indexes so other agents can discover it. ' +
        'Default target is 402 Index — no auth, no signature, no payment; searchable within seconds. ' +
        'Returns one outcome per index ({ source, ok, detail }); a step the chain can\'t satisfy comes ' +
        'back ok:false with the reason. Moves no funds; nothing is PipRail-hosted.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the resource to list.' },
          name: { type: 'string', description: 'Display name (defaults to the host).' },
          description: { type: 'string', description: 'What the resource offers.' },
          priceUsd: { type: 'number', description: 'Advertised price in USD (metadata).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const opts: RegisterOptions = {}
        if (typeof args.name === 'string') opts.name = args.name
        if (typeof args.description === 'string') opts.description = args.description
        if (typeof args.priceUsd === 'number') opts.priceUsd = args.priceUsd
        const outcomes = await client.register(String(args.url), opts)
        return { outcomes }
      },
    },
  ]
}
