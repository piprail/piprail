// Suite 05 — @piprail/mcp's 8th tool: piprail_verify_receipt  (over real stdio JSON-RPC)
//
// Spawns the PUBLISHED @piprail/mcp binary and drives it the way a real MCP client (Claude
// Desktop, Cursor, …) would. Proves the new receipt-verification tool is wired end-to-end.
//
//   OFFLINE (always): READ-ONLY boot (no wallet key) lists ALL 8 tools incl. piprail_verify_receipt;
//     piprail_verify_receipt returns a graceful { ok:false } verdict on a non-existent tx (read-only,
//     never crashes the server).
//   LIVE (Base mainnet, tiny USDC — only with the .secrets wallet):
//     a key-less piprail_pay_request on a REAL (local) 402 refuses with WALLET_REQUIRED; then mint a
//     REAL receipt from an onchain-proof settle, hand it to piprail_verify_receipt → ok:true +
//     onChain.payTo === merchant + matchesClaims:true; a FORGED payer → ok:true but matchesClaims:false.
//
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createPaymentGate, PipRailClient, HEADER_SIGNATURE, HEADER_REQUIRED, HEADER_RESPONSE } from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC } from '../lib/env.mjs'

banner('05 · MCP piprail_verify_receipt (published bin, real stdio)')
const here = dirname(fileURLToPath(import.meta.url))
const MCP_BIN = resolve(here, '..', 'node_modules/@piprail/mcp/dist/bin.js')
const w = loadWallet()

// The published MCP STRICTLY rejects any unknown PIPRAIL_* env var at boot — so the child must get
// a SCRUBBED env (strip every inherited PIPRAIL_* — e.g. this sandbox's own PIPRAIL_WALLET path —
// then add only what we mean to set). This also documents the contract for real MCP-client authors.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PIPRAIL_')))

/** Boot one MCP subprocess with `env`, run JSON-RPC `requests` SEQUENTIALLY, return id→message. */
function mcp(env, requests) {
  return new Promise((resolveP, reject) => {
    const child = spawn('node', [MCP_BIN], { env: { ...CLEAN_ENV, PIPRAIL_PRIVATE_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = '', stderr = '', idx = 0
    const out = new Map()
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout; stderr: ' + stderr.slice(0, 500))) }, 60000)
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const next = () => {
      if (idx >= requests.length) { clearTimeout(timer); child.kill(); return resolveP(out) }
      send({ jsonrpc: '2.0', ...requests[idx] })
    }
    child.stdout.on('data', (d) => {
      buf += d.toString(); let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue
        let m; try { m = JSON.parse(line) } catch { continue }
        if (m.id === 'init') { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); next(); continue }
        if (m.id != null && idx < requests.length && m.id === requests[idx].id) { out.set(m.id, m); idx++; next() }
      }
    })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('exit', () => { clearTimeout(timer); resolveP(out) })
    send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity-sandbox', version: '1' } } })
  })
}
const textOf = (msg) => (msg?.result?.content ?? []).map((p) => p.text ?? '').join('')
const jsonOf = (msg) => { try { return JSON.parse(textOf(msg)) } catch { return {} } }

// ───────────────────────── OFFLINE ─────────────────────────
group('offline — READ-ONLY boot: 8 tools incl. verify_receipt; verify_receipt is graceful on junk')
{
  const out = await mcp({ PIPRAIL_CHAIN: 'base', PIPRAIL_SCHEMES: 'onchain-proof,exact,upto' }, [
    { id: 'tools', method: 'tools/list' },
    // verify_receipt on a STRUCTURALLY-malformed receipt with NO rpcUrl → the read-only guard
    // rejects it WITHOUT opening a socket, so this can't be faked by a swallowed network error.
    { id: 'verify', method: 'tools/call', params: { name: 'piprail_verify_receipt', arguments: { receipt: {} } } },
    // LIVENESS: the server must STILL answer after a junk call — proving it didn't crash.
    { id: 'alive', method: 'tools/list' },
  ])
  const names = (out.get('tools')?.result?.tools ?? []).map((t) => t.name)
  note(`tools: ${names.join(', ')}`)
  check(names.length === 8, `the published MCP exposes 8 tools (got ${names.length})`)
  check(names.includes('piprail_verify_receipt'), 'the 8th tool piprail_verify_receipt is present')

  const verify = jsonOf(out.get('verify'))
  check(verify.ok === false, 'piprail_verify_receipt returns a graceful { ok:false } on a malformed receipt (read-only guard, no chain read)')
  check((out.get('alive')?.result?.tools ?? []).length === 8, 'the server is STILL alive after a junk verify (it did not crash)')
}

// ───────────────────────── LIVE ─────────────────────────
if (!w) {
  skip('no .secrets wallet → skipping the live mint-a-receipt → verify-via-MCP round-trip')
} else {
  // Mint a real, on-chain receipt in-process.
  const gate = createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: w.merchant, rpcUrl: RPC, receipts: true })
  const PORT = 4851, URL = `http://127.0.0.1:${PORT}/r`
  const server = createServer(async (req, res) => {
    try {
      const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
      if (!sig) { const c = await gate.challenge(URL); res.setHeader(HEADER_REQUIRED, c.requiredHeader); res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify(c.challenge)) }
      const r = await gate.verify(sig)
      if (r.kind === 'paid') { res.setHeader(HEADER_RESPONSE, r.receiptHeader); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
      res.setHeader(HEADER_REQUIRED, r.requiredHeader); res.writeHead(r.statusCode ?? 402, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.challenge))
    } catch (err) { res.writeHead(502, {}); res.end(JSON.stringify({ error: String(err?.message ?? err) })) }
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  try {
    // A key-less MCP refuses to PAY the real (local) 402 — read-only mode, no wallet.
    group('live — key-less piprail_pay_request on a real 402 → WALLET_REQUIRED')
    {
      const out = await mcp({ PIPRAIL_CHAIN: 'base', PIPRAIL_SCHEMES: 'onchain-proof' }, [
        { id: 'pay', method: 'tools/call', params: { name: 'piprail_pay_request', arguments: { url: URL } } },
      ])
      const payText = JSON.stringify(out.get('pay')?.result ?? {})
      check(/WALLET_REQUIRED|wallet|private key|read-only/i.test(payText), 'key-less piprail_pay_request refuses on a real 402 (WALLET_REQUIRED)')
    }

    group('live — mint a real receipt (onchain-proof) → verify it THROUGH the MCP tool')
    const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
    const res = await buyer.fetch(URL)
    check(res.status === 200, 'minted a real receipt via an onchain-proof settle (HTTP 200)')
    const receipt = buyer.lastReceipt()
    check(receipt?.piprail === '1', 'captured the PipRailReceipt')

    // Hand the genuine receipt to the published MCP's verify_receipt tool.
    const env = { PIPRAIL_CHAIN: 'base', PIPRAIL_SCHEMES: 'onchain-proof' }
    const okOut = await mcp(env, [{ id: 'v', method: 'tools/call', params: { name: 'piprail_verify_receipt', arguments: { receipt, rpcUrl: RPC } } }])
    const v = jsonOf(okOut.get('v'))
    note(`MCP verify_receipt → ok=${v.ok} matchesClaims=${v.matchesClaims} payTo=${v.onChain?.payTo}`)
    check(v.ok === true, 'piprail_verify_receipt confirms the REAL settlement on-chain (ok:true)')
    check(v.matchesClaims === true, 'the receipt matches its on-chain claims')
    check((v.onChain?.payTo ?? '').toLowerCase() === w.merchant.toLowerCase(), 're-derived payTo === merchant')

    // A FORGED payer is caught through the MCP exactly as in the library.
    const forged = { ...receipt, receipt: { ...receipt.receipt, payer: '0x000000000000000000000000000000000000dEaD' } }
    const badOut = await mcp(env, [{ id: 'v', method: 'tools/call', params: { name: 'piprail_verify_receipt', arguments: { receipt: forged, rpcUrl: RPC } } }])
    const vf = jsonOf(badOut.get('v'))
    check(vf.ok === true && vf.matchesClaims === false, 'a FORGED payer is caught through the MCP (ok:true, matchesClaims:false)')
  } catch (err) {
    check(false, `live MCP verify_receipt threw: ${err?.message ?? err}`)
  } finally {
    server.close()
  }
}

done(w ? '05 mcp verify_receipt' : '05 mcp verify_receipt (offline)')
