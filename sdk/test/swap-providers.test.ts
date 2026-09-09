/**
 * The provider-backed swap rails (Jupiter on Solana, KyberSwap on EVM).
 *
 * These tests exist for ONE reason above all others: **never ship a swap that lands
 * short of the invoice.** A 402 names an exact amount. A router that returns "close
 * enough" would leave the caller still unable to pay, having already spent money.
 * Every quote path below is asserted to return `null` rather than a short quote.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { quoteSolanaSwap } from '../src/drivers/solana/swap.js'
import { quoteEvmSwap } from '../src/drivers/evm/swap.js'
import type { PublicClient } from 'viem'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const USDC = { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' }
const NATIVE = { asset: 'native', decimals: 9, symbol: 'SOL' }

function stubJson(body: unknown, ok = true) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch
}

describe('Jupiter (Solana) — exact output or nothing', () => {
  const base = {
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as never,
    from: USDC,
    to: NATIVE,
    wantAmount: 1_000_000n,
    slippageBps: 50,
  }

  it('accepts a real ExactOut quote and reports Jupiter as the source', async () => {
    stubJson({
      inAmount: '103049',
      outAmount: '1000000',
      otherAmountThreshold: '103565',
      swapMode: 'ExactOut',
      slippageBps: 50,
      platformFee: null,
    })
    const q = await quoteSolanaSwap(base)
    expect(q).not.toBeNull()
    expect(q!.source.kind).toBe('provider')
    expect(q!.source.name).toBe('Jupiter')
    expect(q!.to.amount).toBe('1000000')
    // The cap must be at least Jupiter's own threshold — never tighter.
    expect(BigInt(q!.maxSpend)).toBeGreaterThanOrEqual(103565n)
  })

  it('🔴 REFUSES a quote that silently became ExactIn', async () => {
    stubJson({
      inAmount: '103049',
      outAmount: '1000000',
      otherAmountThreshold: '103565',
      swapMode: 'ExactIn',
      slippageBps: 50,
      platformFee: null,
    })
    expect(await quoteSolanaSwap(base)).toBeNull()
  })

  it('🔴 REFUSES a quote that would land SHORT of the invoice', async () => {
    stubJson({
      inAmount: '103049',
      outAmount: '999999', // one base unit short — still a failed payment
      otherAmountThreshold: '103565',
      swapMode: 'ExactOut',
      slippageBps: 50,
      platformFee: null,
    })
    expect(await quoteSolanaSwap(base)).toBeNull()
  })

  it('returns null (never throws) when Jupiter is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    await expect(quoteSolanaSwap(base)).resolves.toBeNull()
  })

  it('refuses a same-mint "swap"', async () => {
    stubJson({})
    expect(await quoteSolanaSwap({ ...base, to: USDC })).toBeNull()
  })
})

describe('KyberSwap (EVM) — unsupported chains say nothing rather than guess', () => {
  const pc = {} as PublicClient
  const TOKEN_A = { asset: '0xaaa0000000000000000000000000000000000001', decimals: 18, symbol: 'USDT' }
  const TOKEN_B = { asset: '0xbbb0000000000000000000000000000000000002', decimals: 18, symbol: 'USDC' }
  const base = {
    publicClient: pc,
    chainId: 56,
    network: 'eip155:56' as never,
    nativeSymbol: 'BNB',
    owner: '0x0000000000000000000000000000000000000001',
    from: TOKEN_A,
    to: TOKEN_B,
    wantAmount: 10_000_000_000_000_000n, // 0.01
    slippageBps: 100,
  }

  it('returns null for a chain KyberSwap does not cover', async () => {
    stubJson({ code: 0 })
    expect(await quoteEvmSwap({ ...base, chainId: 999_999 })).toBeNull()
  })

  it('🔴 Celo and Scroll stay EXCLUDED — probed live, no route even for USDC/USDT', async () => {
    /*
     * Both chains ANSWER the KyberSwap API, so a coverage page would list them. A live
     * probe on 2026-09-08 returned no route for the most liquid stablecoin pair on
     * either. Listing them would advertise a swap that cannot execute, so they are
     * deliberately absent and this test stops anyone adding them back from a doc.
     */
    stubJson({ code: 0, data: { routeSummary: { amountIn: '1', amountOut: '1' }, routerAddress: '0xr' } })
    expect(await quoteEvmSwap({ ...base, chainId: 42220 })).toBeNull() // Celo
    expect(await quoteEvmSwap({ ...base, chainId: 534352 })).toBeNull() // Scroll
  })

  it('quotes, and reports KyberSwap plus the two-transaction warning', async () => {
    // Both the probe and the real route return a 1:1-ish rate.
    globalThis.fetch = (async (u: unknown) => {
      const url = String(u)
      const amountIn = /amountIn=(\d+)/.exec(url)?.[1] ?? '0'
      return new Response(
        JSON.stringify({
          code: 0,
          data: { routeSummary: { amountIn, amountOut: amountIn }, routerAddress: '0xrouter' },
        }),
        { status: 200 }
      )
    }) as typeof fetch
    const q = await quoteEvmSwap(base)
    expect(q).not.toBeNull()
    expect(q!.source.name).toBe('KyberSwap')
    expect(q!.source.note).toMatch(/TWO transactions/i)
    // Exact-in: the input IS the cap, so maxSpend equals what we send.
    expect(q!.maxSpend).toBe(q!.from.amount)
  })

  it('🔴 REFUSES when the REAL route degrades and would land SHORT of the invoice', async () => {
    /*
     * A uniformly bad rate is fine: the sizing step just asks for more input. The
     * danger is the rate the PROBE promises not surviving into the real quote (thin
     * liquidity, a moving market). Then the swap lands short and the invoice still
     * cannot be paid, with the money already gone. Probe 1:1, real route short.
     */
    const PROBE_IN = 10n ** 16n
    globalThis.fetch = (async (u: unknown) => {
      const amountIn = /amountIn=(\d+)/.exec(String(u))?.[1] ?? '0'
      const out =
        BigInt(amountIn) === PROBE_IN ? amountIn : (base.wantAmount - 1n).toString()
      return new Response(
        JSON.stringify({ code: 0, data: { routeSummary: { amountIn, amountOut: out }, routerAddress: '0xr' } }),
        { status: 200 }
      )
    }) as typeof fetch
    expect(await quoteEvmSwap(base)).toBeNull()
  })

  it('a native-in swap is flagged as needing NO approval', async () => {
    globalThis.fetch = (async (u: unknown) => {
      const amountIn = /amountIn=(\d+)/.exec(String(u))?.[1] ?? '0'
      return new Response(
        JSON.stringify({ code: 0, data: { routeSummary: { amountIn, amountOut: amountIn }, routerAddress: '0xr' } }),
        { status: 200 }
      )
    }) as typeof fetch
    const q = await quoteEvmSwap({ ...base, from: { asset: 'native', decimals: 18, symbol: 'BNB' } })
    expect(q!.source.note).toMatch(/no ERC-20 approval/i)
  })

  it('returns null (never throws) when the aggregator is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('down')
    }) as typeof fetch
    await expect(quoteEvmSwap(base)).resolves.toBeNull()
  })
})
