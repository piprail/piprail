import { Agent } from '@mastra/core/agent'
import { openai } from '@ai-sdk/openai'
import { piprailMcp } from '../mcp'

/**
 * A Mastra agent that can pay x402 ("HTTP 402 Payment Required") URLs on the user's behalf,
 * within a hard spend policy. The payment tools come from the PipRail MCP server (see `../mcp.ts`);
 * `await piprailMcp.listTools()` registers all 8 `piprail_*` tools statically at agent level.
 *
 * Swap the model for any Vercel AI SDK provider. The example uses OpenAI, matching the Mastra
 * template convention; set `OPENAI_API_KEY` to run it.
 */
export const paymentAgent = new Agent({
  id: 'payment-agent',
  name: 'PipRail Payment Agent',
  instructions: `You are an agent that can pay for x402-gated APIs and resources on the user's behalf.

The payment rail is PipRail (self-custodial, no facilitator, no fee). You have a hard spend policy
you cannot exceed — paying above the per-payment cap or lifetime budget is refused automatically.

How to work:
- Before paying anything, READ first: use piprail_quote_payment to see the price and chain, and
  piprail_plan_payment to confirm the payment is affordable and settleable (funds + gas + recipient).
- Only call piprail_pay_request when the user actually wants the paid resource and the quote is
  within budget. It is the only tool that moves money; every other tool is read-only.
- Use piprail_budget to check remaining budget, and piprail_guide if you are unsure of the contract.
- Never reveal or ask for the private key — it lives in the server's environment, not the chat.
- If a payment is declined by policy, explain the cap to the user; do not try to work around it.`,
  model: openai('gpt-4o'),
  tools: await piprailMcp.listTools(),
})
