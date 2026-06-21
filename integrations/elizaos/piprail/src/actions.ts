import type { Action, ActionExample, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core'
import { paymentTools, type AgentTool, type PayingClient } from '@piprail/sdk'
import { getClient, hasWallet } from './client.js'

const URL_RE = /https?:\/\/\S+/

// Each elizaOS Action wraps exactly one PipRail agent tool — no payment logic is reimplemented here.
// `arg` says what to pull from the user's message (a URL or a free-text query); arg-less tools just run.
interface Spec {
  tool: string
  name: string
  similes: string[]
  description: string
  arg?: 'url' | 'query'
  describe: (r: Record<string, unknown>) => string
  examples: ActionExample[][]
}

// A one-turn few-shot example. elizaOS drops actions with NO examples from the planner's prompt, so
// every action needs at least one (user turn + agent turn whose content.actions names the action).
const ex = (user: string, agent: string, action: string): ActionExample[] => [
  { name: '{{user}}', content: { text: user } },
  { name: '{{agent}}', content: { text: agent, actions: [action] } },
]

const SPECS: Spec[] = [
  {
    tool: 'piprail_pay_request', name: 'PIPRAIL_PAY',
    similes: ['PAY', 'PAY_402', 'PURCHASE', 'BUY', 'PIPRAIL_PAY_REQUEST'],
    description: 'Pay for a gated x402 URL (one that returned HTTP 402 Payment Required) and return the unlocked resource. Stays within the spend policy.',
    arg: 'url',
    describe: (r) =>
      r.ok
        ? `Paid${recv(r) ? ` (${recv(r)})` : ''}.${body(r) ? `\n${body(r)}` : ''}`
        : `Payment declined: ${str(r.explain ?? r.reason ?? r.code ?? 'unknown')}`,
    examples: [ex('pay https://api.example.com/premium', 'Paying that x402 endpoint now.', 'PIPRAIL_PAY')],
  },
  {
    tool: 'piprail_quote_payment', name: 'PIPRAIL_QUOTE',
    similes: ['QUOTE', 'PRICE', 'HOW_MUCH', 'COST'],
    description: 'Get the price of a gated x402 URL without paying it.',
    arg: 'url',
    describe: (r) =>
      r.gated ? `Price: ${str(r.amountFormatted)} ${str(r.symbol)}${r.network ? ` on ${str(r.network)}` : ''}.` : 'That URL is not a paid (402) endpoint.',
    examples: [ex('how much is https://api.example.com/premium', 'Let me check the price.', 'PIPRAIL_QUOTE')],
  },
  {
    tool: 'piprail_plan_payment', name: 'PIPRAIL_PLAN',
    similes: ['PLAN', 'CAN_I_AFFORD', 'AFFORD', 'CHECK_PAYMENT'],
    description: 'Check whether the agent can afford a gated x402 URL and which rail is cheapest, without paying.',
    arg: 'url',
    describe: (r) =>
      !r.gated
        ? 'That URL is not a paid (402) endpoint.'
        : r.payable
          ? `Payable${best(r) ? ` — best rail: ${best(r)}` : ''}.`
          : `Not payable right now: ${str(r.fundingHint ?? 'see blockers')}`,
    examples: [ex('can I afford https://api.example.com/premium', 'Checking whether that fits the budget.', 'PIPRAIL_PLAN')],
  },
  {
    tool: 'piprail_discover', name: 'PIPRAIL_DISCOVER',
    similes: ['DISCOVER', 'FIND_API', 'SEARCH_X402', 'FIND_PAID_API'],
    description: 'Find x402-payable APIs/resources that match a query.',
    arg: 'query',
    describe: (r) => `${num(r.count)} x402 resource(s) found.`,
    examples: [ex('find a weather API I can pay for', 'Searching x402 resources for weather.', 'PIPRAIL_DISCOVER')],
  },
  {
    tool: 'piprail_budget', name: 'PIPRAIL_BUDGET',
    similes: ['BUDGET', 'SPENT', 'REMAINING', 'HOW_MUCH_SPENT'],
    description: 'Report how much the agent has spent and what remains under its spend policy.',
    // The budget tool returns a ready-made human string in `report`; `spent`/`remaining` are
    // objects/arrays (String()ing them yields "[object Object]").
    describe: (r) => str(r.report) || 'No spend recorded yet.',
    examples: [ex('how much have you spent?', 'Here is the spend so far.', 'PIPRAIL_BUDGET')],
  },
  {
    tool: 'piprail_guide', name: 'PIPRAIL_GUIDE',
    similes: ['PIPRAIL_HELP', 'HOW_TO_PAY', 'PAYMENT_HELP'],
    description: 'Explain how the PipRail payment tools work and the spend policy in force.',
    // The guide tool returns { guide: <text> }.
    describe: (r) => str(r.guide) || JSON.stringify(r),
    examples: [ex('how do your payment tools work?', 'Here is how I pay for things.', 'PIPRAIL_GUIDE')],
  },
]

// ---- tiny formatters (defensive — tool results are structured but loosely typed) ----
const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
// The wire X402Receipt carries { transaction, asset, amount, … } but NO amountFormatted/symbol —
// surface the tx hash, the honest confirmation an agent can act on.
const recv = (r: Record<string, unknown>): string => {
  const rc = r.receipt as Record<string, unknown> | undefined
  return rc?.transaction ? `tx ${str(rc.transaction).slice(0, 12)}…` : ''
}
const body = (r: Record<string, unknown>): string => {
  const b = r.body
  if (b == null) return ''
  return typeof b === 'string' ? b : JSON.stringify(b)
}
const best = (r: Record<string, unknown>): string => {
  const b = r.best as Record<string, unknown> | undefined
  return b ? str(b.network ?? b.chain) : ''
}

function findTool(client: PayingClient, name: string): AgentTool {
  const tool = paymentTools(client).find((t) => t.name === name)
  if (!tool) throw new Error(`PipRail tool ${name} not found`)
  return tool
}

function toAction(spec: Spec): Action {
  return {
    name: spec.name,
    similes: spec.similes,
    description: spec.description,
    // Gate on the wallet AND (for URL actions) the presence of a URL, so the fund-moving
    // PIPRAIL_PAY isn't even offered on URL-less chatter.
    validate: async (runtime: IAgentRuntime, message?: Memory): Promise<boolean> =>
      hasWallet(runtime) && (spec.arg !== 'url' || URL_RE.test(message?.content?.text ?? '')),
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: unknown,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      // elizaOS's processActions has NO try/catch around a handler — an uncaught throw aborts the
      // whole agent run. getClient (no key / bad chain) and findTool can throw, so wrap everything
      // and always degrade to a structured failure.
      try {
        const text = message?.content?.text ?? ''
        const args: Record<string, unknown> = {}
        if (spec.arg === 'url') {
          const m = text.match(URL_RE)
          if (!m) {
            await callback?.({ text: 'Please include the URL you want me to handle.', actions: [spec.name] })
            return { success: false, text: 'No URL found in the message.' }
          }
          // Strip trailing punctuation/markdown the greedy \S+ may have captured.
          args.url = m[0].replace(/[)\]}>.,;'"]+$/, '')
        } else if (spec.arg === 'query') {
          args.query = text
        }
        const tool = findTool(getClient(runtime), spec.tool)
        const result = (await tool.invoke(args)) as Record<string, unknown>
        const reply = spec.describe(result)
        const ok = result?.ok !== false // pay/plan declines return { ok:false }, never a throw
        await callback?.({ text: reply, actions: [spec.name] })
        return ok
          ? { success: true, text: reply, data: { result } }
          : { success: false, text: reply, error: reply, data: { result } }
      } catch (err) {
        const text = `PipRail error: ${err instanceof Error ? err.message : String(err)}`
        await callback?.({ text, actions: [spec.name] })
        return { success: false, text, error: err instanceof Error ? err : String(err) }
      }
    },
    examples: spec.examples,
  }
}

export function buildActions(): Action[] {
  return SPECS.map(toAction)
}
