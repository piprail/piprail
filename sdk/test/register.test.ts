/**
 * client.register() + discoverySigner — list on the OPEN registries (stubbed
 * HTTP). The 402 Index path needs no signature; the x402scan path signs a SIWX
 * challenge with the real EVM key (so the signature genuinely recovers). Neither
 * path moves funds. Mirrors x402scan's ownership check:
 * recoverMessageAddress(origin, sig) === payTo.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { recoverMessageAddress } from 'viem'
import {
  PipRailClient,
  registerDriver,
  register402Index,
  DIRECTORY_INFO,
  getDirectoryInfo,
  decorateOutcome,
  type ResolvedNetwork,
} from '../src/index.js'

const TEST_KEY = `0x${'1'.repeat(64)}` // valid secp256k1 key; address derived by viem

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function evmClient() {
  return new PipRailClient({ chain: 'base', wallet: { privateKey: TEST_KEY } })
}

describe('client.register() — 402 Index (no auth, the default)', () => {
  it('POSTs the expected no-auth payload and reports ok', async () => {
    let captured: { url: string; body: unknown } | null = null
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const outcomes = await evmClient().register('https://api.example.com/report', {
      name: 'My Report',
      priceUsd: 0.05,
      asset: 'USDC',
    })

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.source).toBe('402index')
    expect(outcomes[0]!.ok).toBe(true)
    expect(captured!.url).toContain('402index.io')
    expect(captured!.body).toMatchObject({
      url: 'https://api.example.com/report',
      name: 'My Report',
      protocol: 'x402',
      price_usd: 0.05,
      payment_asset: 'USDC',
      payment_network: 'base', // derived from the client's chain slug
    })
  })

  it('defaults the listing name to the host and never throws on HTTP error', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch
    const outcomes = await evmClient().register('https://api.example.com/x')
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.status).toBe(429)
  })

  it('omits payment_network when chain is an object {id,rpcUrl} and no network is given', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const client = new PipRailClient({
      chain: { id: 8453, rpcUrl: 'https://example.invalid' },
      wallet: { privateKey: TEST_KEY },
    })
    await client.register('https://api.example.com/report')
    expect('payment_network' in body).toBe(false) // can't fabricate a slug from a chain id
  })

  it('register402Index is usable standalone, defaulting name to the host', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await register402Index({ url: 'https://api.example.com/report' })
    expect(body.name).toBe('api.example.com')
    expect(body.protocol).toBe('x402')
  })
})

describe('discoverySigner — ownership proof (EVM eip191)', () => {
  it('signs the origin string so it recovers to the wallet address', async () => {
    const client = evmClient()
    const signer = await client.discoverySigner()
    expect(signer).not.toBeNull()
    const origin = 'https://api.example.com'
    const signature = await signer!.signMessage(origin)
    const recovered = await recoverMessageAddress({ message: origin, signature: signature as `0x${string}` })
    expect(recovered.toLowerCase()).toBe(signer!.address.toLowerCase())
  })
})

describe('client.register() — x402scan SIWX (EVM)', () => {
  it('signs the SIWX challenge and resends with a recoverable SIGN-IN-WITH-X header', async () => {
    const info = {
      domain: 'x402scan.com',
      uri: 'https://x402scan.com',
      nonce: 'abc123',
      issuedAt: '2026-06-06T00:00:00.000Z',
      expirationTime: '2026-06-06T00:10:00.000Z',
      chainId: 'eip155:8453',
      statement: 'Register this x402 resource.',
    }
    let header: string | null = null
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) {
        return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info } } }), { status: 402 })
      }
      header = h
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const client = evmClient()
    const outcomes = await client.register('https://api.example.com/report', { targets: ['x402scan'] })

    expect(outcomes[0]!.source).toBe('x402scan')
    expect(outcomes[0]!.ok).toBe(true)
    expect(header).not.toBeNull()

    const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))
    const signer = await client.discoverySigner()
    expect(decoded.address.toLowerCase()).toBe(signer!.address.toLowerCase())
    expect(decoded.type).toBe('eip191')
    expect(decoded.nonce).toBe('abc123')
    expect(String(decoded.signature)).toMatch(/^0x[0-9a-fA-F]{130}$/)
    // the header carries the LITERAL signed message — recover against it (mirrors a
    // message-based verifier) and confirm it's a conformant EIP-4361 string.
    expect(typeof decoded.message).toBe('string')
    expect(decoded.message).toContain('Issued At:')
    expect(decoded.message).toContain('Chain ID: 8453')
    expect(decoded.message).toContain('Register this x402 resource.') // statement-present branch
    const recovered = await recoverMessageAddress({
      message: decoded.message,
      signature: decoded.signature as `0x${string}`,
    })
    expect(recovered.toLowerCase()).toBe(signer!.address.toLowerCase())
  })

  it('defaults the required Issued At when the challenge omits it (still recoverable)', async () => {
    const info = { domain: 'x402scan.com', uri: 'https://x402scan.com', nonce: 'n2', chainId: 'eip155:8453' }
    let header: string | null = null
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info } } }), { status: 402 })
      header = h
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const client = evmClient()
    const outcomes = await client.register('https://api.example.com/r', { targets: ['x402scan'] })
    expect(outcomes[0]!.ok).toBe(true)
    const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))
    expect(decoded.message).toMatch(/Issued At: .+/) // defaulted, not omitted
    // no statement in the challenge → no statement block injected (would break recovery)
    expect(decoded.message).not.toContain('Register this x402 resource.')
    const recovered = await recoverMessageAddress({ message: decoded.message, signature: decoded.signature })
    expect(recovered.toLowerCase()).toBe((await client.discoverySigner())!.address.toLowerCase())
  })

  it('accepts an unauthenticated (non-402) register directly, without signing', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) // never a 402 challenge
    }) as typeof fetch
    const outcomes = await evmClient().register('https://api.example.com/r', { targets: ['x402scan'] })
    expect(outcomes[0]!.ok).toBe(true)
    expect(outcomes[0]!.status).toBe(200)
    expect(calls).toBe(1) // no signing round-trip
  })

  it('reports an unparseable SIWX challenge without throwing', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 402 })) as typeof fetch
    const outcomes = await evmClient().register('https://api.example.com/r', { targets: ['x402scan'] })
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.status).toBe(402)
    expect(outcomes[0]!.detail).toMatch(/unparseable/i)
  })
})

describe('client.register() — agent-friendly lifecycle caveats (visibility + note)', () => {
  it("402 Index success → visibility 'pending-review' + a review caveat (NOT 'searchable now')", async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 201 })) as typeof fetch
    const [o] = await evmClient().register('https://api.example.com/r')
    expect(o!.ok).toBe(true)
    expect(o!.visibility).toBe('pending-review')
    expect(o!.note).toMatch(/review|propagat|before/i)
  })

  it("x402scan success → visibility 'live', but the note warns discover() does NOT read it", async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h)
        return new Response(
          JSON.stringify({ extensions: { 'sign-in-with-x': { info: { domain: 'd', uri: 'https://d', nonce: 'n', chainId: 'eip155:8453' } } } }),
          { status: 402 }
        )
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const [o] = await evmClient().register('https://api.example.com/r', { targets: ['x402scan'] })
    expect(o!.ok).toBe(true)
    expect(o!.visibility).toBe('live')
    expect(o!.note).toMatch(/discover\(\) does NOT read|Base\/Solana/i)
  })

  it("any failure → visibility 'not-listable' (an agent never reads ok:false as pending)", async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 429 })) as typeof fetch
    const [o] = await evmClient().register('https://api.example.com/r')
    expect(o!.ok).toBe(false)
    expect(o!.visibility).toBe('not-listable')
    expect(o!.note).toBeTruthy()
  })

  it("bazaar target → 'not-listable' with a facilitator-only caveat", async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const [o] = await evmClient().register('https://x/y', { targets: ['bazaar'] })
    expect(o!.visibility).toBe('not-listable')
    expect(o!.note).toMatch(/facilitator|no register endpoint/i)
  })
})

describe('DIRECTORY_INFO — the queryable lifecycle source of truth', () => {
  it('covers every DiscoverySource with coherent facts', () => {
    for (const src of ['402index', 'x402scan', 'bazaar'] as const) {
      const info = DIRECTORY_INFO[src]
      expect(info.source).toBe(src)
      expect(getDirectoryInfo(src)).toBe(info)
      expect(typeof info.caveat).toBe('string')
      expect(info.caveat.length).toBeGreaterThan(0)
    }
  })

  it('marks x402scan as NOT read by discover() — the key agent caveat', () => {
    expect(DIRECTORY_INFO['x402scan'].readByDiscover).toBe(false)
    expect(DIRECTORY_INFO['402index'].readByDiscover).toBe(true)
    expect(DIRECTORY_INFO['bazaar'].readByDiscover).toBe(true)
  })

  it('x402scan is Base/Solana-only; the others list any chain the resource advertises', () => {
    expect(DIRECTORY_INFO['x402scan'].chains).toContain('eip155:8453')
    expect(DIRECTORY_INFO['402index'].chains).toBeNull()
    expect(DIRECTORY_INFO['bazaar'].chains).toBeNull()
  })

  it('decorateOutcome projects onSuccess on ok, not-listable on failure, and is idempotent', () => {
    const ok = decorateOutcome({ source: '402index', ok: true })
    expect(ok.visibility).toBe('pending-review')
    expect(ok.note).toBe(DIRECTORY_INFO['402index'].caveat)
    const fail = decorateOutcome({ source: 'x402scan', ok: false })
    expect(fail.visibility).toBe('not-listable')
    expect(decorateOutcome(ok)).toEqual(ok) // re-decorating changes nothing
  })
})

describe('client.register() — honest refusals (no silent failure)', () => {
  it('x402scan on a family without a discoverySigner → ok:false with a reason', async () => {
    const NETWORK = 'stellar:pubnet'
    const fakeNet: ResolvedNetwork = {
      family: 'stellar',
      network: NETWORK,
      supports: (n) => n === NETWORK,
      resolveToken: () => ({ asset: 'native', decimals: 7, symbol: 'XLM' }),
      describeAsset: () => ({ symbol: 'XLM', decimals: 7 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => 'ref',
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'XLM', feeDecimals: 7, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: '' }),
      // note: no discoverySigner
    }
    registerDriver({ family: 'stellar', resolve: () => fakeNet })

    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const client = new PipRailClient({ chain: 'stellar', wallet: { secret: 'x' } })
    const outcomes = await client.register('https://api.example.com/report', { targets: ['x402scan'] })
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.detail).toMatch(/signer/i)
    expect(calls).toBe(0) // refused before any network call
  })

  it("bazaar target is honestly unsupported (facilitator-only)", async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch
    const outcomes = await evmClient().register('https://api.example.com/x', { targets: ['bazaar'] })
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.detail).toMatch(/facilitator/i)
  })
})

describe('client.register() — orchestration across targets', () => {
  it('returns one outcome per target, in order (402index + x402scan)', async () => {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('402index.io')) return new Response('{}', { status: 200 })
      // x402scan SIWX
      const h = new Headers(init?.headers ?? {}).get('sign-in-with-x')
      if (!h) return new Response(JSON.stringify({ extensions: { 'sign-in-with-x': { info: { domain: 'd', uri: 'https://d', nonce: 'n', chainId: 'eip155:8453' } } } }), { status: 402 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const outcomes = await evmClient().register('https://api.example.com/r', { targets: ['402index', 'x402scan'] })
    expect(outcomes.map((o) => o.source)).toEqual(['402index', 'x402scan'])
    expect(outcomes.every((o) => o.ok)).toBe(true)
  })

  it('honors an explicit network override over the client chain slug', async () => {
    let payment_network: unknown
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      payment_network = JSON.parse(String(init?.body)).payment_network
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await evmClient().register('https://x/y', { network: 'optimism' })
    expect(payment_network).toBe('optimism') // not 'base'
  })

  it('passes opt-in attribution through to the listing payload (off unless asked)', async () => {
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await evmClient().register('https://x/y') // default
    await evmClient().register('https://x/y', { attribution: true }) // opted in
    expect('via' in bodies[0]!).toBe(false)
    expect(bodies[1]!.via).toBe('@piprail/sdk')
  })
})
