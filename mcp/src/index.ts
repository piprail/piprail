/**
 * @piprail/mcp — a Model Context Protocol server that wraps `@piprail/sdk`, so
 * any MCP client (Claude Desktop, Cursor, Claude Code, Windsurf, …) can pay
 * x402 payment-gated URLs autonomously — capped by a local spend policy the
 * model cannot exceed. Local-only, no backend, no custody.
 *
 *   Run it:    npx -y @piprail/mcp        (configured via PIPRAIL_* env — see README)
 *   Embed it:  import { createMcpServer, startServer } from '@piprail/mcp'
 *
 * This is the LIBRARY entry (no side effects, no shebang). The executable lives
 * in ./bin.ts → dist/bin.js (the `piprail-mcp` bin).
 */
export { createMcpServer } from './server.js'
export {
  parseConfig,
  configToClientOptions,
  walletInputFor,
  ConfigError,
  type Config,
} from './config.js'
export { formatBanner, printBanner, chainWarnings, TOOL_NAMES } from './banner.js'
export { startServer } from './start.js'
export { VERSION } from './version.js'
