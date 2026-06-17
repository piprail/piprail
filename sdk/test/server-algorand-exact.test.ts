/**
 * The gate's `exact` path for Algorand, via a controllable fake `algorand` driver — no RPC.
 * Proves the protocol layer is family-agnostic for the new `algorand` method: it dual-advertises
 * an `algorand` exact rail, routes settlement to `settleExactSelf`, and — the focus here —
 * dedupes a re-submitted payment on a CANONICALIZED `payload.paymentGroup`, so a base64-malleated
 * re-submission of the same group can't slip past the replay claim. (The real driver's tx logic
 * is covered by test/algorand/exact.test.ts; the EVM/SVM paths by server-*-exact.test.ts.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const NETWORK = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const ASSET = '31566704'
const FEE_PAYER = 'SSWUCC4WCWY7Z3KQHYZ3SI4MGMVDS6747ELGEKXLDDQ7DACVJK52VJC7KE'
const PAY_TO = '2OT6GLZYUNCBI4QFNH3DSYNXY7HKFVQ6UYW3CRJ4S5JT2L7T2J3GC5E4'

let settleMode: 'ok' | 'invalid' = 'ok'
const settleSpy = vi.fn()

const fakeAlgorand: PaymentDriver = {
  family: 'algorand',
  resolve(opts) {
    if (opts.chain !== 'algorand') return null
    return {
      family: 'algorand',
      network: NETWORK,
      supports: (n) => n === NETWORK,
      resolveToken: () => ({ asset: ASSET, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'txid',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ALGO', feeDecimals: 6, fee: '0', feeFormatted: '0', basis: 'estimated' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
      // Mirror the real driver: a facilitator-provided feePayer wins; else the relayer's address
      // (FEE_PAYER stands in); with NEITHER, no rail (null). Native isn't exact-payable.
      resolveExactRail: async ({ asset, relayer, feePayer }) => {
        if (asset === 'native') return null
        const fp = feePayer ?? (relayer ? FEE_PAYER : undefined)
        return fp ? { method: 'algorand', extra: { feePayer: fp } } : null
      },
      settleExactSelf: async ({ payload, accept }) => {
        settleSpy({ payload, accept })
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'short' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: 'SETTLED_TXID', asset: accept.asset, amount: accept.amount, payer: 'BUYER', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeAlgorand)

afterEach(() => { settleMode = 'ok'; settleSpy.mockClear() })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const algoHeader = (paymentGroup: string[], paymentIndex = 0) =>
  b64({ x402Version: 2, accepted: { scheme: 'exact', network: NETWORK, asset: ASSET }, payload: { paymentIndex, paymentGroup } })

const gate = () =>
  createPaymentGate({
    chain: 'algorand',
    token: 'USDC',
    amount: '0.05',
    payTo: PAY_TO,
    exact: { settle: 'self', relayer: { key: 'a'.repeat(25) } },
  })

describe('gate · Algorand exact (fake driver, no RPC)', () => {
  it('dual-advertises an `algorand` exact rail beside onchain-proof', async () => {
    const { challenge } = await gate().challenge()
    const rails = challenge.accepts
    const exact = rails.find((r) => r.scheme === 'exact')
    expect(exact).toBeTruthy()
    expect(exact!.extra.assetTransferMethod).toBe('algorand')
    expect((exact!.extra as { feePayer?: string }).feePayer).toBe(FEE_PAYER)
    expect(rails.some((r) => r.scheme === 'onchain-proof')).toBe(true)
  })

  it('routes a valid group to settleExactSelf → paid', async () => {
    const res = await gate().verify(algoHeader(['YWJj', 'ZGVm']))
    expect(res.kind).toBe('paid')
    expect(settleSpy).toHaveBeenCalledOnce()
    const arg = settleSpy.mock.calls[0]![0]
    expect(arg.payload).toMatchObject({ paymentIndex: 0, paymentGroup: ['YWJj', 'ZGVm'] })
    expect(arg.accept.payTo).toBe(PAY_TO)
  })

  it('dedupes a base64-MALLEATED re-submission of the SAME group → tx_already_used', async () => {
    const g = gate()
    const first = await g.verify(algoHeader(['YWJj', 'ZGVm']))
    expect(first.kind).toBe('paid')
    // Re-submit the SAME group bytes with whitespace-malleated base64 — must canonicalize to the
    // same replay key and be rejected BEFORE a second settle.
    const second = await g.verify(algoHeader(['YWJj ', 'ZGVm']))
    expect(second.kind).toBe('invalid')
    if (second.kind === 'invalid') expect(second.error).toBe('tx_already_used')
    expect(settleSpy).toHaveBeenCalledOnce() // settle ran ONCE, not twice
  })

  it('releases the replay claim when settle fails, so a fixed re-present can succeed', async () => {
    const g = gate()
    settleMode = 'invalid'
    const bad = await g.verify(algoHeader(['Zm9v', 'YmFy']))
    expect(bad.kind).toBe('invalid')
    settleMode = 'ok'
    const good = await g.verify(algoHeader(['Zm9v', 'YmFy']))
    expect(good.kind).toBe('paid') // the same group is NOT stuck "used" after a failed settle
  })
})
