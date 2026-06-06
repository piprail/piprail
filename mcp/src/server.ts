/**
 * MCP wiring — the whole bridge between the SDK and the protocol, in one place.
 *
 * `paymentTools(client)` already returns tool descriptors whose `parameters` are
 * draft-07 JSON Schema, so we use the LOW-LEVEL `Server` (its `inputSchema` IS
 * JSON Schema) and the schema drops straight onto the wire — no Zod, no
 * conversion. Adding/removing an SDK tool needs zero changes here.
 *
 * Pure: builds the client + server and wires the two handlers, but connects NO
 * transport (the caller owns that) and touches NO network — so it's testable
 * without a chain.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { PipRailClient, paymentTools } from '@piprail/sdk'
import type { PipRailClientOptions } from '@piprail/sdk'
import { VERSION } from './version.js'

/** Build a configured PipRail MCP server (and its client) ready to connect to a transport. */
export function createMcpServer(clientOptions: PipRailClientOptions): {
  server: Server
  client: PipRailClient
} {
  const client = new PipRailClient(clientOptions)
  const tools = paymentTools(client) // 5 tools (discover · quote · plan · pay · register); .parameters are JSON Schema

  const server = new Server(
    { name: 'piprail', version: VERSION },
    { capabilities: { tools: {} } }
  )

  // Advertise the tools — JSON Schema passes through untouched, and the SDK's
  // advisory annotations (readOnly / destructive / idempotent / openWorld + title)
  // ride along so a client can render the right consent (e.g. flag that the pay
  // tool moves funds). Hints only — the spend policy is the real boundary.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object'; [key: string]: unknown },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }))

  // Dispatch a call to the matching tool's invoke(). A tool-level failure comes
  // back as an `isError` RESULT (per the MCP spec), not a thrown JSON-RPC error,
  // so the model can read the reason and react.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      }
    }
    try {
      const result = await tool.invoke(req.params.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  return { server, client }
}
