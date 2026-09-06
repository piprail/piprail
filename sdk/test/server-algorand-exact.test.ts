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
/** Did the onchain-proof path actually reach the driver's verifier? That is the only
 *  externally visible difference between "the echoed network selected our rail" and "no rail
 *  matched" — a rejected proof re-challenges either way, with no error string. */
const verifySpy = vi.fn()

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
      verify: async () => { verifySpy(); return { ok: false as const, error: 'transfer_not_found' as const, detail: 'unused' } },
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

afterEach(() => { settleMode = 'ok'; settleSpy.mockClear(); verifySpy.mockClear() })

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
    expect(exact!.extra!.assetTransferMethod).toBe('algorand')
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

  /*
   * The gate must tolerate a buyer that echoes a DIFFERENT SPELLING of the same chain.
   *
   * `scheme_exact_algo.md` gives Algorand mainnet as the genesis hash truncated to 32 chars;
   * PipRail binds (and emits) the padded 44-char form. A conformant buyer that canonicalises to
   * the spec form before echoing was being rejected outright, because the gate compared the two
   * ids with `===`. Since 2.16.0 both sides go through `normalizeNetwork`, which maps the spec
   * form onto the padded one.
   *
   * Safe by construction: the network here only SELECTS which offered rail is meant — payTo,
   * amount and asset are all re-derived from the gate's own spec — so widening the match can
   * never redirect a payment. The wrong-network case below proves it stayed narrow.
   */
  const ALGO_SPEC_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'

  it("matches a payment echoing the SPEC's truncated CAIP-2, not our padded one", async () => {
    const header = b64({
      x402Version: 2,
      accepted: { scheme: 'exact', network: ALGO_SPEC_CAIP2, asset: ASSET },
      payload: { paymentIndex: 0, paymentGroup: ['c3BlYw==', 'Zm9ybQ=='] },
    })
    const res = await gate().verify(header)
    expect(res.kind).toBe('paid')
    // and it settled against OUR rail — the echoed spelling selects, it never redirects
    expect(settleSpy.mock.calls[0]![0].accept.network).toBe(NETWORK)
    expect(settleSpy.mock.calls[0]![0].accept.payTo).toBe(PAY_TO)
  })

  it('still refuses a genuinely different network (the widening is only the alias)', async () => {
    const header = b64({
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:8453', asset: ASSET },
      payload: { paymentIndex: 0, paymentGroup: ['d3Jvbmc=', 'Y2hhaW4='] },
    })
    const res = await gate().verify(header)
    expect(res.kind).toBe('invalid')
    expect(settleSpy).not.toHaveBeenCalled()
  })

  it('an onchain-proof echo on the spec-form id is matched too (same selector, both rails)', async () => {
    const header = b64({
      x402Version: 2,
      accepted: { scheme: 'onchain-proof', network: ALGO_SPEC_CAIP2, asset: ASSET },
      payload: { txHash: 'TNJO7RGPA34JQZ7XVWKQAPHKQ4MPHRSGKQZ2VCXKJHVWQ3AYQBFA', nonce: 'n-1' },
    })
    // The fake driver's `verify` always reports transfer_not_found, so this proof is always
    // refused — and a refused proof re-challenges with no error string, so the OUTCOME can't
    // distinguish "no rail matched" from "the rail matched and the proof was bad". Reaching the
    // verifier at all is the observable, which is why the spy exists.
    await gate().verify(header)
    expect(verifySpy).toHaveBeenCalledOnce() // the spec-form id SELECTED our rail

    // A genuinely different chain must still stop BEFORE the verifier — the widening is the
    // alias and nothing else.
    verifySpy.mockClear()
    await gate().verify(
      b64({
        x402Version: 2,
        accepted: { scheme: 'onchain-proof', network: 'eip155:8453', asset: ASSET },
        payload: { txHash: 'WRONGCHAINQZ7XVWKQAPHKQ4MPHRSGKQZ2VCXKJHVWQ3AYQBFA', nonce: 'n-2' },
      })
    )
    expect(verifySpy).not.toHaveBeenCalled()
  })
})
