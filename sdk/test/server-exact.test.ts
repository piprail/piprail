/**
 * The gate's standard `exact` rail — dual-advertise + verify routing + conformant
 * rejection + the throw-vs-402 split — with NO RPC, via a controllable fake EVM
 * driver that implements `exactDomain` + `settleExactSelf`. Proves the protocol-layer
 * wiring (matching, replay-claim, settle-mode routing, receipts) independent of chain.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import { SettlementError } from '../src/errors.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const USDC = '0xusdc'

// Controllable settle behaviour for the fake driver.
let settleMode: 'ok' | 'invalid' | 'throw' = 'ok'
let lastSettleAccept: unknown = null
let domainThrowOnce = false // simulate a transient RPC failure on the first exactDomain read
const settleSpy = vi.fn()

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
      resolveToken: (t) =>
        t === 'native'
          ? { asset: 'native', decimals: 18, symbol: 'ETH' }
          : t === 'USDT'
            ? { asset: '0xusdt', decimals: 6, symbol: 'USDT' }
            : { asset: USDC, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({ ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } }),
      // EIP-3009 only for USDC (the "usdc" asset); native/USDT aren't EIP-3009.
      exactDomain: async (asset) => {
        if (domainThrowOnce) { domainThrowOnce = false; throw new Error('transient RPC reading domain') }
        return asset === USDC ? { name: 'USD Coin', version: '2' } : null
      },
      settleExactSelf: async ({ relayer, payload, accept }) => {
        settleSpy({ relayer, payload, accept })
        lastSettleAccept = accept
        if (settleMode === 'throw') throw new SettlementError('relayer out of gas')
        if (settleMode === 'invalid') return { ok: false, error: 'amount_too_low', detail: 'Authorized 1, required 50000.' }
        return { ok: true, receipt: { scheme: 'exact', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: accept.amount, payer: payload.authorization.from, payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeEvm)

afterEach(() => { settleMode = 'ok'; lastSettleAccept = null; domainThrowOnce = false; settleSpy.mockClear(); vi.restoreAllMocks() })

const AUTH = (over: Record<string, string> = {}) => ({
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  to: PAY_TO,
  value: '50000',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: '0x' + Math.floor(Math.random() * 1e12).toString(16).padStart(64, '0'),
  ...over,
})
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
const v2Header = (accepted: unknown, authorization: unknown, signature = '0xsig') =>
  b64({ x402Version: 2, accepted, payload: { signature, authorization } })
const v1Header = (network: string, authorization: unknown, signature = '0xsig') =>
  b64({ x402Version: 1, scheme: 'exact', network, payload: { signature, authorization } })

const exactGate = (over = {}) =>
  createPaymentGate({
    chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO,
    exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } },
    ...over,
  })

describe('exact rail — dual-advertise', () => {
  it('offers BOTH an exact rail and an onchain-proof rail, exact first', async () => {
    const { challenge } = await exactGate().challenge('https://api/x')
    expect(challenge.accepts).toHaveLength(2)
    const [exact, proof] = challenge.accepts
    expect(exact!.scheme).toBe('exact')
    expect(proof!.scheme).toBe('onchain-proof')
    // exact rail carries the EIP-712 domain READ from the token + the v2 marker.
    expect(exact!.extra).toMatchObject({ assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' })
    expect(exact!.asset).toBe(USDC)
    expect(exact!.amount).toBe('50000')
    expect(exact!.payTo).toBe(PAY_TO)
  })

  it('without `exact:` the challenge is unchanged (onchain-proof only)', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts).toHaveLength(1)
    expect(challenge.accepts[0]!.scheme).toBe('onchain-proof')
  })

  it('describe() lists both rails for discovery', async () => {
    const desc = await exactGate().describe('https://api/x')
    expect(desc.accepts.map((a) => a.scheme).sort()).toEqual(['exact', 'onchain-proof'])
  })
})

describe('exact rail — config validation', () => {
  it('throws when exact is requested on a non-EIP-3009 token (USDT)', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDT', amount: '1', payTo: PAY_TO, exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } } })
    await expect(gate.challenge()).rejects.toThrow(/EIP-3009/)
  })

  it('throws when exact is requested on the native coin', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'native', amount: '0.01', payTo: PAY_TO, exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } } })
    await expect(gate.challenge()).rejects.toThrow(/exact|EIP-3009/)
  })

  it('throws when self mode has no relayer', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: 'self' } })
    await expect(gate.challenge()).rejects.toThrow(/relayer/)
  })

  it('a transient failure on the FIRST resolution does NOT brick the gate — the next call retries (bug #4)', async () => {
    domainThrowOnce = true
    const gate = exactGate()
    await expect(gate.challenge()).rejects.toThrow(/transient RPC/)
    // The rejected resolution must NOT be cached: a later challenge succeeds once the node recovers.
    const { challenge } = await gate.challenge()
    expect(challenge.accepts.some((a) => a.scheme === 'exact')).toBe(true)
  })
})

describe('exact rail — v1 routing safety', () => {
  it('a v1 slug payment on a MULTI-exact-rail gate is rejected (ambiguous), not mis-routed (bug #5)', async () => {
    // Two EVM chains, both with an exact USDC rail → a v1 slug claim (no CAIP-2, no asset)
    // can't disambiguate, so it must NOT silently settle against candidates[0].
    const gate = createPaymentGate({
      accept: [
        { chain: { id: 1, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
        { chain: { id: 8453, rpcUrl: 'y' }, token: 'USDC', amount: '0.05', payTo: PAY_TO },
      ],
      exact: { settle: 'self', relayer: { privateKey: '0x' + 'ab'.repeat(32) } },
    })
    const res = await gate.verify(v1Header('ethereum', AUTH()))
    expect(res).toMatchObject({ kind: 'invalid', error: 'transfer_not_found' })
    expect(settleSpy).not.toHaveBeenCalled() // never settled the wrong rail
  })

  it('a v1 slug payment on a SINGLE-exact-rail gate still settles (unambiguous fallback)', async () => {
    const res = await exactGate().verify(v1Header('base', AUTH()))
    expect(res.kind).toBe('paid')
  })
})

describe('exact rail — verify + settle routing', () => {
  it('verifies a v2 PAYMENT-SIGNATURE exact payment → paid, with the SERVER-trusted accept', async () => {
    const gate = exactGate()
    const { challenge } = await gate.challenge()
    const exactRail = challenge.accepts.find((a) => a.scheme === 'exact')!
    const res = await gate.verify(v2Header(exactRail, AUTH()))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.scheme).toBe('exact')
    // The driver received the SERVER's trusted accept (correct domain), not the client echo.
    expect((lastSettleAccept as { extra: { name: string } }).extra.name).toBe('USD Coin')
  })

  it('verifies a v1 X-PAYMENT (slug network, no accepted) → paid via the single exact rail', async () => {
    const res = await exactGate().verify(v1Header('base', AUTH()))
    expect(res.kind).toBe('paid')
    expect(settleSpy).toHaveBeenCalledOnce()
  })

  it('emits both PAYMENT-RESPONSE and X-PAYMENT-RESPONSE on a paid exact settlement (adapter)', async () => {
    // Verified indirectly via the receiptHeader being present; adapter sets both. Here we
    // assert the gate produced a receipt header for the exact payment.
    const res = await exactGate().verify(v1Header('base', AUTH()))
    expect(res.kind === 'paid' && typeof res.receiptHeader).toBe('string')
  })

  it('ignores a forged client `accepted` — uses the server amount/payTo', async () => {
    const gate = exactGate()
    const { challenge } = await gate.challenge()
    const exactRail = challenge.accepts.find((a) => a.scheme === 'exact')!
    // Forge the echoed accept: tiny amount, attacker payTo. Settle must get the SERVER accept.
    const forged = { ...exactRail, amount: '1', payTo: '0x9999999999999999999999999999999999999999' }
    const res = await gate.verify(v2Header(forged, AUTH()))
    expect(res.kind).toBe('paid')
    const used = lastSettleAccept as { amount: string; payTo: string }
    expect(used.amount).toBe('50000')
    expect(used.payTo).toBe(PAY_TO)
  })

  it('rejects an exact payment for an un-offered network → transfer_not_found (conformant 402)', async () => {
    const gate = exactGate()
    const { challenge } = await gate.challenge()
    const exactRail = challenge.accepts.find((a) => a.scheme === 'exact')!
    const res = await gate.verify(v2Header({ ...exactRail, network: 'eip155:1', asset: '0xother' }, AUTH()))
    expect(res).toMatchObject({ kind: 'invalid', error: 'transfer_not_found' })
  })
})

describe('exact rail — replay + rejection conformance', () => {
  it('rejects a replayed authorization nonce → tx_already_used', async () => {
    const gate = exactGate()
    const auth = AUTH()
    const h = v2Header({ scheme: 'exact', network: 'eip155:8453', asset: USDC }, auth)
    const first = await gate.verify(h)
    const second = await gate.verify(h)
    expect(first.kind).toBe('paid')
    expect(second).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })

  it('a driver rejection becomes a CONFORMANT re-challenge (accepts[] + extensions.piprail + error)', async () => {
    settleMode = 'invalid'
    const gate = exactGate()
    const { challenge } = await gate.challenge()
    const exactRail = challenge.accepts.find((a) => a.scheme === 'exact')!
    const res = await gate.verify(v2Header(exactRail, AUTH()))
    expect(res.kind).toBe('invalid')
    if (res.kind === 'invalid') {
      // It carries a full re-challenge a standard client can retry on.
      expect(res.challenge.accepts.length).toBeGreaterThanOrEqual(2)
      expect(res.challenge.error).toContain('amount_too_low')
      expect(res.challenge.extensions).toMatchObject({ piprail: { code: 'amount_too_low' } })
      expect(typeof res.requiredHeader).toBe('string')
      // NOT the legacy non-conformant shape.
      expect((res.challenge as unknown as Record<string, unknown>).status).toBeUndefined()
    }
  })
})

describe('exact rail — server-side settle failure', () => {
  it('propagates SettlementError (→ 5xx) and releases the nonce claim so a retry can settle', async () => {
    const gate = exactGate()
    const auth = AUTH()
    const h = v2Header({ scheme: 'exact', network: 'eip155:8453', asset: USDC }, auth)
    settleMode = 'throw'
    await expect(gate.verify(h)).rejects.toBeInstanceOf(SettlementError)
    // Claim released → the SAME authorization can be re-presented once the relayer is fixed.
    settleMode = 'ok'
    const retry = await gate.verify(h)
    expect(retry.kind).toBe('paid')
  })
})

describe('exact rail — facilitator mode (Mode B)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('routes to the facilitator (verify→settle) and returns paid', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      const body = url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0xFAC', network: 'eip155:8453', payer: '0xPAYER' }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: { facilitator: 'https://x402.org/facilitator' } } })
    const { challenge } = await gate.challenge()
    const exactRail = challenge.accepts.find((a) => a.scheme === 'exact')!
    const res = await gate.verify(v2Header(exactRail, AUTH()))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.transaction).toBe('0xFAC')
    expect(calls).toEqual(['https://x402.org/facilitator/verify', 'https://x402.org/facilitator/settle'])
  })

  it('forwards a SELF-CONSISTENT v2 body even for a v1 X-PAYMENT client (bug #1)', async () => {
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      const u = String(_url)
      const body = u.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0xFAC', network: 'eip155:8453' }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, exact: { settle: { facilitator: 'https://x402.org/facilitator' } } })
    // A v1 client sends x402Version:1 — but PipRail only builds v2-shaped paymentRequirements,
    // so it must forward x402Version:2 (not 1), or the facilitator gets a self-inconsistent body.
    const res = await gate.verify(v1Header('base', AUTH()))
    expect(res.kind).toBe('paid')
    expect(bodies[0]!.x402Version).toBe(2)
    expect((bodies[0]!.paymentRequirements as { network: string }).network).toBe('eip155:8453') // CAIP-2 (v2)
    expect((bodies[0]!.paymentRequirements as { amount: string }).amount).toBe('50000') // v2 `amount`, not maxAmountRequired
  })
})
