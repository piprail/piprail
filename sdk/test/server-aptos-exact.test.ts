/**
 * The gate's `exact` path for Aptos, via a controllable fake `aptos` driver — no RPC. Proves the
 * protocol layer is family-agnostic for the new `aptos` method: it dual-advertises an `aptos` exact
 * rail, routes settlement to `settleExactSelf`, and — the focus here — dedupes a re-submitted payment
 * on the CANONICALIZED `payload.transaction` + `payload.senderAuth`, so a base64-malleated
 * re-submission of the same fee-payer tx can't slip past the replay claim. (The real driver's tx
 * logic is covered by test/aptos/exact.test.ts; the EVM/SVM/Algorand paths by the other server-*.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const NETWORK = 'aptos:1'
const ASSET = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const FEE_PAYER = '0xf5ab05aca319330eb2f71bc9a761ee3ea7d2b3a2745c179fc85df4262a5d34a8'
const PAY_TO = '0x3b64e41401307dbd4da6fe3a801f330a467dad85b21283021c42366dd90e49d7'

let settleMode: 'ok' | 'invalid' = 'ok'
const settleSpy = vi.fn()

const fakeAptos: PaymentDriver = {
  family: 'aptos',
  resolve(opts) {
    if (opts.chain !== 'aptos') return null
    return {
      family: 'aptos',
      network: NETWORK,
      supports: (n) => n === NETWORK,
      resolveToken: () => ({ asset: ASSET, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'txhash',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'APT', feeDecimals: 8, fee: '0', feeFormatted: '0', basis: 'estimated' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
      // Mirror the real driver: a facilitator-provided feePayer wins; else the relayer's address
      // (FEE_PAYER stands in); with NEITHER, no rail (null). Native isn't exact-payable.
      resolveExactRail: async ({ asset, relayer, feePayer }) => {
        if (asset === 'native') return null
        const fp = feePayer ?? (relayer ? FEE_PAYER : undefined)
        return fp ? { method: 'aptos', extra: { feePayer: fp } } : null
      },
      settleExactSelf: async ({ payload, accept }) => {
        settleSpy({ payload, accept })
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'short' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: 'SETTLED_HASH', asset: accept.asset, amount: accept.amount, payer: 'BUYER', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeAptos)

afterEach(() => { settleMode = 'ok'; settleSpy.mockClear() })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const aptosHeader = (transaction: string, senderAuth: string) =>
  b64({ x402Version: 2, accepted: { scheme: 'exact', network: NETWORK, asset: ASSET }, payload: { transaction, senderAuth } })

const gate = () =>
  createPaymentGate({
    chain: 'aptos',
    token: 'USDC',
    amount: '0.05',
    payTo: PAY_TO,
    exact: { settle: 'self', relayer: { key: '0x' + 'a'.repeat(64) } },
  })

describe('gate · Aptos exact (fake driver, no RPC)', () => {
  it('dual-advertises an `aptos` exact rail beside onchain-proof', async () => {
    const { challenge } = await gate().challenge()
    const rails = challenge.accepts
    const exact = rails.find((r) => r.scheme === 'exact')
    expect(exact).toBeTruthy()
    expect(exact!.extra.assetTransferMethod).toBe('aptos')
    expect((exact!.extra as { feePayer?: string }).feePayer).toBe(FEE_PAYER)
    expect(rails.some((r) => r.scheme === 'onchain-proof')).toBe(true)
  })

  it('routes a valid Aptos payload to settleExactSelf → paid', async () => {
    const res = await gate().verify(aptosHeader('dHhieXRlcw==', 'YXV0aGJ5dGVz'))
    expect(res.kind).toBe('paid')
    expect(settleSpy).toHaveBeenCalledOnce()
    const arg = settleSpy.mock.calls[0]![0]
    expect(arg.payload).toMatchObject({ transaction: 'dHhieXRlcw==', senderAuth: 'YXV0aGJ5dGVz' })
    expect(arg.accept.payTo).toBe(PAY_TO)
  })

  it('dedupes a base64-MALLEATED re-submission of the SAME tx → tx_already_used', async () => {
    const g = gate()
    const first = await g.verify(aptosHeader('dHhieXRlcw==', 'YXV0aGJ5dGVz'))
    expect(first.kind).toBe('paid')
    // Re-submit the SAME tx + auth bytes with whitespace-malleated base64 — must canonicalize to the
    // same replay key and be rejected BEFORE a second settle.
    const second = await g.verify(aptosHeader('dHhieXRlcw== ', 'YXV0aGJ5dGVz'))
    expect(second.kind).toBe('invalid')
    if (second.kind === 'invalid') expect(second.error).toBe('tx_already_used')
    expect(settleSpy).toHaveBeenCalledOnce() // settle ran ONCE, not twice
  })

  it('releases the replay claim when settle fails, so a fixed re-present can succeed', async () => {
    const g = gate()
    settleMode = 'invalid'
    const bad = await g.verify(aptosHeader('Zm9vMTIz', 'YmFyNDU2'))
    expect(bad.kind).toBe('invalid')
    settleMode = 'ok'
    const good = await g.verify(aptosHeader('Zm9vMTIz', 'YmFyNDU2'))
    expect(good.kind).toBe('paid') // the same tx is NOT stuck "used" after a failed settle
  })
})
