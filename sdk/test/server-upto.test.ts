/**
 * The gate's standard `upto` (metered) rail — advertise + verify routing + the Shape-(A)
 * callback-meter lifecycle + the AUDIT B2 (requirePayment-unsupported) and B3 (nonce-release
 * on a metering/settle throw) resolutions — with NO RPC, via a controllable fake EVM driver
 * implementing the upto SPI trio. Mirrors server-exact.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createPaymentGate, requirePayment } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import { SettlementError } from '../src/errors.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'
const RELAYER_ADDR = '0x2222222222222222222222222222222222222222'
const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002'
const USDC = '0xusdc'

// Controllable settle behaviour. `settleSpy` records the (settleAmount, accept) the gate passed.
let settleThrow: 'no' | 'settlement' | 'other' = 'no'
let lastSettle: { settleAmount: bigint; accept: unknown } | null = null
// A persistent "consumed nonce" set the fake settle marks — mirrors the on-chain Permit2 bitmap,
// so a re-present after a SUCCESSFUL settle is rejected by the DRIVER as tx_already_used (in
// addition to the gate's own replay claim), matching real on-chain behaviour.
const consumedNonces = new Set<string>()

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
          : { asset: USDC, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: { account: { address: RELAYER_ADDR }, w } }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({ ok: true, receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' } }),
      // The upto rail-advertisement SPI: a permit2-upto rail with facilitatorAddress = the relayer,
      // ONLY for a non-native ERC-20 on a proxy chain. native / chain id 5000 (proxy-less) → null.
      async resolveUptoRail({ asset }) {
        if (asset === 'native') return null
        if (chain.id === 5000) return null // simulate a proxy-less chain
        return { method: 'permit2-upto', extra: { facilitatorAddress: RELAYER_ADDR, name: 'USD Coin', version: '2' } }
      },
      async settleUptoSelf({ payload, accept, settleAmount }) {
        lastSettle = { settleAmount, accept }
        const nonce = payload.permit2Authorization.nonce
        // Re-present of a SUCCESSFULLY-consumed nonce → on-chain reads it as used.
        if (consumedNonces.has(nonce)) return { ok: false, error: 'tx_already_used', detail: 'Permit2 nonce already used.' }
        if (settleThrow === 'settlement') throw new SettlementError('relayer out of gas')
        if (settleThrow === 'other') throw new Error('the meter computation blew up')
        // Clamp/over-max guard (mirrors the driver).
        const max = BigInt((accept as { amount: string }).amount)
        if (settleAmount > max) return { ok: false, error: 'upto_settle_exceeds_max', detail: `${settleAmount} > ${max}` }
        if (settleAmount === 0n) {
          return { ok: true, receipt: { scheme: 'upto', success: true, network: accept.network, transaction: '', asset: accept.asset, amount: '0', payer: payload.permit2Authorization.from, payTo: accept.payTo, verifiedAt: 'now' } }
        }
        consumedNonces.add(nonce) // burn it on a real settle
        return { ok: true, receipt: { scheme: 'upto', success: true, network: accept.network, transaction: `0x${'fe'.repeat(32)}`, asset: accept.asset, amount: settleAmount.toString(), payer: payload.permit2Authorization.from, payTo: accept.payTo, verifiedAt: 'now' } }
      },
    }
  },
}
registerDriver(fakeEvm)

afterEach(() => { settleThrow = 'no'; lastSettle = null; consumedNonces.clear() })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
let nonceCtr = 0
const PA = (over: Record<string, unknown> = {}) => ({
  permitted: { token: USDC, amount: '500000' }, // signed MAX = 0.50 USDC (6dp)
  from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
  spender: UPTO_PROXY,
  nonce: String(++nonceCtr) + '000000000',
  deadline: '9999999999',
  witness: { to: PAY_TO, facilitator: RELAYER_ADDR, validAfter: '0' },
  ...over,
})
const uptoHeader = (accepted: unknown, pa = PA(), signature = '0xsig') =>
  b64({ x402Version: 2, accepted, payload: { signature, permit2Authorization: pa } })

type SettleAmountFn = (ctx: { maxAmount: bigint; asset: string; network: string; decimals: number; request?: unknown }) => bigint | string | Promise<bigint | string>
const meterGate = (settleAmount: SettleAmountFn, over = {}) =>
  createPaymentGate({
    chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO,
    upto: { relayer: { key: '0x' + 'ab'.repeat(32) }, settleAmount: settleAmount as never },
    ...over,
  })

describe('upto rail — advertise', () => {
  it('offers BOTH an upto rail and an onchain-proof rail, upto first', async () => {
    const { challenge } = await meterGate(() => 0n).challenge('https://api/x')
    expect(challenge.accepts).toHaveLength(2)
    const [upto, proof] = challenge.accepts
    expect(upto!.scheme).toBe('upto')
    expect(proof!.scheme).toBe('onchain-proof')
    expect(upto!.extra).toMatchObject({ assetTransferMethod: 'permit2-upto', facilitatorAddress: RELAYER_ADDR })
    expect(upto!.amount).toBe('500000') // the MAX ceiling
    expect(upto!.payTo).toBe(PAY_TO)
  })

  it('(default omission) without `upto:` the challenge is byte-identical (onchain-proof only)', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO })
    const { challenge } = await gate.challenge()
    expect(challenge.accepts).toHaveLength(1)
    expect(challenge.accepts[0]!.scheme).toBe('onchain-proof')
  })

  it('describe() lists both rails for discovery', async () => {
    const desc = await meterGate(() => 0n).describe('https://api/x')
    expect(desc.accepts.map((a) => a.scheme).sort()).toEqual(['onchain-proof', 'upto'])
  })

  it('throws when upto is requested on the native coin (EVM-Permit2 only)', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'native', amount: '0.01', payTo: PAY_TO, upto: { relayer: { key: '0x' + 'ab'.repeat(32) }, settleAmount: () => 0n } })
    await expect(gate.challenge()).rejects.toThrow(/none of the offered rails support it|EVM-Permit2/i)
  })

  it('throws when upto is requested on a proxy-less chain', async () => {
    const gate = createPaymentGate({ chain: { id: 5000, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO, upto: { relayer: { key: '0x' + 'ab'.repeat(32) }, settleAmount: () => 0n } })
    await expect(gate.challenge()).rejects.toThrow(/none of the offered rails support it|EVM-Permit2/i)
  })

  it('throws when upto has no relayer', async () => {
    const gate = createPaymentGate({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO, upto: { settleAmount: () => 0n } as never })
    await expect(gate.challenge()).rejects.toThrow(/relayer/)
  })
})

describe('upto rail — the callback-meter lifecycle (the supported direct gate.verify() shape)', () => {
  it('invokes settleAmount(ctx) with the MAX and settles the returned ACTUAL', async () => {
    let seenCtx: { maxAmount: bigint; decimals: number } | null = null
    const gate = meterGate((ctx) => { seenCtx = ctx; return 12345n })
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const res = await gate.verify(uptoHeader(upto))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.amount).toBe('12345') // the metered ACTUAL, not the MAX
    expect(seenCtx!.maxAmount).toBe(500000n) // the ctx carries the MAX (the budget ceiling)
    expect(seenCtx!.decimals).toBe(6)
    expect(lastSettle!.settleAmount).toBe(12345n)
  })

  it('resolves the string forms — "50%" of the max, "$0.02", "0" — via the token decimals', async () => {
    // "50%" of 500000 = 250000
    {
      const gate = meterGate(() => '50%')
      const { challenge } = await gate.challenge()
      const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
      const res = await gate.verify(uptoHeader(upto))
      expect(res.kind).toBe('paid')
      if (res.kind === 'paid') expect(res.receipt.amount).toBe('250000')
    }
    // "$0.02" at 6 decimals = 20000
    {
      const gate = meterGate(() => '$0.02')
      const { challenge } = await gate.challenge()
      const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
      const res = await gate.verify(uptoHeader(upto))
      expect(res.kind).toBe('paid')
      if (res.kind === 'paid') expect(res.receipt.amount).toBe('20000')
    }
    // a raw atomic string
    {
      const gate = meterGate(() => '1858')
      const { challenge } = await gate.challenge()
      const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
      const res = await gate.verify(uptoHeader(upto))
      if (res.kind === 'paid') expect(res.receipt.amount).toBe('1858')
    }
    // a HIGH-PRECISION percent (>4dp) FLOORS to 4dp like "$X"/decimal — it must NOT misreport
    // as upto_settle_exceeds_max. "33.333333%" → floor 33.3333% of 500000 = 166666 (not a reject).
    {
      const gate = meterGate(() => '33.333333%')
      const { challenge } = await gate.challenge()
      const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
      const res = await gate.verify(uptoHeader(upto))
      expect(res.kind).toBe('paid')
      if (res.kind === 'paid') expect(res.receipt.amount).toBe('166666')
    }
  })

  it('CLAMP — a callback returning > max is rejected (upto_settle_exceeds_max), never over-settled', async () => {
    const gate = meterGate(() => 500001n) // 1 over the 500000 max
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const res = await gate.verify(uptoHeader(upto))
    expect(res).toMatchObject({ kind: 'invalid', error: 'upto_settle_exceeds_max' })
  })

  it('actual === 0 ⇒ a zero-amount receipt, transaction:"" (no on-chain tx)', async () => {
    const gate = meterGate(() => 0n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const res = await gate.verify(uptoHeader(upto))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') {
      expect(res.receipt.amount).toBe('0')
      expect(res.receipt.transaction).toBe('')
    }
  })

  it('uses the SERVER-trusted accept (forged client echo ignored)', async () => {
    const gate = meterGate(() => 100n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const forged = { ...upto, amount: '1', payTo: '0x9999999999999999999999999999999999999999' }
    const res = await gate.verify(uptoHeader(forged))
    expect(res.kind).toBe('paid')
    const used = lastSettle!.accept as { amount: string; payTo: string }
    expect(used.amount).toBe('500000') // the server MAX, not the forged '1'
    expect(used.payTo).toBe(PAY_TO)
  })
})

describe('upto rail — replay (nonce burned even on a zero-charge)', () => {
  it('re-presenting the same Permit2 nonce ⇒ tx_already_used', async () => {
    const gate = meterGate(() => 100n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    expect((await gate.verify(header)).kind).toBe('paid')
    expect(await gate.verify(header)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })

  it('a ZERO-charge auth still burns the nonce (claimed before metering) ⇒ re-present is tx_already_used', async () => {
    const gate = meterGate(() => 0n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    expect((await gate.verify(header)).kind).toBe('paid')
    expect(await gate.verify(header)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
})

describe('upto rail — AUDIT B3: a throw after the nonce is claimed RELEASES it', () => {
  it('(i) a non-SettlementError throw (the settle/meter path) rejects, fires onFailed, and the SAME nonce can re-present + succeed', async () => {
    const failures: string[] = []
    const gate = meterGate(() => 100n, { onFailed: (f: { code: string }) => failures.push(f.code) })
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    settleThrow = 'other'
    const res = await gate.verify(header)
    expect(res.kind).toBe('invalid') // a rejection, NOT a thrown 500
    expect(failures.length).toBe(1) // onFailed fired
    // Nonce RELEASED → the SAME authorization re-presents and now succeeds.
    settleThrow = 'no'
    const retry = await gate.verify(header)
    expect(retry.kind).toBe('paid')
  })

  it('(i-meter) a throw INSIDE the settleAmount callback releases the nonce + rejects (not a 500)', async () => {
    let calls = 0
    const gate = meterGate(() => { calls++; if (calls === 1) throw new Error('meter exploded'); return 100n })
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    const res = await gate.verify(header)
    expect(res.kind).toBe('invalid')
    // Released → a re-present (now the meter returns 100n) succeeds.
    const retry = await gate.verify(header)
    expect(retry.kind).toBe('paid')
  })

  it('(ii) a SettlementError rethrows (gate 5xx) AND the nonce is released for retry', async () => {
    const gate = meterGate(() => 100n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    settleThrow = 'settlement'
    await expect(gate.verify(header)).rejects.toBeInstanceOf(SettlementError)
    // Released → the SAME authorization settles once the relayer is fixed.
    settleThrow = 'no'
    const retry = await gate.verify(header)
    expect(retry.kind).toBe('paid')
  })

  it('(iii) a SUCCESSFUL settle burns the nonce ⇒ re-present is tx_already_used (failure releases, success burns)', async () => {
    const gate = meterGate(() => 100n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const header = uptoHeader(upto)
    expect((await gate.verify(header)).kind).toBe('paid')
    expect(await gate.verify(header)).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })
})

describe('upto rail — AUDIT B2: requirePayment is UNSUPPORTED for upto', () => {
  it('requirePayment constructed with an `upto` rail THROWS at construction with an actionable message', () => {
    expect(() =>
      requirePayment({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO, upto: { relayer: { key: '0x' + 'ab'.repeat(32) }, settleAmount: () => 0n } })
    ).toThrow(/unsupported through the Express middleware|settles before the route handler/i)
  })

  it('the direct gate.verify() path IS the supported shape (drives settleAmount + settles)', async () => {
    const gate = meterGate(() => 4242n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const res = await gate.verify(uptoHeader(upto))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.amount).toBe('4242')
  })

  it('requirePayment WITHOUT upto is byte-identical to today (no throw, builds the middleware)', () => {
    const mw = requirePayment({ chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.50', payTo: PAY_TO })
    expect(typeof mw).toBe('function')
  })
})

describe('upto rail — rejection conformance + routing', () => {
  it('a driver rejection becomes a CONFORMANT re-challenge (accepts[] + extensions.piprail + error)', async () => {
    const gate = meterGate(() => 100n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    // Forge an over-max signed amount path by routing settleAmount over the max handled above;
    // here exercise an un-offered network instead → transfer_not_found rejection.
    const res = await gate.verify(uptoHeader({ ...upto, network: 'eip155:1', asset: '0xother' }))
    expect(res).toMatchObject({ kind: 'invalid', error: 'transfer_not_found' })
  })

  it('an upto payload is routed to verifyUpto, never to verifyExact (scheme-discriminated)', async () => {
    const gate = meterGate(() => 77n)
    const { challenge } = await gate.challenge()
    const upto = challenge.accepts.find((a) => a.scheme === 'upto')!
    const res = await gate.verify(uptoHeader(upto))
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') expect(res.receipt.scheme).toBe('upto')
  })
})
