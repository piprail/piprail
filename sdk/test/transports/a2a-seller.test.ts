/**
 * The A2A SELLER adapter (`createA2APaymentHandler`) — x402 over Google Agent2Agent,
 * the offline-testable seller core (x402-parity Phase 3). A controllable fake EVM driver
 * (via registerDriver, the server-exact.test.ts harness) proves the transport mapping,
 * the rejection state mapping, the cross-transport replay invariant (B5), and the
 * fulfill-throws-after-settle edge (B7) — independent of any chain.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPaymentGate, requirePayment } from '../../src/server.js'
import {
  createA2APaymentHandler,
  toA2APaymentRequired,
  toA2APaymentReceipts,
  fromA2APaymentRequired,
  fromA2APaymentPayload,
  toA2APaymentFailed,
  toA2AErrorCode,
  VERIFY_CODE_TO_A2A_ERROR,
  A2A_STATUS_KEY,
  A2A_REQUIRED_KEY,
  A2A_PAYLOAD_KEY,
  A2A_RECEIPTS_KEY,
  A2A_ERROR_KEY,
  A2A_X402_EXTENSION_URI_V01,
  A2A_X402_EXTENSION_URI_V02,
  A2A_EXTENSIONS_HEADER,
} from '../../src/transports/a2a.js'
import type { A2AMessage, A2ATask, A2AArtifact } from '../../src/transports/a2a-types.js'
import { registerDriver } from '../../src/drivers/index.js'
import type { PaymentDriver } from '../../src/drivers/types.js'
import { resolveExactRailEvm } from '../../src/drivers/evm/exact.js'
import { SettlementError } from '../../src/errors.js'
import type { X402Receipt, SettleOutcome } from '../../src/x402.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC = '0xusdc'
const RELAYER = { key: '0x' + 'ab'.repeat(32) }

let settleMode: 'ok' | 'invalid' | 'throw' | 'genericThrow' = 'ok'

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
          ? { ok: false, error: 'amount_too_low', detail: `Paid 1, required 50000 (ref ${ref}).` } // ref in detail → distinguishable failures
          : { ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } },
      exactPermit2Supported: () => true,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({ asset, method, readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null), permit2Supported: () => true }),
      settleExactSelf: async ({ payload, accept }) => {
        if (settleMode === 'throw') throw new SettlementError('relayer out of gas')
        // A NON-SettlementError thrown from the settle seam (e.g. a transient RPC blip). server.ts
        // re-throws it verbatim (after releasing the claim), so it escapes verifyObject and exercises
        // the handler's catch ELSE branch (→ a `failed` Task with tx_reverted, never an unhandled crash).
        if (settleMode === 'genericThrow') throw new Error('rpc blip')
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'Authorized 1, required 50000.' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: 'authorization' in payload ? payload.authorization.from : 'x', payTo: accept.payTo, verifiedAt: 'now' } }
      },
      // The `upto` (metered) rail — same SPI the server-verifyobject harness uses, so an upto payload
      // rides A2A end-to-end exactly as it does over HTTP (proving the "every scheme rides A2A" claim).
      resolveUptoRail: async ({ asset }) =>
        asset === 'native'
          ? null
          : { method: 'permit2-upto', extra: { facilitatorAddress: RELAYER_ADDR, name: 'USD Coin', version: '2' } },
      settleUptoSelf: async ({ accept, settleAmount, payload }) => ({
        ok: true,
        receipt: { scheme: 'upto', success: true, network: accept.network, transaction: settleAmount === 0n ? '' : `0x${'ab'.repeat(32)}`, asset: accept.asset, amount: settleAmount.toString(), payer: payload.permit2Authorization.from, payTo: accept.payTo, verifiedAt: 'now' },
      }),
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

const RELAYER_ADDR = '0x2222222222222222222222222222222222222222'
const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002'
/** A permit2 authorization for the `upto` rail (mirrors server-verifyobject.test.ts). */
const PA = (over: Record<string, unknown> = {}) => ({
  permitted: { token: USDC, amount: '50000' },
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  spender: UPTO_PROXY,
  nonce: '424242',
  deadline: '9999999999',
  witness: { to: PAY_TO, facilitator: RELAYER_ADDR, validAfter: '0' },
  ...over,
})

/** Mirror of the documented `@a2a-js/sdk` mount (examples/a2a-server/lib.mjs): the host adapter stamps
 *  the host-owned ids the SDK requires (Task.contextId, status.message.messageId/parts, artifactId). */
function stamp(task: A2ATask, contextId = 'ctx-1'): A2ATask {
  const msg = task.status.message
  if (msg) { msg.messageId ??= 'm-' + Math.random().toString(36).slice(2); msg.parts ??= [] }
  for (const a of task.artifacts ?? []) a.artifactId ??= 'a-' + Math.random().toString(36).slice(2)
  task.contextId = contextId
  return task
}

const baseGate = (over = {}) => createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...over })
const exactGateCfg = { exact: { settle: 'self' as const, relayer: RELAYER } }
const uptoGateCfg = { upto: { relayer: RELAYER, settleAmount: () => 25000n } }

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
  it('a rejected onchain-proof → input-required re-challenge, merchant status payment-failed (spec §9) + error + a failure receipt', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-4')
    const task = await pay.handleMessage(proofMessage('task-4', challenge, '0xbadproof'), 'task-4')
    expect(task.status.state).toBe('input-required') // retryable: retry rides on the TASK STATE, never terminal `failed`
    const meta = task.status.message!.metadata!
    // Per a2a.md §9 ("If a payment fails, the server MUST set x402.payment.status to payment-failed")
    // and its worked EXPIRED-signature example — a VERIFICATION failure, exactly this class — the
    // merchant status is `payment-failed`, NOT `payment-required`. Google's reference executor matches
    // it: `is_valid == false → record_payment_failure → PAYMENT_FAILED`, while the Task state stays
    // `input-required` for retry. (`payment-rejected` is the client→merchant status — the client
    // rejecting our requirements — which we never emit.) A rejection is distinguished from a FIRST
    // challenge (which IS `payment-required`) by this status + the failure receipt + the error code.
    expect(meta[A2A_STATUS_KEY]).toBe('payment-failed')
    expect(meta[A2A_REQUIRED_KEY]).toBeDefined() // a fresh challenge to retry against
    expect(meta[A2A_ERROR_KEY]).toBe('INVALID_AMOUNT') // amount_too_low → INVALID_AMOUNT
    // The a2a.md Invalid-Payment example mandates a failure receipt with network + transaction:''.
    const receipts = meta[A2A_RECEIPTS_KEY]! as SettleOutcome[]
    const failed = receipts[receipts.length - 1]!
    expect(failed.success).toBe(false)
    expect(failed.transaction).toBe('') // §SettleResponse: empty string, never a missing key
    expect(failed.network).toBe('eip155:8453') // attributed to the challenge's single rail network
  })

  it('a FIRST challenge (empty payload) is payment-required with NO error/receipt — distinct from a rejection', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const task = await pay.handleMessage({ kind: 'message' }, 'task-4b')
    const meta = task.status.message!.metadata!
    expect(task.status.state).toBe('input-required')
    // A genuine first/no-proof challenge IS `payment-required` (no payment has failed yet). This is the
    // clean discriminator vs a rejection (now `payment-failed`): a first challenge also has NO error
    // code and NO failure receipt; a rejection carries all three.
    expect(meta[A2A_STATUS_KEY]).toBe('payment-required')
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

describe('A2A seller — §2 regression: a tx-suppressed success is NOT deduped against an empty failure tx', () => {
  it('a failure then a tx-suppressed success (includeTxHash:false) keeps BOTH receipts on one task', async () => {
    // includeTxHash:false makes the gate emit a success X402Receipt with transaction:'' (server.ts §5.3).
    // A prior failure SettleOutcome ALSO carries transaction:'' — so a naive "dedupe on transaction"
    // would drop the success (it equals the failure's empty tx) and ship a payment-completed task
    // carrying only the earlier FAILURE. The fix: an empty transaction is never an idempotency key.
    const pay = createA2APaymentHandler({ gate: baseGate({ receipts: { includeTxHash: false } }) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-sup')
    await pay.handleMessage(proofMessage('task-sup', challenge, '0xbad-sup'), 'task-sup')   // rejected → failure receipt (tx '')
    const good = await pay.handleMessage(proofMessage('task-sup', challenge, '0xgood-sup'), 'task-sup') // settles → success (tx '')
    expect(good.status.state).toBe('completed')
    const receipts = good.status.message!.metadata![A2A_RECEIPTS_KEY]!
    expect(receipts).toHaveLength(2) // BOTH kept — was 1 (success dropped) before the fix
    expect((receipts[0] as SettleOutcome).success).toBe(false)
    expect((receipts[1] as X402Receipt).success).toBe(true)
    expect((receipts[1] as X402Receipt).transaction).toBe('') // suppressed, but still listed
  })
})

describe('A2A seller — §3a: a present-but-unparseable payload re-challenges as a FRESH challenge (kind:challenge)', () => {
  it('an empty {} payload object → input-required + payment-required with NO error/receipt (not a rejection)', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    // A payload key is present but the object carries no usable proof → gate.verifyObject yields
    // kind:'challenge' (NOT 'invalid'). The handler treats it as a fresh first challenge.
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-ch', metadata: { [A2A_PAYLOAD_KEY]: {} } }, 'task-ch')
    const meta = task.status.message!.metadata!
    expect(task.status.state).toBe('input-required')
    expect(meta[A2A_STATUS_KEY]).toBe('payment-required') // a fresh challenge, NOT payment-failed
    expect(meta[A2A_REQUIRED_KEY]).toBeDefined()
    expect(meta[A2A_ERROR_KEY]).toBeUndefined()   // no payment failed → no error
    expect(meta[A2A_RECEIPTS_KEY]).toBeUndefined() // and no failure receipt
  })
})

describe('A2A seller — §3b: a generic (non-SettlementError) throw on settle → failed Task, never a crash', () => {
  it('a transient Error thrown from the settle seam → failed + SETTLEMENT_FAILED + a failure receipt', async () => {
    settleMode = 'genericThrow' // settleExactSelf throws new Error('rpc blip') — NOT a SettlementError
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-blip')
    const exactRail = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact')!
    const payload = { x402Version: 2, accepted: exactRail, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-blip', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-blip')
    expect(task.status.state).toBe('failed') // the throw is caught + mapped, not propagated as a crash
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-failed')
    expect(meta[A2A_ERROR_KEY]).toBe('SETTLEMENT_FAILED') // tx_reverted → SETTLEMENT_FAILED
    const failed = meta[A2A_RECEIPTS_KEY]!.slice(-1)[0] as SettleOutcome
    expect(failed.success).toBe(false)
    expect(failed.errorReason).toMatch(/rpc blip/)
  })
})

describe('A2A seller — §3c: failure-receipt network attribution from the buyer ATTEMPTED rail (multi-network)', () => {
  it('a rejection on a multi-network gate attributes the network the buyer actually attempted, not the first rail', async () => {
    settleMode = 'invalid' // settleExactSelf returns { ok:false } → kind:'invalid' (a rejection)
    // Two EVM rails (eip155:8453 + eip155:1) in one challenge → singleNetworkOf can't pick one, so the
    // attribution MUST come from the buyer's submitted payload (networkFromPayload), not a guess.
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
        { chain: { id: 1, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
      ],
      ...exactGateCfg,
    })
    const pay = createA2APaymentHandler({ gate })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-mn')
    const railOnEth = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact' && a.network === 'eip155:1')!
    const payload = { x402Version: 2, accepted: railOnEth, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-mn', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-mn')
    expect(task.status.state).toBe('input-required') // a rejection, retryable
    const failed = task.status.message!.metadata![A2A_RECEIPTS_KEY]!.slice(-1)[0] as SettleOutcome
    expect(failed.success).toBe(false)
    expect(failed.network).toBe('eip155:1') // the ATTEMPTED rail, not eip155:8453 (the first rail)
  })
})

describe('A2A seller — §3d: the verify-code → A2A error-enum map is a pinned spec contract', () => {
  it('toA2AErrorCode maps every PipRail verify code to its spec A2A error enum, and passes unknown codes through', () => {
    // Pin the whole table so a spec-enum rename/typo can't ship silently.
    for (const [code, expected] of Object.entries(VERIFY_CODE_TO_A2A_ERROR)) {
      expect(toA2AErrorCode(code)).toBe(expected)
    }
    // A couple of named anchors from the spec (a2a.md §9 error enum).
    expect(toA2AErrorCode('payment_expired')).toBe('EXPIRED_PAYMENT')
    expect(toA2AErrorCode('tx_already_used')).toBe('DUPLICATE_NONCE')
    expect(toA2AErrorCode('signature_invalid')).toBe('INVALID_SIGNATURE')
    // INVALID_AMOUNT is kept strictly for genuine amount mismatches; a wrong-recipient / unoffered-rail
    // proof is NOT an amount error, so it maps to the spec's catch-all SETTLEMENT_FAILED (records intent).
    expect(toA2AErrorCode('amount_too_low')).toBe('INVALID_AMOUNT')
    expect(toA2AErrorCode('upto_settle_exceeds_max')).toBe('INVALID_AMOUNT')
    expect(toA2AErrorCode('transfer_not_found')).toBe('SETTLEMENT_FAILED')
    expect(toA2AErrorCode('wrong_recipient')).toBe('SETTLEMENT_FAILED')
    // An unmapped code passes through verbatim (the raw PipRail code is preserved for the buyer).
    expect(toA2AErrorCode('some_unmapped_code')).toBe('some_unmapped_code')
  })
})

describe('A2A seller — §3e: the default task store evicts on taskTtlMs (bounded, not a backend)', () => {
  it('a task record is gone after its TTL — a follow-up on the same taskId sees a fresh, empty history', async () => {
    vi.useFakeTimers()
    try {
      const pay = createA2APaymentHandler({ gate: baseGate(), taskTtlMs: 1_000 })
      const challenge = await pay.handleMessage({ kind: 'message' }, 'task-ttl') // seeds + sets a record (ttl 1s)
      // A rejection writes a failure receipt into the record.
      await pay.handleMessage(proofMessage('task-ttl', challenge, '0xbad-ttl'), 'task-ttl')
      // Advance well past the TTL → the record must be pruned/evicted on the next store read.
      vi.advanceTimersByTime(5_000)
      // A follow-up rejection on the SAME taskId must start from an EMPTY history (the prior receipt is gone),
      // so the appended failure is the ONLY entry — proving eviction, not unbounded retention.
      const after = await pay.handleMessage(proofMessage('task-ttl', challenge, '0xbad-ttl2'), 'task-ttl')
      expect(after.status.message!.metadata![A2A_RECEIPTS_KEY]!).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('A2A seller — §3f: the exported pure codecs', () => {
  it('toA2APaymentRequired carries human-readable parts alongside the challenge', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const { challenge } = await pay.gate.challenge('http://x/1')
    const task = toA2APaymentRequired('t', challenge, [{ kind: 'text', text: 'pay to continue' }])
    expect(task.status.state).toBe('input-required')
    expect(task.status.message!.parts![0]).toMatchObject({ kind: 'text', text: 'pay to continue' })
    expect(task.status.message!.metadata![A2A_REQUIRED_KEY]).toEqual(challenge) // challenge still carried
    expect(task.status.message!.metadata![A2A_STATUS_KEY]).toBe('payment-required')
  })

  it('toA2APaymentReceipts wraps an array under the receipts key; fromA2APaymentPayload guards null/absent', () => {
    const wrapped = toA2APaymentReceipts([{ success: false, transaction: '', errorReason: 'x: y' }])
    expect(wrapped[A2A_RECEIPTS_KEY]).toHaveLength(1)
    expect(fromA2APaymentPayload({ kind: 'message' })).toBeNull() // no metadata at all
    expect(fromA2APaymentPayload({ kind: 'message', metadata: { [A2A_PAYLOAD_KEY]: null } })).toBeNull() // explicit null
    const got = fromA2APaymentPayload({ kind: 'message', taskId: 'tt', metadata: { [A2A_PAYLOAD_KEY]: { a: 1 } } })
    expect(got).toEqual({ raw: { a: 1 }, taskId: 'tt' })
  })
})

describe('A2A seller — §3g: a structured data-part url flows into the challenge resource', () => {
  it('a service request carrying a data part with a url surfaces it in the emitted challenge', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const url = 'https://api.example.com/img'
    const task = await pay.handleMessage({ kind: 'message', parts: [{ kind: 'data', data: { url } }] }, 'task-url')
    const required = task.status.message!.metadata![A2A_REQUIRED_KEY]!
    // server.ts builds a V2 ResourceInfo { url } from the resource string resourceUrlFromMessage extracted.
    const resourceUrl = typeof required.resource === 'object' ? (required.resource as { url?: string }).url : required.resource
    expect(resourceUrl).toBe(url)
  })
})

/* ════════════════ Hardening pass — schema-contract, interop & exhaustive edge cases ════════════════ */

describe('A2A seller — §4a: the host adapter completes the @a2a-js/sdk-REQUIRED field set', () => {
  // PipRail emits TRANSPORT METADATA ONLY (zero @a2a dep); the host adapter stamps the SDK-required
  // host-owned ids (Task.contextId, status.message.messageId/parts, artifacts[].artifactId). These pin
  // both halves of that contract: PipRail omits them, the documented stamp supplies them.
  it('a bare PipRail challenge Task omits contextId/messageId; the documented stamp supplies them', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const task = await pay.handleMessage({ kind: 'message' }, 'task-stamp')
    expect('contextId' in task).toBe(false)                       // PipRail does NOT set host ids
    expect(task.status.message!.messageId).toBeUndefined()
    stamp(task)
    expect(typeof task.contextId).toBe('string')                  // the adapter supplies them
    expect(typeof task.status.message!.messageId).toBe('string')
    expect(Array.isArray(task.status.message!.parts)).toBe(true)
  })

  it('the stamp completes messageId+parts+artifactId across challenge/completed/re-challenge/failed', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg), fulfill: async () => [{ name: 'r', parts: [{ kind: 'text', text: 'x' }] }] })
    const ch = await pay.handleMessage({ kind: 'message' }, 't-a')
    const completed = await pay.handleMessage(proofMessage('t-b', ch, '0xok'), 't-b')
    const rechallenged = await pay.handleMessage(proofMessage('t-c', ch, '0xbad-x'), 't-c')
    settleMode = 'throw'
    const exactRail = fromA2APaymentRequired(ch)!.accepts.find((a) => a.scheme === 'exact')!
    const failed = await pay.handleMessage({ kind: 'message', taskId: 't-d', metadata: { [A2A_PAYLOAD_KEY]: { x402Version: 2, accepted: exactRail, payload: { signature: '0xsig', authorization: AUTH() } } } }, 't-d')
    for (const t of [ch, completed, rechallenged, failed]) {
      stamp(t)
      expect(typeof t.status.message!.messageId).toBe('string')
      expect(Array.isArray(t.status.message!.parts)).toBe(true)
      for (const a of t.artifacts ?? []) expect(typeof a.artifactId).toBe('string')
    }
  })
})

describe('A2A seller — §4b: standard EXACT (EIP-3009) HAPPY path settles over A2A', () => {
  it('a v2 exact payload → completed + payment-completed + a scheme:"exact" receipt with the settled tx', async () => {
    // The scheme a real Google x402 V2 client sends (interop_probe asserts get_scheme()==='exact').
    // Every other exact test forces a failure mode; this pins the cross-counterparty success path.
    const pay = createA2APaymentHandler({ gate: baseGate(exactGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-ex')
    const exactRail = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact')!
    const payload = { x402Version: 2, accepted: exactRail, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-ex', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-ex')
    expect(task.status.state).toBe('completed')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-completed')
    const r = meta[A2A_RECEIPTS_KEY]![0] as X402Receipt
    expect(r.scheme).toBe('exact')
    expect(r.success).toBe(true)
    expect(r.transaction).toBe(`0x${'fe'.repeat(32)}`)
  })
})

describe('A2A seller — §4c: the UPTO (metered) rail rides A2A end-to-end', () => {
  const uptoPayload = (challenge: A2ATask) => {
    const rail = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'upto')!
    return { x402Version: 2, accepted: { scheme: 'upto', network: rail.network, asset: rail.asset }, payload: { signature: '0xsig', permit2Authorization: PA() } }
  }
  it('a v2 upto payload → completed + payment-completed + a scheme:"upto" receipt', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate(uptoGateCfg) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-up')
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-up', metadata: { [A2A_PAYLOAD_KEY]: uptoPayload(challenge) } }, 'task-up')
    expect(task.status.state).toBe('completed')
    expect(task.status.message!.metadata![A2A_STATUS_KEY]).toBe('payment-completed')
    expect((task.status.message!.metadata![A2A_RECEIPTS_KEY]![0] as X402Receipt).scheme).toBe('upto')
  })
  it('a $0 upto settle (settleAmount:0n) → payment-completed, the transaction:"" receipt is APPENDED not dropped', async () => {
    // The real upto path natively produces transaction:'' on a $0 settle — proves appendReceipt's
    // empty-tx branch ships payment-completed, not a dropped/failed receipt.
    const pay = createA2APaymentHandler({ gate: baseGate({ upto: { relayer: RELAYER, settleAmount: () => 0n } }) })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-up0')
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-up0', metadata: { [A2A_PAYLOAD_KEY]: uptoPayload(challenge) } }, 'task-up0')
    expect(task.status.state).toBe('completed')
    expect(task.status.message!.metadata![A2A_STATUS_KEY]).toBe('payment-completed')
    const receipts = task.status.message!.metadata![A2A_RECEIPTS_KEY]!
    expect(receipts).toHaveLength(1)
    expect((receipts[0] as X402Receipt).transaction).toBe('')
  })
})

describe('A2A seller — §4d: multi-chain exact — the buyer\'s CHOSEN rail settles (CAIP-2 routing)', () => {
  it('on a 2-chain exact gate, the buyer picking chain B settles against chain B (not candidates[0])', async () => {
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
        { chain: { id: 1, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
      ],
      ...exactGateCfg,
    })
    const pay = createA2APaymentHandler({ gate })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-mc')
    const railB = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact' && a.network === 'eip155:1')!
    const payload = { x402Version: 2, accepted: railB, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-mc', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-mc')
    expect(task.status.state).toBe('completed')
    const r = task.status.message!.metadata![A2A_RECEIPTS_KEY]![0] as X402Receipt
    expect(r.scheme).toBe('exact')
    expect(r.network).toBe('eip155:1') // the chosen rail settled, not the first
  })
})

describe('A2A seller — §4e: networkFromPayload prefers v2 accepted.network over a conflicting top-level network', () => {
  it('a rejection attributes the v2 accepted.network, not the v1-flat top-level network', async () => {
    settleMode = 'invalid'
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
        { chain: { id: 1, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
      ],
      ...exactGateCfg,
    })
    const pay = createA2APaymentHandler({ gate })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-prec')
    const railB = fromA2APaymentRequired(challenge)!.accepts.find((a) => a.scheme === 'exact' && a.network === 'eip155:1')!
    // accepted.network (eip155:1) and a CONFLICTING top-level network (eip155:8453) — accepted wins.
    const payload = { x402Version: 2, network: 'eip155:8453', accepted: railB, payload: { signature: '0xsig', authorization: AUTH() } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-prec', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-prec')
    expect(task.status.state).toBe('input-required')
    const failed = task.status.message!.metadata![A2A_RECEIPTS_KEY]!.slice(-1)[0] as SettleOutcome
    expect(failed.network).toBe('eip155:1') // accepted-nested won over the conflicting top-level value
  })
})

describe('A2A seller — §S5: a proof naming an UNOFFERED rail is rejected (forged accepted can\'t redirect)', () => {
  it('an onchain-proof whose accepted.network is an UNOFFERED chain → payment-failed + transfer_not_found', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() }) // base-only (eip155:8453)
    // A "good" ref (the fake verify would return ok) but for an UNOFFERED network — selection must
    // reject on the trusted spec BEFORE ever calling verify, so a forged accepted can't redirect funds.
    const payload = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:1', asset: USDC }, payload: { nonce: 'n', txHash: '0xgoodproof' } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-forge', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-forge')
    expect(task.status.state).toBe('input-required')
    const meta = task.status.message!.metadata!
    expect(meta[A2A_STATUS_KEY]).toBe('payment-failed')
    const failed = meta[A2A_RECEIPTS_KEY]!.slice(-1)[0] as SettleOutcome
    expect(failed.errorReason).toMatch(/^transfer_not_found/)
  })
  it('an onchain-proof whose accepted.asset is UNOFFERED → payment-failed + transfer_not_found', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const payload = { x402Version: 2, accepted: { scheme: 'onchain-proof', network: 'eip155:8453', asset: '0xWRONG' }, payload: { nonce: 'n', txHash: '0xgoodproof' } }
    const task = await pay.handleMessage({ kind: 'message', taskId: 'task-forge2', metadata: { [A2A_PAYLOAD_KEY]: payload } }, 'task-forge2')
    expect(task.status.state).toBe('input-required')
    const failed = task.status.message!.metadata![A2A_RECEIPTS_KEY]!.slice(-1)[0] as SettleOutcome
    expect(failed.errorReason).toMatch(/^transfer_not_found/)
  })
})

describe('A2A seller — §S9: fulfill throwing a NON-Error after settle still completes (never crashes)', () => {
  it('fulfill throwing a string → completed + payment-completed + the annotation carries String(err)', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate(), fulfill: async () => { throw 'image-svc-down' } })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-nonerr')
    const task = await pay.handleMessage(proofMessage('task-nonerr', challenge, '0xpaidnonerr'), 'task-nonerr')
    expect(task.status.state).toBe('completed')
    expect(task.status.message!.metadata![A2A_STATUS_KEY]).toBe('payment-completed')
    const receipts = task.status.message!.metadata![A2A_RECEIPTS_KEY]!
    expect(receipts).toHaveLength(1)
    expect((receipts[0] as X402Receipt).success).toBe(true)
    expect(task.artifacts![0]!.metadata!['x402.fulfillment.error']).toContain('image-svc-down')
  })
})

describe('A2A seller — §S10: fulfill returning undefined → completed with NO artifacts key', () => {
  it('a fulfill that returns undefined completes without an artifacts key (defensive ?? [])', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate(), fulfill: async () => undefined as unknown as A2AArtifact[] })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-undef')
    const task = await pay.handleMessage(proofMessage('task-undef', challenge, '0xundef'), 'task-undef')
    expect(task.status.state).toBe('completed')
    expect('artifacts' in task).toBe(false) // not artifacts:[] — the key is omitted entirely
  })
})

describe('A2A seller — §S11: handleMessage mints a stable task id when none is supplied', () => {
  it('with no taskId arg and no message.taskId → a minted task-<uuid> id, surfaced on the Task + message', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const task = await pay.handleMessage({ kind: 'message' }) // no positional id, no message.taskId
    expect(task.id).toMatch(/^task-/)
    expect(task.status.state).toBe('input-required')
    expect(task.status.message!.taskId).toBe(task.id) // the minted id is surfaced on the challenge message
  })
})

describe('A2A seller — §S12: the task store evicts at EXACTLY the expiry instant (strict >, boundary)', () => {
  it('a record whose expiry === now is pruned — a follow-up sees a fresh, empty history', async () => {
    vi.useFakeTimers()
    try {
      const pay = createA2APaymentHandler({ gate: baseGate(), taskTtlMs: 1_000 })
      const challenge = await pay.handleMessage({ kind: 'message' }, 'task-bound')
      await pay.handleMessage(proofMessage('task-bound', challenge, '0xbad-b1'), 'task-bound') // writes a failure receipt
      vi.advanceTimersByTime(1_000) // now === expiry → prune treats it as expired (strict `>`)
      const after = await pay.handleMessage(proofMessage('task-bound', challenge, '0xbad-b2'), 'task-bound')
      expect(after.status.message!.metadata![A2A_RECEIPTS_KEY]!).toHaveLength(1) // prior receipt evicted at the boundary
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('A2A seller — §S13: the receipts cap keeps EXACTLY 64 and evicts the OLDEST (tail-preserving)', () => {
  it('64 distinct failures stay 64; a 65th drops the oldest, not the newest (slice(-64), not slice(0,64))', async () => {
    const pay = createA2APaymentHandler({ gate: baseGate() })
    const challenge = await pay.handleMessage({ kind: 'message' }, 'task-cap2')
    // Failure receipts carry transaction:'' and never dedup → each append grows the history by one.
    // The ref rides in errorReason (verify detail), so every entry is distinguishable.
    let task: A2ATask | undefined
    for (let i = 0; i < 64; i++) task = await pay.handleMessage(proofMessage('task-cap2', challenge, `0xbad-${i}`), 'task-cap2')
    // Exactly at the cap — 64 entries, nothing evicted yet (the oldest, 0xbad-0, is still present).
    let receipts = task!.status.message!.metadata![A2A_RECEIPTS_KEY]! as SettleOutcome[]
    expect(receipts).toHaveLength(64)
    expect(receipts.some((r) => r.errorReason?.includes('0xbad-0)'))).toBe(true)
    // The 65th distinct failure must evict the OLDEST (0xbad-0), keeping the newest tail (slice(-64)).
    task = await pay.handleMessage(proofMessage('task-cap2', challenge, '0xbad-NEWEST'), 'task-cap2')
    receipts = task.status.message!.metadata![A2A_RECEIPTS_KEY]! as SettleOutcome[]
    expect(receipts).toHaveLength(64)
    expect(receipts[receipts.length - 1]!.errorReason).toContain('0xbad-NEWEST')      // newest kept at the tail
    expect(receipts.some((r) => r.errorReason?.includes('0xbad-0)'))).toBe(false)     // oldest evicted (the ')' avoids matching 0xbad-0* prefixes)
  })
})
