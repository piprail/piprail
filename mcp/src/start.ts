/**
 * Startup flow — the linear path the bin runs: parse env → build client+server
 * → print the banner (stderr) → connect stdio. Throws on bad config (the bin
 * catches it → stderr + exit 1). Kept separate from the bin so it's importable
 * and the bin stays a 3-line shebang shim.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { parseConfig, configToClientOptions, type Config } from './config.js'
import { createMcpServer } from './server.js'
import { printBanner } from './banner.js'

/** Boot the server against an env (defaults to `process.env`). */
export async function startServer(
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const config: Config = parseConfig(env)
  const { server } = createMcpServer(configToClientOptions(config))
  printBanner(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
