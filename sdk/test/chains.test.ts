import { describe, it, expect } from 'vitest'
import { bsc } from 'viem/chains'
import { CHAINS, resolveChain } from '../src/index.js'

describe('resolveChain — built-in mainnets', () => {
  it('resolves "base" to 6-decimal USDC', () => {
    const r = resolveChain('base')
    expect(r.chainId).toBe(8453)
    expect(r.tokens.USDC).toMatchObject({ decimals: 6 })
  })

  it('resolves "bnb" to 18-decimal USDC, USDT, FDUSD (EIP-3009), USD1 (EIP-3009)', () => {
    const r = resolveChain('bnb')
    expect(r.chainId).toBe(56)
    expect(r.tokens.USDC).toMatchObject({ decimals: 18, symbol: 'USDC' })
    expect(r.tokens.USDT).toMatchObject({ decimals: 18, symbol: 'USDT' })
    expect(r.tokens.FDUSD).toMatchObject({ decimals: 18, symbol: 'FDUSD', address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409' })
    expect(r.tokens.USD1).toMatchObject({ decimals: 18, symbol: 'USD1', address: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d' })
  })

  it('resolves the rest of the default mainnets', () => {
    expect(resolveChain('ethereum').chainId).toBe(1)
    expect(resolveChain('arbitrum').chainId).toBe(42161)
    expect(resolveChain('optimism').chainId).toBe(10)
    expect(resolveChain('polygon').chainId).toBe(137)
    expect(resolveChain('avalanche').chainId).toBe(43114)
  })

  it('ships Circle EURC (EIP-3009, 6dp) on the chains Circle issues it — so the exact buyer recognises it', () => {
    for (const chain of ['ethereum', 'base', 'avalanche'] as const) {
      const eurc = resolveChain(chain).tokens.EURC
      expect(eurc, `EURC on ${chain}`).toMatchObject({ decimals: 6, symbol: 'EURC' })
      expect(eurc!.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
    // EURC is NOT shipped where Circle doesn't issue it natively.
    expect(resolveChain('arbitrum').tokens.EURC).toBeUndefined()
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

  it('resolves HyperEVM (Hyperliquid, 999) — native USDC, USDT0 omitted', () => {
    // HyperEVM: native Circle USDC; its "USDT" is USDT0 (LayerZero), not built in.
    const h = resolveChain('hyperevm')
    expect(h.chainId).toBe(999)
    expect(h.tokens.USDC).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(h.tokens.USDT).toBeUndefined()
  })

  it('resolves Monad (143) — native USDC, USDT0 omitted', () => {
    // Monad: native Circle USDC; its "USDT" is USDT0 (LayerZero), not built in.
    const m = resolveChain('monad')
    expect(m.chainId).toBe(143)
    expect(m.tokens.USDC).toMatchObject({ decimals: 6, symbol: 'USDC' })
    expect(m.tokens.USDT).toBeUndefined()
  })

  it('resolves Kaia (ex-Klaytn, 8217) — native KAIA + Tether-native USD₮, no native USDC', () => {
    // Kaia: Tether-native USDT (0xd077…4fDb, verified on-chain). Circle issues no native
    // USDC on Kaia, so USDC is intentionally omitted (pay native KAIA or USDT).
    const k = resolveChain('kaia')
    expect(k.chainId).toBe(8217)
    expect(k.chain.nativeCurrency.symbol).toBe('KAIA')
    expect(k.tokens.USDT).toMatchObject({ decimals: 6, symbol: 'USDT' })
    expect(k.tokens.USDC).toBeUndefined()
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
      'sei', 'injective', 'hyperevm', 'monad', 'kaia',
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
