import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PipRailClient,
  MaxRetriesExceededError,
  registerDriver,
  buildChallengeHeader,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

// The double-pay safety contract: once send() broadcasts, the proof ref must
// NEVER be discarded — not even when the client's own confirm() throws (a
// throttled/lagging RPC that 429s its status polls past the validity window
// while the tx actually lands). The client must defer to the server's on-chain
// verify and, if that ultimately fails, surface `ref` so the caller re-verifies
// instead of blindly re-paying. send() must be called EXACTLY ONCE throughout.

const NETWORK = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'
const REF = 'sig-broadcast-abc123'

function challengeBody() {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount: '500000',
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n1', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
  return { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [accept] }
}

// Fake driver: a SEND SPY + a confirm() that throws when `confirmThrows` is set
// (simulating the post-broadcast RPC timeout we hit live on Solana).
let sends = 0
let confirmThrows = false
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => {
    sends += 1
    return REF
  },
  confirm: async () => {
    if (confirmThrows) throw new Error('429 Too Many Requests — signature has expired: block height exceeded')
    return { height: '1' }
  },
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
beforeEach(() => {
  sends = 0
  confirmThrows = false
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(onProof: () => Response) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (!hasProof) {
      const b = challengeBody()
      return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
    }
    return onProof()
  }) as typeof fetch
}

describe('confirm-timeout never discards the proof (double-pay safety)', () => {
  it('confirm throws but the tx landed → submits the proof, succeeds, broadcasts ONCE', async () => {
    confirmThrows = true
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const kinds: string[] = []
    let unconfirmedRef: string | undefined
    const client = new PipRailClient({
      chain: 'stellar',
      wallet: { secret: 'x' },
      onEvent: (e) => {
        kinds.push(e.kind)
        if (e.kind === 'payment-unconfirmed') unconfirmedRef = e.ref
      },
    })

    const res = await client.get(RESOURCE)
    expect(res.status).toBe(200) // server verified the (landed) tx → unlocked
    expect(sends).toBe(1) // NEVER re-broadcast → no double-pay
    expect(client.spent().count).toBe(1) // recorded once
    expect(kinds).toContain('payment-broadcast')
    expect(kinds).toContain('payment-unconfirmed') // honest: confirmation deferred to server
    expect(kinds).not.toContain('payment-confirmed') // local confirm failed
    expect(unconfirmedRef).toBe(REF)
  })

  it('carries .ref on MaxRetriesExceededError so the caller re-verifies, never re-pays', async () => {
    // confirmed path (confirm OK), but the server keeps rejecting the proof.
    stubFetch(() => new Response(JSON.stringify({ status: 'invalid', error: 'tx_not_found', detail: 'not seen yet' }), { status: 402 }))
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, maxPaymentRetries: 1, retryTimeoutMs: 500 })
    const err = await client.get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(MaxRetriesExceededError)
    expect(err.code).toBe('MAX_RETRIES_EXCEEDED')
    expect(err.ref).toBe(REF) // programmatic recovery handle
    expect(err.message).toMatch(/never re-pay|double/i)
    expect(sends).toBe(1)
  })

  it('confirm throws AND server keeps rejecting → throws with .ref + a NOT-confirmed note, ONE broadcast, patient retries', async () => {
    vi.useFakeTimers()
    try {
      confirmThrows = true
      let proofCalls = 0
      stubFetch(() => {
        proofCalls += 1
        return new Response(JSON.stringify({ status: 'invalid', error: 'tx_not_found', detail: 'x' }), { status: 402 })
      })
      const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, maxPaymentRetries: 1 })
      const settle = client.get(RESOURCE).then(() => null, (e) => e)
      await vi.runAllTimersAsync() // flush the (patient) backoff timers
      const err = await settle
      expect(err).toBeInstanceOf(MaxRetriesExceededError)
      expect(err.ref).toBe(REF)
      expect(err.message).toMatch(/NOT locally confirmed/i)
      expect(sends).toBe(1) // single broadcast despite many proof attempts
      expect(proofCalls).toBeGreaterThanOrEqual(6) // unconfirmed → patient floor (6), not maxPaymentRetries (1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('regression: confirm OK → payment-confirmed fires, no unconfirmed event', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const kinds: string[] = []
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, onEvent: (e) => kinds.push(e.kind) })
    const res = await client.get(RESOURCE)
    expect(res.status).toBe(200)
    expect(kinds).toContain('payment-confirmed')
    expect(kinds).not.toContain('payment-unconfirmed')
    expect(sends).toBe(1)
  })
})
