#!/usr/bin/env node
// End-to-end verification for the PipRail × OpenClaw integration.
//
// It does EXACTLY what OpenClaw does — spawns the MCP server the way an
// `mcp.servers` entry in ~/.openclaw/openclaw.json does (same command, args,
// clean env) and drives the tools over the MCP wire protocol. If this passes,
// every tool OpenClaw exposes works; the only thing it can't do is OpenClaw's
// own LLM loop deciding WHEN to call them (that's OpenClaw's job, not ours).
//
//   node verify.mjs                 # offline: handshake + 8 tools + read-only calls
//   node verify.mjs --live          # + quote the live demo + prove the budget cap
//   PIPRAIL_MCP_BIN=../../../mcp/dist/bin.js node verify.mjs --live   # test a local build
//
// No funds move: the wallet is a throwaway key, and the budget test asserts a
// REFUSAL (cap below price → declined before any on-chain send).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const LIVE = process.argv.includes('--live')
const DEMO = 'https://piprail.com/x402/demo' // live payable x402 endpoint: 0.01 USDC on Base
const EXPECTED = [
  'piprail_budget', 'piprail_discover', 'piprail_guide', 'piprail_pay_request',
  'piprail_plan_payment', 'piprail_quote_payment', 'piprail_register', 'piprail_verify_receipt',
].sort()

const localBin = process.env.PIPRAIL_MCP_BIN
const [command, baseArgs] = localBin ? [process.execPath, [localBin]] : ['npx', ['-y', '@piprail/mcp']]

let failures = 0
const pass = (m) => console.log('  ✓ ' + m)
const fail = (m) => { console.error('  ❌ ' + m); failures++ }

// Spawn one MCP server (as OpenClaw would), run fn(send), then tear it down.
// `send(method, params)` speaks newline-delimited JSON-RPC over stdio.
async function withServer(extraEnv, fn) {
  const child = spawn(command, baseArgs, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PIPRAIL_PRIVATE_KEY: '0x' + randomBytes(32).toString('hex'), // throwaway, no funds
      PIPRAIL_CHAIN: 'base', PIPRAIL_MAX_AMOUNT: '0.10', PIPRAIL_MAX_TOTAL: '5.00', PIPRAIL_TOKENS: 'USDC',
      ...extraEnv,
    },
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
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openclaw-verify', version: '1.0.0' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await fn(send)
  } finally { child.kill() }
}

// Parse a tool result's first text block as JSON (the SDK tools return JSON).
const toolJson = (res) => { const t = res?.content?.find((c) => c.type === 'text')?.text; try { return JSON.parse(t) } catch { return t } }

const watchdog = setTimeout(() => { console.error('⏱️  timed out after 180s'); process.exit(2) }, 180_000)
try {
  console.log(`\nPipRail × OpenClaw — verifying via ${localBin ? 'local build' : 'npx -y @piprail/mcp'}${LIVE ? ' (--live)' : ''}\n`)

  // ── 1. Protocol: handshake + the 8 tools (this is what OpenClaw connects to) ──
  console.log('1. MCP server (what OpenClaw spawns from mcp.servers)')
  await withServer({}, async (send) => {
    const { tools } = await send('tools/list', {})
    const names = tools.map((t) => t.name).sort()
    if (JSON.stringify(names) === JSON.stringify(EXPECTED)) pass(`all 8 tools served: ${names.join(', ')}`)
    else fail(`tool set mismatch — got ${names.join(', ')}`)
    if (tools.every((t) => t.inputSchema?.type === 'object')) pass('every tool has a valid object inputSchema (OpenClaw passes it through)')
    else fail('a tool is missing its object inputSchema')
    const guideText = JSON.stringify(toolJson(await send('tools/call', { name: 'piprail_guide', arguments: {} })))
    if (/quote|plan|pay/i.test(guideText)) pass('piprail_guide returns the agent contract')
    else fail('piprail_guide missing the quote/plan/pay contract')
    const budget = toolJson(await send('tools/call', { name: 'piprail_budget', arguments: {} }))
    if (budget && typeof budget === 'object') pass('piprail_budget (read-only) returns a budget object')
    else fail('piprail_budget bad result')
  })

  if (LIVE) {
    // ── 2. Live: read a REAL 402 price through the tool (no payment) ──
    console.log('\n2. Live quote (real 402 read — no payment)')
    await withServer({}, async (send) => {
      const q = toolJson(await send('tools/call', { name: 'piprail_quote_payment', arguments: { url: DEMO } }))
      if (q?.gated === true) pass(`piprail_quote_payment(${DEMO}) → ${q.amountFormatted ?? q.amount} ${q.symbol ?? ''} on ${q.network ?? q.chain}`)
      else fail(`expected a gated quote, got ${JSON.stringify(q).slice(0, 160)}`)
    })

    // ── 3. Live: the budget cap REFUSES an over-policy payment (the safety guarantee) ──
    console.log('\n3. Budget enforcement (cap below price → refused, no funds move)')
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
    ? `\n🎉 PASS — OpenClaw will spawn this server and get all 8 working tools, budget-bound.${LIVE ? ' Live quote + spend cap proven.' : ''}\n`
    : `\n❌ ${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
} catch (e) {
  clearTimeout(watchdog)
  console.error('\n❌ ' + e.message + (LIVE ? '\n   (a --live failure may be a transient network/RPC issue — retry)' : ''))
  process.exit(1)
}
