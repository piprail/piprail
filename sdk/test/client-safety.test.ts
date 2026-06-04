import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PipRailClient,
  PaymentDeclinedError,
  registerDriver,
  buildChallengeHeader,
  type PipRailClientOptions,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

const NETWORK = 'stellar:pubnet'
const RESOURCE = 'https://api.example.com/report'

// A challenge for 0.05 XLM (7dp → 500000 base). `serverSymbol` lets a test make
// the challenge LIE about the symbol so we can prove describeAsset overrides it.
function challengeBody(serverSymbol = 'XLM') {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount: '500000',
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n1', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: serverSymbol },
  }
  return { x402Version: 2 as const, error: null, resource: { url: RESOURCE, description: 'A report' }, accepts: [accept] }
}

// Fake driver with a SEND SPY — the whole point is asserting send is NOT called
// when a payment is declined (no funds move). describeAsset returns the TRUE
// metadata (XLM/7dp), so server-stated symbols can be overridden.
let sends = 0
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: (asset: string) => {
    if (asset === 'native') return { symbol: 'XLM', decimals: 7 }
    if (asset === 'USDC-MINT') return { symbol: 'USDC', decimals: 7 }
    return null
  },
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => {
    sends += 1
    return 'fake-proof-ref'
  },
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 0n, native: 0n }),
  recipientReady: async () => ({ ready: "n/a" as const }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
beforeEach(() => {
  sends = 0
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(serverSymbol = 'XLM', onProof = () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (!hasProof) {
      const body = challengeBody(serverSymbol)
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { 'payment-required': buildChallengeHeader(body) },
      })
    }
    return onProof()
  }) as typeof fetch
}

const newClient = (over: Partial<PipRailClientOptions> = {}) =>
  new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' }, ...over })

describe('quote() — price without paying', () => {
  it('returns the quote and never sends', async () => {
    stubFetch()
    const q = await newClient().quote(RESOURCE)
    expect(q).not.toBeNull()
    expect(q!).toMatchObject({
      network: NETWORK,
      amount: '500000',
      amountFormatted: '0.05',
      decimals: 7,
      symbol: 'XLM',
      payTo: 'GMERCHANT',
      description: 'A report',
      recognized: true,
      withinPolicy: true,
    })
    expect(sends).toBe(0)
  })

  it('returns null for a URL that is not payment-gated', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    expect(await newClient().quote(RESOURCE)).toBeNull()
    expect(sends).toBe(0)
  })

  it('flags a symbol mismatch when the server lies about the symbol', async () => {
    stubFetch('FOO') // challenge claims FOO; describeAsset says XLM
    const q = await newClient().quote(RESOURCE)
    expect(q!.symbol).toBe('XLM') // TRUE symbol wins
    expect(q!.symbolMismatch).toBe(true)
  })

  it('derives amountFormatted from TRUE decimals — a server cannot fake the human amount', async () => {
    // Challenge: amount 500000, but server LIES (decimals 2 → claims "5000.00").
    // describeAsset knows native XLM is 7dp, so 500000 base = 0.05.
    const lyingAccept: X402AcceptEntry = {
      scheme: 'onchain-proof', network: NETWORK, amount: '500000', asset: 'native',
      payTo: 'GMERCHANT', maxTimeoutSeconds: 600,
      extra: { nonce: 'n', decimals: 2, minConfirmations: 1, amountFormatted: '5000.00', symbol: 'XLM' },
    }
    const lying = { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts: [lyingAccept] }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(lying), { status: 402, headers: { 'payment-required': buildChallengeHeader(lying) } })) as typeof fetch
    const q = await newClient().quote(RESOURCE)
    expect(q!.decimals).toBe(7) // TRUE decimals
    expect(q!.amountFormatted).toBe('0.05') // derived, NOT the server's '5000.00'
  })
})

describe('policy guard — refuses BEFORE any on-chain send', () => {
  it('throws PaymentDeclinedError when over maxAmount, without sending', async () => {
    stubFetch()
    const err = await newClient({ policy: { maxAmount: '0.04' } }).get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(err.code).toBe('PAYMENT_DECLINED')
    expect(err.message).toMatch(/maxAmount/)
    expect(sends).toBe(0)
  })

  it('the quote reflects the policy verdict', async () => {
    stubFetch()
    const q = await newClient({ policy: { maxAmount: '0.04' } }).quote(RESOURCE)
    expect(q!.withinPolicy).toBe(false)
    expect(q!.policyReason).toMatch(/maxAmount/)
  })
})

describe('onBeforePay — final approval hook', () => {
  it('declines (no send) when the hook returns false', async () => {
    stubFetch()
    const seen: number[] = []
    const err = await newClient({
      onBeforePay: (q) => {
        seen.push(Number(q.amount))
        return false
      },
    }).get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(seen).toEqual([500000]) // the hook DID see the quote
    expect(sends).toBe(0)
  })

  it('pays when the hook returns true', async () => {
    stubFetch()
    const res = await newClient({ onBeforePay: () => true }).get(RESOURCE)
    expect(res.status).toBe(200)
    expect(sends).toBe(1)
  })

  it('a throwing hook fails safe — declines, never pays', async () => {
    stubFetch()
    const err = await newClient({
      onBeforePay: () => {
        throw new Error('hook boom')
      },
    }).get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(sends).toBe(0)
  })
})

describe('multi-accept selection — client picks the policy-allowed option', () => {
  // A challenge offering BOTH native XLM and USDC on the same (bound) network.
  function stubMulti(onProof = () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
    const accepts: X402AcceptEntry[] = [
      { scheme: 'onchain-proof', network: NETWORK, amount: '500000', asset: 'native', payTo: 'GMERCHANT', maxTimeoutSeconds: 600, extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' } },
      { scheme: 'onchain-proof', network: NETWORK, amount: '500000', asset: 'USDC-MINT', payTo: 'GMERCHANT', maxTimeoutSeconds: 600, extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' } },
    ]
    const body = { x402Version: 2 as const, error: null, resource: { url: RESOURCE }, accepts }
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
      if (!hasProof) {
        return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
      }
      return onProof()
    }) as typeof fetch
  }

  it('quote() prefers the option the policy allows (USDC over native)', async () => {
    stubMulti()
    const q = await newClient({ policy: { tokens: ['USDC'] } }).quote(RESOURCE)
    expect(q!.asset).toBe('USDC-MINT')
    expect(q!.symbol).toBe('USDC')
    expect(q!.withinPolicy).toBe(true)
  })

  it('falls back to the first candidate (so authorize surfaces the reason) when none pass', async () => {
    stubMulti()
    // Policy allows only DOGE — neither offered option qualifies.
    const err = await newClient({ policy: { tokens: ['DOGE'] } }).get(RESOURCE).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(sends).toBe(0)
  })
})

describe('spend ledger', () => {
  it('records a settled payment and totals it by asset', async () => {
    stubFetch()
    const client = newClient()
    await client.get(RESOURCE)
    const s = client.spent()
    expect(s.count).toBe(1)
    expect(s.byAsset[0]).toMatchObject({ asset: 'native', symbol: 'XLM', totalFormatted: '0.05', count: 1 })
  })

  it('does not record a payment that the server ultimately rejects', async () => {
    // proof leg returns a 402 'invalid' → MaxRetriesExceeded, nothing settled.
    stubFetch('XLM', () => new Response(JSON.stringify({ status: 'invalid', error: 'amount_too_low', detail: 'x' }), { status: 402 }))
    const client = newClient({ maxPaymentRetries: 1, retryTimeoutMs: 500 })
    await client.get(RESOURCE).catch(() => {})
    expect(client.spent().count).toBe(0)
  })
})
