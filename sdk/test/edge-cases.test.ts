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

// A 0.05 XLM (7dp → 500000 base) challenge. `host`/`port`/`amount` are tunable
// so we can probe host-allowlist + budget edges.
function challengeBody(opts: { url?: string; amount?: string } = {}) {
  const accept: X402AcceptEntry = {
    scheme: 'onchain-proof',
    network: NETWORK,
    amount: opts.amount ?? '500000',
    asset: 'native',
    payTo: 'GMERCHANT',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'XLM' },
  }
  return { x402Version: 2 as const, error: null, resource: { url: opts.url ?? '' }, accepts: [accept] }
}

let sends = 0
const fakeNet: ResolvedNetwork = {
  family: 'stellar',
  network: NETWORK,
  supports: (n) => n === NETWORK,
  resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
  describeAsset: (a) => (a === 'native' ? { symbol: 'XLM', decimals: 7 } : null),
  assertValidPayTo: () => undefined,
  bindWallet: (w) => ({ _native: w }),
  send: async () => `ref-${++sends}`,
  confirm: async () => ({ height: '1' }),
  estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' }),
  balanceOf: async () => ({ token: 0n, native: 0n }),
  recipientReady: async () => ({ ready: "n/a" as const }),
  verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
}
registerDriver({ family: 'stellar', resolve: () => fakeNet })

const realFetch = globalThis.fetch
beforeEach(() => {
  sends = 0
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function stub(body = challengeBody()) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const hasProof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (!hasProof) {
      return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body) } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
}

const newClient = (over: Partial<PipRailClientOptions> = {}) =>
  new PipRailClient({ chain: 'stellar', wallet: { key: 'x' }, ...over })

describe('maxTotal accumulates across real payments (sequential)', () => {
  it('allows up to the per-asset cap, then declines', async () => {
    stub()
    // cap 0.12 XLM (=1_200_000); each call is 0.05 (=500_000).
    const client = newClient({ policy: { maxTotal: '0.12' } })
    await client.get('https://api.example.com/a') // 0.05 → total 0.05
    await client.get('https://api.example.com/b') // 0.10 → total 0.10
    const err = await client.get('https://api.example.com/c').catch((e) => e) // would be 0.15 > 0.12
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(err.message).toMatch(/maxTotal/)
    expect(sends).toBe(2) // only the first two ever paid
    expect(client.spent().count).toBe(2)
    expect(client.spent().byAsset[0]!.totalFormatted).toBe('0.1')
  })
})

describe('host allowlist ignores the port', () => {
  it('matches a hostname regardless of URL port (dev localhost, custom ports)', async () => {
    stub()
    const q = await newClient({ policy: { hosts: ['127.0.0.1'] } }).quote('http://127.0.0.1:4021/r')
    expect(q!.withinPolicy).toBe(true)
  })
  it('wildcard matches a ported subdomain', async () => {
    stub()
    const q = await newClient({ policy: { hosts: ['*.example.com'] } }).quote('https://api.example.com:8443/r')
    expect(q!.withinPolicy).toBe(true)
  })
  it('still refuses a host outside the list', async () => {
    stub()
    const err = await newClient({ policy: { hosts: ['good.com'] } }).get('https://evil.com/r').catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(sends).toBe(0)
  })
})

describe('concurrency — the ledger is safe under parallel payments', () => {
  it('records every settled payment when fetches run in parallel', async () => {
    stub()
    const client = newClient()
    await Promise.all([
      client.get('https://api.example.com/1'),
      client.get('https://api.example.com/2'),
      client.get('https://api.example.com/3'),
    ])
    expect(sends).toBe(3)
    expect(client.spent().count).toBe(3)
    expect(client.spent().byAsset[0]!.totalFormatted).toBe('0.15')
  })
})

describe('quote() respects init.method', () => {
  it('prices a POST-gated endpoint', async () => {
    stub()
    const q = await newClient().quote('https://api.example.com/r', { method: 'POST' })
    expect(q!.amountFormatted).toBe('0.05')
    expect(sends).toBe(0)
  })
})

describe('a malformed 402 surfaces a typed InvalidEnvelopeError', () => {
  it('throws when the 402 has no parseable challenge', async () => {
    globalThis.fetch = (async () => new Response('not a challenge', { status: 402 })) as typeof fetch
    const err = await newClient().get('https://api.example.com/r').catch((e) => e)
    expect(err.constructor.name).toBe('InvalidEnvelopeError')
    expect(sends).toBe(0)
  })

  it('rejects a non-integer base-unit amount (hostile server) as a typed error, not a raw BigInt throw', async () => {
    stub(challengeBody({ amount: '1.5' })) // base units must be an integer
    const err = await newClient().get('https://api.example.com/r').catch((e) => e)
    expect(err.constructor.name).toBe('InvalidEnvelopeError')
    expect(err.message).toMatch(/base-unit integer/)
    expect(sends).toBe(0)
  })
})
