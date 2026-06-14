import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  MultiChainPayer,
  fetchAcross,
  planAcross,
  paymentTools,
  registerDriver,
  buildChallengeHeader,
  PaymentDeclinedError,
  type ResolvedNetwork,
  type X402AcceptEntry,
  type Caip2,
} from '../src/index.js'

// Genuinely HETEROGENEOUS fake chains — the gap the single-chain tests left open.
// Three families on three networks, each with its own native coin + gas cost, so we
// can prove a buyer holding one wallet per chain pays whichever chain the 402 asks for.
const BASE = 'eip155:8453'
const SOL = 'solana:mainnet'
const XRPL = 'xrpl:mainnet'
const URL = 'https://api.example.com/r'

type NetOver = Partial<
  Pick<ResolvedNetwork, 'balanceOf' | 'recipientReady' | 'estimateCost' | 'send'>
>

function mkNet(
  family: ResolvedNetwork['family'],
  network: Caip2,
  symbol: string,
  fee: string,
  over: NetOver = {}
): ResolvedNetwork {
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: () => ({ asset: 'native', decimals: 6, symbol }),
    describeAsset: (a) => (a === 'native' ? { symbol, decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${network}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({
      feeSymbol: symbol,
      feeDecimals: 6,
      fee,
      feeFormatted: '0.0001',
      basis: 'estimated',
    }),
    balanceOf: async () => ({ token: 100_000_000n, native: 100_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({
      ok: true,
      receipt: {
        scheme: 'onchain-proof',
        success: true,
        network,
        transaction: `ref-${network}`,
        asset: 'native',
        amount: '500000',
        payer: 'P',
        payTo: 'M',
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    ...over,
  }
}

// Live closures so a test can swap a chain's behaviour (broke, expensive, …) before acting.
let baseN = mkNet('evm', BASE, 'ETH', '100')
let solN = mkNet('solana', SOL, 'SOL', '50')
let xrplN = mkNet('xrpl', XRPL, 'XRP', '80')
registerDriver({ family: 'evm', resolve: () => baseN })
registerDriver({ family: 'solana', resolve: () => solN })
registerDriver({ family: 'xrpl', resolve: () => xrplN })

function reset() {
  baseN = mkNet('evm', BASE, 'ETH', '100')
  solN = mkNet('solana', SOL, 'SOL', '50')
  xrplN = mkNet('xrpl', XRPL, 'XRP', '80')
}

function accept(network: Caip2, symbol: string, o: Partial<X402AcceptEntry> = {}): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network,
    amount: '500000', // 0.5 @ 6dp
    asset: 'native',
    payTo: 'M',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.5', symbol },
    ...o,
  }
}

function stub402(accepts: X402AcceptEntry[], onProof?: () => Response) {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const proof = !!new Headers(init?.headers ?? {}).get('payment-signature')
    if (proof && onProof) return onProof()
    const b = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
    return new Response(JSON.stringify(b), {
      status: 402,
      headers: { 'payment-required': buildChallengeHeader(b) },
    })
  }) as typeof fetch
}

const paid200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

// A buyer holding one wallet per chain — the whole point. Order = chain preference.
const payer = (chains: string[] = ['base', 'solana', 'xrpl'], over = {}) =>
  MultiChainPayer.fromWallets({
    wallets: Object.fromEntries(
      chains.map((c) => [c, c === 'solana' ? { secretKey: 'x' } : c === 'xrpl' ? { seed: 'sx' } : { privateKey: '0x' + '1'.repeat(64) }])
    ),
    ...over,
  })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  reset()
})

describe('MultiChainPayer / fetchAcross — pay whichever chain the 402 asks for', () => {
  it('pays the FIRST funded chain in listed order (no cross-coin fee oracle → preference wins)', async () => {
    // base fee 100 > solana fee 50, but across DIFFERENT coins fees aren't comparable,
    // so the first-listed payable chain (base) wins — your preference, not raw magnitude.
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const p = payer(['base', 'solana'])
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    expect(p.spent().count).toBe(1)
    expect(p.spent().records[0]!.network).toBe(BASE)
  })

  it('fetchAcross pays the very rail planAcross names as `best` (consistency)', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const clients = [new PipRailClient({ chain: 'base', wallet: { privateKey: '0x' + '1'.repeat(64) } }), new PipRailClient({ chain: 'solana', wallet: { secretKey: 'x' } })]
    const plan = (await planAcross(clients, URL))!
    expect(plan.best!.accept.network).toBe(BASE) // first-listed payable
    const res = await fetchAcross(clients, URL)
    expect(res.status).toBe(200)
  })

  it('SKIPS a blocked chain and pays the funded one (even if the blocked chain is cheaper)', async () => {
    // base is cheaper (fee 10) but BROKE; solana is funded → must pay solana.
    baseN = mkNet('evm', BASE, 'ETH', '10', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const p = payer(['base', 'solana'])
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    expect(p.spent().records[0]!.network).toBe(SOL)
  })

  it('throws PaymentDeclinedError with a MERGED per-chain hint when no chain can settle', async () => {
    baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    solN = mkNet('solana', SOL, 'SOL', '50', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const err = await payer(['base', 'solana'])
      .get(URL)
      .catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    // The merged hint names BOTH chains (joined with ' · ').
    expect(String(err.message)).toMatch(/base/i)
    expect(String(err.message)).toMatch(/solana|sol/i)
    expect(String(err.message)).toContain('·')
  })

  it('merged decline lists EVERY funded chain’s shortfall, not just the first', async () => {
    // Both chains broke (coin below amount+fee) → the message must name BOTH, each with its
    // own actionable shortfall, so the reader knows every chain to fund (token-vs-gas
    // distinction is proven on real token rails in multi-chain-assets.test.ts).
    baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => ({ token: 100n, native: 100n }) })
    solN = mkNet('solana', SOL, 'SOL', '50', { balanceOf: async () => ({ token: 200n, native: 200n }) })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    expect(plan.payable).toBe(false)
    const hint = plan.fundingHint!
    expect(hint).toMatch(/base/i)
    expect(hint).toMatch(/solana|sol/i)
    expect(hint).toContain('·') // both chains surfaced, joined
    expect(hint).toMatch(/top up|add ~|gas|can't settle/i) // actionable shortfall wording
  })

  it('merged decline shows the ACTIONABLE top-up and DROPS "not offered here" noise', async () => {
    // base offers a rail but is broke; the 402 never offers solana at all.
    baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([accept(BASE, 'ETH')], paid200) // only base offered
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    expect(plan.payable).toBe(false)
    const hint = plan.fundingHint!
    expect(hint).toMatch(/base/i)
    expect(hint).not.toMatch(/not offered|isn't offered/i) // solana's noise is dropped
    expect(hint).not.toContain('·') // single actionable hint → nothing to join
  })

  it('when the 402 offers ONLY chains you don’t hold, the hint says where it IS payable', async () => {
    // Buyer holds base + solana; the 402 only offers XRPL → no actionable chain, so the
    // fallback must tell the reader which chain the 402 actually accepts.
    stub402([accept(XRPL, 'XRP')], paid200)
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options).toEqual([])
    const hint = plan.fundingHint!
    expect(hint).toMatch(/isn't offered|not offered/i)
    expect(hint).toMatch(/xrpl/i) // names where it IS payable
  })

  it('propagates `schemes` to EVERY chain’s client (gasless `exact` opt-in survives the bundle)', async () => {
    // Build the payer with schemes:['exact'] — onchain-proof is then excluded on every
    // client. A 402 offering ONLY onchain-proof is therefore not payable, proving the
    // scheme set reached each underlying client (this is how gasless `exact` opt-in flows
    // through the multi-chain path — live-proven on BNB Permit2).
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const exactOnly = (await payer(['base', 'solana'], { schemes: ['exact'] }).planPayment(URL))!
    expect(exactOnly.payable).toBe(false) // onchain-proof rails excluded on both clients

    reset()
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const dflt = (await payer(['base', 'solana']).planPayment(URL))! // default scheme set
    expect(dflt.payable).toBe(true) // same 402, onchain-proof allowed → payable
  })

  it('passes a NON-gated URL straight through (no 402 → no payment)', async () => {
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    const p = payer(['base', 'solana'])
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    expect(p.spent().count).toBe(0)
  })

  it('cross-coin tiebreak is CLIENT ORDER when fees are equal', async () => {
    // Equal fee on both → the first-listed chain wins.
    baseN = mkNet('evm', BASE, 'ETH', '100')
    solN = mkNet('solana', SOL, 'SOL', '100')
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    expect((await payer(['base', 'solana']).get(URL)).status).toBe(200)
    const pBaseFirst = payer(['base', 'solana'])
    await pBaseFirst.get(URL)
    expect(pBaseFirst.spent().records[0]!.network).toBe(BASE)

    reset()
    baseN = mkNet('evm', BASE, 'ETH', '100')
    solN = mkNet('solana', SOL, 'SOL', '100')
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const pSolFirst = payer(['solana', 'base'])
    await pSolFirst.get(URL)
    expect(pSolFirst.spent().records[0]!.network).toBe(SOL)
  })

  it('a 402 on a chain the buyer has NO wallet for → not payable, fetch throws', async () => {
    // Buyer holds base + solana; the 402 only offers XRPL.
    stub402([accept(XRPL, 'XRP')], paid200)
    const p = payer(['base', 'solana'])
    expect(await p.canAfford(URL)).toBe(false)
    const plan = (await p.planPayment(URL))!
    expect(plan.payable).toBe(false)
    expect(plan.options).toEqual([]) // neither client supports XRPL
    const err = await p.get(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
  })
})

describe('MultiChainPayer — read surface (plan / quote / canAfford / spent / budget)', () => {
  it('planPayment merges options across chains, ranked payable-first', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    expect(plan.payable).toBe(true)
    expect(plan.options.length).toBe(2) // one rail per chain, merged
    expect(plan.best!.accept.network).toBe(BASE) // first-listed payable chain wins
  })

  it('quote returns the best chain’s quote; null when not gated', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
    const q = await payer(['base', 'solana']).quote(URL)
    expect(q!.network).toBe(BASE)
    globalThis.fetch = (async () => new Response('hi', { status: 200 })) as typeof fetch
    expect(await payer(['base', 'solana']).quote(URL)).toBeNull()
  })

  it('canAfford is true when ANY chain can pay, false when none', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
    expect(await payer(['base', 'solana']).canAfford(URL)).toBe(true)
    solN = mkNet('solana', SOL, 'SOL', '50', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => ({ token: 0n, native: 0n }) })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
    expect(await payer(['base', 'solana']).canAfford(URL)).toBe(false)
  })

  it('spent() + budget() AGGREGATE across chains after a payment', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const p = payer(['base', 'solana'], { policy: { maxTotal: '5.00', tokens: ['SOL', 'ETH'] } })
    await p.get(URL)
    const spent = p.spent()
    expect(spent.count).toBe(1)
    expect(spent.byAsset.some((b) => b.network === BASE)).toBe(true) // base is first-listed → it paid
    // The merged budget surfaces the per-(network,asset) row for the chain that paid.
    expect(p.budget().byAsset.some((r) => r.network === BASE)).toBe(true)
  })

  it('discover merges + dedupes across chains (by resource URL)', async () => {
    // Two minimal fake clients with overlapping discovery results.
    const mk = (urls: string[]) =>
      ({
        discover: async () => urls.map((u) => ({ resource: u, name: u, source: 'mock', rails: [] })),
      }) as unknown as PipRailClient
    const p = new MultiChainPayer([mk(['a', 'b']), mk(['b', 'c'])])
    const found = await p.discover()
    expect(found.map((r) => r.resource).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('MultiChainPayer — agent toolkit + guards', () => {
  it('paymentTools(payer) — the pay tool pays across chains, plan tool merges', async () => {
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const p = payer(['base', 'solana'])
    const tools = paymentTools(p)
    expect(tools.map((t) => t.name)).toContain('piprail_pay_request')

    const plan = (await tools.find((t) => t.name === 'piprail_plan_payment')!.invoke({ url: URL })) as {
      gated: boolean
      options: unknown[]
    }
    expect(plan.gated).toBe(true)
    expect(plan.options.length).toBe(2)

    const pay = (await tools.find((t) => t.name === 'piprail_pay_request')!.invoke({ url: URL })) as {
      status: number
      ok: boolean
    }
    expect(pay.status).toBe(200)
    expect(p.spent().records[0]!.network).toBe(BASE) // first-listed payable chain
  })

  it('rejects an empty client set', async () => {
    expect(() => new MultiChainPayer([])).toThrow(TypeError)
    expect(() => MultiChainPayer.fromWallets({ wallets: {} })).toThrow(TypeError)
    await expect(fetchAcross([], URL)).rejects.toThrow(TypeError)
  })

  it('fromWallets builds one client per chain, in order', () => {
    const p = MultiChainPayer.fromWallets({
      wallets: { base: { privateKey: '0x' + '1'.repeat(64) }, solana: { secretKey: 'x' } },
    })
    expect(p.clients.length).toBe(2)
  })
})

describe('MultiChainPayer — cross-coin ranking + outage (regression guards)', () => {
  it('a tiny-base-unit coin does NOT auto-win over a higher-decimals coin (no raw-fee compare across coins)', async () => {
    // BOTH payable (huge balances cover gas). base has a HUGE raw fee (1e15, 18dp coin),
    // solana a TINY raw fee (5, 9dp coin). A naive raw-bigint compare would pick solana;
    // client order must win instead → base (first-listed) is chosen.
    const huge = 10n ** 30n
    baseN = mkNet('evm', BASE, 'ETH', '1000000000000000', {
      balanceOf: async () => ({ token: huge, native: huge }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '1000000000000000', feeFormatted: '0.001', basis: 'estimated' }),
    })
    solN = mkNet('solana', SOL, 'SOL', '5', {
      estimateCost: async () => ({ feeSymbol: 'SOL', feeDecimals: 9, fee: '5', feeFormatted: '0.000000005', basis: 'estimated' }),
    })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')], paid200)
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    expect(plan.best!.state).toBe('payable')
    expect(plan.best!.accept.network).toBe(BASE) // first-listed, NOT the smaller-base-unit solana
  })

  it('a TOTAL outage (every client throws) propagates — canAfford does NOT return a false true', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const p = payer(['base', 'solana'])
    await expect(p.planPayment(URL)).rejects.toThrow(/network down/)
    await expect(p.canAfford(URL)).rejects.toThrow(/network down/)
  })

  it('a SINGLE chain down just drops that chain; the reachable one still plans', async () => {
    // base RPC errors during analysis, solana is fine → plan still returns solana's rail.
    baseN = mkNet('evm', BASE, 'ETH', '100', { balanceOf: async () => { throw new Error('base rpc down') } })
    stub402([accept(BASE, 'ETH'), accept(SOL, 'SOL')])
    const plan = (await payer(['base', 'solana']).planPayment(URL))!
    // base's rail surfaces as 'unknown' (read failed) but solana is payable → best = solana.
    expect(plan.payable).toBe(true)
    expect(plan.best!.accept.network).toBe(SOL)
  })
})
