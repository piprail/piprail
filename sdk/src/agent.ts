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
import { parseReceipt, parseReceiptExtension, decodeBase64Json, type PipRailReceipt } from './x402.js'
import { summarizeSwap, type SwapQuote } from './swap.js'
import { PaymentDeclinedError, PipRailError } from './errors.js'
import { summarizePlan, explainDecline, formatSpendReport } from './render.js'
import { PIPRAIL_AGENT_GUIDE } from './agentGuide.js'
import { PipRailClient } from './client.js'
import { createPaymentGate, type PaymentGate } from './server.js'
import type { ChainSelector } from './drivers/types.js'
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
 * Funnel an EXPECTED SDK failure from a read-only tool into a STRUCTURED result so
 * an agent can branch on it instead of getting an opaque error — mirrors the pay
 * tool's funnel. A typed PipRailError (e.g. WalletRequiredError → `WALLET_REQUIRED`
 * on a read-only client, or a NoCompatibleAcceptError) becomes
 * `{ ok:false, code, reason, explain }`. A genuine, non-SDK error (a bug, a raw
 * network `fetch failed`) is RE-THROWN — by design, exactly like pay_request — so
 * the runtime surfaces it (the MCP server turns it into an `isError` result) rather
 * than masking it as a normal tool reply.
 */
/**
 * May a model swap on this client? Defaults to NO when the client predates modes or does
 * not implement the accessor, so the capability can only ever be gained deliberately.
 */
function canSwap(client: PayingClient): boolean {
  return client.canAgentSwap?.() === true && typeof client.quoteSwap === 'function'
}

/**
 * May a MODEL sell on this wallet? Sovereign authority AND the two things selling needs:
 * an address to be paid at, and a chain to be paid on. A client that cannot report either
 * simply never offers the seller tools, so an older implementation stays valid.
 */
function canSell(client: PayingClient): boolean {
  return client.canAgentSell?.() === true && typeof client.address === 'function'
}

/** One thing the agent has put up for sale, and what it has been paid for it. */
interface SoldOffer {
  id: string
  /** The nonce THIS offer's challenge carried. A proof quoting another offer's nonce is not
   *  payment for this one, however well it verifies on the chain. */
  nonce?: string
  /** The live gate. It owns the used-proof set, which is why the offer must keep it. */
  gate: PaymentGate
  description: string
  price: string
  token: string
  chain: ChainSelector
  payTo: string
  resource: string
  schemes: string[]
  createdAt: string
  earnings: Array<{ at: string; amount: string; symbol: string; payer?: string; ref: string }>
}

/**
 * The challenge nonce a presented proof quotes, if it carries one.
 *
 * Best-effort by design: the `onchain-proof` rail echoes the nonce in both the payload and the
 * accepted block, while a standard `exact` authorization carries a buyer-generated nonce that
 * is not the challenge's. Returning `undefined` there is correct, and the shared used-proof set
 * is what stops an exact settlement being redeemed twice.
 */
function nonceIn(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const p = payload as Record<string, unknown>
  const inner = p.payload as Record<string, unknown> | undefined
  const fromPayload = inner && typeof inner.nonce === 'string' ? inner.nonce : undefined
  const accepted = p.accepted as { extra?: Record<string, unknown> } | undefined
  const fromAccept = typeof accepted?.extra?.nonce === 'string' ? (accepted.extra.nonce as string) : undefined
  return fromPayload ?? fromAccept
}

/** The proof ref (tx hash / digest / locator) a buyer presented, from either wire shape.
 *  The cross-offer replay guard reserves on THIS value, so it must read the same field the
 *  gate ultimately verifies (`payload.txHash`). */
function refIn(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const inner = (payload as Record<string, unknown>).payload as Record<string, unknown> | undefined
  const ref = inner && typeof inner.txHash === 'string' ? inner.txHash.trim() : undefined
  return ref ? ref.toLowerCase() : undefined
}

function toToolError(err: unknown): Record<string, unknown> {
  if (!(err instanceof PipRailError)) throw err
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

/**
 * Eight tools wrapping a configured {@link PipRailClient}:
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
 *   - `piprail_verify_receipt(receipt, rpcUrl?)` — re-verify a verifiable receipt against the
 *     chain WITHOUT a wallet (anyone-verifiable; never throws — returns a structured verdict).
 *
 * The first five are byte-identical in name + order to before; the three read-only
 * tools are appended LAST. EVERY failure the pay tool sees comes back as a
 * STRUCTURED object (`{ ok:false, code, reason, explain, ref?, reasonCode?,
 * declined? }`) — never a thrown error — so the model reasons about it (and never
 * re-pays a broadcast-but-unconfirmed payment) instead of crashing.
 */
export function paymentTools(client: PayingClient): AgentTool[] {
  /*
   * ── THE EIGHT ARE THE FLOOR, NOT THE CEILING ──────────────────────────────────────
   *
   * This list stays byte-identical in every mode (STANDARDS §0), which is also why the
   * "8 tools" stated across forty-odd surfaces remains true. `'sovereign'` mode APPENDS
   * to it rather than changing it, so an operator who never opts in sees exactly what
   * they saw before, and nobody has to re-count anything.
   */
  const base: AgentTool[] = [
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
          query: {
            type: 'string',
            description:
              'Free-text topic to search for (optional). Multi-word queries are fanned out per word and ' +
              'results are ranked by relevance, so "crypto price feed" finds the best matches even when no ' +
              'single listing contains that exact phrase.',
          },
          network: {
            type: 'string',
            description: "CAIP-2 id, 'self' (your chain — default), or 'any' (all chains).",
          },
          category: { type: 'string', description: "Keep ONLY this category, e.g. 'ai', 'finance', 'data' (strict)." },
          asset: { type: 'string', description: "Keep only resources paying in this token symbol, e.g. 'USDC'." },
          maxPrice: { type: 'number', description: 'Drop results advertised above this USD price.' },
          minReliability: { type: 'number', description: 'Drop results below this health score (0–100); unscored pass.' },
          verified: { type: 'boolean', description: 'Prefer verified listings (402 Index).' },
          sort: {
            type: 'string',
            enum: ['relevance', 'reliability', 'price', 'uptime', 'name'],
            description: "Ordering. Default 'relevance' with a query, else first-seen.",
          },
          limit: { type: 'number', description: 'Max results to fetch per index (default 20).' },
        },
        additionalProperties: false,
      },
      invoke: async (args) => {
        try {
          const opts: DiscoverOptions = {}
          if (typeof args.query === 'string') opts.query = args.query
          if (typeof args.network === 'string') opts.network = args.network
          if (typeof args.category === 'string') opts.category = args.category
          if (typeof args.asset === 'string') opts.asset = args.asset
          if (typeof args.maxPrice === 'number') opts.maxPrice = args.maxPrice
          if (typeof args.minReliability === 'number') opts.minReliability = args.minReliability
          if (typeof args.verified === 'boolean') opts.verified = args.verified
          if (typeof args.sort === 'string') opts.sort = args.sort as DiscoverOptions['sort']
          if (typeof args.limit === 'number') opts.limit = args.limit
          const found = await client.discover(opts)
          return {
            count: found.length,
            resources: found.map((r) => ({
              resource: r.resource,
              name: r.name,
              description: r.description,
              source: r.source,
              category: r.category,
              priceUsd: r.priceUsd,
              reliabilityScore: r.reliabilityScore,
              health: r.health,
              verified: r.verified,
              networks: [...new Set(r.rails.map((rail) => rail.network))],
            })),
          }
        } catch (err) {
          return toToolError(err)
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
        try {
          const quote = await client.quote(String(args.url))
          return quote ? { gated: true, ...quote } : { gated: false, url: String(args.url) }
        } catch (err) {
          return toToolError(err)
        }
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
       try {
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
       } catch (err) {
         return toToolError(err)
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
          // Surface the verifiable receipt (when the gate emitted one) so the agent can KEEP it
          // and later re-verify with piprail_verify_receipt — stamped with the URL we fetched.
          const verifiable = parseReceiptExtension(res)
          return {
            status: res.status,
            ok: res.ok,
            body: await readBody(res),
            receipt: parseReceipt(res),
            ...(verifiable ? { verifiableReceipt: { ...verifiable, resource: { url } } } : {}),
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
          description: {
            type: 'string',
            description:
              'What the resource offers. Pack the words agents will search for INTO this text — index search ' +
              'is literal, so a keyword that isn\'t in the name/description won\'t be found.',
          },
          category: { type: 'string', description: "A category, e.g. 'ai', 'finance', 'data' — the top findability field (most listings have none)." },
          tags: { type: 'array', items: { type: 'string' }, description: 'Keywords; folded into the description so they\'re searchable.' },
          priceUsd: { type: 'number', description: 'Advertised price in USD (metadata).' },
          network: {
            type: 'string',
            description:
              "Network slug to advertise, e.g. 'base' (defaults to the paying chain). Set it " +
              'when registering from a multi-chain wallet so the listing names the right chain.',
          },
          asset: { type: 'string', description: "Payment asset symbol, e.g. 'USDC' (metadata)." },
          provider: { type: 'string', description: 'Who runs the resource (provider/org name).' },
          contactEmail: { type: 'string', description: 'Contact email for the listing.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        try {
          const opts: RegisterOptions = {}
          if (typeof args.name === 'string') opts.name = args.name
          if (typeof args.description === 'string') opts.description = args.description
          if (typeof args.category === 'string') opts.category = args.category
          if (Array.isArray(args.tags)) opts.tags = args.tags.filter((t): t is string => typeof t === 'string')
          if (typeof args.priceUsd === 'number') opts.priceUsd = args.priceUsd
          if (typeof args.network === 'string') opts.network = args.network
          if (typeof args.asset === 'string') opts.asset = args.asset
          if (typeof args.provider === 'string') opts.provider = args.provider
          if (typeof args.contactEmail === 'string') opts.contactEmail = args.contactEmail
          const outcomes = await client.register(String(args.url), opts)
          return { outcomes }
        } catch (err) {
          return toToolError(err)
        }
      },
    },
    {
      name: 'piprail_budget',
      description:
        'Read how much of your spend budget and time leash is left — per (network, asset) remaining, ' +
        'the cross-token GRAND TOTAL per denomination (e.g. how much USD you can still spend across ' +
        'every stablecoin and chain), the payment-count leash, the session time envelope, and your ' +
        'spend so far. Use it in Mode A (headless) to self-check BEFORE paying, so you never discover ' +
        'the leash by hitting a decline. Read-only; moves no funds. NOTE: the time envelope is in-memory ' +
        'for THIS process; the money/count totals persist only if a spend store is configured.',
      annotations: {
        title: 'Check remaining budget',
        readOnlyHint: true, // reads the ledger + policy; never pays
        idempotentHint: true, // a pure read
      },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: OPEN_OBJECT,
      invoke: async () => {
        try {
          const spent = client.spent()
          const budget = client.budget()
          return {
            spent,
            remaining: budget.byAsset,
            grandTotal: budget.byDenom, // cross-token spend cap per denomination (USD/EUR/…)
            counts: budget.counts, // payment-count leash (settled + lifetime/window caps)
            session: budget.session,
            policy: client.policy() ?? null, // the configured leash, read back
            report: formatSpendReport(spent),
          }
        } catch (err) {
          return toToolError(err)
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
    {
      name: 'piprail_verify_receipt',
      description:
        'Re-verify a PipRail VERIFIABLE RECEIPT against the chain — confirm a payment REALLY settled ' +
        '(the funds provably moved to payTo for AT LEAST the stated amount) WITHOUT trusting whoever handed ' +
        'you the receipt. Read-only and WALLET-FREE: pass the PipRailReceipt JSON (from a prior ' +
        'piprail_pay_request `verifiableReceipt`, or any third party). Returns { ok, onChain:{payTo,asset,' +
        'amount,payer}, matchesClaims, ageSeconds, error? }: `ok` = the chain confirms the settlement; ' +
        '`onChain.payer` is RE-DERIVED from the tx and `matchesClaims:false` means the receipt forged the ' +
        'payer; `amount` is a verified lower bound. Pass `rpcUrl` for a chain outside the common presets.',
      annotations: {
        title: 'Verify a payment receipt',
        readOnlyHint: true, // re-reads the chain; moves nothing, needs no wallet
        idempotentHint: true,
        openWorldHint: true, // reads an on-chain tx via RPC
      },
      parameters: {
        type: 'object',
        properties: {
          receipt: {
            type: 'object',
            description: 'The PipRailReceipt JSON ({ piprail, receipt, resource, decimals? }) to re-verify.',
          },
          rpcUrl: {
            type: 'string',
            description: "Optional RPC URL for the receipt's chain (required for chains outside the common presets).",
          },
        },
        required: ['receipt'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const receipt = args.receipt as unknown as PipRailReceipt
        const opts = args.rpcUrl ? { rpcUrl: String(args.rpcUrl) } : undefined
        return await PipRailClient.verifyReceipt(receipt, opts)
      },
    },
  ]

  /*
   * ── SOVEREIGN-ONLY: the agent may move its own funds between denominations ─────────
   *
   * Withheld in every other mode, and the reason is not squeamishness: a swap is not a
   * payment, so `maxAmount`, `maxTotal`, the count caps and the session TTL all pass over
   * it untouched. A model looping USDC → SOL → USDC bleeds the pool fee each round while
   * the spend ledger records nothing at all.
   *
   * `'sovereign'` says the agent OWNS these funds and answers for them, so the capability
   * is unlocked — but bounded by `swapPolicy` (a ceiling per swap, a slippage ceiling, an
   * optional destination allowlist), because unlocking it without an instrument that can
   * actually bound it would repeat the mistake the withholding was avoiding.
   */
  const tools: AgentTool[] = [...base]

  if (canSwap(client)) {
    tools.push(
    {
      name: 'piprail_quote_swap',
      description:
        'Price a SAME-CHAIN swap of one token into another WITHOUT swapping. Read-only: signs nothing and ' +
        'moves nothing. Use it when a payment is blocked because you hold the wrong token on the RIGHT ' +
        'chain. Returns { ok, from, to, maxSpend, source, slippageBps } where `maxSpend` is the ceiling ' +
        'enforced ON-CHAIN (not an estimate) and `source` NAMES who priced it, because PipRail runs no ' +
        'price oracle. `ok:false` with no quote means no route or no liquidity, never "no funds". This ' +
        'CANNOT cross chains: to pay on a chain you hold nothing on, use a wallet on that chain.',
      annotations: {
        title: 'Price a token swap',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: "Token you HOLD and will spend (symbol, address, or 'native')." },
          to: { type: 'string', description: "Token you NEED (symbol, address, or 'native')." },
          wantAmount: { type: 'string', description: 'How much of `to` you need, in human units (e.g. "0.50").' },
          slippageBps: {
            type: 'number',
            description: 'Optional tolerance in basis points (default 50 = 0.5%). Refused if above your swapPolicy cap.',
          },
        },
        required: ['from', 'to', 'wantAmount'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const a = args as { from: string; to: string; wantAmount: string; slippageBps?: number }
        try {
          const quote = await client.quoteSwap?.({
            from: a.from,
            to: a.to,
            wantAmount: a.wantAmount,
            slippageBps: a.slippageBps,
          })
          if (!quote) {
            return {
              ok: false,
              reason: 'no_route',
              explain:
                'No route or no liquidity for that pair on this chain. This is not a funding problem. ' +
                'Try a different pair, or pay from a chain where you already hold the token.',
            }
          }
          return {
            ok: true,
            from: { symbol: quote.from.symbol, amount: quote.from.amountFormatted },
            to: { symbol: quote.to.symbol, amount: quote.to.amountFormatted },
            maxSpend: quote.maxSpendFormatted,
            slippageBps: quote.slippageBps,
            source: { kind: quote.source.kind, name: quote.source.name, note: quote.source.note },
            summary: summarizeSwap(quote),
            quote,
          }
        } catch (err) {
          return toToolError(err)
        }
      },
    },
    {
      name: 'piprail_swap',
      description:
        '🔴 MOVES FUNDS. Execute a swap you already priced with piprail_quote_swap. Pass that tool\'s ' +
        '`quote` back UNMODIFIED: it carries the route and the on-chain spend ceiling. Re-quote rather ' +
        'than reusing an old one, because a stale route gets you a worse price than you were shown. ' +
        'Your PAYMENT budget does not govern this call; your swapPolicy does. Nothing is swapped if the ' +
        'market moves past the ceiling, though chains that charge for a reverted transaction still take gas.',
      annotations: {
        title: 'Swap tokens',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      parameters: {
        type: 'object',
        properties: {
          quote: { type: 'object', description: 'The `quote` object returned by piprail_quote_swap, unmodified.' },
        },
        required: ['quote'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const a = args as { quote: SwapQuote }
        try {
          const receipt = await client.swap?.(a.quote)
          if (!receipt) return { ok: false, reason: 'unsupported', explain: 'This client cannot swap.' }
          return {
            ok: true,
            transaction: receipt.transaction,
            network: receipt.network,
            from: { symbol: receipt.from.symbol, amount: receipt.from.amountFormatted },
            to: { symbol: receipt.to.symbol, amount: receipt.to.amountFormatted },
            source: receipt.source.name,
          }
        } catch (err) {
          return toToolError(err)
        }
      },
    },
    )
  }

  /*
   * ── SELLING: the other half of owning a wallet ──────────────────────────────────
   *
   * Until now the toolkit exposed one half of a wallet. An agent could pay for anything
   * and be paid for nothing, which is not a budget so much as an allowance, and an
   * allowance is the opposite of sovereignty. `'sovereign'` adds the earning half: price
   * something, hand the buyer a challenge, verify what comes back, then deliver.
   *
   * WHY THIS NEEDS NO SERVER, NO HOST AND NO PORT. A gate is a pure function of the offer
   * and the chain: `sell` mints the 402 challenge and `collect` verifies a proof against
   * it, and NEITHER touches HTTP. So the agent can carry the challenge to a buyer over
   * whatever it already speaks (a chat turn, an A2A task, an MCP result, a queue) and
   * carry the proof back the same way. Earning therefore needs no infrastructure at all,
   * which is what puts it in reach of an agent that has a wallet and a conversation and
   * nothing else. An agent that DOES run HTTP serves these same two calls through
   * `toFetchHandler` instead, and the wire is identical.
   *
   * THE SELLER SIDE NEVER HOLDS A KEY. `payTo` is a public address, so this works on a
   * machine with no signing ability whatsoever, and a host compromise cannot reach the
   * earnings. That asymmetry is the strongest security property PipRail has, and it is
   * why selling is safe to hand a model in a way that spending is not.
   *
   * The gate objects live in THIS process, for the life of these tools. That is not
   * incidental: a gate holds the used-proof set that stops a buyer redeeming one payment
   * twice, so an offer that outlived its gate would lose its replay protection. Restart
   * and the offers are gone; anything longer-lived belongs in a real deployment with a
   * durable `isUsed`/`markUsed`.
   */
  if (!canSell(client)) return tools

  const offers = new Map<string, SoldOffer>()
  /*
   * 🔴 ONE SETTLEMENT, ONE DELIVERY — shared across every offer in this session.
   *
   * Each offer owns a separate gate, and a gate's replay set is scoped to itself. That is right
   * for `requirePayment`, where one gate guards one resource, and WRONG here: two offers priced
   * the same to the same address are, to a driver, indistinguishable, so one real payment could
   * be redeemed against both. Proven before this existed: a buyer paid 1.00 for a haiku and
   * collected the expensive offer with the same settlement.
   *
   * The used set therefore belongs to the STORE, not the gate.
   */
  const spentProofs = new Set<string>()
  const offerOr = (id: unknown): SoldOffer | { ok: false; reason: string; offers: string[] } => {
    const found = typeof id === 'string' ? offers.get(id) : undefined
    return (
      found ?? {
        ok: false as const,
        reason: `no offer ${JSON.stringify(id)}. Offers live in memory for this session only, so a restart clears them — call piprail_sell again to re-price it.`,
        offers: [...offers.keys()],
      }
    )
  }

  tools.push(
    {
      name: 'piprail_sell',
      description:
        'Put something up for sale and get the payment challenge to hand a buyer. YOU set the price. ' +
        'Returns an offerId plus a `challenge` object: give that challenge to the buyer over ANY channel ' +
        '(a reply, an A2A task, an MCP result) — it needs no web server and no open port. When they send ' +
        'back a payment proof, call piprail_collect BEFORE you deliver. Money goes straight to your own ' +
        'address; receiving needs no key, so nothing here can spend. Offers are in-memory for this ' +
        'session. By default the offer carries the standard `exact` rail as well as onchain-proof, so ' +
        'ordinary x402 agent-buyers can pay it — without `exact` most of them cannot, and a listing they ' +
        'cannot pay earns nothing.',
      annotations: {
        title: 'Sell something',
        readOnlyHint: false, // creates an offer in this session and advertises an address to be paid at
        destructiveHint: false, // moves no funds; receiving cannot spend
        idempotentHint: false, // each call mints a NEW offer with its own nonce
        openWorldHint: false, // publishes nowhere — piprail_register is what lists an offer publicly
      },
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'What the buyer is paying for. They see this in the challenge, and it is what you are promising to deliver — be specific.',
          },
          price: { type: 'string', description: "The price you are charging, human-readable, e.g. '2.50'." },
          token: { type: 'string', description: "What to be paid in. Defaults to 'USDC'. Use 'native' for the chain's own coin." },
          chain: { type: 'string', description: 'Which chain to be paid on. Defaults to the chain this wallet is on.' },
          payTo: {
            type: 'string',
            description:
              'Where the money goes. Defaults to YOUR OWN address, which is almost always what you want — set it only to be paid somewhere else, and never to an address a buyer gave you.',
          },
          resource: { type: 'string', description: 'Optional identifier or URL for the thing being sold; a label is minted if omitted.' },
        },
        required: ['description', 'price'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        try {
          const description = typeof args.description === 'string' ? args.description.trim() : ''
          const price = typeof args.price === 'string' ? args.price.trim() : ''
          if (!description) return { ok: false, reason: 'sell needs a `description` — it is what the buyer sees and what you owe them.' }
          if (!price) return { ok: false, reason: "sell needs a `price`, human-readable, e.g. '2.50'." }

          const token = typeof args.token === 'string' && args.token.trim() ? args.token.trim() : 'USDC'
          const chain = (typeof args.chain === 'string' && args.chain.trim() ? args.chain.trim() : client.chain?.()) as
            | ChainSelector
            | undefined
          if (chain === undefined) {
            return { ok: false, reason: 'sell needs a `chain` — this wallet cannot report one of its own.' }
          }
          /*
           * The payTo default is the whole reason `address()` exists. An agent handed a key it
           * never chose has no other way to learn where it gets paid, and asking it to supply an
           * address it cannot know would make selling unreachable in exactly the case that matters.
           */
          let payTo: string
          if (typeof args.payTo === 'string' && args.payTo.trim()) {
            payTo = args.payTo.trim()
          } else if (typeof client.address === 'function') {
            payTo = await client.address()
          } else {
            return { ok: false, reason: 'sell needs a `payTo` — this wallet cannot report its own address.' }
          }

          const id = `offer_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
          const resource = typeof args.resource === 'string' && args.resource.trim() ? args.resource.trim() : `piprail:${id}`
          const base = { chain, token, amount: price, payTo, description, discovery: true } as const

          /*
           * Offer the standard `exact` rail whenever the family HAS one, because agent buyers
           * overwhelmingly speak `exact` and cannot pay an onchain-proof-only gate at all. Not
           * every family has a ratified exact scheme though, and a native coin never does, so
           * this asks for it, checks whether it actually resolved, and falls back rather than
           * failing the sale. The fallback is reported, never silent: an agent that does not know
           * its rail is unpayable by most buyers will sit waiting for money that cannot arrive.
           */
          const railSchemes = (t: { rails?: ReadonlyArray<{ schemes?: readonly string[] }> }): string[] => [
            ...new Set((t.rails ?? []).flatMap((r) => [...(r.schemes ?? [])])),
          ]
          /*
           * Each offer's gate keeps its OWN built-in replay set — that set reserves
           * synchronously, so it already stops a SAME-offer double-collect under concurrency.
           * CROSS-offer replay is owned by `collect` instead (see `spentProofs` above): it
           * reserves the ref synchronously before any await, which a per-gate set cannot do
           * for its siblings, and which an injected isUsed/markUsed pair cannot do at all
           * (the gate reads it before `verify()` and writes it after, so N concurrent
           * collects on N gates would every one observe "unused").
           */
          let gate = createPaymentGate({ ...base, exact: true })
          let check = await gate.selfTest()
          const warnings: string[] = []
          /*
           * Test the RESOLVED RAILS, not `ok`. A gate whose exact rail fell away still reports
           * `ok: true` (correctly: it can take money, just not gaslessly), and explains the drop on
           * stderr, where a model cannot see it. Reading `ok` here would ship an offer that says
           * `exact` on the tin and cannot be paid by the buyers it was added for.
           */
          if (!check.ok || !railSchemes(check).includes('exact')) {
            const why = check.error ?? 'it did not resolve on this RPC'
            gate = createPaymentGate({ ...base })
            check = await gate.selfTest()
            warnings.push(
              'This offer carries onchain-proof ONLY, so a standard x402 agent-buyer cannot pay it. ' +
                'A PipRail buyer (piprail_pay_request) and a human still can. ' +
                `The gasless exact rail was dropped because ${why} ` +
                'Two things cause this: the token or family has no exact scheme (a native coin never ' +
                'does, so price in USDC), or the token domain read failed on a busy public RPC, which ' +
                'is transient. Retrying on a dedicated rpcUrl is worth one attempt before you settle ' +
                'for this.'
            )
          }
          if (!check.ok) {
            return { ok: false, reason: check.error ?? 'this offer could not be priced on that chain.', chain, token }
          }
          for (const w of check.warnings ?? []) warnings.push(String(w))

          const { challenge, requiredHeader } = await gate.challenge(resource)
          const schemes = railSchemes(check)
          const nonce = challenge.accepts.find((a) => a.scheme === 'onchain-proof')?.extra?.nonce
          const offer: SoldOffer = {
            id,
            nonce: typeof nonce === 'string' ? nonce : undefined,
            gate,
            description,
            price,
            token,
            chain,
            payTo,
            resource,
            schemes,
            createdAt: new Date().toISOString(),
            earnings: [],
          }
          offers.set(id, offer)

          return {
            ok: true,
            offerId: id,
            description,
            price,
            token,
            chain,
            payTo,
            paidToYou: payTo === (typeof client.address === 'function' ? await client.address().catch(() => undefined) : undefined),
            schemes,
            challenge,
            /*
             * The header an x402 402 must carry alongside the body. An agent serving its own
             * offer over HTTP needs BOTH halves, and omitting this quietly left it emitting a
             * non-conformant 402 that only a lenient buyer would pay.
             */
            requiredHeader,
            next:
              `Give \`challenge\` to the buyer over any channel you like. Serving it over HTTP? Send it as a ` +
              `402 body with \`requiredHeader\` as the PAYMENT-REQUIRED header. When they hand back a proof, ` +
              `call piprail_collect with offerId ${id} and DO NOT deliver until it comes back paid:true. ` +
              `To let strangers find this offer, call piprail_register with its URL.`,
            ...(warnings.length ? { warnings } : {}),
          }
        } catch (err) {
          return toToolError(err)
        }
      },
    },
    {
      name: 'piprail_collect',
      description:
        'Verify a payment a buyer says they made for one of YOUR offers, against the chain. This is the ' +
        'only thing that proves you were paid — a buyer claiming to have paid, a plausible-looking tx ' +
        'hash, and a real settlement are three different things, and only this call tells them apart. ' +
        'Returns paid:true with a receipt, or paid:false with the reason and a fresh challenge the buyer ' +
        'can retry against. DELIVER NOTHING UNTIL IT RETURNS paid:true. Each proof can be redeemed once: ' +
        'a replay of an already-collected payment comes back paid:false, never a second sale.',
      annotations: {
        title: 'Collect a payment',
        readOnlyHint: false, // burns the proof into the offer's used set, so it cannot be redeemed twice
        destructiveHint: false, // moves no funds; it only reads the chain and records what it found
        idempotentHint: false, // deliberately NOT: a second call on the same proof is a replay and is refused
        openWorldHint: true, // reads the settlement via RPC
      },
      parameters: {
        type: 'object',
        properties: {
          offerId: { type: 'string', description: 'The offer being paid for, from piprail_sell.' },
          payment: {
            type: 'string',
            description:
              'What the buyer sent back: the payment-signature header value, or the payment payload as a JSON string. Pass it through exactly as received.',
          },
        },
        required: ['offerId', 'payment'],
        additionalProperties: false,
      },
      invoke: async (args) => {
        try {
          const offer = offerOr(args.offerId)
          if ('ok' in offer) return offer
          const raw = typeof args.payment === 'string' ? args.payment.trim() : ''
          if (!raw) return { ok: false, reason: 'collect needs the `payment` the buyer sent back.' }

          /*
           * A buyer may hand over the base64 header value OR the decoded payload as JSON, and an
           * agent relaying it through a chat turn has no reason to know which it is holding. Both
           * run the SAME verification (`verifyObject` is the gate's raw-JSON seam, sharing one
           * replay set with `verify`), so accepting either costs nothing and refusing one would
           * only produce a failure the agent cannot act on.
           */
          const asObject = raw.startsWith('{') ? (JSON.parse(raw) as unknown) : undefined

          /*
           * 🔴 BIND THE PROOF TO THIS OFFER, before the chain is ever consulted.
           *
           * A driver can only ask "did this settlement move >= X to this address?". Two offers
           * at one price to one address answer that identically, so a payment for the cheap one
           * verified perfectly against the expensive one. The nonce is the only field that tells
           * them apart, so it is the only thing that can refuse this.
           */
          const presented = nonceIn(asObject ?? decodeBase64Json(raw))
          if (offer.nonce && presented && presented !== offer.nonce) {
            return {
              ok: true,
              paid: false,
              offerId: offer.id,
              reason:
                'this proof was minted for a DIFFERENT offer (its challenge nonce is not this one). ' +
                'A payment for one offer is not payment for another, even at the same price.',
              code: 'wrong_offer',
              next: 'Do NOT deliver. Ask the buyer to pay THIS offer\'s challenge.',
            }
          }

          /*
           * 🔴 CROSS-OFFER REPLAY, INCLUDING UNDER CONCURRENCY.
           *
           * The nonce check above refuses a proof minted for another offer. This refuses the
           * same SETTLEMENT being collected twice across different offers — and it must happen
           * synchronously, before any await, or five concurrent collects each read "unspent"
           * and each deliver. `reservedHere` is a per-invocation local, so only the call that
           * actually won the reservation can release it; a genuine replay (someone else holds
           * the reservation) leaves it untouched.
           */
          const proofRef = refIn(asObject ?? decodeBase64Json(raw))
          let reservedHere: string | undefined
          if (proofRef) {
            if (spentProofs.has(proofRef)) {
              return {
                ok: true,
                paid: false,
                offerId: offer.id,
                reason: 'this settlement was already collected — one payment settles exactly one offer.',
                code: 'tx_already_used',
                next: 'Do NOT deliver. Ask the buyer to pay THIS offer\'s challenge.',
              }
            }
            spentProofs.add(proofRef)
            reservedHere = proofRef
          }

          let result
          try {
            result = asObject !== undefined ? await offer.gate.verifyObject(asObject) : await offer.gate.verify(raw)
          } catch (err) {
            // A thrown verify (transient RPC) must not burn a still-valid payment.
            if (reservedHere) spentProofs.delete(reservedHere)
            throw err
          }
          // Keep the reservation ONLY for a settled payment; anything else releases it so the
          // buyer can retry, mirroring the gate's own claim/release.
          if (result.kind !== 'paid' && reservedHere) spentProofs.delete(reservedHere)

          if (result.kind === 'paid') {
            const r = result.receipt as unknown as Record<string, unknown>
            const entry = {
              at: new Date().toISOString(),
              amount: String(r.amountFormatted ?? offer.price),
              symbol: String(r.symbol ?? offer.token),
              ...(typeof r.payer === 'string' ? { payer: r.payer } : {}),
              ref: String(r.transaction ?? r.reference ?? ''),
            }
            offer.earnings.push(entry)
            return {
              ok: true,
              paid: true,
              offerId: offer.id,
              earned: `${entry.amount} ${entry.symbol}`,
              receipt: result.receipt,
              next: `Payment is settled and on-chain. Deliver "${offer.description}" now. This proof is spent and cannot be collected again.`,
            }
          }
          if (result.kind === 'invalid') {
            return {
              ok: true,
              paid: false,
              offerId: offer.id,
              reason: result.detail || result.error,
              code: result.error,
              retryChallenge: result.challenge,
              next: 'Do NOT deliver. Give the buyer `retryChallenge` if they want to try again.',
            }
          }
          return {
            ok: true,
            paid: false,
            offerId: offer.id,
            reason: 'no payment was presented — this is a fresh challenge, not a settlement.',
            retryChallenge: result.challenge,
            next: 'Do NOT deliver. The buyer has not paid yet.',
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            return { ok: false, reason: 'the `payment` looked like JSON but would not parse. Pass the buyer\'s proof through unchanged.' }
          }
          return toToolError(err)
        }
      },
    },
    {
      name: 'piprail_earnings',
      description:
        'What you have SOLD and what you have actually been paid this session — the earning-side mirror of ' +
        'piprail_budget. Counts only payments proven by piprail_collect, never what a buyer claimed. ' +
        'In-memory for this session, so it resets on restart and is a record of this run, not a ledger.',
      annotations: {
        title: 'Your earnings',
        readOnlyHint: true, // pure read of this session's collected payments
        idempotentHint: true,
        openWorldHint: false,
      },
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      invoke: async () => {
        const list = [...offers.values()]
        const byAsset: Record<string, number> = {}
        for (const o of list) {
          for (const e of o.earnings) byAsset[e.symbol] = (byAsset[e.symbol] ?? 0) + Number(e.amount || 0)
        }
        const collected = list.reduce((n, o) => n + o.earnings.length, 0)
        return {
          ok: true,
          offers: list.map((o) => ({
            offerId: o.id,
            description: o.description,
            price: `${o.price} ${o.token}`,
            chain: o.chain,
            payTo: o.payTo,
            schemes: o.schemes,
            timesPaid: o.earnings.length,
            earnings: o.earnings,
          })),
          totals: Object.fromEntries(Object.entries(byAsset).map(([s, n]) => [s, String(n)])),
          collected,
          report:
            list.length === 0
              ? 'Nothing on sale yet. piprail_sell prices something.'
              : `${list.length} offer(s), ${collected} payment(s) collected: ` +
                (collected === 0
                  ? 'nothing paid yet.'
                  : Object.entries(byAsset)
                      .map(([s, n]) => `${n} ${s}`)
                      .join(', ')),
        }
      },
    },
    {
      name: 'piprail_wallet',
      description:
        'What YOU can SPEND, and where you get paid — your balance sheet, which is a different ' +
        'question from piprail_budget (that is how much of your allowance is left). Returns your ' +
        'own address per chain plus the spendable amount of each asset. Use it before deciding to ' +
        'sell, swap or ask to be topped up, and give the address to anyone who needs to send you ' +
        'funds. On some chains a native amount is LOWER than the figure a block explorer shows, ' +
        'because the chain makes an account retain a minimum it can never send (Solana, XRPL, ' +
        'Stellar, Algorand). That gap is locked, not lost, and this number is the one you can ' +
        'actually pay with. A null amount means the read was UNAVAILABLE, not zero: do NOT treat ' +
        'it as being broke. Read-only; moves nothing and needs no approval.',
      annotations: {
        title: 'Your wallet',
        readOnlyHint: true, // reads addresses and balances; changes nothing
        idempotentHint: true,
        openWorldHint: true, // balances come from RPC
      },
      parameters: {
        type: 'object',
        properties: {
          assets: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Symbols to report, e.g. ['native','USDC','USDT']. Defaults to your chain's coin and USDC. " +
              'A symbol your chain does not ship comes back known:false rather than as a zero.',
          },
        },
        additionalProperties: false,
      },
      invoke: async (args) => {
        try {
          const assets =
            Array.isArray(args.assets) && args.assets.length
              ? args.assets.filter((a): a is string => typeof a === 'string')
              : ['native', 'USDC']
          const address = typeof client.address === 'function' ? await client.address().catch(() => null) : null
          const holdings =
            typeof client.balanceOf === 'function' ? await client.balanceOf(assets).catch(() => []) : []
          const held = holdings.filter((h) => h.known && h.amount !== null && h.amount !== '0')
          const unknown = holdings.filter((h) => h.known && h.amount === null)
          return {
            ok: true,
            address,
            chain: typeof client.chain === 'function' ? client.chain() : undefined,
            holdings,
            report:
              (held.length
                ? `You hold ${held.map((h) => `${h.amountFormatted} ${h.symbol}`).join(', ')}.`
                : 'No positive balance in the assets you asked about.') +
              (unknown.length
                ? ` Could NOT read ${unknown.map((h) => h.symbol).join(', ')} — unknown, not zero; retry before concluding you are broke.`
                : ''),
            next: 'To be paid here, give out `address`. piprail_budget is your spend leash; this is what you own.',
          }
        } catch (err) {
          return toToolError(err)
        }
      },
    }
  )

  return tools
}
