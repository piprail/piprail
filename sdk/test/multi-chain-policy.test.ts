import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PipRailClient,
  MultiChainPayer,
  registerDriver,
  buildChallengeHeader,
  PaymentDeclinedError,
  type ResolvedNetwork,
  type X402AcceptEntry,
  type Caip2,
} from '../src/index.js'

// Proves the *documented* per-chain / per-token spend controls on MultiChainPayer:
//   1. The array constructor (`new MultiChainPayer([clientA, clientB])`) lets each
//      PipRailClient carry its OWN policy — and a policy-blocked chain is SKIPPED by
//      routing (policy is evaluated in planPayment → OUTSIDE_POLICY → not payable).
//   2. `onBeforePay` gives per-TOKEN caps within one chain (branch on `quote.symbol`).
//   3. The crucial distinction: a per-chain *policy* refusal reroutes (it's a plan
//      signal); an `onBeforePay` *veto* is a HARD decline on the chosen chain (it runs
//      at pay time on the owning client, so the payer does NOT silently try another chain).
// Same fake-driver harness style as multi-chain-payer.test.ts.

const BASE = 'eip155:8453'
const SOL = 'solana:mainnet'
const URL = 'https://api.example.com/r'
const USDC_EVM = '0xUSDConBase'
const USDT_EVM = '0xUSDTonBase'
const USDC_SOL = 'UsdcMintSol'

const EVM_WALLET = { privateKey: '0x' + '1'.repeat(64) }
const SOL_WALLET = { secretKey: 'x' }

let sends = 0 // every fake `send()` bumps this — proves a veto did NOT broadcast

function tokenMeta(asset: string): { symbol: string; decimals: number } | null {
  if (asset === USDC_EVM || asset === USDC_SOL) return { symbol: 'USDC', decimals: 6 }
  if (asset === USDT_EVM) return { symbol: 'USDT', decimals: 6 }
  return null
}

function mkNet(
  family: ResolvedNetwork['family'],
  network: Caip2,
  nativeSymbol: string,
  nativeDecimals: number
): ResolvedNetwork {
  return {
    family,
    network,
    supports: (n) => n === network,
    resolveToken: (sel) => {
      if (sel === 'USDC') return { asset: family === 'solana' ? USDC_SOL : USDC_EVM, decimals: 6, symbol: 'USDC' }
      if (sel === 'USDT') return { asset: USDT_EVM, decimals: 6, symbol: 'USDT' }
      return { asset: 'native', decimals: nativeDecimals, symbol: nativeSymbol }
    },
    describeAsset: (a) =>
      tokenMeta(a) ?? (a === 'native' ? { symbol: nativeSymbol, decimals: nativeDecimals } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => {
      sends++
      return `ref-${network}`
    },
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({
      feeSymbol: nativeSymbol,
      feeDecimals: nativeDecimals,
      fee: '1000',
      feeFormatted: '0.0001',
      basis: 'estimated',
    }),
    // Big balances so affordability is never the blocker — policy / onBeforePay are.
    balanceOf: async () => ({ token: 10n ** 12n, native: 10n ** 18n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({
      ok: true,
      receipt: {
        scheme: 'onchain-proof',
        success: true,
        network,
        transaction: `ref-${network}`,
        asset: 'x',
        amount: '500000',
        payer: 'P',
        payTo: 'M',
        verifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }
}

const baseN = mkNet('evm', BASE, 'ETH', 18)
const solN = mkNet('solana', SOL, 'SOL', 9)
registerDriver({ family: 'evm', resolve: () => baseN })
registerDriver({ family: 'solana', resolve: () => solN })

function accept(network: Caip2, asset: string, symbol: string, decimals: number, amount: string): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network,
    amount,
    asset,
    payTo: 'M',
    maxTimeoutSeconds: 600,
    extra: {
      nonce: 'n',
      decimals,
      minConfirmations: 1,
      amountFormatted: (Number(amount) / 10 ** decimals).toString(),
      symbol,
    },
  }
}

const paid200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

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

const realFetch = globalThis.fetch
beforeEach(() => {
  sends = 0
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('MultiChainPayer array constructor — a DIFFERENT policy per chain', () => {
  it('each PipRailClient enforces its OWN policy, and routing SKIPS a policy-blocked chain', async () => {
    // base offers USDC and is listed first, but its policy caps maxAmount at 0.10 — the
    // 0.50 payment is OUTSIDE_POLICY there. solana's policy allows up to 1.00. The payer
    // must therefore fall through and settle on solana.
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '500000'), accept(SOL, USDC_SOL, 'USDC', 6, '500000')], paid200)
    const payer = new MultiChainPayer([
      new PipRailClient({ chain: 'base', wallet: EVM_WALLET, policy: { maxAmount: '0.10', tokens: ['USDC'] } }),
      new PipRailClient({ chain: 'solana', wallet: SOL_WALLET, policy: { maxAmount: '1.00', tokens: ['USDC'] } }),
    ])

    const plan = (await payer.planPayment(URL))!
    // base's rail is present but BLOCKED by its own policy; solana is the best payable rail.
    const baseOpt = plan.options.find((o) => o.accept.network === BASE)!
    expect(baseOpt.state).toBe('blocked')
    expect(baseOpt.blockers).toContain('OUTSIDE_POLICY')
    expect(plan.best!.accept.network).toBe(SOL)

    const res = await payer.get(URL)
    expect(res.status).toBe(200)
    expect(payer.spent().records[0]!.network).toBe(SOL) // base's stricter policy refused → solana paid
    expect(sends).toBe(1)
  })

  it('reordering preference (strict chain second) lets the first chain pay under its own cap', async () => {
    // Same two policies, but now solana (cap 1.00) is listed FIRST → it pays; base never
    // gets a turn. Proves order = preference AND each client keeps its own policy.
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '500000'), accept(SOL, USDC_SOL, 'USDC', 6, '500000')], paid200)
    const payer = new MultiChainPayer([
      new PipRailClient({ chain: 'solana', wallet: SOL_WALLET, policy: { maxAmount: '1.00', tokens: ['USDC'] } }),
      new PipRailClient({ chain: 'base', wallet: EVM_WALLET, policy: { maxAmount: '0.10', tokens: ['USDC'] } }),
    ])
    await payer.get(URL)
    expect(payer.spent().records[0]!.network).toBe(SOL)
  })

  it('when EVERY chain’s policy refuses, the whole payment is declined (before any send)', async () => {
    // Both caps below the 0.50 payment → no payable chain → PaymentDeclinedError, no broadcast.
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '500000'), accept(SOL, USDC_SOL, 'USDC', 6, '500000')], paid200)
    const payer = new MultiChainPayer([
      new PipRailClient({ chain: 'base', wallet: EVM_WALLET, policy: { maxAmount: '0.10', tokens: ['USDC'] } }),
      new PipRailClient({ chain: 'solana', wallet: SOL_WALLET, policy: { maxAmount: '0.10', tokens: ['USDC'] } }),
    ])
    const plan = (await payer.planPayment(URL))!
    expect(plan.payable).toBe(false)
    const err = await payer.get(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(sends).toBe(0)
  })
})

describe('onBeforePay — a DIFFERENT cap per token on one chain', () => {
  // The documented per-token pattern: coarse gate in `policy` (which tokens at all),
  // fine gate in `onBeforePay` (a different per-payment ceiling keyed by quote.symbol).
  const CAP: Record<string, number> = { USDC: 0.25, USDT: 1, ETH: 0.001 }
  const mkClient = () =>
    new PipRailClient({
      chain: 'base',
      wallet: EVM_WALLET,
      policy: { tokens: ['USDC', 'USDT'], maxAmount: '5.00' }, // coarse gate passes
      onBeforePay: (q) => {
        const cap = CAP[q.symbol ?? '']
        return cap != null && Number(q.amountFormatted) <= cap
      },
    })

  it('vetoes a USDC payment OVER its 0.25 cap — no send, reasonCode APPROVAL', async () => {
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '500000')], paid200) // 0.50 USDC
    const err = await mkClient().get(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(err.reasonCode).toBe('APPROVAL')
    expect(sends).toBe(0)
  })

  it('allows a USDC payment UNDER its 0.25 cap', async () => {
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '100000')], paid200) // 0.10 USDC
    expect((await mkClient().get(URL)).status).toBe(200)
    expect(sends).toBe(1)
  })

  it('SAME 0.50 amount, different token → different outcome (the cap really is per-token)', async () => {
    // 0.50 USDT is allowed (USDT cap 1.00) even though 0.50 USDC was vetoed (USDC cap 0.25).
    stub402([accept(BASE, USDT_EVM, 'USDT', 6, '500000')], paid200) // 0.50 USDT
    expect((await mkClient().get(URL)).status).toBe(200)
    expect(sends).toBe(1)
  })
})

describe('policy vs onBeforePay — the routing distinction', () => {
  it('an onBeforePay veto on the chosen chain is a HARD decline — it does NOT reroute to another chain', async () => {
    // Both chains are policy-payable, base listed first → base is chosen as `best`. base's
    // onBeforePay then vetoes at pay time. Unlike a policy block (a plan signal that reroutes),
    // the hook runs on the owning client AFTER best is picked, so the payment is declined
    // outright — solana is NOT silently used as a fallback.
    stub402([accept(BASE, USDC_EVM, 'USDC', 6, '500000'), accept(SOL, USDC_SOL, 'USDC', 6, '500000')], paid200)
    const payer = new MultiChainPayer([
      new PipRailClient({ chain: 'base', wallet: EVM_WALLET, policy: { tokens: ['USDC'] }, onBeforePay: () => false }),
      new PipRailClient({ chain: 'solana', wallet: SOL_WALLET, policy: { tokens: ['USDC'] } }),
    ])
    // The plan (policy-only, no hook) still ranks base as best — proving the veto is NOT a plan signal.
    expect((await payer.planPayment(URL))!.best!.accept.network).toBe(BASE)
    const err = await payer.get(URL).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentDeclinedError)
    expect(err.reasonCode).toBe('APPROVAL')
    expect(sends).toBe(0) // neither chain paid
  })
})
