// Built for agents — give an LLM a budget-bound wallet as a couple of tools.
//
// `paymentTools(client)` returns framework-agnostic descriptors (name +
// description + JSON Schema + invoke). The PipRailClient carries the budget, so
// the model can NEVER overspend — every payment goes through the same policy.
//
//   node agent-tools.mjs        # prints the two tool descriptors + a dry-run
//
// Below: the same descriptors wired to MCP, the Vercel AI SDK, and the OpenAI /
// Anthropic function-calling APIs — a few lines each. (No deps added here.)

import { PipRailClient, paymentTools } from '@piprail/sdk'

const client = new PipRailClient({
  wallet: { privateKey: process.env.AGENT_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  chain: 'base',
  // The guardrails that make autonomous spend safe — opt-in, enforced before any send.
  policy: {
    maxAmount: '0.10',          // never pay more than $0.10 for one call
    maxTotal: '5.00',           // never spend more than $5 total (per token)
    chains: ['base'],           // only on Base
    tokens: ['USDC'],           // only in USDC
    hosts: ['*.example.com'],   // only these hosts
  },
  // Optional human/policy-in-the-loop approval on top of the budget.
  onBeforePay: (q) => {
    console.log(`approve ${q.amountFormatted} ${q.symbol} on ${q.network}? (auto-yes under budget)`)
    return true
  },
})

const tools = paymentTools(client)
console.log('Tools an agent can call:')
for (const t of tools) console.log(`  • ${t.name} — ${t.description.slice(0, 72)}…`)

// ── 1. MCP server (@modelcontextprotocol/sdk) ──────────────────────────────
//   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
//   const server = new McpServer({ name: 'piprail', version: '1.0.0' })
//   for (const t of tools) {
//     server.registerTool(t.name, { description: t.description, inputSchema: t.parameters },
//       async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await t.invoke(args)) }] }))
//   }

// ── 2. Vercel AI SDK (`ai`) ────────────────────────────────────────────────
//   import { tool, jsonSchema, generateText } from 'ai'
//   const aiTools = Object.fromEntries(tools.map((t) =>
//     [t.name, tool({ description: t.description, parameters: jsonSchema(t.parameters), execute: t.invoke })]))
//   await generateText({ model, tools: aiTools, prompt: 'Buy the report at https://api.example.com/report' })

// ── 3. OpenAI / Anthropic function calling ─────────────────────────────────
//   const fns = tools.map((t) => ({ type: 'function', function: {
//     name: t.name, description: t.description, parameters: t.parameters } }))
//   …then route the model's tool call to the matching `t.invoke(args)`.

// Dry-run the quote tool (no payment) against the URL, if one is given.
const url = process.env.URL
if (url) {
  const [quoteTool] = tools
  console.log('\nquote:', await quoteTool.invoke({ url }))
  console.log('spent so far:', client.spent())
}
