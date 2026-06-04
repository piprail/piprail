#!/usr/bin/env node
// PipRail MCP server — hands a model a budget-bound payment wallet.
//
// paymentTools(client) returns tool descriptors whose `parameters` are JSON
// Schema, so we use the LOW-LEVEL MCP Server (its tool inputSchema *is* JSON
// Schema) rather than the high-level McpServer (which expects Zod shapes).
//
//   AGENT_KEY=0x… node server.mjs        # speaks MCP over stdio
//
// Add to an MCP client, e.g. Claude Desktop's claude_desktop_config.json:
//   { "mcpServers": { "piprail": { "command": "node", "args": ["/abs/path/server.mjs"] } } }

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { PipRailClient, paymentTools } from '@piprail/sdk'

// The client's policy IS the budget — the model literally cannot overspend.
const client = new PipRailClient({
  chain: 'base',
  wallet: { privateKey: process.env.AGENT_KEY },
  policy: {
    maxAmount: '0.10', // per call
    maxTotal: '5.00', // lifetime, per token
    tokens: ['USDC'],
  },
})

const tools = paymentTools(client) // → piprail_quote_payment, piprail_plan_payment, piprail_pay_request

const server = new Server({ name: 'piprail', version: '1.0.0' }, { capabilities: { tools: {} } })

// Advertise the three tools (their parameters are already JSON Schema).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
}))

// Dispatch a tool call to its invoke().
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true }
  try {
    const result = await tool.invoke(req.params.arguments ?? {})
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[piprail] MCP server ready on stdio — budget 0.10/call, 5.00 total USDC on Base')
