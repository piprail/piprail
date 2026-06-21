// Round-trips the PipRail A2A mount through the REAL @a2a-js/sdk request handler (in-process:
// handler.sendMessage → executor → event bus → ResultManager → Task). If PipRail's Task survives
// the SDK's own machinery with its x402 metadata intact, the documented mount genuinely runs.
//
//   node test.mjs
//
import { buildHandler } from './lib.mjs'
import { A2A_STATUS_KEY, A2A_REQUIRED_KEY, A2A_PAYLOAD_KEY, A2A_X402_EXTENSION_URI_V01 } from '@piprail/sdk'

let pass = true
const ok = (c, m) => { if (!c) { console.error(`  ✗ FAIL: ${m}`); pass = false; process.exitCode = 1 } else console.log(`  ✓ ${m}`) }
const userMsg = (over = {}) => ({ kind: 'message', messageId: 'm-' + Math.random().toString(36).slice(2), role: 'user', parts: [{ kind: 'text', text: 'generate' }], ...over })

console.log('════════ PipRail × @a2a-js/sdk — real in-process round-trip ════════')
const { handler } = buildHandler()

try {
  // 1. The AgentCard the SDK serves advertises the x402 extension.
  const card = await handler.getAgentCard()
  const exts = card.capabilities?.extensions ?? []
  ok(exts.some((e) => e.uri === A2A_X402_EXTENSION_URI_V01), 'AgentCard (served by the SDK) advertises the x402 extension URI')

  // 2. A service request with no payment → the SDK runs our executor and returns a Task. The point:
  //    PipRail's Task + its x402 metadata SURVIVE the SDK's ResultManager and reach the client.
  const result = await handler.sendMessage({ message: userMsg() })
  ok(result?.kind === 'task', `the SDK returned a Task (kind=${result?.kind})`)
  ok(result?.status?.state === 'input-required', `Task state === input-required (got ${result?.status?.state})`)
  ok(!!result?.id && !!result?.contextId, 'the SDK preserved id + contextId on the Task')

  const meta = result?.status?.message?.metadata ?? {}
  ok(meta[A2A_STATUS_KEY] === 'payment-required', 'x402.payment.status === payment-required (intact after the SDK ResultManager)')
  const required = meta[A2A_REQUIRED_KEY]
  ok(required?.x402Version === 2 && Array.isArray(required?.accepts), 'the raw x402.payment.required challenge (x402Version 2) reached the client through the SDK')
  ok(result?.status?.message?.messageId != null, 'the published message carries a messageId (SDK event-correlation requirement)')

  // 3. A bogus follow-up proof on the SAME task → a retryable re-challenge (no crash through the SDK).
  const bogus = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: required.accepts[0].network, asset: required.accepts[0].asset }, payload: { nonce: 'x', txHash: '0x' + 'de'.repeat(32) } }
  const rechallenge = await handler.sendMessage({ message: userMsg({ taskId: result.id, metadata: { [A2A_PAYLOAD_KEY]: bogus } }) })
  ok(rechallenge?.status?.state === 'input-required', 'a bogus proof stays RETRYABLE (input-required) through the SDK — never throws')
  // Per a2a.md §9 (+ Google's reference executor), a payment that fails verification → status
  // `payment-failed`; retry rides on the input-required TASK STATE, not the status.
  ok(rechallenge?.status?.message?.metadata?.[A2A_STATUS_KEY] === 'payment-failed', 'the re-challenge status is payment-failed (spec §9 merchant status; retry via input-required state)')

  console.log('\n════════ ' + (pass ? 'PASSED ✓ — the documented @a2a-js/sdk mount RUNS end-to-end' : 'FAILED ✗') + ' ════════')
} catch (err) {
  console.error('  ERROR:', err?.stack ?? err)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
