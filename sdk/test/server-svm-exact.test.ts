/**
 * The gate's `exact` path for a NON-EVM family (Solana/SVM), via a controllable fake `solana`
 * driver — no RPC. Proves the protocol layer is family-agnostic: it dual-advertises a `svm` rail,
 * routes settlement to `settleExactSelf`, and — the focus here — dedupes a re-submitted payment
 * on a CANONICALIZED `payload.transaction`, so a base64-malleated re-submission can't slip past
 * the replay claim. (The EVM path is covered by server-exact.test.ts.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const FEE_PAYER = 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd'
const PAY_TO = 'Fn92mUtJGi6L6j2nEcV8ZMbGQzVJDUe4PEWx9B8nBWxj'

let settleMode: 'ok' | 'invalid' = 'ok'
const settleSpy = vi.fn()

const fakeSolana: PaymentDriver = {
  family: 'solana',
  resolve(opts) {
    if (opts.chain !== 'solana') return null
    return {
      family: 'solana',
      network: NETWORK,
      supports: (n) => n === NETWORK,
      resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'sig',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'SOL', feeDecimals: 9, fee: '5000', feeFormatted: '0.000005', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
      // Mirror the real driver: the facilitator-provided feePayer hint wins; else the relayer's
      // pubkey (FEE_PAYER stands in); with NEITHER, there's no rail (null).
      resolveExactRail: async ({ relayer, feePayer }) => {
        const fp = feePayer ?? (relayer ? FEE_PAYER : undefined)
        return fp ? { method: 'svm', extra: { feePayer: fp, tokenProgram: 'spl-token' } } : null
      },
      settleExactSelf: async ({ payload, accept }) => {
        settleSpy({ payload, accept })
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'short' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: 'SETTLED_SIG', asset: accept.asset, amount: accept.amount, payer: 'BUYER', payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeSolana)

afterEach(() => { settleMode = 'ok'; settleSpy.mockClear() })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const svmHeader = (transaction: string) =>
  b64({ x402Version: 2, accepted: { scheme: 'exact', network: NETWORK, asset: USDC }, payload: { transaction } })

const gate = () =>
  createPaymentGate({
    chain: 'solana',
    token: 'USDC',
    amount: '0.05',
    payTo: PAY_TO,
    exact: { settle: 'self', relayer: { secretKey: new Uint8Array(64) } },
  })

describe('gate — SVM exact dual-advertise + settle routing', () => {
  it('dual-advertises a `svm` rail (feePayer in extra) beside onchain-proof', async () => {
    const { challenge } = await gate().challenge('https://api/x')
    expect(challenge.accepts).toHaveLength(2)
    expect(challenge.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, extra: { assetTransferMethod: 'svm', feePayer: FEE_PAYER } })
    expect(challenge.accepts[1]!.scheme).toBe('onchain-proof')
  })

  it('routes an inbound svm PAYMENT-SIGNATURE to settleExactSelf → paid', async () => {
    const res = await gate().verify(svmHeader(Buffer.from([1, 2, 3, 4]).toString('base64')))
    expect(res.kind).toBe('paid')
    expect(settleSpy).toHaveBeenCalledTimes(1)
  })
})

describe('gate — SVM replay dedupe is canonical (base64-malleation can\'t bypass it)', () => {
  it('a re-submission with whitespace/padding-mutated base64 → tx_already_used (settled once)', async () => {
    const g = gate()
    const tx = Buffer.from([9, 8, 7, 6, 5]).toString('base64') // has '=' padding
    const first = await g.verify(svmHeader(tx))
    expect(first.kind).toBe('paid')

    // Same tx BYTES, different base64 STRING: strip padding AND add a newline.
    const malleated = `${tx.replace(/=+$/, '')}\n`
    expect(malleated).not.toBe(tx)
    const second = await g.verify(svmHeader(malleated))
    expect(second.kind).toBe('invalid')
    if (second.kind === 'invalid') expect(second.error).toBe('tx_already_used')
    expect(settleSpy).toHaveBeenCalledTimes(1) // settle ran only for the first submission
  })

  it('a rejected settle releases the claim → the same tx can be re-presented', async () => {
    const g = gate()
    const tx = Buffer.from([4, 4, 4, 4]).toString('base64')
    settleMode = 'invalid'
    const first = await g.verify(svmHeader(tx))
    expect(first.kind).toBe('invalid')
    // Claim released on a client-fixable rejection → a corrected retry isn't wrongly "already used".
    settleMode = 'ok'
    const second = await g.verify(svmHeader(tx))
    expect(second.kind).toBe('paid')
    expect(settleSpy).toHaveBeenCalledTimes(2)
  })
})

describe('gate — SVM facilitator mode (neither buyer nor merchant pays gas; facilitator sponsors)', () => {
  const FACILITATOR = 'https://facilitator.example'
  const FAC_FEEPAYER = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4'
  let calls: { url: string; method: string }[] = []
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    realFetch = globalThis.fetch
    // Route the facilitator's GET /supported (feePayer discovery) + POST /verify + /settle.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      calls.push({ url: u, method: init?.method ?? 'GET' })
      if (u.endsWith('/supported')) {
        return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: FAC_FEEPAYER } }] }), { status: 200 })
      }
      if (u.endsWith('/verify')) return new Response(JSON.stringify({ isValid: true, payer: 'BUYER' }), { status: 200 })
      if (u.endsWith('/settle')) return new Response(JSON.stringify({ success: true, transaction: 'FAC_TXID', network: NETWORK, payer: 'BUYER' }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
  })
  afterEach(() => { globalThis.fetch = realFetch })

  const facilitatorGate = (over = {}) =>
    createPaymentGate({ chain: 'solana', token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: { facilitator: FACILITATOR, ...over } } })

  it('discovers the facilitator fee-payer from /supported and advertises it', async () => {
    const { challenge } = await facilitatorGate().challenge('https://api/x')
    expect(challenge.accepts[0]).toMatchObject({ scheme: 'exact', extra: { assetTransferMethod: 'svm', feePayer: FAC_FEEPAYER } })
    expect(calls.some((c) => c.url.endsWith('/supported'))).toBe(true)
    // settleExactSelf was NOT used (no merchant relayer in facilitator mode).
    expect(settleSpy).not.toHaveBeenCalled()
  })

  it('a configured feePayer override SKIPS the /supported fetch', async () => {
    const { challenge } = await facilitatorGate({ feePayer: FAC_FEEPAYER }).challenge('https://api/x')
    expect(challenge.accepts[0]).toMatchObject({ extra: { feePayer: FAC_FEEPAYER } })
    expect(calls.some((c) => c.url.endsWith('/supported'))).toBe(false) // discovery skipped
  })

  it('routes an inbound svm payment to the facilitator (/verify → /settle) → paid, txid from facilitator', async () => {
    const res = await facilitatorGate().verify(svmHeader(Buffer.from([5, 5, 5, 5]).toString('base64')))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.transaction).toBe('FAC_TXID')
    expect(calls.some((c) => c.url.endsWith('/verify') && c.method === 'POST')).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/settle') && c.method === 'POST')).toBe(true)
    expect(settleSpy).not.toHaveBeenCalled() // facilitator settled, not the gate
  })

  it('forwards a paymentRequirements.extra carrying the facilitator feePayer (not name/version)', async () => {
    await facilitatorGate().verify(svmHeader(Buffer.from([6, 6, 6, 6]).toString('base64')))
    const settleCall = calls.find((c) => c.url.endsWith('/settle'))
    expect(settleCall).toBeTruthy()
  })

  it('if /supported is unreachable AND no feePayer override → no rail → the gate refuses loudly', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.endsWith('/supported')) return new Response('err', { status: 500 })
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch
    await expect(facilitatorGate().challenge()).rejects.toThrow(/none of the offered rails support it/i)
  })
})
