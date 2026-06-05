// Drives the REAL @piprail/mcp the way a real MCP client does: it spawns the
// published bin (dist/bin.js) as a subprocess and speaks the MCP wire protocol to
// it over stdio. Nothing in-process — this is what catches build, shebang,
// ESM-resolution, and stdout-pollution bugs the package's unit tests can't.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const require = createRequire(import.meta.url)

// Resolve the installed @piprail/mcp's bin portably: its main entry is dist/index.js
// and the bin is its sibling dist/bin.js. Works whether @piprail/mcp is installed
// from npm (standalone) or symlinked as a workspace (inside this monorepo) — so the
// harness always drives the SAME artifact a user runs via `npx -y @piprail/mcp`.
export const BIN = join(dirname(require.resolve('@piprail/mcp')), 'bin.js')

export function assertBinBuilt() {
  if (!existsSync(BIN)) {
    throw new Error(
      `@piprail/mcp bin not found at ${BIN}\n` +
        `If you're in the monorepo, build it:  npm run build:sdk && npm run build:mcp  (from the repo root)\n` +
        `If you're standalone, install deps:   npm install  (in this folder)`
    )
  }
}

/**
 * Spawn the real server and connect a real MCP client over stdio. `env` is the
 * ONLY PIPRAIL_* config the child sees (the transport inherits just HOME/PATH/etc.,
 * never ambient PIPRAIL_* vars), so each scenario is hermetic.
 * Returns { client, stderr(), close() }.
 */
export async function connectServer(env = {}) {
  assertBinBuilt()
  const transport = new StdioClientTransport({
    command: process.execPath, // node — same effect as the bin's `#!/usr/bin/env node`
    args: [BIN],
    env,
    stderr: 'pipe',
  })
  let stderrBuf = ''
  transport.stderr?.on('data', (c) => (stderrBuf += c.toString()))

  const client = new Client({ name: 'mcp-sandbox', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport) // spawns the process + completes the MCP handshake

  return {
    client,
    stderr: () => stderrBuf,
    close: async () => {
      try { await client.close() } catch { /* already gone */ }
    },
  }
}

/** Call a tool; return its parsed JSON result + the raw isError flag + the text. */
export async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = Array.isArray(res.content) ? (res.content[0]?.text ?? '') : ''
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { isError: Boolean(res.isError), json, text }
}

/**
 * Boot the bin with a VALID config, let it run `ms`, capture stdout/stderr
 * separately, then kill it. Proves the banner lands on stderr and stdout stays a
 * pristine protocol channel (a single stray stdout byte corrupts MCP framing).
 */
export function bootSnapshot(env = {}, ms = 600) {
  assertBinBuilt()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('error', reject)
    setTimeout(() => { child.kill('SIGKILL'); resolvePromise({ stdout, stderr }) }, ms)
  })
}

/**
 * Spawn the bin WITHOUT a client and wait for it to exit — for the config-error
 * paths, where the server prints to stderr and exits non-zero before any
 * handshake. Resolves { code, stdout, stderr }.
 */
export function runBinToExit(env = {}, { timeoutMs = 10_000 } = {}) {
  assertBinBuilt()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => (stdout += c.toString()))
    child.stderr.on('data', (c) => (stderr += c.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bin did not exit within ${timeoutMs}ms (it kept running — config likely OK)`))
    }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }) })
  })
}
