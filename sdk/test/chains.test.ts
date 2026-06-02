import { describe, it, expect } from 'vitest'
import { bsc } from 'viem/chains'
import { CHAINS, resolveChain } from '../src/index.js'

describe('resolveChain — built-in mainnets', () => {
  it('resolves "base" to 6-decimal USDC', () => {
    const r = resolveChain('base')
    expect(r.chainId).toBe(8453)
    expect(r.tokens.USDC).toMatchObject({ decimals: 6 })
  })

  it('resolves "bnb" to 18-decimal USDC + USDT', () => {
    const r = resolveChain('bnb')
    expect(r.chainId).toBe(56)
    expect(r.tokens.USDC).toMatchObject({ decimals: 18 })
    expect(r.tokens.USDT).toMatchObject({ decimals: 18 })
  })

  it('resolves the rest of the default mainnets', () => {
    expect(resolveChain('ethereum').chainId).toBe(1)
    expect(resolveChain('arbitrum').chainId).toBe(42161)
    expect(resolveChain('optimism').chainId).toBe(10)
    expect(resolveChain('polygon').chainId).toBe(137)
    expect(resolveChain('avalanche').chainId).toBe(43114)
  })

  it('resolves the newer popular chains (verified USDC + USDT)', () => {
    const expected = [
      ['mantle', 5000], ['sonic', 146], ['linea', 59144], ['scroll', 534352],
      ['celo', 42220], ['zksync', 324], ['unichain', 130], ['worldchain', 480],
    ] as const
    for (const [name, id] of expected) {
      const r = resolveChain(name)
      expect(r.chainId).toBe(id)
      expect(r.tokens.USDC).toMatchObject({ decimals: 6, symbol: 'USDC' })
    }
    // USDT is built in everywhere except World Chain (no canonical USDT there).
    expect(resolveChain('mantle').tokens.USDT).toMatchObject({ decimals: 6 })
    expect(resolveChain('worldchain').tokens.USDT).toBeUndefined()
  })

  it('resolves the native-EVM additions (Sei, Injective) — verified on-chain', () => {
    // Sei pacific-1 EVM: native Circle USDC; USDT (USDT0) intentionally not built in.
    const sei = resolveChain('sei')
    expect(sei.chainId).toBe(1329)
    expect(sei.tokens.USDC).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(sei.tokens.USDT).toBeUndefined()
    // Injective native EVM: native Circle USDC + USDT (MultiVM Token Standard).
    const inj = resolveChain('injective')
    expect(inj.chainId).toBe(1776)
    expect(inj.tokens.USDC).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(inj.tokens.USDT).toMatchObject({ decimals: 6, symbol: 'USDT' })
  })

  it('USDT is now built in on the major chains', () => {
    for (const name of ['ethereum', 'arbitrum', 'optimism', 'polygon', 'avalanche'] as const) {
      expect(resolveChain(name).tokens.USDT).toMatchObject({ decimals: 6, symbol: 'USDT' })
    }
  })

  it('lets an rpcUrl override the built-in default', () => {
    expect(resolveChain('base', 'https://my.base.rpc').rpcUrl).toBe('https://my.base.rpc')
  })

  it('pins a reliable default RPC for ethereum (viem default is flaky)', () => {
    expect(resolveChain('ethereum').rpcUrl).toBe('https://ethereum-rpc.publicnode.com')
  })

  it('throws a helpful error for an unknown name', () => {
    // @ts-expect-error — not a built-in name
    expect(() => resolveChain('dogechain')).toThrow(/unknown chain "dogechain"/)
  })

  it('CHAINS is iterable for a chain picker (mainnets only, no testnets)', () => {
    const keys = Object.keys(CHAINS)
    expect(keys).toEqual([
      'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche',
      'mantle', 'sonic', 'linea', 'scroll', 'celo', 'zksync', 'unichain', 'worldchain',
      'sei', 'injective',
    ])
    expect(keys.some((k) => /test|sepolia|devnet/i.test(k))).toBe(false)
  })
})

describe('resolveChain — viem Chain + exotic custom', () => {
  it('accepts a viem Chain and still knows its tokens by id', () => {
    const r = resolveChain(bsc)
    expect(r.chainId).toBe(56)
    expect(r.rpcUrl).toBe(bsc.rpcUrls.default.http[0])
    expect(r.tokens.USDC).toMatchObject({ decimals: 18 })
  })

  it('wraps a bare { id, rpcUrl } into a usable chain — any exotic EVM chain', () => {
    // Aurora (1313161554) isn't a built-in preset → proves the no-allowlist path.
    const r = resolveChain({ id: 1313161554, rpcUrl: 'https://mainnet.aurora.dev' })
    expect(r.chainId).toBe(1313161554)
    expect(r.chain.name).toBe('EVM 1313161554')
    expect(r.chain.nativeCurrency.decimals).toBe(18)
    expect(r.tokens).toEqual({}) // unknown chain → no built-in tokens
  })

  it('honours custom name + nativeCurrency on a minimal config', () => {
    const r = resolveChain({
      id: 5000,
      rpcUrl: 'https://x',
      name: 'Mantle',
      nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
    })
    expect(r.chain.name).toBe('Mantle')
    expect(r.chain.nativeCurrency.symbol).toBe('MNT')
  })

  it('throws when a minimal config has no rpcUrl', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => resolveChain({ id: 5000 })).toThrow(/needs an rpcUrl/)
  })
})
