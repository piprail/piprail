/**
 * Replay protection under CONCURRENCY — the property a sequential test cannot see.
 *
 * A gate checks the used-proof set, then `await`s the driver's `verify()`, then records.
 * Anything that reads the set before that await and writes after it lets N simultaneous
 * requests carrying ONE proof all observe "unused" and all settle. The built-in store
 * always reserved synchronously; a CUSTOM `isUsed`/`markUsed` store did not, so the
 * documented multi-instance path silently lost the guarantee. These tests pin all of it:
 *
 *   1. built-in store          — one winner, concurrent
 *   2. custom store, one gate  — one winner, concurrent (the in-process reserve)
 *   3. custom store, atomic    — one winner across SEPARATE gates (multi-process shape)
 *   4. release on failure      — a transient verify failure never burns a valid proof,
 *                                for the built-in store AND via `releaseUsed`
 *
 * No RPC: a module-isolated fake EVM driver whose verify() is swappable per test.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { X402AcceptEntry, X402Challenge } from '../src/x402.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'
const TX = `0x${'b'.repeat(64)}`

/** Verification is never instantaneous in production; the await is where the race lives. */
let verifyDelayMs = 5
let verifyThrows = false

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
      resolveToken: () => ({ asset: `0x${'a'.repeat(40)}`, decimals: 6, symbol: 'USDC' }),
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => TX,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({
        feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const,
      }),
      addressOf: async () => '0xself',
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => {
        if (verifyDelayMs) await new Promise((r) => setTimeout(r, verifyDelayMs))
        if (verifyThrows) throw new Error('transient RPC failure')
        return {
          ok: true,
          receipt: {
            scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
            asset: accept.asset, amount: accept.amount, payer: '0xpayer', payTo: accept.payTo,
            verifiedAt: 'now',
          },
        }
      },
    }
  },
}
registerDriver(fakeEvm)

const BASE = { chain: { id: 8453, rpcUrl: 'x' }, token: 'USDC', amount: '0.05', payTo: PAY_TO } as const
type Gate = ReturnType<typeof createPaymentGate>

function proofAccept(c: X402Challenge): X402AcceptEntry {
  const a = c.accepts.find((x): x is X402AcceptEntry => x.scheme === 'onchain-proof')
  if (!a) throw new Error('test: no onchain-proof accept')
  return a
}

/** A payment header answering a fresh challenge from `gate`, carrying `txHash`. */
async function payment(gate: Gate, txHash = TX): Promise<string> {
  const { challenge } = await gate.challenge('https://x.test/r')
  const accept = proofAccept(challenge)
  return buildSignatureHeader({
    x402Version: 2,
    accepted: accept,
    payload: { nonce: accept.extra.nonce, txHash },
  })
}

/** Fire one proof at N gates at once; return how many were PAID. */
async function racePaid(gates: Gate[], txHash = TX): Promise<number> {
  const headers = await Promise.all(gates.map((g) => payment(g, txHash)))
  const results = await Promise.all(gates.map((g, i) => g.verify(headers[i]!)))
  return results.filter((r) => r.kind === 'paid').length
}

/** An in-memory stand-in for Redis `SET NX`: check AND reserve in one synchronous step. */
function atomicStore() {
  const keys = new Set<string>()
  return {
    isUsed: async (ref: string) => {
      if (keys.has(ref)) return true
      keys.add(ref)
      return false
    },
    markUsed: async () => {},
    releaseUsed: async (ref: string) => {
      keys.delete(ref)
    },
    size: () => keys.size,
  }
}

beforeEach(() => {
  verifyDelayMs = 5
  verifyThrows = false
})

describe('concurrent redeem of ONE proof — exactly one winner', () => {
  it('built-in store: 5 simultaneous requests, one settles', async () => {
    const gate = createPaymentGate(BASE)
    expect(await racePaid([gate, gate, gate, gate, gate])).toBe(1)
  })

  it('CUSTOM store on one gate: the in-process reserve still closes the race', async () => {
    // Regression: this returned 5/5. `claimTx` consulted the custom store with an `await`
    // and recorded only after verification, so every concurrent request read "unused".
    const spent = new Set<string>()
    const gate = createPaymentGate({
      ...BASE,
      isUsed: async (ref) => spent.has(ref),
      markUsed: async (ref) => void spent.add(ref),
    })
    expect(await racePaid([gate, gate, gate, gate, gate])).toBe(1)
  })

  it('CUSTOM store across SEPARATE gates: an atomic reserve is what protects it', async () => {
    // Separate gates cannot see each other's in-process set (nor can separate processes),
    // so this is the case only an atomic check-and-reserve can win. It is the shape the
    // docs prescribe for a multi-instance deployment.
    const store = atomicStore()
    const gates = Array.from({ length: 5 }, () => createPaymentGate({ ...BASE, ...store }))
    expect(await racePaid(gates)).toBe(1)
  })

  it('a NON-atomic custom store across separate gates is the known multi-process hazard', async () => {
    // Pinned deliberately: a plain read-then-write store cannot win this race, which is
    // exactly why the docs demand `SET NX`. If this ever starts passing, the seam changed
    // and the guidance in replay-protection.md needs revisiting.
    const spent = new Set<string>()
    const gates = Array.from({ length: 5 }, () =>
      createPaymentGate({
        ...BASE,
        isUsed: async (ref) => spent.has(ref),
        markUsed: async (ref) => void spent.add(ref),
      })
    )
    expect(await racePaid(gates)).toBeGreaterThan(1)
  })
})

describe('a claimed proof is released when it does not settle', () => {
  it('built-in store: a thrown verify leaves the proof spendable', async () => {
    const gate = createPaymentGate(BASE)
    verifyThrows = true
    await expect(gate.verify(await payment(gate))).rejects.toThrow(/transient/)
    verifyThrows = false
    expect((await gate.verify(await payment(gate))).kind).toBe('paid')
  })

  it('custom store: `releaseUsed` gives a reserving store the same property', async () => {
    // Without this hook an atomic `isUsed` traded a double-spend for a burned payment:
    // the buyer's funds moved, the reservation stuck, and the proof could never be redeemed.
    const store = atomicStore()
    const gate = createPaymentGate({ ...BASE, ...store })
    verifyThrows = true
    await expect(gate.verify(await payment(gate))).rejects.toThrow(/transient/)
    verifyThrows = false
    expect(store.size()).toBe(0) // the reservation was handed back
    expect((await gate.verify(await payment(gate))).kind).toBe('paid')
  })

  it('a REJECTED proof also releases, so a buyer can retry', async () => {
    const store = atomicStore()
    const gate = createPaymentGate({ ...BASE, ...store })
    // A proof for a rail this gate does not offer is rejected, not settled.
    const { challenge } = await gate.challenge('https://x.test/r')
    const accept = proofAccept(challenge)
    const wrongRail = buildSignatureHeader({
      x402Version: 2,
      accepted: { ...accept, network: 'eip155:1' } as X402AcceptEntry,
      payload: { nonce: accept.extra.nonce, txHash: TX },
    })
    const rejected = await gate.verify(wrongRail)
    expect(rejected.kind).not.toBe('paid')
    expect((await gate.verify(await payment(gate))).kind).toBe('paid')
  })

  it('a SETTLED proof stays claimed (release must not undo a real spend)', async () => {
    const store = atomicStore()
    const gate = createPaymentGate({ ...BASE, ...store })
    expect((await gate.verify(await payment(gate))).kind).toBe('paid')
    const replay = await gate.verify(await payment(gate))
    expect(replay.kind).toBe('invalid')
    expect(replay.kind === 'invalid' && replay.error).toBe('tx_already_used')
  })
})

describe('releaseUsed is refused unless the store is complete', () => {
  it('throws when given without isUsed/markUsed (it would never fire)', () => {
    expect(() =>
      createPaymentGate({ ...BASE, releaseUsed: () => {} })
    ).toThrow(/releaseUsed/)
  })
})
