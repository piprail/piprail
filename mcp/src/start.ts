/**
 * Startup flow — the linear path the bin runs: parse env → build client+server
 * → print the banner (stderr) → connect stdio. Throws on bad config (the bin
 * catches it → stderr + exit 1). Kept separate from the bin so it's importable
 * and the bin stays a 3-line shebang shim.
 */
import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileSpendStore } from '@piprail/sdk/node'
import type { PipRailEvent } from '@piprail/sdk'
import {
  parseConfig,
  configToClientOptions,
  configToClientOptionsList,
  type Config,
} from './config.js'
import { createMcpServer, type McpServerOptions } from './server.js'
import { printBanner } from './banner.js'

/**
 * Build the operator event sink for `PIPRAIL_EVENT_LOG`: one-line JSON per payment
 * event to `stderr` (the default channel — stdout is the MCP protocol) or to a file.
 * Never throws (a log sink must not break the server); bigints are stringified.
 */
function eventSink(target: string): (event: PipRailEvent) => void {
  return (event) => {
    try {
      const line = `${JSON.stringify(
        { at: new Date().toISOString(), ...event },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
      )}\n`
      if (target.toLowerCase() === 'stderr') process.stderr.write(line)
      else appendFileSync(target, line)
    } catch {
      /* a log sink must never break the server */
    }
  }
}

/** Boot the server against an env (defaults to `process.env`). */
export async function startServer(
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const config: Config = parseConfig(env)
  const serverOpts: McpServerOptions = {
    confirm: config.confirm,
    ...(config.confirmTimeoutMs != null ? { confirmTimeoutMs: config.confirmTimeoutMs } : {}),
    guide: config.guide,
    // Durable budget (survives a restart) + an operator event sink — both opt-in, no backend.
    ...(config.spendLog ? { spendStore: fileSpendStore(config.spendLog) } : {}),
    ...(config.eventLog ? { onEvent: eventSink(config.eventLog) } : {}),
  }
  // Multi-chain (PIPRAIL_CHAINS) ⇒ one client per chain behind a MultiChainPayer (sharing
  // one ledger so the grand total spans chains); single-chain ⇒ the one client.
  const { server } = config.chains
    ? createMcpServer(configToClientOptionsList(config), serverOpts)
    : createMcpServer(configToClientOptions(config), serverOpts)
  printBanner(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
