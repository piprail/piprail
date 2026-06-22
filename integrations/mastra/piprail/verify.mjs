#!/usr/bin/env node
// End-to-end verification for the PipRail × Mastra integration.
//
// Mastra consumes PipRail as a standard MCP server (`@mastra/mcp`'s MCPClient spawning
// `npx -y @piprail/mcp`). This script proves two layers:
//
//   1. The MCP server itself — handshake + all 8 piprail_* tools (zero dependencies; spawns the
//      server exactly as MCPClient does and drives it over JSON-RPC). Always runs.
//   2. The Mastra-native path — instantiates the REAL `@mastra/mcp` MCPClient and asserts
//      `listTools()` surfaces all 8 PipRail tools to a Mastra agent. Runs only with `--mastra`
//      (needs `npm install` first); skipped with a note otherwise.
//
//   node verify.mjs                 # offline: handshake + 8 tools + read-only calls
//   node verify.mjs --live          # + quote the live demo + prove the budget cap refuses overspend
//   node verify.mjs --mastra        # + drive the real @mastra/mcp MCPClient.listTools()
//   node verify.mjs --live --mastra # everything
//   PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live --mastra   # test a local build
//
// No funds move: the wallet is a throwaway key, and the budget test asserts a REFUSAL.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const LIVE = process.argv.includes('--live')
const MASTRA = process.argv.includes('--mastra')
const DEMO = 'https://piprail.com/x402/demo' // live payable x402 endpoint: 0.01 USDC on Base
const EXPECTED = [
  'piprail_budget', 'piprail_discover', 'piprail_guide', 'piprail_pay_request',
  'piprail_plan_payment', 'piprail_quote_payment', 'piprail_register', 'piprail_verify_receipt',
].sort()

const localBin = process.env.PIPRAIL_MCP_BIN
const [command, baseArgs] = localBin ? [process.execPath, [localBin]] : ['npx', ['-y', '@piprail/mcp']]
const serverEnv = {
  PIPRAIL_PRIVATE_KEY: '0x' + randomBytes(32).toString('hex'), // throwaway, no funds
  PIPRAIL_CHAIN: 'base', PIPRAIL_MAX_AMOUNT: '0.10', PIPRAIL_MAX_TOTAL: '5.00', PIPRAIL_TOKENS: 'USDC',
}

let failures = 0
const pass = (m) => console.log('  ✓ ' + m)
const fail = (m) => { console.error('  ❌ ' + m); failures++ }

// Spawn one MCP server (as MCPClient would), run fn(send), then tear it down.
async function withServer(extraEnv, fn) {
  const child = spawn(command, baseArgs, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...serverEnv, ...extraEnv },
  })
  const pending = new Map()
  let buf = '', nextId = 1
  child.stdout.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)) }, 60_000)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mastra-verify', version: '1.0.0' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await fn(send)
  } finally { child.kill() }
}

const toolJson = (res) => { const t = res?.content?.find((c) => c.type === 'text')?.text; try { return JSON.parse(t) } catch { return t } }

const watchdog = setTimeout(() => { console.error('⏱️  timed out after 240s'); process.exit(2) }, 240_000)
try {
  console.log(`\nPipRail × Mastra — verifying via ${localBin ? 'local build' : 'npx -y @piprail/mcp'}${LIVE ? ' (--live)' : ''}${MASTRA ? ' (--mastra)' : ''}\n`)

  // ── 1. Protocol: handshake + the 8 tools (what Mastra's MCPClient connects to) ──
  console.log('1. MCP server (what @mastra/mcp MCPClient spawns)')
  await withServer({}, async (send) => {
    const { tools } = await send('tools/list', {})
    const names = tools.map((t) => t.name).sort()
    if (JSON.stringify(names) === JSON.stringify(EXPECTED)) pass(`all 8 tools served: ${names.join(', ')}`)
    else fail(`tool set mismatch — got ${names.join(', ')}`)
    if (tools.every((t) => t.inputSchema?.type === 'object')) pass('every tool has a valid object inputSchema (Mastra registers each as a callable tool)')
    else fail('a tool is missing its object inputSchema')
    const budget = toolJson(await send('tools/call', { name: 'piprail_budget', arguments: {} }))
    if (budget && typeof budget === 'object') pass('piprail_budget (read-only) returns a budget object')
    else fail('piprail_budget bad result')
  })

  // ── 2. Mastra-native: drive the REAL @mastra/mcp MCPClient ──
  if (MASTRA) {
    console.log('\n2. Mastra-native (real @mastra/mcp MCPClient.listTools())')
    let MCPClient
    try { ({ MCPClient } = await import('@mastra/mcp')) }
    catch { fail('@mastra/mcp not installed — run `npm install` in this folder, then re-run with --mastra'); MCPClient = null }
    if (MCPClient) {
      const client = new MCPClient({
        id: 'piprail-verify-' + randomBytes(3).toString('hex'),
        servers: { piprail: { command, args: baseArgs, env: serverEnv } },
      })
      try {
        const tools = await client.listTools()
        const keys = Object.keys(tools)
        const present = EXPECTED.filter((name) => keys.some((k) => k.includes(name)))
        if (present.length === EXPECTED.length) pass(`MCPClient.listTools() surfaces all 8 PipRail tools to a Mastra agent (${keys.length} keys)`)
        else fail(`MCPClient.listTools() missing ${EXPECTED.filter((n) => !present.includes(n)).join(', ')} — got keys: ${keys.join(', ')}`)
        if (keys.every((k) => typeof tools[k]?.execute === 'function')) pass('every surfaced tool is callable (has execute) — wires straight into new Agent({ tools })')
        else fail('a surfaced tool is missing execute()')
      } finally { await client.disconnect().catch(() => {}) }
    }
  } else {
    console.log('\n(skip Mastra-native MCPClient check — re-run with `--mastra` after `npm install`)')
  }

  if (LIVE) {
    console.log('\n3. Live quote (real 402 read — no payment)')
    await withServer({}, async (send) => {
      const q = toolJson(await send('tools/call', { name: 'piprail_quote_payment', arguments: { url: DEMO } }))
      if (q?.gated === true) pass(`piprail_quote_payment(${DEMO}) → ${q.amountFormatted ?? q.amount} ${q.symbol ?? ''} on ${q.network ?? q.chain}`)
      else fail(`expected a gated quote, got ${JSON.stringify(q).slice(0, 160)}`)
    })

    console.log('\n4. Budget enforcement (cap below price → refused, no funds move)')
    await withServer({ PIPRAIL_MAX_AMOUNT: '0.001' }, async (send) => { // 0.001 < demo's 0.01
      const r = toolJson(await send('tools/call', { name: 'piprail_pay_request', arguments: { url: DEMO } }))
      if (r?.declined === true || r?.ok === false) pass(`piprail_pay_request refused by policy (${r.code ?? r.reasonCode ?? 'declined'}) — the model cannot overspend`)
      else fail(`expected a policy refusal, got ${JSON.stringify(r).slice(0, 160)}`)
    })
  } else {
    console.log('\n(skip live demo + budget-enforcement checks — re-run with `--live`)')
  }

  clearTimeout(watchdog)
  console.log(failures === 0
    ? `\n🎉 PASS — a Mastra agent gets all 8 working PipRail tools, budget-bound.${MASTRA ? ' Proven through the real @mastra/mcp MCPClient.' : ''}${LIVE ? ' Live quote + spend cap proven.' : ''}\n`
    : `\n❌ ${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
} catch (e) {
  clearTimeout(watchdog)
  console.error('\n❌ ' + e.message + (LIVE ? '\n   (a --live failure may be a transient network/RPC issue — retry)' : ''))
  process.exit(1)
}
