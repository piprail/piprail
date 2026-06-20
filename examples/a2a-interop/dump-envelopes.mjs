// Dump PipRail's actual A2A wire envelopes to JSON, for the interop probe to validate against
// Google's x402 library. Resolves @piprail/sdk from the workspace (run from the repo root).
//   node examples/a2a-interop/dump-envelopes.mjs   ->   /tmp/pr-required.json + /tmp/pr-payload.json
import { writeFileSync } from 'node:fs'
import { createPaymentGate, createA2APaymentHandler, A2A_REQUIRED_KEY } from '@piprail/sdk'

const PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'

// A gate that dual-advertises the standard `exact` rail (the one a Google A2A wallet can pay).
const gate = createPaymentGate({
  chain: 'base', token: 'USDC', amount: '0.01', payTo: PAYTO, rpcUrl: 'https://base-rpc.publicnode.com',
  exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } },
})
const pay = createA2APaymentHandler({ gate })

// 1. The A2A PaymentRequired (no payload → input-required Task) — the merchant's challenge.
const task = await pay.handleMessage({ kind: 'message' }, 'interop')
const required = task.status.message.metadata[A2A_REQUIRED_KEY]
writeFileSync('/tmp/pr-required.json', JSON.stringify(required, null, 2))

// 2. A sample exact PaymentPayload of the shape the handler consumes (the buyer's submission core).
const exactRail = required.accepts.find((a) => a.scheme === 'exact')
const payload = {
  x402Version: 2,
  accepted: exactRail,
  payload: {
    signature: '0x' + 'cd'.repeat(65),
    authorization: {
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAYTO, value: '10000',
      validAfter: '0', validBefore: '9999999999', nonce: '0x' + '11'.repeat(32),
    },
  },
}
writeFileSync('/tmp/pr-payload.json', JSON.stringify(payload, null, 2))

console.log('wrote /tmp/pr-required.json + /tmp/pr-payload.json')
console.log('  x402Version:', required.x402Version, '| schemes:', required.accepts.map((a) => a.scheme).join(', '))
