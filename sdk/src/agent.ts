/**
 * Agent toolkit — hand an LLM the ability to quote and pay, with the client's
 * spend policy already baked in. Framework-agnostic and ZERO-dependency: this
 * ships plain tool *descriptors* (name + description + JSON Schema + invoke),
 * which adapt to MCP, the Vercel AI SDK, OpenAI/Anthropic function-calling, or
 * LangChain in a couple of lines (see examples/agent-tools.mjs).
 *
 * The model can't bypass the budget — `policy` / `onBeforePay` live on the
 * {@link PayingClient} these tools wrap, so every payment goes through the same
 * guard. That client is a single-chain {@link PipRailClient} OR a
 * {@link MultiChainPayer} (one wallet per chain, auto-routing to whichever chain
 * the 402 asks for) — the tools are identical either way.
 */
import { parseReceipt } from './x402.js'
import { PaymentDeclinedError, PipRailError } from './errors.js'
import { summarizePlan, explainDecline, formatSpendReport } from './render.js'
import { PIPRAIL_AGENT_GUIDE } from './agentGuide.js'
import type { PayingClient, DiscoverOptions, RegisterOptions } from './client.js'

/**
 * MCP-style tool annotations — optional, advisory hints that let an MCP client or
 * agent reason about a tool's *nature* (is it safe to call freely? does it move
 * value?). They mirror the MCP spec's `ToolAnnotations`. NOTE: hints only — a
 * client must never make a security decision solely on these; the spend policy is
 * the real boundary.
 */
export interface ToolAnnotations {
  /** Human-friendly title for the tool. */
  title?: string
  /** True when the tool only READS — no state change, no funds moved. */
  readOnlyHint?: boolean
  /** True when the tool may move value or do something not easily undone (only meaningful when not read-only). */
  destructiveHint?: boolean
  /** True when calling repeatedly with the same args has no additional effect. */
  idempotentHint?: boolean
  /** True when the tool reaches the open world — external indexes, chains, or arbitrary URLs. */
  openWorldHint?: boolean
}

/** A framework-agnostic tool definition an agent runtime can register. */
export interface AgentTool {
  /** Unique tool name (snake_case, namespaced `piprail_…`). */
  name: string
  /** What the tool does — written for an LLM to read. */
  description: string
  /** JSON Schema (draft-07 object) describing the arguments. */
  parameters: Record<string, unknown>
  /** Advisory MCP-style hints about the tool's nature (read-only, value-moving, …). */
  annotations?: ToolAnnotations
  /** Optional JSON Schema (draft-07 object) for the tool's RESULT — declared only
   *  on stable read-only tools so a strict client can validate `structuredContent`.
   *  Kept OPEN (no `additionalProperties:false`) so additive fields never break it. */
  outputSchema?: Record<string, unknown>
  /** Execute the tool. Returns a JSON-serialisable result. */
  invoke: (args: Record<string, unknown>) => Promise<unknown>
}

/** An OPEN object output schema (extra fields always allowed) — the only safe
 *  shape for a tool whose result grows additively. Declared on the stable reads. */
const OPEN_OBJECT: Record<string, unknown> = { type: 'object', additionalProperties: true }

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
 * Seven tools wrapping a configured {@link PipRailClient}:
 *   - `piprail_discover(query?)` — FIND payable resources on the open x402
 *     indexes, WITHOUT paying (the phone book — solves "what can I buy?").
 *   - `piprail_quote_payment(url)` — price a gated URL WITHOUT paying.
 *   - `piprail_plan_payment(url)` — check you CAN pay (balance + gas + recipient
 *     readiness) across every rail the URL offers, WITHOUT paying.
 *   - `piprail_pay_request(url, method?, body?)` — pay if needed and return the result.
 *   - `piprail_register(url, …)` — LIST a resource you run on the open indexes so
 *     other agents can find it (402 Index, no signature).
 *   - `piprail_budget()` — read the remaining spend budget + time leash (Mode A self-check).
 *   - `piprail_guide()` — read the agent contract (how to quote/plan/pay + read a refusal).
 *
 * The first five are byte-identical in name + order to before; the two read-only
 * tools are appended LAST. EVERY failure the pay tool sees comes back as a
 * STRUCTURED object (`{ ok:false, code, reason, explain, ref?, reasonCode?,
 * declined? }`) — never a thrown error — so the model reasons about it (and never
 * re-pays a broadcast-but-unconfirmed payment) instead of crashing.
 */
export function paymentTools(client: PayingClient): AgentTool[] {
  return [
    {
      name: 'piprail_discover',
      description:
        'Find x402 payment-gated resources on the OPEN indexes (a phone book of payable APIs) WITHOUT ' +
        'paying. Use it to answer "what can I buy?" — search by topic, then quote/plan/pay a chosen one. ' +
        "By default returns only resources payable on your wallet's chain (network='self'); pass 'any' " +
        'for every chain. Results are cross-scheme: ALWAYS call piprail_quote_payment on a chosen ' +
        'resource (it re-checks the live price) before piprail_pay_request.',
      annotations: {
        title: 'Discover payable x402 APIs',
        readOnlyHint: true, // reads the open indexes only; never pays
        openWorldHint: true, // reaches external indexes (402 Index, CDP Bazaar)
      },
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
      annotations: {
        title: 'Quote an x402 price',
        readOnlyHint: true, // reads the 402 challenge; never pays
        openWorldHint: true, // fetches an arbitrary URL
      },
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the gated resource.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT,
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
      annotations: {
        title: 'Plan an x402 payment',
        readOnlyHint: true, // reads balances + the challenge; never pays
        openWorldHint: true, // fetches a URL and reads chain state
      },
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the gated resource.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT,
      invoke: async (args) => {
        const plan = await client.planPayment(String(args.url))
        if (plan == null) return { gated: false, url: String(args.url) }
        return {
          gated: true,
          payable: plan.payable,
          status: plan.status,
          fundingHint: plan.fundingHint,
          // One model-readable line distilling the whole plan.
          summary: summarizePlan(plan),
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
          // The session's time leash, present only when a time policy is configured.
          ...(plan.session ? { session: plan.session } : {}),
        }
      },
    },
    {
      name: 'piprail_pay_request',
      description:
        'Fetch an x402 payment-gated URL, automatically making the required payment if needed ' +
        '(subject to the spend policy + approval hook). Pays whichever rail the client is configured ' +
        'for — PipRail\'s backendless on-chain rail, or, when enabled, the standard `exact` rail ' +
        '(where the buyer signs and the server settles, so no buyer gas). Returns the HTTP status, ' +
        'the response body, and a payment receipt if one settled. If the payment is refused by policy ' +
        'or the approval hook, returns { declined: true, reason } — no funds moved.',
      annotations: {
        title: 'Pay an x402 request',
        readOnlyHint: false, // this is the one tool that MOVES FUNDS
        destructiveHint: true, // a payment is value-moving and not reversible
        idempotentHint: false, // paying twice = two payments
        openWorldHint: true, // fetches a URL and settles a payment
      },
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
          // The single funnel: EVERY SDK failure reaches the model as a structured
          // object, never a thrown crash. A policy/approval refusal keeps
          // `declined:true` (+ a typed `reasonCode` to spot a TERMINAL one); the
          // common non-decline failures (insufficient funds, no rail, and the
          // double-spend-critical timeouts that carry `.ref`) now arrive with a
          // `code` + an `explain` line instead of escaping as an opaque error.
          if (err instanceof PipRailError) {
            const out: Record<string, unknown> = {
              ok: false,
              code: err.code,
              reason: err.message,
              explain: explainDecline(err),
            }
            if (err instanceof PaymentDeclinedError) {
              out.declined = true
              if (err.reasonCode) out.reasonCode = err.reasonCode
            }
            const ref = (err as { ref?: string }).ref
            if (typeof ref === 'string') out.ref = ref
            return out
          }
          // A genuine, non-SDK bug → let it surface as an MCP isError.
          throw err
        }
      },
    },
    {
      name: 'piprail_register',
      description:
        'List an x402 payment-gated resource YOU run on the open indexes so other agents can discover it. ' +
        'Default target is 402 Index — no auth, no signature, no payment; a self-registered listing is ' +
        'pending review (verify your domain on 402index.io for instant approval). Returns one outcome per ' +
        'index ({ source, ok, detail, visibility, note }); a step the chain can\'t satisfy comes back ' +
        'ok:false with the reason. Moves no funds; nothing is PipRail-hosted. NOTE: index/agent payers are ' +
        'overwhelmingly standard `exact` clients — a default onchain-proof-only gate gets listed but they ' +
        'cannot pay it, so add an `exact` rail (and set the gate\'s `discovery` option, required for x402scan) ' +
        'to be usefully discoverable AND payable.',
      annotations: {
        title: 'Register an x402 endpoint',
        readOnlyHint: false, // writes a listing to an external index
        destructiveHint: false, // adds a listing; nothing is destroyed and no funds move
        openWorldHint: true, // posts to external indexes (402 Index)
        // idempotentHint intentionally omitted — index dedup behaviour isn't guaranteed.
      },
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the resource to list.' },
          name: { type: 'string', description: 'Display name (defaults to the host).' },
          description: { type: 'string', description: 'What the resource offers.' },
          priceUsd: { type: 'number', description: 'Advertised price in USD (metadata).' },
          network: {
            type: 'string',
            description:
              "Network slug to advertise, e.g. 'base' (defaults to the paying chain). Set it " +
              'when registering from a multi-chain wallet so the listing names the right chain.',
          },
          asset: { type: 'string', description: "Payment asset symbol, e.g. 'USDC' (metadata)." },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const opts: RegisterOptions = {}
        if (typeof args.name === 'string') opts.name = args.name
        if (typeof args.description === 'string') opts.description = args.description
        if (typeof args.priceUsd === 'number') opts.priceUsd = args.priceUsd
        if (typeof args.network === 'string') opts.network = args.network
        if (typeof args.asset === 'string') opts.asset = args.asset
        const outcomes = await client.register(String(args.url), opts)
        return { outcomes }
      },
    },
    {
      name: 'piprail_budget',
      description:
        'Read how much of your spend budget and time leash is left — per (network, asset) remaining, ' +
        'the session time envelope, and your spend so far. Use it in Mode A (headless) to self-check ' +
        'BEFORE paying, so you never discover the leash by hitting a decline. Read-only; moves no funds. ' +
        'NOTE: totals and the time envelope are in-memory for THIS process and reset on restart.',
      annotations: {
        title: 'Check remaining budget',
        readOnlyHint: true, // reads the in-memory ledger + policy; never pays
        idempotentHint: true, // a pure read
      },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: OPEN_OBJECT,
      invoke: async () => {
        const spent = client.spent()
        const budget = client.budget()
        return {
          spent,
          remaining: budget.byAsset,
          session: budget.session,
          report: formatSpendReport(spent),
        }
      },
    },
    {
      name: 'piprail_guide',
      description:
        'Read the PipRail agent contract — the quote → plan → pay loop, how to read a refusal (and ' +
        'which declines are TERMINAL), the never-re-pay rule for broadcast-but-unconfirmed payments, ' +
        'and Mode A (headless) vs Mode B (supervised). Read-only; call it once if unsure how to use these tools.',
      annotations: {
        title: 'How to use PipRail',
        readOnlyHint: true,
        idempotentHint: true,
      },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      invoke: async () => ({ guide: PIPRAIL_AGENT_GUIDE }),
    },
  ]
}
