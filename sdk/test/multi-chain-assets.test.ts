import { describe, it, expect, afterEach } from 'vitest'
import {
  MultiChainPayer,
  registerDriver,
  buildChallengeHeader,
  type ResolvedNetwork,
  type X402AcceptEntry,
  type Caip2,
} from '../src/index.js'

// Multi-ASSET fake chains: USDC + USDT + native on each, with REAL-ish decimals
// (USDC/USDT 6dp, BNB native 18dp, SOL native 9dp) so we can prove asset-type
// routing AND that the dollar/native spend cap is enforced in the TOKEN's own units.
const BNB: Caip2 = 'eip155:56'
const SOL: Caip2 = 'solana:mainnet'
const URL = 'https://api.example.com/r'

type Bal = { token: bigint | null; native: bigint | null }
function mkNet(
  family: ResolvedNetwork['family'],
  network: Caip2,
  nativeSymbol: string,
  nativeDecimals: number,
  fee: string,
  balances: (asset: string) => Bal = () => ({ token: 10n ** 30n, native: 10n ** 30n })
): ResolvedNetwork {
  const meta = (a: string) =>
    a === 'native'
      ? { symbol: nativeSymbol, decimals: nativeDecimals }
      : a === 'USDC'
        ? { symbol: 'USDC', decimals: 6 }
        : a === 'USDT'
          ? { symbol: 'USDT', decimals: 6 }
          : null
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: () => ({ asset: 'native', decimals: nativeDecimals, symbol: nativeSymbol }),
    describeAsset: (a) => meta(a),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => `ref-${network}`,
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: nativeSymbol, feeDecimals: nativeDecimals, fee, feeFormatted: '0.0001', basis: 'estimated' }),
    balanceOf: async (_w, asset) => balances(asset),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: true, receipt: { scheme: 'onchain-proof', success: true, network, transaction: `ref-${network}`, asset: 'native', amount: '1', payer: 'P', payTo: 'M', verifiedAt: '2026-01-01T00:00:00.000Z' } }),
  }
}

let bnbN = mkNet('evm', BNB, 'BNB', 18, '100')
let solN = mkNet('solana', SOL, 'SOL', 9, '50')
registerDriver({ family: 'evm', resolve: () => bnbN })
registerDriver({ family: 'solana', resolve: () => solN })
function reset() {
  bnbN = mkNet('evm', BNB, 'BNB', 18, '100')
  solN = mkNet('solana', SOL, 'SOL', 9, '50')
}

const pow = (n: number) => 10n ** BigInt(n)
/** A rail for `asset` priced at `human` (converted to base via `decimals`). */
function accept(network: Caip2, asset: string, human: string, decimals: number, symbol: string): X402AcceptEntry {
  const [w, f = ''] = human.split('.')
  const base = (BigInt(w || '0') * pow(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals))).toString()
  return {
    scheme: 'onchain-proof', network, asset, amount: base, payTo: 'M', maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals, minConfirmations: 1, amountFormatted: human, symbol },
  }
}
const usdc = (net: Caip2, human = '0.05') => accept(net, 'USDC', human, 6, 'USDC')
const usdt = (net: Caip2, human = '0.05') => accept(net, 'USDT', human, 6, 'USDT')
const nativeRail = (net: Caip2, sym: string, dec: number, human = '0.001') => accept(net, 'native', human, dec, sym)

function stub402(accepts: X402AcceptEntry[], onProof?: () => Response) {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (onProof && new Headers(init?.headers ?? {}).get('payment-signature')) return onProof()
    const b = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts }
    return new Response(JSON.stringify(b), { status: 402, headers: { 'payment-required': buildChallengeHeader(b) } })
  }) as typeof fetch
}
const paid200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

const payer = (over = {}) =>
  MultiChainPayer.fromWallets({
    wallets: { bnb: { privateKey: '0x' + '1'.repeat(64) }, solana: { secretKey: 'x' } },
    policy: { maxAmount: '1.00', maxTotal: '5.00', tokens: ['USDC', 'USDT', 'native'] },
    ...over,
  })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  reset()
})

describe('multi-chain × asset type (USDC · USDT · native)', () => {
  it('routes across USDC, USDT, and native rails — first-listed payable chain wins', async () => {
    // USDC on BNB, USDT + native on Solana — all payable. Across coins there's no oracle,
    // so the first-listed chain (bnb) wins; its USDC rail settles.
    stub402([usdc(BNB), usdt(SOL), nativeRail(SOL, 'SOL', 9)], paid200)
    const p = payer() // wallets { bnb, solana } — bnb first
    const plan = (await p.planPayment(URL))!
    expect(plan.payable).toBe(true)
    expect(plan.options).toHaveLength(3)
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    expect(p.spent().records[0]!.network).toBe(BNB)
    expect(p.spent().records[0]!.symbol).toBe('USDC')
  })

  it('pays a NATIVE-coin rail (native is a first-class payment asset)', async () => {
    stub402([nativeRail(BNB, 'BNB', 18, '0.001')], paid200)
    const p = payer()
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    const rec = p.spent().records[0]!
    expect(rec.network).toBe(BNB)
    expect(rec.symbol).toBe('BNB')
  })

  it('pays a USDT rail', async () => {
    stub402([usdt(BNB, '0.05')], paid200)
    const p = payer()
    expect((await p.get(URL)).status).toBe(200)
    expect(p.spent().records[0]!.symbol).toBe('USDT')
  })
})

describe('spend cap is enforced in the TOKEN’s units (≈ dollars for stablecoins, native-units for coins)', () => {
  it('a stablecoin rail UNDER maxAmount is payable; OVER is blocked (OUTSIDE_POLICY)', async () => {
    stub402([usdc(BNB, '0.50')]) // maxAmount 1.00 USDC → 0.50 ok
    expect((await payer().planPayment(URL))!.payable).toBe(true)
    stub402([usdc(BNB, '2.00')]) // 2.00 > 1.00 → blocked
    const blocked = (await payer().planPayment(URL))!
    expect(blocked.payable).toBe(false)
    expect(blocked.options[0]!.blockers).toContain('OUTSIDE_POLICY')
  })

  it('maxAmount "1.00" caps a NATIVE rail at 1.0 of that coin — NOT $1 (the documented no-oracle behavior)', async () => {
    // 0.5 BNB is under the 1.00-BNB cap → payable (even though 0.5 BNB ≫ $1).
    stub402([nativeRail(BNB, 'BNB', 18, '0.5')])
    expect((await payer().planPayment(URL))!.payable).toBe(true)
    // 2.0 BNB is over the 1.00-BNB cap → blocked.
    stub402([nativeRail(BNB, 'BNB', 18, '2.0')])
    expect((await payer().planPayment(URL))!.options[0]!.blockers).toContain('OUTSIDE_POLICY')
  })

  it('the cap binds to the token’s TRUE decimals — a lying server can’t understate the price', async () => {
    // Server claims 2 decimals (so "amount" base looks tiny) but the SDK knows USDC = 6dp.
    const lying = accept(BNB, 'USDC', '5.00', 6, 'USDC')
    lying.extra = { ...lying.extra, decimals: 2 } // server lies about decimals
    stub402([lying]) // true value 5.00 USDC > 1.00 cap → still blocked
    const plan = (await payer().planPayment(URL))!
    expect(plan.options[0]!.blockers).toContain('OUTSIDE_POLICY')
  })
})

describe('maxTotal is per-(network, asset) — no cross-token, no cross-chain sum', () => {
  it('lifetime cap accrues per chain+token; the same token on another chain is a separate bucket', async () => {
    const p = payer({ policy: { maxAmount: '1.00', maxTotal: '1.00', tokens: ['USDC'] } })
    // First 0.6 USDC on BNB → ok.
    stub402([usdc(BNB, '0.60')], paid200)
    expect((await p.get(URL)).status).toBe(200)
    // Second 0.6 USDC on BNB → 0.6+0.6 > 1.00 lifetime cap for (BNB,USDC) → blocked.
    stub402([usdc(BNB, '0.60')])
    expect((await p.planPayment(URL))!.options[0]!.blockers).toContain('OUTSIDE_POLICY')
    // But 0.6 USDC on SOLANA is a DIFFERENT bucket → still payable.
    stub402([usdc(SOL, '0.60')])
    expect((await p.planPayment(URL))!.payable).toBe(true)
  })
})

describe('tokens allowlist gates which assets the bundle will pay', () => {
  it('a rail in a token NOT on the allowlist is OUTSIDE_POLICY', async () => {
    const p = payer({ policy: { maxAmount: '1.00', maxTotal: '5.00', tokens: ['USDC'] } }) // USDT/native NOT allowed
    stub402([usdt(BNB, '0.05'), nativeRail(SOL, 'SOL', 9, '0.001')])
    const plan = (await p.planPayment(URL))!
    expect(plan.payable).toBe(false)
    for (const o of plan.options) expect(o.blockers).toContain('OUTSIDE_POLICY')
  })

  it('adding "native" to the allowlist lets a native rail through', async () => {
    const p = payer({ policy: { maxAmount: '1.00', maxTotal: '5.00', tokens: ['native'] } })
    stub402([nativeRail(SOL, 'SOL', 9, '0.001')], paid200)
    expect((await p.get(URL)).status).toBe(200)
  })
})

describe('insufficient funds vs gas, across asset types', () => {
  it('holds the stablecoin but no native gas → INSUFFICIENT_GAS (not INSUFFICIENT_TOKEN)', async () => {
    bnbN = mkNet('evm', BNB, 'BNB', 18, '100', (a) => (a === 'native' ? { token: 0n, native: 0n } : { token: 10n ** 12n, native: 0n }))
    stub402([usdc(BNB, '0.05')])
    const o = (await payer().planPayment(URL))!.options[0]!
    expect(o.blockers).toContain('INSUFFICIENT_GAS')
    expect(o.blockers).not.toContain('INSUFFICIENT_TOKEN')
  })

  it('merged multi-chain decline names DISTINCT reasons: token short on one chain, gas short on the other', async () => {
    // BNB: no USDC (needs the token). Solana: has USDC but no SOL (needs gas). A clear
    // message must tell the agent BOTH — top up USDC on bnb AND add SOL gas on solana.
    bnbN = mkNet('evm', BNB, 'BNB', 18, '100', (a) => (a === 'native' ? { token: 10n ** 30n, native: 10n ** 30n } : { token: 0n, native: 10n ** 30n }))
    solN = mkNet('solana', SOL, 'SOL', 9, '50', (a) => (a === 'native' ? { token: 0n, native: 0n } : { token: 10n ** 12n, native: 0n }))
    stub402([usdc(BNB, '0.05'), usdc(SOL, '0.05')])
    const plan = (await payer().planPayment(URL))!
    expect(plan.payable).toBe(false)
    const hint = plan.fundingHint!
    expect(hint).toMatch(/bnb/i)
    expect(hint).toMatch(/solana/i)
    expect(hint).toMatch(/top up .*USDC/i) // bnb's token shortfall, named with the symbol
    expect(hint).toMatch(/gas/i) // solana's gas shortfall
    expect(hint).toContain('·') // both chains, joined into one clear sentence
    // And the per-rail blockers stay machine-readable for an agent that parses them.
    const byNet = Object.fromEntries(plan.options.map((o) => [o.accept.network, o.blockers]))
    expect(byNet[BNB]).toContain('INSUFFICIENT_TOKEN')
    expect(byNet[SOL]).toContain('INSUFFICIENT_GAS')
  })

  it('a read-only chain in the bundle contributes nothing but never breaks the funded one', async () => {
    // solana wallet omitted ⇒ that client is read-only; bnb still pays.
    const p = MultiChainPayer.fromWallets({
      wallets: { bnb: { privateKey: '0x' + '1'.repeat(64) } },
      policy: { tokens: ['USDC'], maxAmount: '1.00' },
    })
    stub402([usdc(BNB, '0.05'), usdc(SOL, '0.05')], paid200) // offers both, buyer only holds BNB
    const res = await p.get(URL)
    expect(res.status).toBe(200)
    expect(p.spent().records[0]!.network).toBe(BNB)
  })
})
