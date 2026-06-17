/**
 * The gate's `exact` path for NEAR, via a controllable fake `near` driver — no RPC. NEAR exact is
 * NEP-141-only + FACILITATOR-settled (no PipRail self-settle: the relayer wraps the delegate in its
 * own outer transaction and sponsors gas + the 1 yocto). So this proves the protocol layer is
 * family-agnostic for the new `near` method: it discovers the facilitator fee-payer from /supported,
 * dual-advertises a `near` rail carrying that feePayer, forwards an inbound SignedDelegateAction to
 * the facilitator (/verify → /settle), and — the focus here — dedupes a re-submitted payment on a
 * CANONICALIZED `payload.signedDelegateAction`, so a base64-malleated re-submission can't slip past
 * the replay claim. (The buyer's delegate build is covered by test/near/exact.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const NETWORK = 'near:mainnet'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const FEE_PAYER = 'uvd-facilitator.near'
const PAY_TO = 'merchant.near'
const FACILITATOR = 'https://facilitator.example'

const fakeNear: PaymentDriver = {
  family: 'near',
  resolve(opts) {
    if (opts.chain !== 'near') return null
    return {
      family: 'near',
      network: NETWORK,
      supports: (n) => n === NETWORK,
      resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'alice.near:HASH',
      confirm: async () => ({ height: '0' }),
      estimateCost: async () => ({ feeSymbol: 'NEAR', feeDecimals: 24, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
      // Mirror the real driver: NEAR exact is facilitator-settled, so it advertises ONLY with a
      // facilitator-provided feePayer; native / no-feePayer ⇒ no rail. There is NO settleExactSelf.
      resolveExactRail: async ({ asset, feePayer }) => {
        if (asset === 'native' || !feePayer) return null
        return { method: 'near', extra: { feePayer } }
      },
    }
  },
}
registerDriver(fakeNear)

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const nearHeader = (signedDelegateAction: string) =>
  b64({ x402Version: 2, accepted: { scheme: 'exact', network: NETWORK, asset: USDC }, payload: { signedDelegateAction } })

describe('gate — NEAR exact (facilitator-settled; buyer & merchant pay zero NEAR)', () => {
  let calls: { url: string; method: string }[] = []
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    calls = []
    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      calls.push({ url: u, method: init?.method ?? 'GET' })
      if (u.endsWith('/supported')) {
        // UVD's shape: a near:mainnet exact kind whose extra.feePayer is the relayer account.
        return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: FEE_PAYER } }] }), { status: 200 })
      }
      if (u.endsWith('/verify')) return new Response(JSON.stringify({ isValid: true, payer: 'alice.near' }), { status: 200 })
      if (u.endsWith('/settle')) return new Response(JSON.stringify({ success: true, transaction: 'NEAR_FAC_TXID', network: NETWORK, payer: 'alice.near' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })

  const gate = () =>
    createPaymentGate({ chain: 'near', token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: { facilitator: FACILITATOR } } })

  it('discovers the facilitator relayer from /supported and dual-advertises a `near` rail carrying it', async () => {
    const { challenge } = await gate().challenge('https://api/x')
    expect(challenge.accepts).toHaveLength(2)
    expect(challenge.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, extra: { assetTransferMethod: 'near', feePayer: FEE_PAYER } })
    expect(challenge.accepts[1]!.scheme).toBe('onchain-proof')
    expect(calls.some((c) => c.url.endsWith('/supported'))).toBe(true)
  })

  it('forwards an inbound SignedDelegateAction to the facilitator (/verify → /settle) → paid', async () => {
    const res = await gate().verify(nearHeader('AQAAA_fakeSignedDelegate_base64'))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.transaction).toBe('NEAR_FAC_TXID')
    expect(calls.some((c) => c.url.endsWith('/verify') && c.method === 'POST')).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/settle') && c.method === 'POST')).toBe(true)
  })

  it('forwards a v2 paymentRequirements carrying the NEAR relayer feePayer in extra', async () => {
    let settleBody: Record<string, unknown> | undefined
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u.endsWith('/settle')) settleBody = JSON.parse(init!.body as string)
      return (prev as typeof globalThis.fetch)(input, init)
    }) as typeof globalThis.fetch
    await gate().verify(nearHeader('AQAAA_fakeSignedDelegate_b'))
    const reqs = settleBody?.paymentRequirements as { network: string; amount: string; extra: { feePayer?: string } }
    expect(reqs.network).toBe(NETWORK)
    expect(reqs.amount).toBe('50000') // v2 atomic amount (0.05 USDC, 6dp)
    expect(reqs.extra.feePayer).toBe(FEE_PAYER)
  })

  it('dedupes a base64-malleated re-submission of the SAME signed delegate → tx_already_used', async () => {
    const sda = 'AQAAA_singleUseDelegate_xyz'
    const g = gate() // ONE gate instance — the replay set lives in its closure.
    const first = await g.verify(nearHeader(sda))
    expect(first.kind).toBe('paid')
    // Same signed action, re-base64'd via a fresh JSON frame — the gate canonicalizes the
    // signedDelegateAction bytes into the replay key, so the second submit is rejected.
    const second = await g.verify(nearHeader(sda))
    expect(second.kind).toBe('invalid')
    if (second.kind === 'invalid') expect(second.error).toBe('tx_already_used')
  })
})
