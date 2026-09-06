/**
 * x402 **v1** on the BUYER path — parsing a v1 challenge and answering on the v1 wire.
 *
 * Context (see the version-posture note in `x402.ts`): v2 REPLACED v1 on the wire. PipRail's
 * stance is Postel's law — EMIT strict v2, ACCEPT liberal v1 + v2. The GATE already honoured
 * that (it reads the v1 `x-payment` header, the v1 flat payload, `maxAmountRequired`, slug
 * networks). The BUYER did not: `isValidChallenge` hard-required `x402Version === 2`, so every
 * v1 server was an `InvalidEnvelopeError` — and no v1 header emitter existed at all, so even a
 * parsed v1 challenge could not have been answered.
 *
 * Measured scope: 251 of the 15,686 resources on the CDP Bazaar are v1 (290 exact rails). Small,
 * but they are real live merchants, and the asymmetry (parse v1 receipts, refuse v1 challenges)
 * was an oversight rather than a decision.
 *
 * The wire facts below were probed live against `x402factory.ai` on 2026-09-06:
 *   • a v1 server IGNORES `PAYMENT-SIGNATURE` (it just re-challenges with another 402)
 *   • it reads `X-PAYMENT`, and answers a malformed one with `400 {"message":"invalid X-PAYMENT header"}`
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  normalizeV1Challenge,
  buildV1PaymentHeader,
  decodeBase64Json,
  NoCompatibleAcceptError,
  InvalidEnvelopeError,
  type ResolvedNetwork,
  type X402ExactAcceptEntry,
  type ExactPaymentPayload,
} from '../src/index.js'

const URL = 'https://x402factory.ai/base/coinprice'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYTO = '0x402FaCcC3fAeb72351CC2b68C7966faF5f22B0d4'

/**
 * A REAL v1 challenge body, captured verbatim from `x402factory.ai/base/coinprice` on
 * 2026-09-06 (description truncated). Note every v1↔v2 skew in one object: `x402Version: 1`,
 * `maxAmountRequired` instead of `amount`, the slug network `"base"` instead of CAIP-2, and the
 * resource as a per-accept STRING instead of a hoisted top-level object.
 */
const V1_BODY = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '1000',
      resource: URL,
      description: 'Base coin price mini-endpoint for major tokens only.',
      mimeType: 'application/json',
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      asset: USDC,
      outputSchema: { input: { type: 'http', method: 'POST' } },
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
} as const

let payExactCalls = 0
beforeEach(() => {
  payExactCalls = 0
})

function makeNet(): ResolvedNetwork {
  return {
    family: 'evm',
    network: 'eip155:8453',
    supports: (n: string) => n === 'eip155:8453',
    resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a: string) => (a === USDC ? { symbol: 'USDC', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w: unknown) => ({ _native: w }),
    send: async () => '0xTX',
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'estimated' as const }),
    balanceOf: async () => ({ token: 1_000_000n, native: 10n ** 18n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
    payExact: async (_w: unknown, accept: X402ExactAcceptEntry) => {
      payExactCalls += 1
      return {
        payload: {
          signature: `0x${'cd'.repeat(65)}`,
          authorization: { from: '0xPAYER', to: accept.payTo, value: accept.amount, validAfter: '0', validBefore: '9999999999', nonce: '0xNONCE' },
        } as ExactPaymentPayload,
        accepted: accept,
        payerFrom: '0xPAYER',
        nonce: '0xNONCE',
      }
    },
  } as unknown as ResolvedNetwork
}

let net = makeNet()
registerDriver({ family: 'evm', resolve: () => net })

/** A client that WILL pay an exact rail — `schemes` is opt-in, so the default client won't. */
const payingClient = () =>
  new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], policy: { maxAmount: '1' } })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  net = makeNet()
})

/** A v1 server: 402 with a PLAIN JSON body (no payment-required header) until X-PAYMENT arrives. */
function stubV1(onPaid: (xPayment: string) => Response, body: unknown = V1_BODY) {
  const seen: { xPayment?: string; paymentSignature?: string } = {}
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? {})
    const xPayment = h.get('x-payment')
    seen.paymentSignature = h.get('payment-signature') ?? undefined
    if (!xPayment) return new Response(JSON.stringify(body), { status: 402, headers: { 'content-type': 'application/json' } })
    seen.xPayment = xPayment
    return onPaid(xPayment)
  }) as typeof fetch
  return seen
}

/** The v1 settled response: a 200 carrying the legacy `x-payment-response` receipt header. */
const v1Settle200 = () =>
  new Response(JSON.stringify({ price: 1 }), {
    status: 200,
    headers: {
      'x-payment-response': Buffer.from(
        JSON.stringify({ success: true, transaction: '0xSETTLED', network: 'base', payer: '0xPAYER' }),
        'utf8'
      ).toString('base64'),
    },
  })

describe('normalizeV1Challenge — lifting a v1 body into the internal shape', () => {
  it('absorbs all four v1↔v2 skews', () => {
    const c = normalizeV1Challenge(V1_BODY)!
    expect(c).not.toBeNull()
    expect(c.x402Version).toBe(1) // KEPT — it is what routes the answer onto the v1 wire
    // (1) maxAmountRequired → amount, with the legacy key preserved for any facilitator reading it
    expect(c.accepts[0]!.amount).toBe('1000')
    expect((c.accepts[0] as unknown as Record<string, unknown>).maxAmountRequired).toBe('1000')
    // (2) slug → CAIP-2 for matching, with the wire form remembered for the echo
    expect(c.accepts[0]!.network).toBe('eip155:8453')
    expect((c.accepts[0] as X402ExactAcceptEntry).wireNetwork).toBe('base')
    // (3) the per-accept resource STRING becomes the top-level resource object
    expect(c.resource.url).toBe(URL)
    expect(c.resource.mimeType).toBe('application/json')
    expect((c.accepts[0] as unknown as Record<string, unknown>).resource).toBeUndefined()
    // (4) unknown keys ride along untouched (a facilitator's extras must survive)
    expect(c.accepts[0]!.extra).toEqual({ name: 'USD Coin', version: '2' })
  })

  it('does not mutate the caller\'s body', () => {
    const body = structuredClone(V1_BODY) as Record<string, unknown>
    const before = JSON.stringify(body)
    normalizeV1Challenge(body)
    expect(JSON.stringify(body)).toBe(before)
  })

  it('maps every slug it knows, and leaves an unknown slug alone rather than guessing', () => {
    const withNet = (network: string) =>
      normalizeV1Challenge({ ...V1_BODY, accepts: [{ ...V1_BODY.accepts[0], network }] })!.accepts[0]!
    expect(withNet('solana').network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(withNet('polygon').network).toBe('eip155:137')
    expect(withNet('celo').network).toBe('eip155:42220')
    // An unresolvable slug stays verbatim: "unresolved, don't hide it" beats a confident wrong
    // mapping, which would pay the right address on the WRONG chain.
    const unknown = withNet('not-a-chain')
    expect(unknown.network).toBe('not-a-chain')
    expect((unknown as X402ExactAcceptEntry).wireNetwork).toBeUndefined() // nothing was rewritten
  })

  it('an accept already in CAIP-2 keeps its network and records no wireNetwork', () => {
    const a = normalizeV1Challenge({
      ...V1_BODY,
      accepts: [{ ...V1_BODY.accepts[0], network: 'eip155:8453' }],
    })!.accepts[0] as X402ExactAcceptEntry
    expect(a.network).toBe('eip155:8453')
    expect(a.wireNetwork).toBeUndefined()
  })

  it('rejects anything that is not a v1 challenge (returns null, never throws)', () => {
    expect(normalizeV1Challenge(null)).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 2, accepts: [{}], resource: { url: 'x' } })).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 1, accepts: [] })).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 1, accepts: [null] })).toBeNull()
    // v1's resource lives on the accept; without one there is no URL to hoist
    expect(normalizeV1Challenge({ x402Version: 1, accepts: [{ scheme: 'exact' }] })).toBeNull()
    expect(normalizeV1Challenge('nope')).toBeNull()
  })
})

describe('buildV1PaymentHeader — the flat v1 payload', () => {
  it('frames { x402Version: 1, scheme, network, payload } as base64 JSON', () => {
    const h = buildV1PaymentHeader({ scheme: 'exact', network: 'base', payload: { signature: '0xsig' } })
    expect(decodeBase64Json(h)).toEqual({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0xsig' },
    })
  })
})

describe('paying a live-shaped v1 server end to end', () => {
  it('quotes a v1 challenge (it used to be an InvalidEnvelopeError)', async () => {
    stubV1(() => v1Settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const q = (await client.quote(URL))!
    expect(q.network).toBe('eip155:8453') // canonicalised for the caller, not the raw slug
    expect(q.amountFormatted).toBe('0.001')
    expect(q.symbol).toBe('USDC')
    expect(q.recognized).toBe(true)
  })

  it('answers on the v1 wire: X-PAYMENT set, PAYMENT-SIGNATURE absent, slug echoed verbatim', async () => {
    const seen = stubV1(() => v1Settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1)
    expect(seen.paymentSignature).toBeUndefined() // a v1 server ignores it — sending it is noise
    const flat = decodeBase64Json(seen.xPayment!) as Record<string, unknown>
    expect(flat.x402Version).toBe(1)
    expect(flat.scheme).toBe('exact')
    // THE v1 SUBTLETY: echo the slug the server sent, not our canonical CAIP-2 — a v1 verifier
    // string-compares this against its own requirement and `eip155:8453` would not match.
    expect(flat.network).toBe('base')
    expect((flat.payload as Record<string, unknown>).signature).toBe(`0x${'cd'.repeat(65)}`)
    expect(flat).not.toHaveProperty('accepted') // v1 has no accepted echo
  })

  it('records the spend exactly once from the v1 x-payment-response receipt', async () => {
    stubV1(() => v1Settle200())
    const events: string[] = []
    const client = new PipRailClient({
      chain: 'base',
      wallet: { key: '0x1' },
      schemes: ['exact'],
      onEvent: (e) => events.push(e.kind),
    })
    await client.fetch(URL)
    expect(events.filter((k) => k === 'payment-settled')).toHaveLength(1)
    expect(client.spent().count).toBe(1)
  })

  it('a v2 challenge is still answered on the v2 wire (no cross-contamination)', async () => {
    let sawXPayment: string | null = null
    let sawSig: string | null = null
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      sawXPayment = h.get('x-payment')
      sawSig = h.get('payment-signature')
      if (!sawSig) {
        const body = {
          x402Version: 2,
          resource: { url: URL },
          accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
        }
        return new Response(JSON.stringify(body), { status: 402 })
      }
      return new Response('{}', { status: 200, headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: '0xT', network: 'eip155:8453', payer: '0xPAYER' })).toString('base64') } })
    }) as typeof fetch
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    expect((await client.fetch(URL)).status).toBe(200)
    expect(sawSig).toBeTruthy()
    expect(sawXPayment).toBeNull()
  })

  it('a v1 rail on a DIFFERENT chain is not matched by a base client', async () => {
    stubV1(() => v1Settle200(), { ...V1_BODY, accepts: [{ ...V1_BODY.accepts[0], network: 'polygon' }] })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })

  it('a v1 402 that keeps refusing never records a spend', async () => {
    stubV1(() => new Response(JSON.stringify({ error: 'insufficient_funds' }), { status: 402 }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], maxPaymentRetries: 1 })
    await expect(client.fetch(URL)).rejects.toThrow()
    expect(client.spent().count).toBe(0)
  })

  it('the v1 rail still obeys the spend policy', async () => {
    stubV1(() => v1Settle200())
    const client = new PipRailClient({
      chain: 'base',
      wallet: { key: '0x1' },
      schemes: ['exact'],
      policy: { maxAmount: '0.0001' }, // the rail asks 0.001
    })
    await expect(client.fetch(URL)).rejects.toThrow()
    expect(payExactCalls).toBe(0)
  })

  it('the DEFAULT client still refuses a v1 exact-only challenge (defaults unchanged)', async () => {
    stubV1(() => v1Settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } }) // no `schemes`
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })

  /*
   * A v1 server is, by definition, running code nobody has updated in a while. These are the
   * malformed and half-migrated bodies such a server actually emits — each one must produce a
   * TYPED refusal and zero spend, never a crash and never a payment built on a guess.
   */
  it('a NUMERIC maxAmountRequired is refused as an envelope error, not coerced', async () => {
    // Only a base-unit STRING is money. Coercing 1000 (a JSON number) would risk a float, and a
    // float in an amount is how you overpay by orders of magnitude.
    stubV1(() => v1Settle200(), {
      ...V1_BODY,
      accepts: [{ ...V1_BODY.accepts[0], maxAmountRequired: 1000 }],
    })
    const client = payingClient()
    await expect(client.quote(URL)).rejects.toBeInstanceOf(InvalidEnvelopeError)
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(InvalidEnvelopeError)
    expect(payExactCalls).toBe(0)
  })

  it('a half-migrated body carrying BOTH names prices on `amount`, the v2 one', () => {
    const c = normalizeV1Challenge({
      ...V1_BODY,
      accepts: [{ ...V1_BODY.accepts[0], amount: '5', maxAmountRequired: '1000' }],
    })
    expect(c!.accepts[0]!.amount).toBe('5')
    // `maxAmountRequired` rides along untouched — a facilitator reading the legacy name off our
    // echo still finds it, and we never had to choose between them.
    expect((c!.accepts[0] as unknown as { maxAmountRequired: string }).maxAmountRequired).toBe('1000')
  })

  it('hoists the resource from whichever accept carries it, not just the first', () => {
    const c = normalizeV1Challenge({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'base', maxAmountRequired: '1', payTo: PAYTO, asset: USDC, maxTimeoutSeconds: 60 },
        { scheme: 'exact', network: 'solana', maxAmountRequired: '2', resource: 'https://second/r', payTo: 'S', asset: 'M', maxTimeoutSeconds: 60 },
      ],
    })
    expect(c!.resource.url).toBe('https://second/r')
    // …and each accept keeps its own canonicalised network + wire slug
    expect(c!.accepts.map((a) => a.network)).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'])
  })

  it('refuses a body with no resource on ANY accept (there would be nothing to pay for)', () => {
    expect(
      normalizeV1Challenge({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1', payTo: PAYTO, asset: USDC, maxTimeoutSeconds: 60 }],
      })
    ).toBeNull()
  })

  it('refuses a stringly-typed version and a null accept, exactly like the v2 validator', () => {
    expect(normalizeV1Challenge({ ...V1_BODY, x402Version: '1' })).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 1, accepts: [null, V1_BODY.accepts[0]] })).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 1, accepts: [] })).toBeNull()
    expect(normalizeV1Challenge({ x402Version: 2, accepts: [V1_BODY.accepts[0]] })).toBeNull()
  })

  it('carries a v1 `error` string through, so a re-challenge reason is not lost', () => {
    expect(normalizeV1Challenge({ ...V1_BODY, error: 'insufficient_funds' })!.error).toBe('insufficient_funds')
  })

  it('lifts a v1 body delivered in the PAYMENT-REQUIRED header, not just the body', async () => {
    // v1 predates that header, but a mixed-version proxy in front of a v1 origin can add it.
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      if (h.get('x-payment')) return v1Settle200()
      return new Response('nope', {
        status: 402,
        headers: { 'payment-required': Buffer.from(JSON.stringify(V1_BODY), 'utf8').toString('base64') },
      })
    }) as typeof fetch
    const q = await payingClient().quote(URL)
    expect(q!.amount).toBe('1000')
    expect(q!.network).toBe('eip155:8453')
  })

  /*
   * `wireNetwork` is ours, not the merchant's — the normalizer adds it to remember the slug a v1
   * server sent while `network` is canonicalised for matching. Every `accepted` echo is
   * documented as the rail returned VERBATIM, and facilitators compare (some hash) that block, so
   * a key the merchant never published must not appear in it. It leaked until 2.16.0.
   */
  it('never echoes the synthetic `wireNetwork` back to the merchant', async () => {
    const seen: { sig?: string } = {}
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? {})
      const sig = h.get('payment-signature')
      if (!sig) {
        return new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [{ scheme: 'onchain-proof', network: 'base', maxAmountRequired: '1000', resource: URL, payTo: PAYTO, asset: USDC, maxTimeoutSeconds: 60 }],
          }),
          { status: 402, headers: { 'content-type': 'application/json' } }
        )
      }
      seen.sig = sig
      return new Response('{"ok":1}', { status: 200 })
    }) as typeof fetch

    // onchain-proof is the one scheme that still uses the v2 `accepted` echo on a v1 challenge.
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, policy: { maxAmount: '1' } })
    await client.fetch(URL)
    const decoded = decodeBase64Json(seen.sig!) as { accepted: Record<string, unknown> }
    expect(decoded.accepted.wireNetwork).toBeUndefined()
    expect(Object.keys(decoded.accepted)).not.toContain('wireNetwork')
    // the rail itself is still echoed intact
    expect(decoded.accepted.payTo).toBe(PAYTO)
    expect(decoded.accepted.network).toBe('eip155:8453')
  })
})
