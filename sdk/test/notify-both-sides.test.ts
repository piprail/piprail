/**
 * SUPER-TEST: both the merchant AND the buyer are notified, on SUCCESS and on FAILURE, across every
 * edge case — onchain-proof + exact rails, every VerifyErrorCode, transient vs definitive, the
 * requirePayment middleware, concurrency, replay-after-success, the throw-vs-onFailed split, and a
 * full real client<->gate loop over HTTP proving both sides receive the SAME code. NO RPC — a
 * controllable fake EVM driver.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { createPaymentGate, requirePayment } from '../src/server.js'
import type { FailedPayment } from '../src/server.js'
import { PipRailClient } from '../src/client.js'
import { buildSignatureHeader, HEADER_SIGNATURE, HEADER_REQUIRED, HEADER_RESPONSE } from '../src/x402.js'
import type { VerifyErrorCode } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import { resolveExactRailEvm } from '../src/drivers/evm/exact.js'
import { SettlementError } from '../src/errors.js'

const PAY_TO = '0x4444444444444444444444444444444444444444'
const USDC = '0xusdc'

// Controllable fake driver behaviour.
let verifyError: VerifyErrorCode | null = null // onchain verify() returns this rejection when set
let verifyThrows = false // onchain verify() THROWS (a transient RPC failure) when true
let settleMode: 'ok' | 'invalid' | 'throw' = 'ok' // exact settleExactSelf outcome

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
      resolveToken: (t) => (t === 'native' ? { asset: 'native', decimals: 18, symbol: 'ETH' } : { asset: USDC, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 999999999n, native: 999999999n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => {
        if (verifyThrows) throw new Error('transient RPC reading the tx')
        if (verifyError) return { ok: false, error: verifyError, detail: `forced ${verifyError}` }
        return { ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } }
      },
      exactPermit2Supported: () => true,
      exactDomain: async (asset) => (asset === USDC ? { name: 'USD Coin', version: '2' } : null),
      resolveExactRail: async ({ asset, method }) =>
        resolveExactRailEvm({ asset, method, readDomain: async (a) => (a === USDC ? { name: 'USD Coin', version: '2' } : null), permit2Supported: () => true }),
      settleExactSelf: async ({ accept }) => {
        if (settleMode === 'throw') throw new SettlementError('relayer out of gas')
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'Authorized 1, required 50000.' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeEvm)

afterEach(() => { verifyError = null; verifyThrows = false; settleMode = 'ok' })

function gateWith(opts: Partial<Parameters<typeof createPaymentGate>[0]> = {}) {
  return createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, ...opts })
}

// Build + submit an onchain-proof. tx is the proof ref; the driver's verifyError controls the verdict.
async function pay(gate: ReturnType<typeof createPaymentGate>, tx = `0x${'c'.repeat(64)}`) {
  const { challenge } = await gate.challenge()
  const accept = proofAccepts(challenge)[0]!
  return gate.verify(buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } }))
}

// ── exact-rail header helpers (mirrors server-exact.test.ts) ──
const AUTH = () => ({ from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: PAY_TO, value: '50000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + Math.floor(Math.random() * 1e12).toString(16).padStart(64, '0') })
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
async function payExact(gate: ReturnType<typeof createPaymentGate>) {
  const { challenge } = await gate.challenge('https://x')
  const exactAccept = challenge.accepts.find((a) => a.scheme === 'exact')!
  return gate.verify(b64({ x402Version: 2, accepted: exactAccept, payload: { signature: '0xsig', authorization: AUTH() } }))
}

// ── A. every VerifyErrorCode a driver can return fires onFailed, with the right code + transient flag ──
describe('onFailed — fires for EVERY VerifyErrorCode (onchain), tagged transient correctly', () => {
  const DEFINITIVE: VerifyErrorCode[] = ['tx_reverted', 'no_meta', 'wrong_recipient', 'amount_too_low', 'transfer_not_found', 'payment_expired', 'signature_invalid']
  const TRANSIENT: VerifyErrorCode[] = ['tx_not_found', 'insufficient_confirmations']

  for (const code of DEFINITIVE) {
    it(`fires onFailed{code:'${code}', transient:false}`, async () => {
      let got: FailedPayment | undefined
      verifyError = code
      const res = await pay(gateWith({ onFailed: (f) => void (got = f) }), `0x${'d'.repeat(64)}`)
      expect(res.kind).toBe('invalid')
      expect(got).toEqual({ code, detail: `forced ${code}`, transient: false })
    })
  }
  for (const code of TRANSIENT) {
    it(`fires onFailed{code:'${code}', transient:TRUE} (client auto-retries; alert only on !transient)`, async () => {
      let got: FailedPayment | undefined
      verifyError = code
      const res = await pay(gateWith({ onFailed: (f) => void (got = f) }), `0x${'e'.repeat(64)}`)
      expect(res.kind).toBe('invalid')
      expect(got).toEqual({ code, detail: `forced ${code}`, transient: true })
    })
  }
})

// ── B + C. the exact rail: a rejection fires onFailed; a SettlementError (5xx) does NOT ──
describe('onFailed — the exact rail', () => {
  it('fires onFailed on an exact-rail rejection (settle returns invalid)', async () => {
    let got: FailedPayment | undefined
    settleMode = 'invalid'
    const gate = gateWith({ exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } }, onFailed: (f) => void (got = f) })
    const res = await payExact(gate)
    expect(res.kind).toBe('invalid')
    expect(got?.code).toBe('amount_too_low')
    expect(got?.transient).toBe(false)
  })

  it('does NOT fire onFailed on a SettlementError — it THROWS (→ 5xx), not a payment verdict', async () => {
    const onFailed = vi.fn()
    settleMode = 'throw'
    const gate = gateWith({ exact: { settle: 'self', relayer: { key: '0x' + 'ab'.repeat(32) } }, onFailed })
    await expect(payExact(gate)).rejects.toBeInstanceOf(SettlementError)
    expect(onFailed).toHaveBeenCalledTimes(0)
  })
})

// ── D. a transient RPC THROW in verify() does not fire onFailed (it propagates; proof not burned) ──
describe('onFailed — a thrown transient error is not a verdict', () => {
  it('does NOT fire onFailed when the driver verify() THROWS (the proof is retryable, not rejected)', async () => {
    const onFailed = vi.fn()
    verifyThrows = true
    await expect(pay(gateWith({ onFailed }))).rejects.toThrow(/transient RPC/)
    expect(onFailed).toHaveBeenCalledTimes(0)
  })
})

// ── E. the requirePayment (Express) middleware fires BOTH hooks ──
describe('requirePayment middleware — fires onPaid AND onFailed', () => {
  function mockRes() {
    const headers: Record<string, string> = {}
    return { headers, _status: 0, setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v), status(c: number) { this._status = c; return this }, json: vi.fn(function (this: unknown) { return this }) }
  }
  async function challengeSig(gate: ReturnType<typeof createPaymentGate>, tx: string) {
    const { challenge } = await gate.challenge()
    const accept = proofAccepts(challenge)[0]!
    return buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } })
  }

  it('a rejected proof → onFailed; a valid proof → onPaid; a no-proof request → neither', async () => {
    const onPaid = vi.fn()
    const onFailed = vi.fn()
    const gate = gateWith({ onPaid, onFailed }) // a sibling gate to mint matching challenges
    const mw = requirePayment({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, onPaid, onFailed })

    // no proof → challenge, neither hook
    const next1 = vi.fn(); const r1 = mockRes()
    await mw({ headers: {} }, r1 as never, next1)
    expect(r1._status).toBe(402)
    expect(onPaid).toHaveBeenCalledTimes(0)
    expect(onFailed).toHaveBeenCalledTimes(0)

    // rejected proof → onFailed
    verifyError = 'amount_too_low'
    const next2 = vi.fn(); const r2 = mockRes()
    await mw({ headers: { [HEADER_SIGNATURE]: await challengeSig(gate, `0x${'2'.repeat(64)}`) } }, r2 as never, next2)
    expect(r2._status).toBe(402)
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect((onFailed.mock.calls[0]![0] as FailedPayment).code).toBe('amount_too_low')

    // valid proof → onPaid, next() called
    verifyError = null
    const next3 = vi.fn(); const r3 = mockRes()
    await mw({ headers: { [HEADER_SIGNATURE]: await challengeSig(gate, `0x${'3'.repeat(64)}`) } }, r3 as never, next3)
    expect(next3).toHaveBeenCalledTimes(1)
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledTimes(1) // unchanged
  })
})

// ── F. concurrency: N parallel rejections each fire onFailed exactly once ──
describe('onFailed — concurrency', () => {
  it('fires once per rejected attempt across many parallel verifies', async () => {
    const onFailed = vi.fn()
    verifyError = 'amount_too_low'
    const gate = gateWith({ onFailed })
    await Promise.all(Array.from({ length: 12 }, (_, i) => pay(gate, `0x${i.toString(16).padStart(64, '0')}`)))
    expect(onFailed).toHaveBeenCalledTimes(12)
  })
})

// ── G. replay-after-success: onPaid once, then onFailed once (tx_already_used) — both sides correct ──
describe('onPaid + onFailed — a settled proof, then its replay', () => {
  it('fires onPaid on the settlement and onFailed{tx_already_used} on the replay', async () => {
    const onPaid = vi.fn(); const onFailed = vi.fn()
    const gate = gateWith({ onPaid, onFailed })
    const tx = `0x${'a'.repeat(64)}`
    expect((await pay(gate, tx)).kind).toBe('paid')
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledTimes(0)
    const replay = await pay(gate, tx)
    expect(replay.kind).toBe('invalid')
    expect(onPaid).toHaveBeenCalledTimes(1) // not re-fired
    expect(onFailed).toHaveBeenCalledTimes(1)
    const f = onFailed.mock.calls[0]![0] as FailedPayment
    expect(f.code).toBe('tx_already_used')
    expect(f.transient).toBe(false)
  })
})

// ── J. the capstone: a REAL client<->gate loop over HTTP — both sides get the SAME code ──
describe('both sides over a real HTTP loop', () => {
  async function withServer(gate: ReturnType<typeof createPaymentGate>, fn: (url: string) => Promise<void>) {
    const server = createServer(async (req, res) => {
      const sig = req.headers[HEADER_SIGNATURE]
      if (!sig) { const c = await gate.challenge(`http://127.0.0.1${req.url}`); res.setHeader(HEADER_REQUIRED, c.requiredHeader); res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify(c.challenge)) }
      const v = await gate.verify(sig)
      if (v.kind === 'paid') { res.setHeader(HEADER_RESPONSE, v.receiptHeader); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
      res.setHeader(HEADER_REQUIRED, v.requiredHeader); res.writeHead(v.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(v.challenge))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const { port } = server.address() as { port: number }
    try { await fn(`http://127.0.0.1:${port}/r`) } finally { server.close() }
  }

  it('SUCCESS → merchant onPaid + buyer payment-settled + 200', async () => {
    const onPaid = vi.fn()
    let settled = false
    await withServer(gateWith({ onPaid }), async (url) => {
      const buyer = new PipRailClient({ chain: { id: 8453, rpcUrl: 'x' }, wallet: { key: '0x' + '1'.repeat(64) }, onEvent: (e) => { if (e.kind === 'payment-settled') settled = true } })
      const res = await buyer.fetch(url)
      expect(res.status).toBe(200)
    })
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)
  })

  it('FAILURE → merchant onFailed AND buyer payment-failed, with the SAME code', async () => {
    verifyError = 'amount_too_low'
    let merchantCode: string | undefined
    let buyerCode: string | undefined
    await withServer(gateWith({ onFailed: (f) => { merchantCode = f.code } }), async (url) => {
      const buyer = new PipRailClient({ chain: { id: 8453, rpcUrl: 'x' }, wallet: { key: '0x' + '1'.repeat(64) }, maxPaymentRetries: 1, retryTimeoutMs: 1000, onEvent: (e) => { if (e.kind === 'payment-failed') buyerCode = e.code } })
      await expect(buyer.fetch(url)).rejects.toThrow(/amount_too_low/)
    })
    expect(merchantCode).toBe('amount_too_low') // merchant notified
    expect(buyerCode).toBe('amount_too_low') // buyer notified
    expect(merchantCode).toBe(buyerCode) // ONE consistent reason on both sides
  })
})
