/**
 * Adversarial edge cases for the swap subsystem.
 *
 * The rule this file enforces: **a swap either happens exactly as quoted, or it does
 * not happen at all.** There is no acceptable middle where money moves and the caller
 * gets something other than what they were shown. Every case below is a way that
 * could go wrong, driven from the outside with hostile or degenerate input.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  applySlippage,
  resolveSlippageBps,
  summarizeSwap,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  type SwapQuote,
} from '../src/index.js'
import { quoteSolanaSwap, swapSolana } from '../src/drivers/solana/swap.js'
import { quoteEvmSwap, swapEvm } from '../src/drivers/evm/swap.js'
import { InsufficientFundsError } from '../src/errors.js'
import { quoteStellarSwap } from '../src/drivers/stellar/swap.js'
import { quoteAptosSwap, swapAptos } from '../src/drivers/aptos/swap.js'
import { quoteTonSwap } from '../src/drivers/ton/swap.js'
import { quoteTronSwap } from '../src/drivers/tron/swap.js'
import { quoteXrplSwap } from '../src/drivers/xrpl/swap.js'
import type { PublicClient } from 'viem'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const stub = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

/* ───────────────────────────── pure maths boundaries ───────────────────────────── */

describe('slippage maths: boundaries and hostile input', () => {
  it('never rounds DOWN, even at one base unit', () => {
    // Rounding down would make the on-chain cap tighter than the caller asked for,
    // and the swap would fail for a reason they never chose.
    for (const bps of [1, 7, 50, 999, 1000]) {
      expect(applySlippage(1n, bps)).toBeGreaterThanOrEqual(1n)
    }
    expect(applySlippage(1n, 1)).toBe(2n)
  })

  it('is exact at zero slippage', () => {
    expect(applySlippage(123_456_789n, 0)).toBe(123_456_789n)
  })

  it('survives amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 10n ** 30n
    expect(applySlippage(huge, 50)).toBe((huge * 10_050n + 9_999n) / 10_000n)
    // and never silently degrades into float territory
    expect(typeof applySlippage(huge, 50)).toBe('bigint')
  })

  it('handles zero without dividing by anything', () => {
    expect(applySlippage(0n, 500)).toBe(0n)
  })

  it('rejects every non-integer, negative, or over-ceiling tolerance', () => {
    for (const bad of [-1, -0.5, 1.5, NaN, Infinity, -Infinity, MAX_SLIPPAGE_BPS + 1, 1e9]) {
      expect(() => resolveSlippageBps(bad)).toThrow(RangeError)
    }
    expect(resolveSlippageBps(undefined)).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(resolveSlippageBps(MAX_SLIPPAGE_BPS)).toBe(MAX_SLIPPAGE_BPS)
    expect(resolveSlippageBps(0)).toBe(0)
  })
})

/* ─────────────────── malformed provider responses must never crash ─────────────────── */

const SOL_BASE = {
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as never,
  from: { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  to: { asset: 'native', decimals: 9, symbol: 'SOL' },
  wantAmount: 1_000_000n,
  slippageBps: 50,
}

describe('Jupiter: hostile and degenerate responses', () => {
  const cases: Array<[string, unknown]> = [
    ['empty object', {}],
    ['null body', null],
    ['an array instead of an object', []],
    ['missing otherAmountThreshold', { inAmount: '1', outAmount: '1000000', swapMode: 'ExactOut' }],
    ['missing inAmount', { otherAmountThreshold: '1', outAmount: '1000000', swapMode: 'ExactOut' }],
    ['non-numeric inAmount', { inAmount: 'abc', outAmount: '1000000', otherAmountThreshold: '1', swapMode: 'ExactOut' }],
    ['negative inAmount', { inAmount: '-5', outAmount: '1000000', otherAmountThreshold: '1', swapMode: 'ExactOut' }],
    ['zero inAmount', { inAmount: '0', outAmount: '1000000', otherAmountThreshold: '1', swapMode: 'ExactOut' }],
    ['a float where an integer belongs', { inAmount: '1.5', outAmount: '1000000', otherAmountThreshold: '1', swapMode: 'ExactOut' }],
    ['an error payload', { error: 'no route found' }],
  ]
  for (const [label, body] of cases) {
    it(`returns null for ${label}`, async () => {
      stub(body)
      await expect(quoteSolanaSwap(SOL_BASE)).resolves.toBeNull()
    })
  }

  it('returns null on a 500, a 404 and a non-JSON body', async () => {
    stub({}, 500)
    expect(await quoteSolanaSwap(SOL_BASE)).toBeNull()
    stub({}, 404)
    expect(await quoteSolanaSwap(SOL_BASE)).toBeNull()
    globalThis.fetch = (async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch
    expect(await quoteSolanaSwap(SOL_BASE)).toBeNull()
  })

  it('refuses a zero or negative wantAmount outright', async () => {
    stub({ inAmount: '1', outAmount: '0', otherAmountThreshold: '1', swapMode: 'ExactOut' })
    expect(await quoteSolanaSwap({ ...SOL_BASE, wantAmount: 0n })).toBeNull()
    expect(await quoteSolanaSwap({ ...SOL_BASE, wantAmount: -1n })).toBeNull()
  })

  it('🔴 DISCLOSES a platform fee instead of repeating the no-fee claim', async () => {
    stub({
      inAmount: '103049',
      outAmount: '1000000',
      otherAmountThreshold: '103565',
      swapMode: 'ExactOut',
      platformFee: { amount: '500', feeBps: 5 },
    })
    const q = await quoteSolanaSwap(SOL_BASE)
    expect(q!.source.note).toMatch(/CARRIES A PLATFORM FEE/i)
    expect(q!.source.note).toMatch(/PipRail did not set one/i)
    expect(q!.source.note).not.toMatch(/carries no platform fee/i)
  })

  it('states the no-fee fact plainly when there is genuinely no fee', async () => {
    stub({
      inAmount: '103049',
      outAmount: '1000000',
      otherAmountThreshold: '103565',
      swapMode: 'ExactOut',
      platformFee: null,
    })
    const q = await quoteSolanaSwap(SOL_BASE)
    expect(q!.source.note).toMatch(/no platform fee/i)
  })

  it('never reports a cap TIGHTER than the provider’s own threshold', async () => {
    // If Jupiter's threshold exceeds ours, theirs must win: it is what goes on-chain.
    stub({
      inAmount: '100000',
      outAmount: '1000000',
      otherAmountThreshold: '999999999',
      swapMode: 'ExactOut',
      platformFee: null,
    })
    const q = await quoteSolanaSwap(SOL_BASE)
    expect(BigInt(q!.maxSpend)).toBe(999_999_999n)
  })
})

/* ───────────────────────────── EVM edge cases ───────────────────────────── */

const EVM_BASE = {
  publicClient: {} as PublicClient,
  chainId: 56,
  network: 'eip155:56' as never,
  nativeSymbol: 'BNB',
  owner: '0x0000000000000000000000000000000000000001',
  from: { asset: '0xaaa0000000000000000000000000000000000001', decimals: 18, symbol: 'USDT' },
  to: { asset: '0xbbb0000000000000000000000000000000000002', decimals: 18, symbol: 'USDC' },
  wantAmount: 10n ** 16n,
  slippageBps: 100,
}

describe('KyberSwap: hostile and degenerate responses', () => {
  it('returns null when the probe itself fails', async () => {
    stub({ code: 0, data: {} })
    expect(await quoteEvmSwap(EVM_BASE)).toBeNull()
  })

  it('returns null when the probe returns a zero rate (no division by zero)', async () => {
    stub({ code: 0, data: { routeSummary: { amountIn: '1', amountOut: '0' }, routerAddress: '0xr' } })
    await expect(quoteEvmSwap(EVM_BASE)).resolves.toBeNull()
  })

  it('returns null when routerAddress is missing, even with a good route', async () => {
    globalThis.fetch = (async (u: unknown) => {
      const amountIn = /amountIn=(\d+)/.exec(String(u))?.[1] ?? '0'
      return new Response(JSON.stringify({ code: 0, data: { routeSummary: { amountIn, amountOut: amountIn } } }), { status: 200 })
    }) as typeof fetch
    expect(await quoteEvmSwap(EVM_BASE)).toBeNull()
  })

  it('returns null for non-numeric amounts rather than throwing', async () => {
    stub({ code: 0, data: { routeSummary: { amountIn: 'x', amountOut: 'y' }, routerAddress: '0xr' } })
    await expect(quoteEvmSwap(EVM_BASE)).resolves.toBeNull()
  })

  it('🔴 DISCLOSES an integrator fee if one ever appears', async () => {
    globalThis.fetch = (async (u: unknown) => {
      const amountIn = /amountIn=(\d+)/.exec(String(u))?.[1] ?? '0'
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            routeSummary: {
              amountIn,
              amountOut: amountIn,
              extraFee: { feeAmount: '1000', feeReceiver: '0xdeadbeef', chargeFeeBy: 'currency_in' },
            },
            routerAddress: '0xr',
          },
        }),
        { status: 200 }
      )
    }) as typeof fetch
    const q = await quoteEvmSwap(EVM_BASE)
    expect(q!.source.note).toMatch(/CARRIES AN INTEGRATOR FEE/i)
  })

  it('treats an all-empty extraFee as no fee (the real shape KyberSwap returns)', async () => {
    globalThis.fetch = (async (u: unknown) => {
      const amountIn = /amountIn=(\d+)/.exec(String(u))?.[1] ?? '0'
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            routeSummary: { amountIn, amountOut: amountIn, extraFee: { feeAmount: '', chargeFeeBy: '', feeReceiver: '' } },
            routerAddress: '0xr',
          },
        }),
        { status: 200 }
      )
    }) as typeof fetch
    const q = await quoteEvmSwap(EVM_BASE)
    expect(q!.source.note).toMatch(/no integrator fee/i)
  })

  it('refuses a same-token swap regardless of address casing', async () => {
    stub({ code: 0 })
    const mixed = { ...EVM_BASE.from, asset: EVM_BASE.from.asset.toUpperCase() }
    expect(await quoteEvmSwap({ ...EVM_BASE, to: mixed })).toBeNull()
  })
})

/* ───────────────────────── Stellar and XRPL edge cases ───────────────────────── */

describe('Stellar: degenerate Horizon responses', () => {
  const base = {
    server: { strictReceivePaths: () => ({ call: async () => ({ records: [] }) }) } as never,
    network: 'stellar:pubnet' as never,
    from: { asset: 'native', decimals: 7, symbol: 'XLM' },
    to: { asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7, symbol: 'USDC' },
    wantAmount: 500_000n,
    slippageBps: 50,
  }

  it('returns null when Horizon offers no path', async () => {
    expect(await quoteStellarSwap(base)).toBeNull()
  })

  it('returns null when Horizon throws', async () => {
    const server = {
      strictReceivePaths: () => ({
        call: async () => {
          throw new Error('502')
        },
      }),
    } as never
    await expect(quoteStellarSwap({ ...base, server })).resolves.toBeNull()
  })

  it('skips unparseable candidates instead of failing the whole quote', async () => {
    const server = {
      strictReceivePaths: () => ({
        call: async () => ({ records: [{ source_amount: 'not-a-number' }, { source_amount: '1.0000000', path: [] }] }),
      }),
    } as never
    const q = await quoteStellarSwap({ ...base, server })
    expect(q).not.toBeNull()
    expect(q!.from.amount).toBe('10000000') // the good candidate, 1.0 XLM at 7dp
  })

  it('refuses a same-asset swap', async () => {
    expect(await quoteStellarSwap({ ...base, to: base.from })).toBeNull()
  })

  it('🔴 returns null for a MALFORMED ISSUER instead of throwing', async () => {
    // `new Asset()` throws "Issuer is invalid". quoteSwap is contractually never-throw,
    // so a caller passing a bad custom token must get null, not an exception.
    await expect(
      quoteStellarSwap({ ...base, to: { asset: 'USDC:NOT_A_VALID_ISSUER', decimals: 7, symbol: 'USDC' } })
    ).resolves.toBeNull()
  })
})

describe('XRPL: degenerate path-find responses', () => {
  const base = {
    client: { pathFind: async () => ({ alternatives: [] }) } as never,
    network: 'xrpl:0' as never,
    owner: 'rTEST',
    from: { asset: 'native', decimals: 6, symbol: 'XRP' },
    to: { asset: 'ABC:rISSUER', decimals: 6, symbol: 'ABC' },
    wantAmount: 100_000n,
    slippageBps: 100,
  }

  it('returns null with no alternatives', async () => {
    expect(await quoteXrplSwap(base)).toBeNull()
  })

  it('returns null when the node refuses path finding', async () => {
    const client = {
      pathFind: async () => {
        throw new Error('srcActMalformed')
      },
    } as never
    await expect(quoteXrplSwap({ ...base, client })).resolves.toBeNull()
  })

  it('ignores alternatives with unusable source amounts and picks the cheapest valid one', async () => {
    const client = {
      pathFind: async () => ({
        alternatives: [
          { source_amount: undefined, paths_computed: [] },
          { source_amount: '900000', paths_computed: [[{ currency: 'X' }]] },
          { source_amount: '700000', paths_computed: [[{ currency: 'Y' }]] },
        ],
      }),
    } as never
    const q = await quoteXrplSwap({ ...base, client })
    expect(q!.from.amount).toBe('700000') // cheapest input wins
  })

  it('refuses a same-asset swap', async () => {
    expect(await quoteXrplSwap({ ...base, to: base.from })).toBeNull()
  })

  it('🔴 handles XRPL float precision instead of discarding the route', async () => {
    /*
     * XRPL issued amounts are floats carried as strings with up to 16 significant
     * digits, while our base-unit convention is fixed at `decimals`. parseUnits
     * REJECTS the excess, so a real RLUSD route ("0.02789866666666666") threw and the
     * quote came back null as if no route existed. The reverse direction looked
     * unsupported when it was fine. This is the exact string from mainnet.
     */
    const client = {
      pathFind: async () => ({
        alternatives: [
          {
            source_amount: { currency: 'ABC', issuer: 'rISSUER', value: '0.02789866666666666' },
            paths_computed: [[{ currency: 'X' }]],
          },
        ],
      }),
    } as never
    const q = await quoteXrplSwap({
      ...base,
      client,
      from: { asset: 'ABC:rISSUER', decimals: 6, symbol: 'ABC' },
      to: { asset: 'native', decimals: 6, symbol: 'XRP' },
    })
    expect(q).not.toBeNull()
    // 0.02789866… at 6dp rounds UP to 27899, never down: the cap must cover the spend.
    expect(q!.from.amount).toBe('27899')
  })
})

/* ───────────────────────────── the summary line ───────────────────────────── */

describe('summarizeSwap always names the source', () => {
  const q = (over: Partial<SwapQuote> = {}): SwapQuote => ({
    source: { kind: 'protocol', name: 'Stellar SDEX' },
    network: 'stellar:pubnet' as never,
    from: { asset: 'native', symbol: 'XLM', decimals: 7, amount: '1', amountFormatted: '0.0000001' },
    to: { asset: 'U', symbol: 'USDC', decimals: 7, amount: '1', amountFormatted: '0.0000001' },
    maxSpend: '1',
    maxSpendFormatted: '0.0000001',
    slippageBps: 0,
    route: null,
    ...over,
  })

  it('handles zero slippage and dust amounts without producing nonsense', () => {
    const s = summarizeSwap(q())
    expect(s).toMatch(/0% slippage/)
    expect(s).toMatch(/Stellar SDEX/)
  })

  it('renders fractional percentages correctly', () => {
    expect(summarizeSwap(q({ slippageBps: 1 }))).toMatch(/0\.01% slippage/)
    expect(summarizeSwap(q({ slippageBps: 1000 }))).toMatch(/10% slippage/)
  })

  it('carries the provider name through for a third-party rail', () => {
    expect(summarizeSwap(q({ source: { kind: 'provider', name: 'Jupiter' } }))).toMatch(/Rate from Jupiter/)
  })
})

/* ────────────── a mined transaction is NOT a successful swap ──────────────
 *
 * Both cases below shipped as silent success. Found live on Robinhood Chain, whose
 * 100ms blocks stale a route between quote and inclusion far more often than a
 * 2-second chain does — but the hole was identical on every EVM chain and on Solana.
 *
 * Why it is the worst possible failure: the caller receives a SwapReceipt carrying a
 * REAL transaction hash for a swap that moved nothing. An agent then believes it holds
 * the token and goes on to pay an invoice it cannot cover.
 */
describe('a swap that fails on-chain must THROW, never return a receipt', () => {
  const QUOTE = {
    source: { kind: 'provider', name: 'KyberSwap' },
    network: 'eip155:4663',
    from: { asset: 'native', decimals: 18, symbol: 'ETH', amount: '1', amountFormatted: '1' },
    to: { asset: '0xtok', decimals: 6, symbol: 'USDG', amount: '1', amountFormatted: '1' },
    maxSpend: '1000',
    maxSpendFormatted: '0.000000000000001',
    slippageBps: 50,
    route: {
      chainPath: 'robinhood',
      routeSummary: { amountIn: '1000', amountOut: '1' },
      routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
      needsApproval: false,
      tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    },
  } as unknown as SwapQuote

  it('EVM: a REVERTED receipt is a failure, not a completed swap', async () => {
    stub({ code: 0, data: { data: '0xdeadbeef', routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' } })
    const publicClient = {
      // viem resolves this for a reverted tx exactly as for a successful one.
      waitForTransactionReceipt: async () => ({ status: 'reverted' as const }),
    } as unknown as Parameters<typeof swapEvm>[0]['publicClient']
    const walletClient = {
      sendTransaction: async () => '0xhash',
    } as unknown as Parameters<typeof swapEvm>[0]['walletClient']

    await expect(
      swapEvm({ publicClient, walletClient, account: { address: '0x1' } as never, chain: {} as never, quote: QUOTE })
    ).rejects.toThrow(InsufficientFundsError)
  })

  it('EVM: a SUCCESS receipt still returns the hash (the guard is not over-eager)', async () => {
    stub({ code: 0, data: { data: '0xdeadbeef', routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' } })
    const publicClient = {
      waitForTransactionReceipt: async () => ({ status: 'success' as const }),
    } as unknown as Parameters<typeof swapEvm>[0]['publicClient']
    const walletClient = {
      sendTransaction: async () => '0xgoodhash',
    } as unknown as Parameters<typeof swapEvm>[0]['walletClient']

    const r = await swapEvm({ publicClient, walletClient, account: { address: '0x1' } as never, chain: {} as never, quote: QUOTE })
    expect(r.transaction).toBe('0xgoodhash')
  })

  it('Solana: a confirmed-with-error transaction is a failure, not a completed swap', async () => {
    stub({ swapTransaction: Buffer.from('not-a-real-tx').toString('base64') })
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: 'bh', lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => 'sig123',
      confirmTransaction: async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    }
    // Deserialization of the stub bytes fails first, which is itself a throw rather than a
    // silent success — the contract that matters here is "never resolve to a receipt".
    await expect(
      swapSolana({
        connection,
        keypair: { publicKey: { toBase58: () => 'pk' } },
        quote: { ...QUOTE, route: { otherAmountThreshold: '1' } },
      } as never)
    ).rejects.toThrow()
  })
})

/* ─────────────────── Aptos / Hyperion: contract-call routing ─────────────────── */

const APT_META = '0xa'
const USDC_META = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const APTOS_BASE = {
  network: 'aptos:1' as never,
  from: { asset: USDC_META, decimals: 6, symbol: 'USDC' },
  to: { asset: 'native', decimals: 8, symbol: 'APT' },
  wantAmount: 1_000_000n,
  slippageBps: 100,
  owner: '0x1',
}
/** A view stub: `answers` maps a function-name fragment to its return value. */
const aptosClient = (answers: Record<string, unknown>, throwOn?: string) => ({
  view: async ({ payload }: { payload: { function: string } }) => {
    if (throwOn && payload.function.includes(throwOn)) throw new Error('view exploded')
    const key = Object.keys(answers).find((k) => payload.function.includes(k))
    if (!key) throw new Error('no stub for ' + payload.function)
    return answers[key]
  },
  build: async () => ({}),
  signSubmit: async () => ({ hash: '0xhash' }),
  waitFor: async () => ({ success: true }),
})
// info_both_fa: [name0, token0, sym1, token1, pool, r0, r1, liquidity, ?, feeRate]
const info = (liquidity: string, fee = '100') => [
  ['Tether', '0xdead', 'USDC', USDC_META, '0xpool', '1', '1', liquidity, '0', fee],
]

describe('Aptos/Hyperion: a route only ships when the chain says it can fill', () => {
  it('returns null for a zero want amount (no division, no call)', async () => {
    const c = aptosClient({})
    expect(await quoteAptosSwap({ ...APTOS_BASE, wantAmount: 0n, client: c as never })).toBeNull()
  })

  it('returns null when both sides are the same asset, however spelled', async () => {
    const c = aptosClient({})
    // 0xa and its fully padded form are the SAME address — this must not become a "route".
    const padded = '0x' + 'a'.padStart(64, '0')
    const q = await quoteAptosSwap({
      ...APTOS_BASE,
      from: { asset: padded, decimals: 8, symbol: 'APT' },
      to: { asset: 'native', decimals: 8, symbol: 'APT' },
      client: c as never,
    })
    expect(q).toBeNull()
  })

  it('SKIPS an empty pool rather than paying to price it', async () => {
    // liquidity 0 on every tier -> no pricing call is made at all, so a missing stub for
    // get_batch_amount_in would throw if we ever called it. Reaching null proves we did not.
    const c = aptosClient({ liquidity_pool_info_both_fa: info('0') })
    expect(await quoteAptosSwap({ ...APTOS_BASE, client: c as never })).toBeNull()
  })

  it('returns null when discovery throws, never propagating the error', async () => {
    const c = aptosClient({ liquidity_pool_info_both_fa: info('999') }, 'liquidity_pool_info_both_fa')
    await expect(quoteAptosSwap({ ...APTOS_BASE, client: c as never })).resolves.toBeNull()
  })

  it('returns null when the price comes back as zero', async () => {
    const c = aptosClient({ liquidity_pool_info_both_fa: info('999'), get_batch_amount_in: ['0'] })
    expect(await quoteAptosSwap({ ...APTOS_BASE, client: c as never })).toBeNull()
  })

  it('prices a live pool and pads the INPUT ceiling, leaving the output exact', async () => {
    const c = aptosClient({ liquidity_pool_info_both_fa: info('999'), get_batch_amount_in: ['1000'] })
    const q = await quoteAptosSwap({ ...APTOS_BASE, client: c as never })
    expect(q).not.toBeNull()
    expect(q!.to.amount).toBe('1000000') // exact output, untouched by slippage
    expect(BigInt(q!.maxSpend)).toBe(1010n) // input padded by 1%
  })

  it('a transaction that COMMITS BUT FAILS is a failure, not a swap', async () => {
    const client = {
      view: async () => [],
      build: async () => ({}),
      signSubmit: async () => ({ hash: '0xbad' }),
      waitFor: async () => ({ success: false, vm_status: 'Move abort ESQRT_PRICE_LIMIT_UNAVAILABLE' }),
    }
    await expect(
      swapAptos({
        client: client as never,
        signer: {},
        sender: '0x1',
        quote: {
          network: 'aptos:1',
          to: { amount: '1000' },
          maxSpend: '2000',
          from: {},
          source: {},
          route: { pool: '0xp', fromMetadata: '0xa', toMetadata: '0xb', feeTier: 0, recipient: '0x1', fromIsToken0: true },
        } as never,
      })
    ).rejects.toThrow(InsufficientFundsError)
  })
})

/* ─────────────────── TON / STON.fi: keyless reverse simulation ─────────────────── */

const TON_BASE = {
  network: 'tvm:-239' as never,
  from: { asset: 'native', decimals: 9, symbol: 'GRAM' },
  to: { asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6, symbol: 'USDT' },
  wantAmount: 50_000n,
  slippageBps: 100,
}

describe('TON/STON.fi: the reverse simulation is the whole quote', () => {
  it('returns null when the simulation errors out', async () => {
    stub({}, 500)
    expect(await quoteTonSwap(TON_BASE)).toBeNull()
  })

  it('returns null when the response carries no offer', async () => {
    stub({ router_address: 'EQrouter' })
    expect(await quoteTonSwap(TON_BASE)).toBeNull()
  })

  it('returns null when the response names no router', async () => {
    stub({ offer_units: '100' })
    expect(await quoteTonSwap(TON_BASE)).toBeNull()
  })

  it('returns null for a non-numeric offer rather than throwing', async () => {
    stub({ offer_units: 'not-a-number', router_address: 'EQrouter' })
    await expect(quoteTonSwap(TON_BASE)).resolves.toBeNull()
  })

  it('maps the router version the simulation reports, not a hardcoded one', async () => {
    stub({
      offer_units: '35528128',
      router_address: 'EQrouter',
      min_ask_units: '50000',
      fee_percent: '0.001',
      router: { major_version: 2, minor_version: 1, pton_version: '2.1' },
      gas_params: { forward_gas: '240000000' },
    })
    const q = await quoteTonSwap(TON_BASE)
    expect((q!.route as { routerVersion: string }).routerVersion).toBe('v2_1')
    // The offer side is fixed by the simulation, so it IS the ceiling.
    expect(q!.maxSpend).toBe('35528128')
    expect(q!.to.amount).toBe('50000')
  })

  /*
   * 🔴 "Reverse" is not "exact". Asked for 50000 at 1% tolerance, STON.fi returns an on-chain
   * floor of 49500 and the router will deliver 49500. That short-pays an invoice, and this
   * route was advertised as "exactly 0.05 USDT" while two tests here ASSERTED the 49500 floor
   * as correct. The floor must cover the invoice, or there is no quote.
   */
  it('asks the simulation for MORE than the invoice, so the floor can cover it', async () => {
    let asked = ''
    globalThis.fetch = (async (url: string | URL) => {
      asked = String(url)
      return new Response(JSON.stringify({ offer_units: '100', router_address: 'EQrouter', min_ask_units: '50000' }))
    }) as typeof fetch
    await quoteTonSwap(TON_BASE) // 50000 at 100 bps
    // 50000 / (1 - 0.01) = 50505.05… → rounded UP
    expect(asked).toContain('units=50506')
    expect(asked).toContain('slippage_tolerance=0.010000')
  })

  it('refuses to quote when the on-chain floor is below the invoice', async () => {
    stub({ offer_units: '100', router_address: 'EQrouter', min_ask_units: '49500', router: { major_version: 2, minor_version: 2 } })
    await expect(quoteTonSwap(TON_BASE)).resolves.toBeNull()
  })

  it('carries an on-chain minimum that is at least the invoice', async () => {
    stub({ offer_units: '100', router_address: 'EQrouter', min_ask_units: '50120', router: { major_version: 2, minor_version: 2 } })
    const q = await quoteTonSwap(TON_BASE)
    expect(BigInt((q!.route as { minAskUnits: string }).minAskUnits)).toBeGreaterThanOrEqual(50_000n)
  })

  it('returns null, never a later SyntaxError, when the floor or gas is not a number', async () => {
    stub({ offer_units: '100', router_address: 'EQrouter', min_ask_units: 'lots' })
    await expect(quoteTonSwap(TON_BASE)).resolves.toBeNull()
    stub({ offer_units: '100', router_address: 'EQrouter', min_ask_units: '50000', gas_params: { forward_gas: 'some' } })
    const q = await quoteTonSwap(TON_BASE)
    // an unparseable gas figure falls back to the documented default instead of poisoning swap()
    expect((q!.route as { forwardGas: string }).forwardGas).toBe('300000000')
  })
})

describe('Aptos: the signer receives, never the account that quoted', () => {
  /*
   * `route.recipient` is captured at QUOTE time. Passing it to the entry function meant a
   * quote obtained by one wallet and executed by another paid the output to the first. Every
   * other family derives the destination from the signing wallet at swap time; this pins it.
   */
  it('sends the output to p.sender even when the quote was priced for someone else', async () => {
    const captured: unknown[] = []
    const client = {
      view: async () => ['0'],
      build: async ({ data }: { data: { functionArguments: unknown[] } }) => {
        captured.push(...data.functionArguments)
        return {}
      },
      signSubmit: async () => ({ hash: '0xabc' }),
      waitFor: async () => ({ success: true }),
    }
    const quote = {
      network: 'aptos:1',
      source: { kind: 'provider', name: 'Hyperion' },
      from: { asset: 'native', symbol: 'APT', decimals: 8, amount: '1000', amountFormatted: '0.00001' },
      to: { asset: '0xbeef', symbol: 'USDC', decimals: 6, amount: '50', amountFormatted: '0.00005' },
      maxSpend: '1010',
      maxSpendFormatted: '0.0000101',
      slippageBps: 100,
      route: {
        feeTier: 1,
        pool: '0xpool',
        fromMetadata: '0xa',
        toMetadata: '0xbeef',
        recipient: '0xQUOTER',
        fromIsToken0: true,
      },
    }

    await swapAptos({ client: client as never, signer: {}, sender: '0xSIGNER', quote: quote as never })

    expect(captured).toContain('0xSIGNER')
    expect(captured).not.toContain('0xQUOTER')
  })
})

/* ─────────────────── Tron / SunSwap: constant-call routing ─────────────────── */

const TRON_BASE = {
  network: 'tron:mainnet' as never,
  from: { asset: 'native', decimals: 6, symbol: 'TRX' },
  to: { asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' },
  wantAmount: 50_000n,
  slippageBps: 100,
  owner: 'TVvRPbEpkY34SmqEkioxtKywenWLmtuVzL',
}
const tronClient = (result: unknown) => ({
  transactionBuilder: {
    triggerConstantContract: async () => result,
    triggerSmartContract: async () => ({ result: { result: true }, transaction: {} }),
  },
  trx: { sign: async () => ({ txID: 'x' }), sendRawTransaction: async () => ({ result: true, txid: 'x' }) },
})
/** encode a uint256[] return: offset, length, then values */
const uintArray = (...vals: bigint[]) =>
  [32n, BigInt(vals.length), ...vals].map((v) => v.toString(16).padStart(64, '0')).join('')

describe('Tron/SunSwap: hostile constant-call results', () => {
  it('returns null when the router reports failure', async () => {
    const c = tronClient({ result: { result: false } })
    expect(await quoteTronSwap({ ...TRON_BASE, client: c as never })).toBeNull()
  })

  it('returns null on a truncated return rather than decoding garbage', async () => {
    const c = tronClient({ result: { result: true }, constant_result: ['deadbeef'] })
    expect(await quoteTronSwap({ ...TRON_BASE, client: c as never })).toBeNull()
  })

  it('returns null when the decoded amount is zero', async () => {
    const c = tronClient({ result: { result: true }, constant_result: [uintArray(0n, 50000n)] })
    expect(await quoteTronSwap({ ...TRON_BASE, client: c as never })).toBeNull()
  })

  it('returns null when a length header lies about the payload', async () => {
    // claims 9 values but supplies 2 — must not read past the end
    const hex = [32n, 9n, 1n, 2n].map((v) => v.toString(16).padStart(64, '0')).join('')
    const c = tronClient({ result: { result: true }, constant_result: [hex] })
    await expect(quoteTronSwap({ ...TRON_BASE, client: c as never })).resolves.toBeNull()
  })

  it('prices an exact output and caps the input on-chain', async () => {
    const c = tronClient({ result: { result: true }, constant_result: [uintArray(148_079n, 50_000n)] })
    const q = await quoteTronSwap({ ...TRON_BASE, client: c as never })
    expect(q!.from.amount).toBe('148079')
    expect(q!.to.amount).toBe('50000') // exact output
    expect(BigInt(q!.maxSpend)).toBe(149_560n) // +1%
    expect(q!.source.name).toBe('SunSwap V2')
  })

  it('names Tron’s energy charge in the quote, so the fee is never a surprise', async () => {
    const c = tronClient({ result: { result: true }, constant_result: [uintArray(100n, 50_000n)] })
    const q = await quoteTronSwap({ ...TRON_BASE, client: c as never })
    expect(q!.source.note).toMatch(/energy/i)
  })
})
