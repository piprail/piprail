import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core'
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
}

const SPECS: Spec[] = [
  {
    tool: 'piprail_pay_request', name: 'PIPRAIL_PAY',
    similes: ['PAY', 'PAY_402', 'PURCHASE', 'BUY', 'PIPRAIL_PAY_REQUEST'],
    description: 'Pay for a gated x402 URL (one that returned HTTP 402 Payment Required) and return the unlocked resource. Stays within the spend policy.',
    arg: 'url',
    describe: (r) =>
      r.ok
        ? `Paid${recv(r) ? ` ${recv(r)}` : ''}.${body(r) ? `\n${body(r)}` : ''}`
        : `Payment declined: ${str(r.explain ?? r.reason ?? r.code ?? 'unknown')}`,
  },
  {
    tool: 'piprail_quote_payment', name: 'PIPRAIL_QUOTE',
    similes: ['QUOTE', 'PRICE', 'HOW_MUCH', 'COST'],
    description: 'Get the price of a gated x402 URL without paying it.',
    arg: 'url',
    describe: (r) =>
      r.gated ? `Price: ${str(r.amountFormatted)} ${str(r.symbol)}${r.network ? ` on ${str(r.network)}` : ''}.` : 'That URL is not a paid (402) endpoint.',
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
  },
  {
    tool: 'piprail_discover', name: 'PIPRAIL_DISCOVER',
    similes: ['DISCOVER', 'FIND_API', 'SEARCH_X402', 'FIND_PAID_API'],
    description: 'Find x402-payable APIs/resources that match a query.',
    arg: 'query',
    describe: (r) => `${num(r.count)} x402 resource(s) found.`,
  },
  {
    tool: 'piprail_budget', name: 'PIPRAIL_BUDGET',
    similes: ['BUDGET', 'SPENT', 'REMAINING', 'HOW_MUCH_SPENT'],
    description: 'Report how much the agent has spent and what remains under its spend policy.',
    describe: (r) => `Spent ${str(r.spent ?? '0')}; remaining ${str(r.remaining ?? 'see policy')}.`,
  },
  {
    tool: 'piprail_guide', name: 'PIPRAIL_GUIDE',
    similes: ['PIPRAIL_HELP', 'HOW_TO_PAY', 'PAYMENT_HELP'],
    description: 'Explain how the PipRail payment tools work and the spend policy in force.',
    describe: (r) => (typeof r === 'string' ? r : str(JSON.stringify(r))),
  },
]

// ---- tiny formatters (kept defensive — tool results are structured but loosely typed) ----
const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const recv = (r: Record<string, unknown>): string => {
  const rc = r.receipt as Record<string, unknown> | undefined
  return rc ? `${str(rc.amountFormatted)} ${str(rc.symbol)}`.trim() : ''
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
    validate: async (runtime: IAgentRuntime): Promise<boolean> => hasWallet(runtime),
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: unknown,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const text = message?.content?.text ?? ''
      const args: Record<string, unknown> = {}
      if (spec.arg === 'url') {
        const m = text.match(URL_RE)
        if (!m) {
          await callback?.({ text: 'Please include the URL you want me to handle.' })
          return { success: false, text: 'No URL found in the message.' }
        }
        args.url = m[0]
      } else if (spec.arg === 'query') {
        args.query = text
      }
      const tool = findTool(getClient(runtime), spec.tool)
      const result = (await tool.invoke(args)) as Record<string, unknown>
      const reply = spec.describe(result)
      await callback?.({ text: reply })
      return { success: true, text: reply, data: { result } }
    },
    examples: [],
  }
}

export function buildActions(): Action[] {
  return SPECS.map(toAction)
}
