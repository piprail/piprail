// Suite 04 — the A2A (Google Agent2Agent) TRANSPORT  — x402's THIRD official transport
//
// A2A carries PipRail's BYTE-IDENTICAL x402 envelopes inside Google Agent2Agent Task/Message
// JSON-RPC metadata (the five `x402.payment.*` keys) instead of HTTP headers — a thin codec
// ABOVE the driver boundary, so every chain family rides A2A for free with ZERO driver changes.
// The SELLER adapter (`createA2APaymentHandler`) shipped in 2.10.0; the buyer/AP2 carriage are
// deferred (they trail on live Google reference-client interop). This proves the seller works.
//
//   OFFLINE (always): no-payload → a payment-required Task carrying the challenge as RAW JSON;
//     the agent-card extension declares the foundation-cited x402 URIs; the failure-receipt helper
//     emits a spec-conformant {success:false, transaction:''} outcome.
//   LIVE (Base mainnet, tiny USDC — only with the .secrets wallet):
//     a REAL onchain-proof payment, verified + settled THROUGH the A2A handler (not gate.verify)
//     → a `completed` Task carrying a real X402Receipt + a result artifact. Plus a bogus-proof
//     rejection → a conformant `payment-required` re-challenge + error + failure receipt (free RPC read, no spend).
//
import { createServer } from 'node:http'
import {
  createPaymentGate, PipRailClient, decodeBase64Json,
  createA2APaymentHandler, fromA2APaymentRequired, toA2APaymentFailed,
  A2A_PAYLOAD_KEY, A2A_REQUIRED_KEY, A2A_STATUS_KEY, A2A_RECEIPTS_KEY, A2A_ERROR_KEY,
  A2A_X402_EXTENSION_URI_V01, A2A_X402_EXTENSION_URI_V02, A2A_EXTENSIONS_HEADER,
  HEADER_SIGNATURE, HEADER_REQUIRED,
} from '@piprail/sdk'
import { check, banner, group, note, skip, done } from '../lib/report.mjs'
import { loadWallet, RPC, USDC } from '../lib/env.mjs'

banner('04 · A2A (GOOGLE AGENT2AGENT) TRANSPORT')
const w = loadWallet()
const MERCHANT = w?.merchant ?? '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const baseGate = (over = {}) => createPaymentGate({ chain: 'base', token: 'USDC', amount: '0.001', payTo: MERCHANT, rpcUrl: RPC, ...over })

// ───────────────────────── OFFLINE ─────────────────────────
group('offline — Task lifecycle, the agent-card extension, and the failure-receipt helper')
{
  const pay = createA2APaymentHandler({ gate: baseGate() })

  // No payload → an input-required Task with status payment-required + the challenge as RAW JSON.
  const task = await pay.handleMessage({ kind: 'message', parts: [{ kind: 'text', text: 'generate an image' }] }, 'task-1')
  check(task.status.state === 'input-required', 'a service request with no payment → Task state input-required')
  const meta = task.status.message?.metadata ?? {}
  check(meta[A2A_STATUS_KEY] === 'payment-required', 'metadata x402.payment.status === payment-required')
  const required = meta[A2A_REQUIRED_KEY]
  check(required && typeof required === 'object' && required.x402Version === 2, 'the challenge rides as a RAW JSON object (not a base64 header), x402Version 2')
  check(required?.accepts?.[0]?.scheme === 'onchain-proof', 'the carried challenge offers the onchain-proof rail')
  check(JSON.stringify(fromA2APaymentRequired(task)) === JSON.stringify(required), 'fromA2APaymentRequired round-trips the carried challenge')

  // The agent-card extension declares the x402 capability with the foundation-cited URIs.
  const ext = pay.agentCardExtension({ required: true })
  check(ext.uri === A2A_X402_EXTENSION_URI_V01, 'agentCardExtension() → the v0.1 URI (the foundation/Google-cited default)')
  check(ext.required === true && /x402/i.test(ext.description ?? ''), 'the extension is marked required + describes x402')
  check(pay.agentCardExtension({ version: 'v0.2' }).uri === A2A_X402_EXTENSION_URI_V02, 'version:"v0.2" → the AP2 Embedded-Flow URI')
  check('required' in pay.agentCardExtension() === false, 'required is omitted by default')
  check(A2A_EXTENSIONS_HEADER === 'X-A2A-Extensions', 'the spec-exact activation header name is exported')

  // The exported failure-receipt helper emits a spec-conformant outcome.
  const fail = toA2APaymentFailed('settlement_failed', 'relayer down', [], 'eip155:8453')
  check(fail[A2A_STATUS_KEY] === 'payment-failed', 'toA2APaymentFailed → status payment-failed')
  const receipts = fail[A2A_RECEIPTS_KEY]
  const last = receipts[receipts.length - 1]
  check(last.success === false && last.transaction === '' && last.network === 'eip155:8453',
    "the failure receipt is conformant (success:false, transaction:'' never missing, network set)")
}

// ───────────────────────── LIVE ─────────────────────────
if (!w) {
  skip('no .secrets wallet → skipping the live A2A settle + bogus-proof rejection')
} else {
// A REAL onchain-proof payment, but the seller verifies + settles it THROUGH the A2A handler.
// The HTTP buyer is unchanged — we only swap the verification seam from gate.verify(b64) to
// pay.handleMessage(A2A payload). That is exactly the "every chain rides A2A for free" claim.
group('live — a real Base payment, settled THROUGH the A2A handler → completed Task + receipt')
const gate = baseGate({ receipts: true })
const pay = createA2APaymentHandler({
  gate,
  fulfill: async () => [{ name: 'result', parts: [{ kind: 'text', text: 'the paid resource' }] }],
})
let completedTask = null
const PORT = 4841
const URL = `http://127.0.0.1:${PORT}/a2a`
const server = createServer(async (req, res) => {
  try {
    const sig = req.headers[HEADER_SIGNATURE] ?? req.headers['payment-signature']
    if (!sig) {
      const c = await gate.challenge(URL)
      res.setHeader(HEADER_REQUIRED, c.requiredHeader)
      res.writeHead(402, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(c.challenge))
    }
    // Route the buyer's REAL payment payload through the A2A SELLER adapter.
    const payload = decodeBase64Json(sig)
    const taskId = 'live-a2a-1'
    const task = await pay.handleMessage({ kind: 'message', taskId, metadata: { [A2A_PAYLOAD_KEY]: payload } }, taskId)
    if (task.status.state === 'completed') {
      completedTask = task
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, via: 'a2a' }))
    }
    // Anything else → re-challenge so the buyer could retry (not expected on the happy path).
    const c = await gate.challenge(URL)
    res.setHeader(HEADER_REQUIRED, c.requiredHeader)
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify(c.challenge))
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message ?? err) }))
  }
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

try {
  const buyer = new PipRailClient({ chain: 'base', wallet: { key: w.key }, rpcUrl: RPC })
  note('the SAME HTTP buyer pays — only the seller-side verification seam is A2A')
  const res = await buyer.fetch(URL)
  check(res.status === 200, 'the real payment settled via the A2A handler (HTTP 200)')
  check(completedTask?.status.state === 'completed', 'the A2A Task reached state `completed`')
  check(completedTask?.status.message?.metadata?.[A2A_STATUS_KEY] === 'payment-completed', 'metadata x402.payment.status === payment-completed')
  const rcpts = completedTask?.status.message?.metadata?.[A2A_RECEIPTS_KEY] ?? []
  check(rcpts.length === 1 && rcpts[0].success === true, 'the Task carries exactly one SUCCESS X402Receipt')
  check(/^0x[0-9a-fA-F]{64}$/.test(rcpts[0]?.transaction ?? ''), 'the receipt carries a real on-chain tx hash')
  check(completedTask?.artifacts?.[0]?.parts?.[0]?.text === 'the paid resource', 'the fulfilled result rides back as an A2A artifact')

  // The receipt is independently re-verifiable (the same portable proof, just delivered over A2A).
  const v = await PipRailClient.verifyReceipt({ piprail: '1', receipt: rcpts[0], resource: URL }, { rpcUrl: RPC })
  check(v.ok === true && v.onChain.payTo.toLowerCase() === w.merchant.toLowerCase(), 'the A2A-delivered receipt re-verifies on-chain (payTo === merchant)')
} catch (err) {
  check(false, `live A2A settle threw: ${err?.message ?? err}`)
} finally {
  server.close()
}

// A BOGUS proof (a tx that doesn't exist) → a conformant, RETRYABLE rejection. Free RPC read, no spend.
group('live — a bogus proof → payment-required re-challenge + error + failure receipt (no money moves)')
{
  const rejectGate = baseGate()
  const rpay = createA2APaymentHandler({ gate: rejectGate })
  const challenge = await rpay.handleMessage({ kind: 'message' }, 'task-bad')
  const ch = fromA2APaymentRequired(challenge)
  const accept = ch.accepts.find((a) => a.scheme === 'onchain-proof')
  const payload = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: accept.network, asset: accept.asset }, payload: { nonce: 'echoed', txHash: '0x' + 'de'.repeat(32) } }
  const task = await rpay.handleMessage({ kind: 'message', taskId: 'task-bad', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-bad')
  const meta = task.status.message?.metadata ?? {}
  check(task.status.state === 'input-required', 'a rejected proof stays RETRYABLE (input-required), never terminal `failed`')
  // Per the A2A x402 spec, the MERCHANT's retryable status is `payment-required` (NOT the
  // client-only `payment-rejected`); the rejection is signalled by the error code + a failure receipt.
  check(meta[A2A_STATUS_KEY] === 'payment-required', 'merchant re-challenge status === payment-required (spec; not the client-only payment-rejected)')
  check(!!meta[A2A_ERROR_KEY], 'an x402.payment.error code is attached (marks it a rejection, not a first challenge)')
  const failed = (meta[A2A_RECEIPTS_KEY] ?? []).slice(-1)[0]
  check(failed?.success === false && failed?.transaction === '', 'a failure receipt (success:false, transaction:"") is appended')
  check(!!meta[A2A_REQUIRED_KEY], 'a FRESH challenge is attached to retry against')
}
}

done(w ? '04 a2a' : '04 a2a (offline)')
