import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  MaxRetriesExceededError,
  buildChallengeHeader,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

const NETWORK = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'

function accept(): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount: '500000',
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'nonce-1', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
}
const challengeBody = () => ({ x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [accept()] })

// A fake driver so the client never touches a real chain RPC — these tests
// exercise only the HTTP/402 flow and how the client surfaces the server's
// rejection reason to the agent. Registering it pre-empts the lazy real one
// (vitest isolates the module registry per test file).
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => 'fake-proof-ref',
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub fetch: a 402 challenge for the first (proof-less) call, then `onProof`. */
function stubFetch(onProof: () => Response) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (!hasProof) {
      return new Response(JSON.stringify(challengeBody()), {
        status: 402,
        headers: { 'payment-required': buildChallengeHeader(challengeBody()) },
      })
    }
    return onProof()
  }) as typeof fetch
}

describe('PipRailClient — surfaces the server rejection reason to the agent', () => {
  it('throws MaxRetriesExceededError carrying the server error code + detail', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            x402Version: 2,
            status: 'invalid',
            error: 'amount_too_low',
            detail: 'Paid 40000, required 500000.',
          }),
          { status: 402 }
        )
    )
    const failures: string[] = []
    const client = new PipRailClient({
      chain: 'stellar',
      wallet: { secret: 'x' },
      maxPaymentRetries: 1,
      retryTimeoutMs: 1000,
      onEvent: (e) => {
        if (e.kind === 'payment-failed') failures.push(e.reason)
      },
    })

    const err = await client.get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(MaxRetriesExceededError)
    expect(err.message).toMatch(/amount_too_low/)
    expect(err.message).toMatch(/Paid 40000, required 500000/)
    // the agent also learns the reason via the event stream
    expect(failures.some((r) => r.includes('amount_too_low'))).toBe(true)
  })

  it('returns the 200 response once the proof is accepted', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, maxPaymentRetries: 2 })
    const res = await client.get(RESOURCE)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('estimateCost(url) returns the quote + the native-coin gas estimate, without paying', async () => {
    let proofCalls = 0
    stubFetch(() => {
      proofCalls += 1
      return new Response('{}', { status: 200 })
    })
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' } })
    const est = await client.estimateCost(RESOURCE)
    expect(est).not.toBeNull()
    // the payment (what leaves the wallet) …
    expect(est!.quote.amountFormatted).toBe('0.05')
    expect(est!.quote.symbol).toBe('XLM')
    // … and the gas (native coin burned to send it) — a DISTINCT number
    expect(est!.cost.feeSymbol).toBe('XLM')
    expect(est!.cost.feeDecimals).toBe(7)
    expect(est!.cost.feeFormatted).toBe('0.00001')
    expect(est!.cost.basis).toBe('heuristic')
    // estimating must not pay — no proof-bearing request was ever made
    expect(proofCalls).toBe(0)
  })

  it('estimateCost(url) returns null when the URL is not payment-gated', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' } })
    expect(await client.estimateCost(RESOURCE)).toBeNull()
  })

  it('on a MULTI-chain challenge, estimateCost prices the chain the client is bound to', async () => {
    // The challenge offers an EVM option (which this stellar client can't pay) AND
    // the stellar option. The client picks ITS chain and estimates that one's gas.
    const multi = {
      x402Version: 2 as const,
      error: null,
      resource: { url: RESOURCE },
      accepts: [{ ...accept(), network: 'eip155:8453' as const, asset: '0xUSDC' }, accept()],
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(multi), {
        status: 402,
        headers: { 'payment-required': buildChallengeHeader(multi) },
      })) as typeof fetch
    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' } })
    const est = await client.estimateCost(RESOURCE)
    expect(est).not.toBeNull()
    expect(est!.quote.network).toBe('stellar:pubnet') // picked its own chain, not the EVM option
    expect(est!.cost.feeSymbol).toBe('XLM')
  })

  it('a throwing onEvent handler never breaks the payment flow (safeEmit)', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    let calls = 0
    const client = new PipRailClient({
      chain: 'stellar',
      wallet: { secret: 'x' },
      onEvent: () => {
        calls += 1
        throw new Error('handler boom')
      },
    })
    const res = await client.get(RESOURCE)
    expect(res.status).toBe(200)
    expect(calls).toBeGreaterThan(0) // safeEmit DID invoke the (throwing) handler — not a false pass
  })
})
