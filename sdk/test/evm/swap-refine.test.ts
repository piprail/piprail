/**
 * Exact-output emulation must REFINE, not give up.
 *
 * `quoteEvmSwap` learns the rate from a deliberately tiny probe (0.01 of the input token), then
 * solves for the input that buys the wanted output. Price impact between the probe size and the
 * real size is not the caller's slippage tolerance, so the first real quote can land just short.
 * Returning null there tells an agent "this chain cannot swap", which is false and
 * unrecoverable.
 *
 * Measured live on Optimism: a probe rate of 402.0 wei per USDC-base became 398.1 at 2.5 USDC —
 * a 0.49% drift a 50 bps pad could not absorb. The swap was refused while Base, running the same
 * code with luckier drift, went through.
 *
 * The invoice guard stays absolute: a route that still cannot clear is still refused.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { quoteEvmSwap } from '../../src/drivers/evm/swap.js'

const USDC = { asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' }
const NATIVE = { asset: 'native', decimals: 18, symbol: 'ETH' }
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/**
 * A fake aggregator with PRICE IMPACT: the rate falls in proportion to the size traded.
 * `impactScale` is the input at which the rate would reach zero, so a SMALLER scale means a
 * steeper market. This is the shape that broke the estimate: cheap at probe size, worse at real
 * size, and the gap is not the caller's slippage tolerance.
 */
function stubAggregator({ probeRate, impactScale }: { probeRate: bigint; impactScale?: bigint }) {
  const calls: bigint[] = []
  globalThis.fetch = (async (url: string) => {
    const amountIn = BigInt(new URL(String(url)).searchParams.get('amountIn')!)
    calls.push(amountIn)
    const drop = impactScale ? (probeRate * amountIn) / impactScale : 0n
    const rate = probeRate > drop ? probeRate - drop : 1n
    return new Response(
      JSON.stringify({ data: { routeSummary: { amountOut: (amountIn * rate).toString() }, routerAddress: ROUTER } })
    )
  }) as typeof fetch
  return calls
}

const quote = (wantAmount: bigint, slippageBps = 50) =>
  quoteEvmSwap({
    chainId: 10,
    network: 'eip155:10',
    from: USDC,
    to: NATIVE,
    wantAmount,
    slippageBps,
    nativeSymbol: 'ETH',
  } as never)

describe('a quote that lands short is refined, not abandoned', () => {
  it('a flat rate quotes in one shot', async () => {
    const calls = stubAggregator({ probeRate: 400_000_000n }) // no impact
    const q = await quote(1_000_000_000_000_000n) // 0.001 ETH
    expect(q).not.toBeNull()
    expect(BigInt(q!.to.amount)).toBeGreaterThanOrEqual(1_000_000_000_000_000n)
    expect(calls.length).toBe(2) // probe + real, no refinement needed
  })

  it('PRICE IMPACT that breaks the estimate still yields a quote', async () => {
    // The live Optimism shape: at the ~2.5e6 input this solves for, the rate is ~0.5% worse
    // than at the 1e4 probe — more than a 50 bps pad absorbs.
    const calls = stubAggregator({ probeRate: 400_000_000n, impactScale: 500_000_000n })
    const q = await quote(1_000_000_000_000_000n)
    expect(q).not.toBeNull()
    // It clears the invoice, which is the whole point.
    expect(BigInt(q!.to.amount)).toBeGreaterThanOrEqual(1_000_000_000_000_000n)
    // And it needed at least one refinement to get there.
    expect(calls.length).toBeGreaterThan(2)
  })

  it('the input it reports IS what it will spend (maxSpend is the cap)', async () => {
    const calls = stubAggregator({ probeRate: 400_000_000n, impactScale: 500_000_000n })
    const q = await quote(1_000_000_000_000_000n)
    expect(q!.maxSpend).toBe(q!.from.amount)
    // The last route call is the one that was quoted, so the cap is a real, priced input.
    expect(BigInt(q!.maxSpend)).toBe(calls[calls.length - 1])
  })

  it('refinement is BOUNDED on a pool that CANNOT deliver the amount', async () => {
    /*
     * A thin pool: output saturates at its liquidity however much you put in. No input clears
     * the invoice, so the answer must be "no route" — reached in a bounded number of calls
     * rather than by climbing forever.
     */
    let calls = 0
    const LIQUIDITY = 900_000_000_000_000n // 0.0009 ETH, short of the 0.001 asked for
    globalThis.fetch = (async (url: string) => {
      calls++
      const amountIn = BigInt(new URL(String(url)).searchParams.get('amountIn')!)
      const raw = amountIn * 400_000_000n
      const out = raw < LIQUIDITY ? raw : LIQUIDITY
      return new Response(
        JSON.stringify({ data: { routeSummary: { amountOut: out.toString() }, routerAddress: ROUTER } })
      )
    }) as typeof fetch
    expect(await quote(1_000_000_000_000_000n)).toBeNull()
    expect(calls).toBeLessThanOrEqual(6) // probe + at most a handful of attempts
  })

  it('a LINEAR rate always clears eventually — refinement simply finds the input', async () => {
    // Worth stating: a constant (impact-free) rate can never be short for long, because
    // scaling the input scales the output with it. The refusals below are about markets whose
    // rate DEGRADES with size, which is the only case that genuinely cannot clear.
    stubAggregator({ probeRate: 2n })
    const q = await quote(10n ** 15n)
    expect(q).not.toBeNull()
    expect(BigInt(q!.to.amount)).toBeGreaterThanOrEqual(10n ** 15n)
  })

  it('a flat rate that never improves stops rather than spinning', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      // Constant output regardless of input — refining can never help.
      return new Response(
        JSON.stringify({ data: { routeSummary: { amountOut: '1' }, routerAddress: ROUTER } })
      )
    }) as typeof fetch
    expect(await quote(1_000_000_000_000_000n)).toBeNull()
    expect(calls).toBeLessThanOrEqual(6)
  })
})
