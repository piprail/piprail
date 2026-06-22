import { Agent } from '@mastra/core/agent'
import { openai } from '@ai-sdk/openai'
import { piprailMcp } from '../mcp'

/**
 * A Mastra agent that can pay x402 ("HTTP 402 Payment Required") URLs on the user's behalf,
 * within a hard spend policy. The payment tools come from the PipRail MCP server (see `../mcp.ts`);
 * `await piprailMcp.listTools()` registers all 8 PipRail tools statically at agent level. Mastra
 * namespaces MCP tools by the server key, so they surface to the model as `<serverKey>_<tool>` —
 * the instructions below describe each tool by role, so the model uses the exact names from its
 * tool schema rather than any hard-coded string.
 *
 * Swap the model for any Vercel AI SDK provider (or Mastra's `'openai/…'` model router). The
 * example uses OpenAI; set `OPENAI_API_KEY` to run it.
 */
export const paymentAgent = new Agent({
  id: 'payment-agent',
  name: 'PipRail Payment Agent',
  instructions: `You are an agent that can pay for x402-gated APIs and resources on the user's behalf.

The payment rail is PipRail (self-custodial, no facilitator, no fee). You have a hard spend policy
you cannot exceed — paying above the per-payment cap or lifetime budget is refused automatically.

You have PipRail tools for: discovering payable endpoints, quoting a price, planning a payment,
paying, checking your budget, verifying a receipt, and an agent guide. Use the exact tool names as
they appear in your tool list. How to work:
- Before paying anything, READ first: use the quote tool to see the price and chain, then the plan
  tool to confirm the payment is affordable and settleable (funds + gas + recipient ready).
- Only call the pay tool when the user actually wants the paid resource and the quote is within
  budget. It is the ONLY tool that moves money; every other PipRail tool is read-only.
- Use the budget tool to check remaining budget, and the guide tool if you are unsure of the contract.
- Never reveal or ask for the private key — it lives in the server's environment, not the chat.
- If a payment is declined by policy, explain the cap to the user; do not try to work around it.`,
  model: openai('gpt-5'),
  tools: await piprailMcp.listTools(),
})
