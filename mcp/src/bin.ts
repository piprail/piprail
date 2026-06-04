#!/usr/bin/env node
// The executable entry (the `piprail-mcp` bin). Separate from index.ts so the
// shebang lands ONLY here — a `#!` line in the importable library entry would
// break `import '@piprail/mcp'`. esbuild preserves this leading shebang and tsup
// marks the output executable.
import { startServer } from './start.js'

startServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  // stderr only — stdout is the MCP protocol channel.
  console.error(`\n[piprail] ${message}\n`)
  process.exit(1)
})
