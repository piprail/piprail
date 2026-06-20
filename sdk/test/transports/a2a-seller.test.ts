/**
 * The A2A SELLER adapter (`createA2APaymentHandler`) — x402 over Google Agent2Agent,
 * the offline-testable seller core (x402-parity Phase 3). A controllable fake EVM driver
 * (via registerDriver, the server-exact.test.ts harness) proves the transport mapping,
 * the rejection state mapping, the cross-transport replay invariant (B5), and the
 * fulfill-throws-after-settle edge (B7) — independent of any chain.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createPaymentGate, requirePayment } from '../../src/server.js'
import {
  createA2APaymentHandler,
  fromA2APaymentRequired,
  toA2APaymentFailed,
  A2A_STATUS_KEY,
  A2A_REQUIRED_KEY,
  A2A_PAYLOAD_KEY,
  A2A_RECEIPTS_KEY,
  A2A_ERROR_KEY,
  A2A_X402_EXTENSION_URI_V01,
  A2A_X402_EXTENSION_URI_V02,
  A2A_EXTENSIONS_HEADER,
} from '../../src/transports/a2a.js'
import type { A2AMessage, A2ATask } from '../../src/transports/a2a-types.js'
import { registerDriver } from '../../src/drivers/index.js'
import type { PaymentDriver } from '../../src/drivers/types.js'
import { resolveExactRailEvm } from '../../src/drivers/evm/exact.js'
import { SettlementError } from '../../src/errors.js'
import type { X402Receipt, SettleOutcome } from '../../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC = '0xusdc'
const RELAYER = { key: '0x' + 'ab'.repeat(32) }

let settleMode: 'ok' | 'invalid' | 'throw' = 'ok'

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      // onchain-proof verify: ok unless the proof ref says otherwise (the ref encodes the verdict).
      verify: async (ref, accept) =>
        ref.startsWith('0xbad')
          ? { ok: false, error: 'amount_too_low', detail: 'Paid 1, required 50000.' }
          : { ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } },
      exactPermit2Supported: () => true,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({ asset, method, readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null), permit2Supported: () => true }),
      settleExactSelf: async ({ payload, accept }) => {
        if (settleMode === 'throw') throw new SettlementError('relayer out of gas')
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'Authorized 1, required 50000.' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: 'authorization' in payload ? payload.authorization.from : 'x', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeEvm)

afterEach(() => { settleMode = 'ok' })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const AUTH = (over: Record<string, string> = {}) => ({
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAY_TO, value: '50000', validAfter: '0', validBefore: '9999999999',
  nonce: '0x' + Math.floor(Math.random() * 1e12).toString(16).padStart(64, '0'), ...over,
})

const baseGate = (over = {}) => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...over })
const exactGateCfg = { exact: { settle: 'self' as const, relayer: RELAYER } }

/** An onchain-proof submission Message echoing the gate's challenge nonce + a proof ref. */
function proofMessage(taskId: string, challenge: A2ATask, ref = '0xgoodproof'): A2AMessage {
  const ch = fromA2APaymentRequired(challenge)!
  const accept = ch.accepts.find((a) => a.scheme === 'onchain-proof')!
  const payload = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: accept.network, asset: accept.asset }, payload: { nonce: 'echoed-nonce', txHash: ref } }
  return { kind: 'message', taskId, metadata: { [A2A_PAYLOAD_KEY]: payload } }
}

describe('A2A seller — no payload → input-required + x402.payment.required', () => {
  it('a service request (no payload) returns a payment-required Task with the challenge as RAW JSON', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const task = await pay.handleMessage({ kind: 'message', parts: [{ kind: 'text', text: 'generate an image' }] }, 'task-1')
    expect(task.status.state).toBe('input-required')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-required')
    // The challenge rides as a RAW object, not a base64 string.
    const required = meta[A2A_REQUIRED_KEY]!
    expect(typeof required).toBe('object')
    expect(required.x402Version).toBe(2)
    expect(required.accepts[0]!.scheme).toBe('onchain-proof')
    expect(fromA2APaymentRequired(task)).toEqual(required)
  })
})

describe('A2A seller — valid payload → completed + receipts + payment-completed', () => {
  it('settles an onchain-proof payload → completed Task carrying an X402Receipt + an artifact', async () => {
    // Canonical A2AArtifact shape: content lives under `parts` (not flat kind/text) — matches the docs.
    const pay = createA2APaymentHandler({ gate: baseGate(), fulfill: async () => [{ name: 'result', parts: [{ kind: 'text', text: '42' }] }] })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-2')
    const task = await pay.handleMessage(proofMessage('task-2', challenge), 'task-2')
    expect(task.status.state).toBe('completed')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-completed')
    const receipts = meta[A2A_RECEIPTS_KEY]!
    expect(receipts).toHaveLength(1)
    expect((receipts[0] as X402Receipt).success).toBe(true)
    expect((receipts[0] as X402Receipt).transaction).toBe('0xgoodproof')
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts![0]!.parts![0]).toMatchObject({ kind: 'text', text: '42' }) // content in `parts`
  })

  it('a handler built WITHOUT fulfill still completes (metadata-only receipt, no artifacts)', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-3')
    const task = await pay.handleMessage(proofMessage('task-3', challenge), 'task-3')
    expect(task.status.state).toBe('completed')
    expect(task.artifacts).toBeUndefined()
    expect((task.status.message!.metadata![A2A_RECEIPTS_KEY]![0] as X402Receipt).success).toBe(true)
  })
})

describe('A2A seller — rejected proof → conformant re-challenge (RETRYABLE)', () => {
  it('a rejected onchain-proof → input-required re-challenge, merchant status payment-required (spec) + error + a failure receipt', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-4')
    const task = await pay.handleMessage(proofMessage('task-4', challenge, '0xbadproof'), 'task-4')
    expect(task.status.state).toBe('input-required') // retryable, never terminal `failed`
    const meta = task.status.message!.metadata!
    // Per the A2A x402 spec §5.1 + Google's reference merchant executor, the merchant's only
    // retryable status is `payment-required` (it re-issues a challenge). `payment-rejected` is a
    // CLIENT→merchant status (the client rejecting the offered requirements); `payment-failed` is
    // the TERMINAL settlement failure. A rejected proof is distinguished from a FIRST challenge by
    // the appended failure receipt + the `x402.payment.error` code — NOT by the status string.
    expect(meta[A2A_STATUS_KEY]).toBe('payment-required')
    expect(meta[A2A_REQUIRED_KEY]).toBeDefined() // a fresh challenge to retry against
    expect(meta[A2A_ERROR_KEY]).toBe('INVALID_AMOUNT') // amount_too_low → INVALID_AMOUNT
    // The a2a.md Invalid-Payment example mandates a failure receipt with network + transaction:''.
    const receipts = meta[A2A_RECEIPTS_KEY]! as SettleOutcome[]
    const failed = receipts[receipts.length - 1]!
    expect(failed.success).toBe(false)
    expect(failed.transaction).toBe('') // §SettleResponse: empty string, never a missing key
    expect(failed.network).toBe('eip155:8453') // attributed to the challenge's single rail network
  })

  it('a FIRST challenge (empty payload) is payment-required with NO error/receipt — distinct from a rejection re-challenge', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const task = await pay.handleMessage({ kind: 'message' }, 'task-4b')
    const meta = task.status.message!.metadata!
    expect(task.status.state).toBe('input-required')
    expect(meta[A2A_STATUS_KEY]).toBe('payment-required')
    // The discriminator vs a rejection: a first challenge has NO error code and NO failure receipt.
    expect(meta[A2A_ERROR_KEY]).toBeUndefined()
    expect(meta[A2A_RECEIPTS_KEY]).toBeUndefined()
  })

  it('the exported toA2APaymentFailed helper emits a conformant receipt (success:false + transaction:"" + network)', () => {
    const meta = toA2APaymentFailed('settlement_failed', 'relayer down', [], 'eip155:8453')
    expect(meta[A2A_STATUS_KEY]).toBe('payment-failed')
    const receipts = meta[A2A_RECEIPTS_KEY]! as SettleOutcome[]
    const failed = receipts[receipts.length - 1]!
    expect(failed.success).toBe(false)
    expect(failed.transaction).toBe('') // never a missing key (§SettleResponse)
    expect(failed.network).toBe('eip155:8453')
    expect(failed.errorReason).toContain('relayer down')
  })
})

describe('A2A seller — settle-side SettlementError → failed + error + {success:false} receipt', () => {
  it('a SettlementError (the money never moved) → failed Task + x402.payment.error + a failure receipt', async () => {
    settleMode = 'throw'
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-5')
    const ch = fromA2APaymentRequired(challenge)!
    const exactRail = ch.accepts.find((a) => a.scheme === 'exact')!
    const payload = { x402Version: 2, accepted: exactRail, payload: { signature: '0xsig', authorization: AUTH() } }
    const msg: A2AMessage = { kind: 'message', taskId: 'task-5', metadata: { [A2A_PAYLOAD_KEY]: payload } }
    const task = await pay.handleMessage(msg, 'task-5')
    expect(task.status.state).toBe('failed')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-failed')
    expect(meta[A2A_ERROR_KEY]).toBe('SETTLEMENT_FAILED')
    const receipts = meta[A2A_RECEIPTS_KEY]!
    const failed = receipts[receipts.length - 1] as SettleOutcome
    expect(failed.success).toBe(false)
    // The x402 v2 SettlementResponse marks `transaction` Required ('' if settlement failed) — emit it.
    expect(failed.transaction).toBe('')
    expect('transaction' in failed).toBe(true)
    // The terminal failure receipt also carries the network the buyer attempted (from the payload).
    expect(failed.network).toBe('eip155:8453')
  })

  it('sources the failure-receipt network from a v1-FLAT payload (top-level network, no accepted.network)', async () => {
    settleMode = 'throw'
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-5b')
    const exactRail = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact')!
    const { network, ...acceptedNoNet } = exactRail as unknown as Record<string, unknown> // strip accepted.network
    // v1-FLAT shape: network at the TOP level, not under `accepted` — networkFromPayload must read it.
    const payload = { x402Version: 1, network, accepted: acceptedNoNet, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-5b', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-5b')
    const receipts = task.status.message!.metadata![A2A_RECEIPTS_KEY]!
    const failed = receipts[receipts.length - 1] as SettleOutcome
    expect(failed.success).toBe(false)
    expect(failed.network).toBe('eip155:8453') // sourced from the top-level v1-flat field, not accepted.network
  })

  it('the per-task receipts[] history is BOUNDED (a pinned taskId + repeated throws cannot grow it unbounded)', async () => {
    settleMode = 'throw'
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-cap')
    const ch = fromA2APaymentRequired(challenge)!
    const exactRail = ch.accepts.find((a) => a.scheme === 'exact')!
    let last
    for (let i = 0; i < 200; i++) {
      const payload = { x402Version: 2, accepted: exactRail, payload: { signature: '0xsig', authorization: AUTH() } }
      last = await pay.handleMessage({ kind: 'message', taskId: 'task-cap', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-cap')
    }
    const receipts = last!.status.message!.metadata![A2A_RECEIPTS_KEY]!
    expect(receipts.length).toBeLessThanOrEqual(64) // capped, not 200
  })
})

describe('A2A seller — B5: HTTP + A2A share ONE replay set (cross-transport replay-rejection)', () => {
  it('a proof settled over A2A is rejected when resubmitted over HTTP (shared isUsed/markUsed)', async () => {
    // ONE shared replay store — the mandatory B5 fix when HTTP builds its own gate.
    const used = new Set<string>()
    const store = { isUsed: (r: string) => used.has(r), markUsed: (r: string) => { used.add(r) } }

    const a2aGate = baseGate(store)
    const pay = createA2APaymentHandler({ gate: a2aGate })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-6')
    const proof = proofMessage('task-6', challenge, '0xsharedproof')
    const a2aTask = await pay.handleMessage(proof, 'task-6')
    expect(a2aTask.status.state).toBe('completed') // settled once over A2A

    // The SAME proof over HTTP requirePayment built from the SAME shared store → rejected.
    const sigHeader = b64((proof.metadata![A2A_PAYLOAD_KEY] as object))
    const mw = requirePayment({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...store })
    let httpStatus = 0
    let httpBody: { error?: string; extensions?: { piprail?: { code?: string } } } = {}
    await mw(
      { headers: { 'payment-signature': sigHeader } } as never,
      { setHeader() {}, status(c: number) { httpStatus = c; return this }, json(b: unknown) { httpBody = b as never; return this } } as never,
      () => { httpStatus = 200 }
    )
    expect(httpStatus).toBe(402)
    // The conformant 402 body carries the machine code in extensions.piprail.code (the reason
    // string `error` is "tx_already_used: …"); both prove the cross-transport replay was caught.
    expect(httpBody.extensions!.piprail!.code).toBe('tx_already_used')
    expect(httpBody.error).toMatch(/^tx_already_used/)
  })

  it('the REVERSE: a proof settled over HTTP is rejected when resubmitted over A2A', async () => {
    const used = new Set<string>()
    const store = { isUsed: (r: string) => used.has(r), markUsed: (r: string) => { used.add(r) } }

    // Build the HTTP gate + the A2A handler from gates that SHARE the store.
    const a2aGate = baseGate(store)
    const pay = createA2APaymentHandler({ gate: a2aGate })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-7')
    const proof = proofMessage('task-7', challenge, '0xreverseproof')
    const sigHeader = b64((proof.metadata![A2A_PAYLOAD_KEY] as object))

    // Settle over HTTP first.
    const mw = requirePayment({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...store })
    let httpOk = false
    await mw(
      { headers: { 'payment-signature': sigHeader } } as never,
      { setHeader() {}, status() { return this }, json() { return this } } as never,
      () => { httpOk = true }
    )
    expect(httpOk).toBe(true)

    // The same proof over A2A → rejected (re-challenge with tx_already_used → DUPLICATE_NONCE).
    const a2aTask = await pay.handleMessage(proof, 'task-7')
    expect(a2aTask.status.state).toBe('input-required')
    expect(a2aTask.status.message!.metadata![A2A_ERROR_KEY]).toBe('DUPLICATE_NONCE')
  })
})

describe('A2A seller — B7: fulfill throws AFTER a successful settle', () => {
  it('Task completes (carrying the success receipt + an error annotation), spend recorded ONCE', async () => {
    let fulfillCalls = 0
    const pay = createA2APaymentHandler({
      gate: baseGate(),
      fulfill: async () => { fulfillCalls++; throw new Error('image generator crashed') },
    })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-8')
    const task = await pay.handleMessage(proofMessage('task-8', challenge, '0xpaidthenfail'), 'task-8')
    // NEVER input-required / failed — the money moved, so re-paying would double-spend.
    expect(task.status.state).toBe('completed')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-completed')
    const receipts = meta[A2A_RECEIPTS_KEY]!
    expect((receipts[0] as X402Receipt).success).toBe(true) // the success receipt is carried
    expect(receipts).toHaveLength(1) // spend recorded ONCE
    // The post-settle failure surfaces in an artifact annotation, not as a re-challenge.
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts![0]!.metadata!['x402.fulfillment.settled']).toBe(true)
    expect(task.artifacts![0]!.metadata!['x402.fulfillment.error']).toContain('image generator crashed')
    expect(fulfillCalls).toBe(1)
  })
})

describe('A2A seller — receipt accumulation + dedupe', () => {
  it('two settles in one task append (a failed attempt is a {success:false} SettleOutcome)', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-9')
    // First: a rejected proof — re-challenge (no receipt is appended on a rejection's re-challenge path,
    // since the gate returns kind:'invalid' with no settle). Then a good proof → completed with 1 receipt.
    await pay.handleMessage(proofMessage('task-9', challenge, '0xbad-x'), 'task-9')
    const good = await pay.handleMessage(proofMessage('task-9', challenge, '0xgood-x'), 'task-9')
    expect(good.status.state).toBe('completed')
    const receipts = good.status.message!.metadata![A2A_RECEIPTS_KEY]!
    expect((receipts[receipts.length - 1] as X402Receipt).success).toBe(true)
  })

  it('a re-presented SUCCESS proof in one task dedupes on the settlement tx (no double-list)', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-10')
    const first = await pay.handleMessage(proofMessage('task-10', challenge, '0xdedupe'), 'task-10')
    expect(first.status.message!.metadata![A2A_RECEIPTS_KEY]).toHaveLength(1)
    // Re-presenting the SAME proof would be replay-rejected by the gate (re-challenge) — so the
    // receipts[] length stays 1; this asserts the accumulator never double-lists a success tx.
    const second = await pay.handleMessage(proofMessage('task-10', challenge, '0xdedupe'), 'task-10')
    expect(second.status.state).toBe('input-required') // replay → re-challenge
  })
})

describe('A2A seller — agentCardExtension', () => {
  it('returns the v0.1 URI (foundation-cited default) with required:true', () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const ext = pay.agentCardExtension({ required: true })
    expect(ext.uri).toBe(A2A_X402_EXTENSION_URI_V01)
    expect(ext.required).toBe(true)
    expect(ext.description).toContain('x402')
  })

  it('returns the v0.2 URI when version:"v0.2" (AP2 targets)', () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    expect(pay.agentCardExtension({ version: 'v0.2' }).uri).toBe(A2A_X402_EXTENSION_URI_V02)
  })

  it('omits `required` by default', () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    expect('required' in pay.agentCardExtension()).toBe(false)
  })

  // The spec-mandated activation header name (a2a.md §Extension Activation) — value-pinned so a
  // future typo in the exported constant is caught (mirrors the URI pins above).
  it('exports the spec-exact extension-activation header name', () => {
    expect(A2A_EXTENSIONS_HEADER).toBe('X-A2A-Extensions')
  })
})

describe('A2A seller — B4: the store is NOT on the verification path', () => {
  it('a payload carrying its own nonce verifies even with NO prior challenge in the store', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    // Build a proof WITHOUT first calling handleMessage to seed the store — the buyer carries the
    // nonce in its payload, so verify() re-derives the accept from the merchant's own config.
    const payload = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', asset: USDC }, payload: { nonce: 'self-carried', txHash: '0xnostore' } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'orphan-task', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'orphan-task')
    expect(task.status.state).toBe('completed') // verified with no store state at all
  })
})
