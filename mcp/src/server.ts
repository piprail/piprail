/**
 * MCP wiring — the whole bridge between the SDK and the protocol, in one place.
 *
 * `paymentTools(client)` already returns tool descriptors whose `parameters` are
 * draft-07 JSON Schema, so we use the LOW-LEVEL `Server` (its `inputSchema` IS
 * JSON Schema) and the schema drops straight onto the wire — no Zod, no
 * conversion. Adding/removing an SDK tool needs zero changes here.
 *
 * Three opt-in layers ride on top, all additive:
 *   - **Mode B (ask-before-pay):** when `confirm`, the SDK's `onBeforePay` seam is
 *     wired to `server.elicitInput()` (see `confirm.ts`). Off ⇒ byte-identical.
 *   - **Structured output:** every tool result is emitted BOTH as a text block and
 *     as `structuredContent`, with an `outputSchema` forwarded for the stable reads.
 *   - **The agent guide:** when `guide` (default on), the `PIPRAIL_AGENT_GUIDE` is
 *     exposed as an MCP prompt + a `piprail://guide` resource, and a read-only
 *     `piprail://budget` resource mirrors the live spend leash.
 *
 * Pure: builds the client + server and wires the handlers, but connects NO
 * transport (the caller owns that) and touches NO network — testable without a chain.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { PipRailClient, paymentTools, PIPRAIL_AGENT_GUIDE } from '@piprail/sdk'
import type { PipRailClientOptions } from '@piprail/sdk'
import { VERSION } from './version.js'
import { buildConfirmHook } from './confirm.js'

/** Options layered onto the base client wiring — all opt-in. */
export interface McpServerOptions {
  /** Mode B: ask the human to approve each payment via elicitation. Default off. */
  confirm?: boolean
  /** Override the elicitation approval window (ms). Default `CONFIRM_TIMEOUT_MS`. */
  confirmTimeoutMs?: number
  /** Expose the agent-guide prompt + the guide/budget resources. Default on. */
  guide?: boolean
}

/** Build a configured PipRail MCP server (and its client) ready to connect to a transport. */
export function createMcpServer(
  clientOptions: PipRailClientOptions,
  opts?: McpServerOptions
): {
  server: Server
  client: PipRailClient
} {
  const guideOn = opts?.guide !== false // default ON (additive — only ADDS a prompt/resource)

  // Late-bind the server so the confirm hook (which needs `server` to call
  // elicitInput) can be merged into the client options BEFORE the client exists.
  // Safe because PipRailClient's constructor never invokes onBeforePay — only
  // authorize() does, at pay-time, long after `server` is assigned and connected.
  let server: Server
  const effectiveOptions: PipRailClientOptions = opts?.confirm
    ? {
        ...clientOptions,
        // An embedder-supplied hook wins; otherwise our elicitation hook.
        onBeforePay:
          clientOptions.onBeforePay ?? buildConfirmHook(() => server, opts.confirmTimeoutMs),
      }
    : clientOptions

  const client = new PipRailClient(effectiveOptions)
  const tools = paymentTools(client) // 7 tools (discover · quote · plan · pay · register · budget · guide)

  // Elicitation is a CLIENT capability — the server only declares tools (+ the
  // guide's prompts/resources when enabled).
  const capabilities: { tools: object; prompts?: object; resources?: object } = { tools: {} }
  if (guideOn) {
    capabilities.prompts = {}
    capabilities.resources = {}
  }
  server = new Server({ name: 'piprail', version: VERSION }, { capabilities })

  // Advertise the tools — JSON Schema passes through untouched, plus the SDK's
  // advisory annotations and (for the stable reads) the result `outputSchema`.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object'; [key: string]: unknown },
      ...(t.annotations ? { annotations: t.annotations } : {}),
      ...(t.outputSchema
        ? { outputSchema: t.outputSchema as { type: 'object'; [key: string]: unknown } }
        : {}),
    })),
  }))

  // Dispatch a call to the matching tool's invoke(). A tool-level failure comes
  // back as an `isError` RESULT (per the MCP spec), not a thrown JSON-RPC error,
  // so the model can read the reason and react. An object result is ALSO emitted
  // as `structuredContent` (additive — clients that ignore it read the text block).
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
      const text = JSON.stringify(result, null, 2)
      const isObject = result != null && typeof result === 'object' && !Array.isArray(result)
      return {
        content: [{ type: 'text', text }],
        ...(isObject ? { structuredContent: result as Record<string, unknown> } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  // The agent guide — a prompt + two resources. Gated behind `guide` so the TOOLS
  // path is byte-identical when off. The budget resource closes over THIS `client`
  // (start.ts may keep discarding the returned client — it doesn't need it here).
  if (guideOn) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'piprail_agent_guide',
          description:
            'How to pay x402 resources with PipRail: the quote → plan → pay loop, reading a refusal, and Mode A vs Mode B.',
        },
      ],
    }))
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      if (req.params.name !== 'piprail_agent_guide') {
        throw new Error(`Unknown prompt: ${req.params.name}`)
      }
      return {
        messages: [{ role: 'user', content: { type: 'text', text: PIPRAIL_AGENT_GUIDE } }],
      }
    })
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        { uri: 'piprail://guide', name: 'PipRail agent guide', mimeType: 'text/markdown' },
        { uri: 'piprail://budget', name: 'PipRail spend budget', mimeType: 'application/json' },
      ],
    }))
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params.uri
      if (uri === 'piprail://guide') {
        return { contents: [{ uri, mimeType: 'text/markdown', text: PIPRAIL_AGENT_GUIDE }] }
      }
      if (uri === 'piprail://budget') {
        const budget = client.budget()
        const payload = { spent: client.spent(), remaining: budget.byAsset, session: budget.session }
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
        }
      }
      throw new Error(`Unknown resource: ${uri}`)
    })
  }

  return { server, client }
}
