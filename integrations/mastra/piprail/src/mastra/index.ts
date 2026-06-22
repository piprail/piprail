import { Mastra } from '@mastra/core'
import { paymentAgent } from './agents/payment-agent'

/**
 * The Mastra instance. Run `mastra dev` to open the playground and chat with the payment agent,
 * or import `mastra` / `paymentAgent` into your own app.
 *
 * This is the first x402 payment integration for Mastra — it gives an agent a budget-bound wallet
 * across every chain PipRail supports, via the `@piprail/mcp` MCP server.
 */
export const mastra = new Mastra({
  agents: { paymentAgent },
})

export { paymentAgent }
