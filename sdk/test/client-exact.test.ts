/**
 * The buyer-side `exact` rail wired into PipRailClient (opt-in `schemes`). Drives a
 * FAKE evm driver (with `payExact` + `describeAsset`) so no real chain/RPC is touched
 * — these tests pin the scheme gating, the conservative pay path, and the three
 * correctness invariants (no double-broadcast, no phantom spend, recordSpend once).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  PipRailClient,
  planAcross,
  registerDriver,
  buildChallengeHeader,
  PipRailError,
  MaxRetriesExceededError,
  NoCompatibleAcceptError,
  PaymentDeclinedError,
  PaymentTimeoutError,
  UnsupportedSchemeError,
  type ResolvedNetwork,
  type X402AcceptEntry,
  type X402ExactAcceptEntry,
  type ExactPaymentPayload,
} from '../src/index.js'

const NET = 'eip155:8453'
const URL = 'https://api.example.com/r'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UNKNOWN = '0x00000000000000000000000000000000000000ff'
const PAYTO = '0x1111111111111111111111111111111111111111'

let payExactCalls = 0
let sendCalls = 0
let nonceCtr = 0
beforeEach(() => {
  payExactCalls = 0
  sendCalls = 0
  nonceCtr = 0
})

function makeNet(opts: { withExact?: boolean } = {}): ResolvedNetwork {
  const withExact = opts.withExact ?? true
  const net: ResolvedNetwork = {
    family: 'evm',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a) => (a === USDC ? { symbol: 'USDC', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => {
      sendCalls += 1
      return '0xONCHAINPROOFTX'
    },
    confirm: async () => ({ height: '100' }),
    estimateCost: async (accept) =>
      accept.scheme === 'exact'
        ? { feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'estimated' as const }
        : { feeSymbol: 'ETH', feeDecimals: 18, fee: '21000000000000', feeFormatted: '0.000021', basis: 'estimated' as const },
    balanceOf: async () => ({ token: 1_000_000n, native: 1_000_000_000_000_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
  }
  if (withExact) {
    net.payExact = async (_w, accept) => {
      payExactCalls += 1
      nonceCtr += 1
      const nonce = `0x${nonceCtr.toString(16).padStart(64, '0')}`
      const payload: ExactPaymentPayload = {
        signature: `0x${'cd'.repeat(65)}`,
        authorization: { from: '0xPAYER', to: accept.payTo, value: accept.amount, validAfter: '0', validBefore: '9999999999', nonce },
      }
      return { payload, accepted: accept, payerFrom: '0xPAYER', nonce }
    }
  }
  return net
}

let net = makeNet()
registerDriver({ family: 'evm', resolve: () => net })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  net = makeNet()
})

function exactAccept(over: Partial<X402ExactAcceptEntry> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: NET,
    amount: '50000', // 0.05 @ 6dp
    asset: USDC,
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2', decimals: 6, symbol: 'USDC' },
    ...over,
  }
}
function onchainAccept(over: Partial<X402AcceptEntry> = {}): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: NET,
    amount: '50000',
    asset: USDC,
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
    ...over,
  }
}

/** Stub fetch: 402 (challenge) for a proof-less request, else `onProof(sigHeader, reqCount)`. */
function stub(accepts: unknown[], onProof: (sig: string, n: number) => Response | Promise<Response>) {
  let proofReqs = 0
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const sig = new Headers(init?.headers ?? {}).get('payment-signature')
    if (!sig) {
      const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
      return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body as never) } })
    }
    proofReqs += 1
    return onProof(sig, proofReqs)
  }) as typeof fetch
  return { proofReqs: () => proofReqs }
}

const settle200 = (tx = '0xSETTLE') =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: NET, payer: '0xPAYER' }), 'utf8').toString('base64') },
  })

describe('schemes gating', () => {
  it('REGRESSION: default client (no schemes) on an exact-only challenge → NoCompatibleAcceptError', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })

  it('schemes:["exact"] pays the exact rail: signs ONCE, sets a v2 PAYMENT-SIGNATURE, no broadcast/confirm', async () => {
    let sentSig = ''
    stub([exactAccept()], (sig) => {
      sentSig = sig
      return settle200()
    })
    const events: string[] = []
    const client = new PipRailClient({
      chain: 'base',
      wallet: { key: '0x1' },
      schemes: ['exact'],
      onEvent: (e) => events.push(e.kind),
    })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1)
    expect(sendCalls).toBe(0) // exact NEVER goes through net.send/confirm
    // the header is the v2 nested envelope, not the onchain-proof proof
    const decoded = JSON.parse(Buffer.from(sentSig, 'base64').toString('utf8'))
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted.scheme).toBe('exact')
    expect(decoded.payload.signature).toBe(`0x${'cd'.repeat(65)}`)
    // events: required → settled, with NO broadcast/confirmed/unconfirmed
    expect(events).toContain('payment-required')
    expect(events).toContain('payment-settled')
    expect(events).not.toContain('payment-broadcast')
    expect(events).not.toContain('payment-confirmed')
  })

  it('per-call fetch(url,{schemes:["exact"]}) overrides — and does NOT leak into later calls', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } }) // default onchain-proof
    const res = await client.fetch(URL, { schemes: ['exact'] })
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1)
    // a subsequent default call must NOT remember the override → exact-only is uncompatible again
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
  })

  it('mixed dual-rail (onchain-proof + exact) on one chain → pays ONCHAIN-PROOF (bucket order), exactly one rail', async () => {
    stub([onchainAccept(), exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['onchain-proof', 'exact'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(sendCalls).toBe(1) // onchain-proof paid …
    expect(payExactCalls).toBe(0) // … and NOT exact (at most one rail per 402)
  })

  it('exact rail on an UNRECOGNISED token is not gathered → NoCompatibleAcceptError (no fallback)', async () => {
    stub([exactAccept({ asset: UNKNOWN })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })

  it('a family without payExact, exact-only + no fallback → UnsupportedSchemeError; WITH a fallback → pays onchain-proof', async () => {
    net = makeNet({ withExact: false })
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(UnsupportedSchemeError)

    net = makeNet({ withExact: false })
    stub([exactAccept(), onchainAccept()], () => settle200())
    const client2 = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['onchain-proof', 'exact'] })
    const res = await client2.fetch(URL)
    expect(res.status).toBe(200)
    expect(sendCalls).toBe(1)
  })
})

describe('exact pay path — correctness invariants', () => {
  it('idempotent: a 402-then-200 reuses the SAME signed header — signs ONCE', async () => {
    const sigs: string[] = []
    stub([exactAccept()], (sig, n) => {
      sigs.push(sig)
      return n === 1 ? new Response('still verifying', { status: 402 }) : settle200()
    })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], retryTimeoutMs: 1000 })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1) // signed once
    expect(sigs.length).toBe(2)
    expect(sigs[0]).toBe(sigs[1]) // identical header re-presented (same nonce)
  })

  it('BLOCKER #1: a post-POST transport error → PaymentTimeoutError(nonce); NEVER re-POSTs', async () => {
    const h = stub([exactAccept()], () => {
      throw new Error('socket hang up')
    })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentTimeoutError)
    expect(err.ref).toMatch(/^0x[0-9a-f]{64}$/) // the authorization nonce
    expect(h.proofReqs()).toBe(1) // submitted once, NOT re-POSTed
    expect(client.spent().count).toBe(0)
  })

  it('BLOCKER #2: 200 + success:false → rejection, NO recorded spend', async () => {
    stub([exactAccept()], () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'payment-response': Buffer.from(JSON.stringify({ success: false, errorReason: 'insufficient_funds', transaction: '' }), 'utf8').toString('base64') },
      })
    )
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(MaxRetriesExceededError)
    expect(client.spent().count).toBe(0) // the phantom-spend guard
  })

  it('BLOCKER #3: an affirmative settle records the spend EXACTLY once, ref = the settle tx', async () => {
    stub([exactAccept()], () => settle200('0xDEADBEEF'))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await client.fetch(URL)
    const spend = client.spent()
    expect(spend.count).toBe(1)
    expect(spend.records[0]!.ref).toBe('0xDEADBEEF')
    expect(spend.byAsset[0]!.totalBase).toBe('50000')
  })

  it('a 5xx (server settle failure) is returned as-is — no spend, not MaxRetriesExceededError', async () => {
    stub([exactAccept()], () => new Response('relayer down', { status: 502 }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(502)
    expect(client.spent().count).toBe(0)
  })

  it('persistent 402 → MaxRetriesExceededError telling the caller to re-present the SAME authorization', async () => {
    stub([exactAccept()], () => new Response('rejected', { status: 402 }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], maxPaymentRetries: 1 })
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(MaxRetriesExceededError)
    expect(err.message).toMatch(/re-present the SAME authorization/i)
    expect(err.ref).toMatch(/^0x[0-9a-f]{64}$/)
    expect(client.spent().count).toBe(0)
  })

  it('over-budget exact is refused BEFORE signing (PaymentDeclinedError; payExact not called)', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], policy: { maxAmount: '0.01' } })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(PaymentDeclinedError)
    expect(payExactCalls).toBe(0) // authorize() refuses before any signature
    expect(client.spent().count).toBe(0)
  })
})

describe('planPayment + exact — the gasless affordability model', () => {
  it('an exact rail on a token-funded, ZERO-native wallet is payable with fee 0', async () => {
    stub([exactAccept()], () => settle200())
    net.balanceOf = async () => ({ token: 1_000_000n, native: 0n })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const plan = await client.planPayment(URL)
    expect(plan!.payable).toBe(true)
    expect(plan!.best!.cost.fee).toBe('0')
    expect(plan!.best!.blockers).toEqual([])
    expect(plan!.best!.warnings).not.toContain('THIN_GAS_MARGIN')
  })

  it('contrast: an onchain-proof token rail with zero native → INSUFFICIENT_GAS (proves exact is gasless)', async () => {
    stub([onchainAccept()], () => settle200())
    net.balanceOf = async () => ({ token: 1_000_000n, native: 0n })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    const plan = await client.planPayment(URL)
    expect(plan!.options[0]!.blockers).toContain('INSUFFICIENT_GAS')
  })

  it('under-funded exact → INSUFFICIENT_TOKEN with a token-only shortfall (never gas)', async () => {
    stub([exactAccept()], () => settle200())
    net.balanceOf = async () => ({ token: 10n, native: 0n })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const opt = (await client.planPayment(URL))!.options[0]!
    expect(opt.blockers).toContain('INSUFFICIENT_TOKEN')
    expect(opt.blockers).not.toContain('INSUFFICIENT_GAS')
    expect(opt.shortfall?.token).toBeDefined()
    expect(opt.shortfall?.native).toBeUndefined()
  })

  it('over-budget exact → OUTSIDE_POLICY', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], policy: { maxAmount: '0.01' } })
    expect((await client.planPayment(URL))!.options[0]!.blockers).toContain('OUTSIDE_POLICY')
  })

  it('estimateCost(url) on an exact rail → fee 0, basis estimated', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const est = await client.estimateCost(URL)
    expect(est!.cost.fee).toBe('0')
    expect(est!.cost.basis).toBe('estimated')
  })
})

/* ───────────────── audit edge cases (the bug-hunt regression battery) ───────────────── */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
/** A response carrying a base64 PAYMENT-RESPONSE SettleResponse at any status. */
const settleResp = (status: number, body: unknown) =>
  new Response('{}', { status, headers: { 'payment-response': b64(body) } })

describe('exact pay path — spec failure shapes', () => {
  it('BLOCKER REGRESSION: a 402 + PAYMENT-RESPONSE {success:false} is DEFINITIVE — no retry, no spend', async () => {
    // The x402 v2 transport spec returns a settlement failure as HTTP 402 + base64
    // PAYMENT-RESPONSE {success:false, errorReason}. It must NOT be retried as a transient 402.
    const h = stub([exactAccept()], () =>
      settleResp(402, { success: false, errorReason: 'insufficient_funds', transaction: '', network: NET, payer: '0xPAYER' })
    )
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(MaxRetriesExceededError)
    expect(err.message).toMatch(/insufficient_funds/)
    expect(h.proofReqs()).toBe(1) // submitted ONCE — never blindly re-POSTed
    expect(client.spent().count).toBe(0)
  })

  it('a 5xx carrying success:false is a SERVER settle failure — returned as-is, no spend, not MaxRetries', async () => {
    stub([exactAccept()], () => settleResp(503, { success: false, errorReason: 'relayer_down', transaction: '', network: NET }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(503)
    expect(client.spent().count).toBe(0)
  })

  it('a receipt-less 200 settles once with an eip3009-nonce: audit ref', async () => {
    stub([exactAccept()], () => new Response('{}', { status: 200 })) // NO payment-response header
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await client.fetch(URL)
    expect(client.spent().count).toBe(1)
    expect(client.spent().records[0]!.ref).toMatch(/^eip3009-nonce:0x[0-9a-f]{64}$/)
  })

  it('a 200 with transaction:"" falls back to the nonce ref, never an empty ref', async () => {
    stub([exactAccept()], () => settleResp(200, { success: true, transaction: '', network: NET }))
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await client.fetch(URL)
    expect(client.spent().records[0]!.ref).toMatch(/^eip3009-nonce:/)
  })

  it('payment-settled carries the conformant settle outcome (transaction) on facilitator interop', async () => {
    stub([exactAccept()], () => settleResp(200, { success: true, transaction: '0xSETTLED', network: NET }))
    let ev: { settle?: { transaction?: string } } | null = null
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'], onEvent: (e) => { if (e.kind === 'payment-settled') ev = e } })
    await client.fetch(URL)
    expect(ev!.settle!.transaction).toBe('0xSETTLED')
  })
})

describe('exact pay path — safety, abort & malformed rails', () => {
  it('flags symbolMismatch when an exact rail lies about the token symbol', async () => {
    stub([exactAccept({ extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2', decimals: 6, symbol: 'USDT' } })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    expect((await client.quote(URL))!.symbolMismatch).toBe(true)
    expect((await client.planPayment(URL))!.options[0]!.warnings).toContain('SYMBOL_MISMATCH')
  })

  it('a default client on an exact-only-but-PAYABLE EVM 402 gets a one-line enable-schemes hint', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } }) // default schemes
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(NoCompatibleAcceptError)
    expect(err.message).toMatch(/schemes/)
    expect(err.message).toMatch(/exact/)
  })

  it('a pre-flight caller abort surfaces an AbortError and never signs', async () => {
    stub([exactAccept()], () => settle200())
    const ac = new AbortController()
    ac.abort()
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const err = await client.fetch(URL, { signal: ac.signal }).catch((e) => e)
    expect(err?.name).toBe('AbortError')
    expect(payExactCalls).toBe(0)
  })

  it('a mid/post-flight transport drop → PaymentTimeoutError(nonce) — verify on-chain, never re-pay', async () => {
    stub([exactAccept()], () => { throw new DOMException('aborted', 'AbortError') })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentTimeoutError)
    expect(err.ref).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it.each([
    ['omitted', undefined],
    ['a string', '300'],
  ])('a foreign exact rail whose maxTimeoutSeconds is %s is dropped — a typed error, never a raw SyntaxError', async (_label, bad) => {
    const rail = { ...exactAccept(), maxTimeoutSeconds: bad } as unknown as X402ExactAcceptEntry
    stub([rail], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PipRailError)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect(payExactCalls).toBe(0)
  })

  it('clamps the per-attempt timeout to the auth deadline (a slow facilitator cannot outlive validBefore)', async () => {
    // maxTimeoutSeconds:2 → deadline ~1s; the default retryTimeoutMs is 30s. A 5s-sleeping
    // facilitator must be aborted at the clamp (~1s) → PaymentTimeoutError, NOT a 5s hang.
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const sig = new Headers(init?.headers ?? {}).get('payment-signature')
      if (!sig) {
        const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts: [exactAccept({ maxTimeoutSeconds: 2 })] }
        return new Response(JSON.stringify(body), { status: 402, headers: { 'payment-required': buildChallengeHeader(body as never) } })
      }
      return await new Promise<Response>((res, rej) => {
        const t = setTimeout(() => res(settle200()), 5000)
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')) })
      })
    }) as typeof fetch
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const start = Date.now()
    const err = await client.fetch(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentTimeoutError)
    expect(Date.now() - start).toBeLessThan(3000) // aborted at the ~1s clamp, not the 5s sleep
  })

  it('echoes an unknown facilitator extra key VERBATIM in the PAYMENT-SIGNATURE (spec: echo in full)', async () => {
    let sentSig = ''
    const acc = exactAccept()
    ;(acc.extra as Record<string, unknown>).someFacilitatorKey = 'keep-me'
    stub([acc], (sig) => { sentSig = sig; return settle200() })
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await client.fetch(URL)
    const decoded = JSON.parse(Buffer.from(sentSig, 'base64').toString('utf8'))
    expect(decoded.accepted.extra.someFacilitatorKey).toBe('keep-me')
  })
})

describe('exact routing — autoRoute & planAcross', () => {
  it('autoRoute pays the fee-0 exact rail on a mixed challenge when native gas is 0', async () => {
    net.balanceOf = async () => ({ token: 1_000_000n, native: 0n }) // onchain-proof would be gas-blocked
    stub([onchainAccept(), exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['onchain-proof', 'exact'], autoRoute: true })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1) // the gasless exact rail …
    expect(sendCalls).toBe(0) // … not the gas-blocked onchain-proof rail
  })

  it('planAcross surfaces an exact rail and can pick it as best', async () => {
    stub([exactAccept()], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const plan = await planAcross([client], URL)
    expect(plan).not.toBeNull()
    expect(plan!.options.some((o) => o.accept.scheme === 'exact')).toBe(true)
    expect(plan!.best?.accept.scheme).toBe('exact')
  })
})

describe('B: slug-network normalization on the BUYER pay path (BNB / AEON interop)', () => {
  // The buyer's rail-match used to require the LITERAL CAIP-2 ('eip155:8453'); a foreign
  // 402 (AEON serves v1 duplicate kinds '56'/'bsc'; community facilitators emit 'bsc')
  // that labelled the SAME chain with a slug was silently skipped. The pay path now
  // normalizes the rail's network the SAME way discovery's railOnNetwork already does.
  // ADDITIVE: a CAIP-2 value passes through normalizeNetwork unchanged (every existing
  // test above still pins the CAIP-2 path), so only slugs resolving to the BOUND chain
  // become newly payable — never a different chain.
  // The slug networks below are intentionally NOT CAIP-2 — widen past the `Caip2` field type.
  const slug = (n: string) => n as X402ExactAcceptEntry['network']

  it('pays an EXACT rail whose network is a SLUG ("base") resolving to the bound chain', async () => {
    stub([exactAccept({ network: slug('base') })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(payExactCalls).toBe(1)
  })

  it('pays an ONCHAIN-PROOF rail whose network is a SLUG ("base") — gather + payAndConfirm both normalize', async () => {
    stub([onchainAccept({ network: slug('base') })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    const res = await client.fetch(URL)
    expect(res.status).toBe(200)
    expect(sendCalls).toBe(1)
  })

  it('REGRESSION: a slug for a DIFFERENT chain ("polygon") is NOT matched by a base client', async () => {
    stub([exactAccept({ network: slug('polygon') })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })

  it('REGRESSION: an unrecognised network slug stays UNmatched (no false positive)', async () => {
    stub([exactAccept({ network: slug('not-a-chain') })], () => settle200())
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' }, schemes: ['exact'] })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(NoCompatibleAcceptError)
    expect(payExactCalls).toBe(0)
  })
})
