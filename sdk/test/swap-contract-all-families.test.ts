/**
 * ── THE SWAP CONTRACT, ACROSS ALL TEN FAMILIES ──────────────────────────────────
 *
 * `ERRORS.md` §5 now states it: **`quoteSwap` must never throw.** No pool, no route, a
 * hostile response, a rate limit, a DNS failure, a node returning HTML — every one of them
 * is `null`, exactly like `estimateCost`, `balanceOf` and `recipientReady`.
 *
 * That matters more than it looks. `quoteSwap` is the "could I swap?" question, so a caller
 * asks it speculatively, often about a pair that has no pool. If one family throws where the
 * other nine return null, the caller has to wrap it — and then a genuinely missing pool is
 * indistinguishable from an outage.
 *
 * Every family currently honours it, but nothing ENFORCED it: `swap-edge-cases.test.ts` tests
 * families one at a time with fixtures tuned to each, so an eleventh family could be added
 * with a throwing quote and no existing test would notice. This walks all ten uniformly and
 * fails if any one of them throws.
 *
 * The hostile network is deliberately total: fetch rejects, every client method rejects, and
 * where a family reads JSON it also gets served HTML and truncated garbage.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { quoteAlgorandSwap } from '../src/drivers/algorand/swap.js'
import { quoteAptosSwap } from '../src/drivers/aptos/swap.js'
import { quoteEvmSwap } from '../src/drivers/evm/swap.js'
import { quoteNearSwap } from '../src/drivers/near/swap.js'
import { quoteSolanaSwap } from '../src/drivers/solana/swap.js'
import { quoteStellarSwap } from '../src/drivers/stellar/swap.js'
import { quoteSuiSwap } from '../src/drivers/sui/swap.js'
import { quoteTonSwap } from '../src/drivers/ton/swap.js'
import { quoteTronSwap } from '../src/drivers/tron/swap.js'
import { quoteXrplSwap } from '../src/drivers/xrpl/swap.js'
import type { PublicClient } from 'viem'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/** A client whose every method rejects, for the families that take one. */
const hostileClient = () =>
  new Proxy(
    {},
    {
      get(): unknown {
        return new Proxy(
          async () => {
            throw new Error('node is down')
          },
          {
            get(): unknown {
              return async () => {
                throw new Error('node is down')
              }
            },
          }
        )
      },
    }
  )

/**
 * Every family, with a realistic pair and whatever client shape its quote takes. Keeping
 * them in one table is the point: adding a family means adding a row here, and the row
 * immediately inherits every case below.
 */
const FAMILIES = [
  {
    name: 'algorand',
    call: (extra: object) =>
      quoteAlgorandSwap({
        network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as never,
        from: { asset: 'native', decimals: 6, symbol: 'ALGO' } as never,
        to: { asset: '31566704', decimals: 6, symbol: 'USDC' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        ...extra,
      } as never),
  },
  {
    name: 'aptos',
    call: (extra: object) =>
      quoteAptosSwap({
        client: hostileClient() as never,
        network: 'aptos:1' as never,
        from: { asset: 'native', decimals: 8, symbol: 'APT' } as never,
        to: { asset: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', decimals: 6, symbol: 'USDC' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        owner: '0x1',
        ...extra,
      } as never),
  },
  {
    name: 'evm',
    call: (extra: object) =>
      quoteEvmSwap({
        publicClient: hostileClient() as unknown as PublicClient,
        chainId: 8453,
        network: 'eip155:8453' as never,
        nativeSymbol: 'ETH',
        owner: '0x0000000000000000000000000000000000000001',
        from: { asset: '0xaaa0000000000000000000000000000000000001', decimals: 6, symbol: 'USDC' } as never,
        to: { asset: 'native', decimals: 18, symbol: 'ETH' } as never,
        wantAmount: 10n ** 15n,
        slippageBps: 100,
        ...extra,
      } as never),
  },
  {
    name: 'near',
    call: (extra: object) =>
      quoteNearSwap({
        client: hostileClient() as never,
        network: 'near:mainnet' as never,
        from: { asset: 'native', decimals: 24, symbol: 'NEAR' } as never,
        to: { asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, symbol: 'USDC' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        ...extra,
      } as never),
  },
  {
    name: 'solana',
    call: (extra: object) =>
      quoteSolanaSwap({
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as never,
        from: { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' } as never,
        to: { asset: 'native', decimals: 9, symbol: 'SOL' } as never,
        wantAmount: 1_000_000n,
        slippageBps: 50,
        ...extra,
      } as never),
  },
  {
    name: 'stellar',
    call: (extra: object) =>
      quoteStellarSwap({
        server: { strictReceivePaths: () => { throw new Error('horizon is down') } } as never,
        network: 'stellar:pubnet' as never,
        from: { asset: 'native', decimals: 7, symbol: 'XLM' } as never,
        to: { asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7, symbol: 'USDC' } as never,
        wantAmount: 500_000n,
        slippageBps: 100,
        ...extra,
      } as never),
  },
  {
    name: 'sui',
    call: (extra: object) =>
      quoteSuiSwap({
        network: 'sui:mainnet' as never,
        from: { asset: 'native', decimals: 9, symbol: 'SUI' } as never,
        to: { asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', decimals: 6, symbol: 'USDC' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        sender: '0x1',
        ...extra,
      } as never),
  },
  {
    name: 'ton',
    call: (extra: object) =>
      quoteTonSwap({
        network: 'tvm:-239' as never,
        from: { asset: 'native', decimals: 9, symbol: 'GRAM' } as never,
        to: { asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6, symbol: 'USDT' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        ...extra,
      } as never),
  },
  {
    name: 'tron',
    call: (extra: object) =>
      quoteTronSwap({
        client: hostileClient() as never,
        network: 'tron:mainnet' as never,
        from: { asset: 'native', decimals: 6, symbol: 'TRX' } as never,
        to: { asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, symbol: 'USDT' } as never,
        wantAmount: 50_000n,
        slippageBps: 100,
        owner: 'TVvRPbEpkY34SmqEkioxtKywenWLmtuVzL',
        ...extra,
      } as never),
  },
  {
    name: 'xrpl',
    call: (extra: object) =>
      quoteXrplSwap({
        client: hostileClient() as never,
        network: 'xrpl:0' as never,
        from: { asset: 'native', decimals: 6, symbol: 'XRP' } as never,
        to: { asset: 'USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq', decimals: 15, symbol: 'USD' } as never,
        wantAmount: 500_000n,
        slippageBps: 100,
        account: 'rB5TihdPbKgMrkFqrqUC3yLdE8hhv4BdeY',
        ...extra,
      } as never),
  },
] as const

expect(FAMILIES).toHaveLength(10)

/** Replace fetch with something that fails the way a real network fails. */
function breakFetch(mode: 'reject' | 'html' | 'truncated' | 'empty-200' | 'rate-limited') {
  globalThis.fetch = (async () => {
    if (mode === 'reject') throw new TypeError('fetch failed')
    const body =
      mode === 'html'
        ? '<!doctype html><html><body>502 Bad Gateway</body></html>'
        : mode === 'truncated'
          ? '{"data":{"routeSum'
          : ''
    return new Response(body, {
      status: mode === 'rate-limited' ? 429 : 200,
      headers: { 'content-type': mode === 'html' ? 'text/html' : 'application/json' },
    })
  }) as typeof fetch
}

describe('quoteSwap never throws, in any family, however broken the network is', () => {
  const modes = ['reject', 'html', 'truncated', 'empty-200', 'rate-limited'] as const

  for (const family of FAMILIES) {
    for (const mode of modes) {
      it(`${family.name}: returns null on a ${mode} network`, async () => {
        breakFetch(mode)
        // Not `.rejects` — the assertion IS that it resolves. A throw here fails the test
        // with the driver's own error, which is exactly the diagnostic you want.
        await expect(family.call({})).resolves.toBeNull()
      })
    }
  }
})

describe('quoteSwap refuses degenerate inputs without a network call', () => {
  for (const family of FAMILIES) {
    it(`${family.name}: a zero amount is null, and nothing is fetched`, async () => {
      const spy = vi.fn(async () => new Response('{}', { status: 200 }))
      globalThis.fetch = spy as unknown as typeof fetch
      await expect(family.call({ wantAmount: 0n })).resolves.toBeNull()
      expect(spy).not.toHaveBeenCalled()
    })

    it(`${family.name}: a negative amount is null`, async () => {
      breakFetch('reject')
      await expect(family.call({ wantAmount: -1n })).resolves.toBeNull()
    })
  }
})

describe('quoteSwap does not quote a token against itself', () => {
  for (const family of FAMILIES) {
    it(`${family.name}: same asset on both sides is null`, async () => {
      breakFetch('reject')
      const same = { asset: 'native', decimals: 9, symbol: 'X' }
      // A self-swap has no meaning and would burn a fee for nothing, so it must not price.
      await expect(family.call({ from: same, to: same })).resolves.toBeNull()
    })
  }
})
