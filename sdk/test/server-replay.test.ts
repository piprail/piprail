/**
 * Replay protection + payment recovery — the DEFAULT (built-in) in-memory store.
 *
 * Proves the three properties an x402 gate lives or dies by:
 *   1. Within the replay window, the same proof can't be redeemed twice (security).
 *   2. The store is BOUNDED — an entry is evicted once it's older than the window,
 *      so a long-lived gate doesn't leak memory. (Production safety still holds: the
 *      driver's recency check rejects any proof that old — see drivers/evm/verify.ts.)
 *   3. A THROWN verify() releases the claim, so a transient RPC blip doesn't
 *      permanently burn an otherwise-valid proof (the buyer/agent can retry).
 *
 * Uses a module-isolated fake EVM driver whose verify() is swappable per test, so a
 * payment round-trips with NO RPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { VerifyResult } from '../src/x402.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'

// Swappable verify() — default succeeds, echoing the server-trusted accept into the receipt.
let verifyImpl: (ref: string, accept: any) => Promise<VerifyResult> = async (ref, accept) => ({
  ok: true,
  receipt: {
    scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
    asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now',
  },
})

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
      resolveToken: (token: unknown) => ({ asset: `0x${String(token).toLowerCase()}`, decimals: 6, symbol: String(token) }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'BNB', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: (ref, accept) => verifyImpl(ref, accept),
    }
  },
}
registerDriver(fakeEvm)

// 60-second replay window keeps the eviction test's arithmetic obvious.
function gate(maxTimeoutSeconds = 60) {
  return createPaymentGate({ chain: { id: 56, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO, maxTimeoutSeconds })
}

describe('replay store — isUsed/markUsed must be supplied as a PAIR (fail loud, never half-arm)', () => {
  const base = { chain: { id: 56, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO } as const
  it('throws at construction when ONLY isUsed is given (writes would no-op → every proof replays)', () => {
    expect(() => createPaymentGate({ ...base, isUsed: () => false })).toThrow(/together/i)
  })
  it('throws at construction when ONLY markUsed is given (reads always false → nothing rejected)', () => {
    expect(() => createPaymentGate({ ...base, markUsed: () => {} })).toThrow(/together/i)
  })
  it('accepts BOTH (the intended custom-store config) and NEITHER (built-in store)', () => {
    expect(() => createPaymentGate({ ...base, isUsed: () => false, markUsed: () => {} })).not.toThrow()
    expect(() => createPaymentGate({ ...base })).not.toThrow()
  })
})
async function pay(g: ReturnType<typeof gate>, tx: string) {
  const { challenge } = await g.challenge()
  const accept = proofAccepts(challenge)[0]!
  return g.verify(buildSignatureHeader({ x402Version: 2, accepted: accept, payload: { nonce: accept.extra.nonce, txHash: tx } }))
}

const TX = (c: string) => `0x${c.repeat(64)}`

beforeEach(() => {
  verifyImpl = async (ref, accept) => ({
    ok: true,
    receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
  })
})
afterEach(() => vi.useRealTimers())

describe('replay protection — built-in store', () => {
  it('1. blocks a second redemption of the same proof WITHIN the window', async () => {
    const g = gate()
    expect((await pay(g, TX('a'))).kind).toBe('paid') // first redemption settles
    expect(await pay(g, TX('a'))).toMatchObject({ kind: 'invalid', error: 'tx_already_used' }) // replay blocked
  })

  it('1b. SECURITY: a MEMO-BOUND family (verify ignores the ref, returns a FIXED on-chain hash) is deduped on the VERIFIED hash — varying txHash under one nonce can NOT re-redeem', async () => {
    // Memo-bound drivers (XRPL/Stellar/TON/Algorand) + native NEAR locate the tx by payTo+memo and
    // ignore the client ref, returning the REAL on-chain hash. Pre-fix the gate keyed the replay set
    // on the client-echoed txHash, so a client could vary it and re-redeem the SAME payment. Now the
    // gate claims on receipt.transaction. Simulate it: verify returns a fixed hash regardless of ref.
    const ONLEDGER = 'REAL_ONLEDGER_HASH'
    verifyImpl = async (_ref, accept) => ({
      ok: true,
      receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ONLEDGER, asset: accept.asset, amount: accept.amount, payer: 'GPAYER', payTo: accept.payTo, verifiedAt: 'now' },
    })
    const g = gate()
    expect((await pay(g, TX('aa'))).kind).toBe('paid') // first redemption of the real payment
    // a SECOND presentation with a DIFFERENT client txHash but the same on-ledger payment:
    expect(await pay(g, TX('bb'))).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
  })

  it('2. is BOUNDED — evicts an entry once it ages past the replay window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const g = gate(60) // 60s window
    expect((await pay(g, TX('b'))).kind).toBe('paid')
    // Still inside the window → still blocked.
    vi.setSystemTime(1_000_000 + 59_000)
    expect(await pay(g, TX('b'))).toMatchObject({ kind: 'invalid', error: 'tx_already_used' })
    // Past the window → the entry is evicted, so the store doesn't hold it forever.
    // (In production the driver's recency check rejects a proof this old; here the fake
    //  verify() has no recency gate, so eviction surfaces as a fresh 'paid'.)
    vi.setSystemTime(1_000_000 + 61_000)
    expect((await pay(g, TX('b'))).kind).toBe('paid')
  })

  it('3. RELEASES the claim when verify() THROWS, so the proof can be retried (not burned)', async () => {
    const g = gate()
    // A transient blip: verify() throws once.
    verifyImpl = async () => {
      throw new Error('RPC node unreachable')
    }
    await expect(pay(g, TX('c'))).rejects.toThrow(/RPC node unreachable/)
    // The blip clears; the SAME proof must now succeed (it was NOT permanently burned).
    verifyImpl = async (ref, accept) => ({
      ok: true,
      receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
    })
    expect((await pay(g, TX('c'))).kind).toBe('paid')
  })

  it('a graceful verify() rejection also releases the claim (retryable)', async () => {
    const g = gate()
    verifyImpl = async () => ({ ok: false, error: 'tx_not_found', detail: 'RPC lag — not seen yet' })
    expect(await pay(g, TX('d'))).toMatchObject({ kind: 'invalid', error: 'tx_not_found' })
    // The lag clears → same proof now settles (the failed attempt didn't burn it).
    verifyImpl = async (ref, accept) => ({
      ok: true,
      receipt: { scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref, asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo, verifiedAt: 'now' },
    })
    expect((await pay(g, TX('d'))).kind).toBe('paid')
  })
})
