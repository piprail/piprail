import { describe, it, expect } from 'vitest'
import { nativeCost } from '../src/util/cost.js'
import { evmDriver } from '../src/drivers/evm/index.js'
import { solanaDriver } from '../src/drivers/solana/index.js'
import { tonDriver } from '../src/drivers/ton/index.js'
import { stellarDriver } from '../src/drivers/stellar/index.js'
import { xrplDriver } from '../src/drivers/xrpl/index.js'
import { tronDriver } from '../src/drivers/tron/index.js'
import { suiDriver } from '../src/drivers/sui/index.js'
import { nearDriver } from '../src/drivers/near/index.js'
import { aptosDriver } from '../src/drivers/aptos/index.js'
import { algorandDriver } from '../src/drivers/algorand/index.js'
import type { ResolveOptions } from '../src/drivers/types.js'
import type { X402AcceptEntry, X402AnyAccept } from '../src/x402.js'

// A dead RPC so the RPC-reading drivers (EVM gas price, XRPL fee) deterministically
// fall back to their heuristic — no network, no flakiness.
const DEAD = 'http://127.0.0.1:1'

function accept(network: string, asset: string): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: network as `${string}:${string}`,
    amount: '50000',
    asset,
    payTo: 'recipient',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05' },
  }
}

/** A standard `exact` accept (the buyer-gasless rail). `method` selects the EVM transfer method. */
function exactAccept(network: string, asset: string, method = 'eip3009'): X402AnyAccept {
  return {
    scheme: 'exact',
    network: network as `${string}:${string}`,
    amount: '50000',
    asset,
    payTo: 'recipient',
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: method, decimals: 6, name: 'USD Coin', version: '2', amountFormatted: '0.05', symbol: 'USDC' },
  } as unknown as X402AnyAccept
}

/** A standard `upto` (metered) accept — also buyer-gasless (Permit2-upto). */
function uptoAccept(network: string, asset: string): X402AnyAccept {
  return {
    scheme: 'upto',
    network: network as `${string}:${string}`,
    amount: '500000',
    asset,
    payTo: 'recipient',
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: '0x2222222222222222222222222222222222222222', decimals: 6, amountFormatted: '0.5', symbol: 'USDC' },
  } as unknown as X402AnyAccept
}

describe('nativeCost — the shared cost builder', () => {
  it('formats the fee and carries basis + optional detail', () => {
    expect(nativeCost({ symbol: 'ETH', decimals: 18, fee: 105_000_000_000_000n, basis: 'estimated' })).toEqual({
      feeSymbol: 'ETH',
      feeDecimals: 18,
      fee: '105000000000000',
      feeFormatted: '0.000105',
      basis: 'estimated',
    })
    const withDetail = nativeCost({ symbol: 'XRP', decimals: 6, fee: 12n, basis: 'heuristic', detail: '~12 drops' })
    expect(withDetail.feeFormatted).toBe('0.000012')
    expect(withDetail.detail).toBe('~12 drops')
  })

  it('a zero fee formats as "0"', () => {
    expect(nativeCost({ symbol: 'SOL', decimals: 9, fee: 0n, basis: 'heuristic' }).feeFormatted).toBe('0')
  })
})

describe('estimateCost — deterministic per-driver fees (native coin)', () => {
  it('Stellar: 100 stroops (1 op), XLM 7dp', async () => {
    const c = await stellarDriver.resolve({ chain: 'stellar' })!.estimateCost(accept('stellar:pubnet', 'native'))
    expect(c).toMatchObject({ feeSymbol: 'XLM', feeDecimals: 7, fee: '100', feeFormatted: '0.00001', basis: 'heuristic' })
  })

  it('Solana: 5000 lamports native; +token-account rent for a token', async () => {
    const native = await solanaDriver.resolve({ chain: 'solana' })!.estimateCost(accept('solana:x', 'native'))
    expect(native).toMatchObject({ feeSymbol: 'SOL', feeDecimals: 9, fee: '5000', feeFormatted: '0.000005' })
    const token = await solanaDriver.resolve({ chain: 'solana' })!.estimateCost(accept('solana:x', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))
    expect(token.fee).toBe('2044280') // 5000 + 2_039_280 ATA rent
    expect(token.feeSymbol).toBe('SOL')
  })

  it('TON: ~0.01 GRAM native, ~0.05 GRAM jetton, 9dp', async () => {
    const native = await tonDriver.resolve({ chain: 'ton' })!.estimateCost(accept('tvm:-239', 'native'))
    // Native ticker is GRAM since the 2026-06-15 Toncoin→Gram rebrand; network unchanged (tvm:-239).
    expect(native).toMatchObject({ feeSymbol: 'GRAM', feeDecimals: 9, feeFormatted: '0.01' })
    const jetton = await tonDriver.resolve({ chain: 'ton' })!.estimateCost(accept('tvm:-239', 'EQjettonmaster'))
    expect(jetton.feeFormatted).toBe('0.05')
  })

  it('Tron: heuristic ~30k energy + bandwidth = 12.945 TRX (no from), 6dp', async () => {
    const c = await tronDriver.resolve({ chain: 'tron' })!.estimateCost(accept('tron:mainnet', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
    // 30000*420 + 345000 = 12_945_000 sun
    expect(c).toMatchObject({ feeSymbol: 'TRX', feeDecimals: 6, fee: '12945000', feeFormatted: '12.945', basis: 'heuristic' })
  })

  it('EVM: dead RPC → heuristic 5 gwei × gas (21k native / 65k token), ETH 18dp', async () => {
    const net = evmDriver.resolve({ chain: 'base', rpcUrl: DEAD })!
    const native = await net.estimateCost(accept('eip155:8453', 'native'))
    expect(native).toMatchObject({ feeSymbol: 'ETH', feeDecimals: 18, fee: '105000000000000', feeFormatted: '0.000105', basis: 'heuristic' })
    const token = await net.estimateCost(accept('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'))
    expect(token.fee).toBe('325000000000000') // 5 gwei × 65k
  })

  it('XRPL: dead RPC → heuristic 12 drops, XRP 6dp', async () => {
    const c = await xrplDriver.resolve({ chain: 'xrpl', rpcUrl: DEAD })!.estimateCost(accept('xrpl:0', 'native'))
    expect(c).toMatchObject({ feeSymbol: 'XRP', feeDecimals: 6, fee: '12', feeFormatted: '0.000012', basis: 'heuristic' })
  })

  it('Sui: ≈0.003 SUI flat heuristic, 9dp', async () => {
    const c = await suiDriver.resolve({ chain: 'sui' })!.estimateCost(accept('sui:mainnet', 'native'))
    expect(c).toMatchObject({ feeSymbol: 'SUI', feeDecimals: 9, fee: '3000000', feeFormatted: '0.003', basis: 'heuristic' })
  })

  it('NEAR: ≈0.0015 NEAR (ft_transfer gas) heuristic, 24dp', async () => {
    const c = await nearDriver.resolve({ chain: 'near' })!.estimateCost(accept('near:mainnet', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'))
    expect(c).toMatchObject({ feeSymbol: 'NEAR', feeDecimals: 24, fee: '1500000000000000000000', feeFormatted: '0.0015', basis: 'heuristic' })
  })
})

describe('estimateCost — agent-safe invariant: never throws, always a valid shape', () => {
  // EVM + XRPL read RPC in estimateCost → a dead RPC forces (and proves) the
  // heuristic fallback. The others are pure heuristics, so they use defaults.
  const cases: Array<[string, ResolveOptions, string]> = [
    ['evm', { chain: 'base', rpcUrl: DEAD }, 'eip155:8453'],
    ['solana', { chain: 'solana' }, 'solana:x'],
    ['ton', { chain: 'ton' }, 'tvm:-239'],
    ['stellar', { chain: 'stellar' }, 'stellar:pubnet'],
    ['xrpl', { chain: 'xrpl', rpcUrl: DEAD }, 'xrpl:0'],
    ['tron', { chain: 'tron' }, 'tron:mainnet'],
    ['sui', { chain: 'sui' }, 'sui:mainnet'],
    ['near', { chain: 'near' }, 'near:mainnet'],
  ]
  const drivers = { evm: evmDriver, solana: solanaDriver, ton: tonDriver, stellar: stellarDriver, xrpl: xrplDriver, tron: tronDriver, sui: suiDriver, near: nearDriver }

  for (const [fam, opts, network] of cases) {
    it(`${fam}: returns a well-formed CostEstimate (never throws)`, async () => {
      const net = drivers[fam as keyof typeof drivers].resolve(opts)!
      const c = await net.estimateCost(accept(network, 'native'))
      expect(typeof c.feeSymbol).toBe('string')
      expect(c.feeSymbol.length).toBeGreaterThan(0)
      expect(Number.isInteger(c.feeDecimals)).toBe(true)
      expect(/^\d+$/.test(c.fee)).toBe(true) // non-negative integer base units
      expect(BigInt(c.fee) >= 0n).toBe(true)
      expect(typeof c.feeFormatted).toBe('string')
      expect(['estimated', 'heuristic']).toContain(c.basis)
    })
  }
})

describe('estimateCost — exact + upto rails are buyer-gasless across families (multi-chain)', () => {
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  it('EVM exact (eip3009) → fee 0, basis estimated, ETH', async () => {
    const net = evmDriver.resolve({ chain: 'base', rpcUrl: DEAD })!
    expect(await net.estimateCost(exactAccept('eip155:8453', USDC_BASE, 'eip3009'))).toMatchObject({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', basis: 'estimated' })
  })
  it('EVM exact (permit2) → fee 0 with the one-time-approval caveat in detail', async () => {
    const net = evmDriver.resolve({ chain: 'bnb', rpcUrl: DEAD })!
    const c = await net.estimateCost(exactAccept('eip155:56', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'permit2'))
    expect(c.fee).toBe('0')
    expect(c.basis).toBe('estimated')
    expect(c.detail).toMatch(/Permit2 approval/)
  })
  it('EVM upto (metered) → fee 0, basis estimated — BREAK-IT: pre-fix this returned the 5-gwei gas heuristic', async () => {
    const net = evmDriver.resolve({ chain: 'base', rpcUrl: DEAD })!
    const c = await net.estimateCost(uptoAccept('eip155:8453', USDC_BASE))
    expect(c.fee).toBe('0')
    expect(c.basis).toBe('estimated')
  })
  it('EVM onchain-proof control → a real (non-zero) heuristic fee', async () => {
    const net = evmDriver.resolve({ chain: 'base', rpcUrl: DEAD })!
    expect(BigInt((await net.estimateCost(accept('eip155:8453', USDC_BASE))).fee) > 0n).toBe(true)
  })

  // Aptos + Algorand — the two exact families that previously had ZERO estimateCost coverage.
  it('Aptos exact → fee 0 / estimated; onchain-proof → 100000 / heuristic, APT 8dp', async () => {
    const net = aptosDriver.resolve({ chain: 'aptos' })!
    expect(await net.estimateCost(exactAccept('aptos:mainnet', '0x1::aptos_coin::AptosCoin'))).toMatchObject({ feeSymbol: 'APT', feeDecimals: 8, fee: '0', basis: 'estimated' })
    expect(await net.estimateCost(accept('aptos:mainnet', 'native'))).toMatchObject({ feeSymbol: 'APT', fee: '100000', basis: 'heuristic' })
  })
  it('Algorand exact → fee 0 / estimated; onchain-proof → 1000 / heuristic, ALGO 6dp', async () => {
    const net = algorandDriver.resolve({ chain: 'algorand' })!
    expect(await net.estimateCost(exactAccept('algorand:mainnet', '31566704'))).toMatchObject({ feeSymbol: 'ALGO', feeDecimals: 6, fee: '0', basis: 'estimated' })
    expect(await net.estimateCost(accept('algorand:mainnet', 'native'))).toMatchObject({ feeSymbol: 'ALGO', fee: '1000', basis: 'heuristic' })
  })

  // GUARD: a family with NO exact rail must keep pricing an exact-scheme accept as buyer-paid
  // (non-zero) — a fee-0 exact branch on a chain that can't settle exact would be a bug.
  it('a no-exact family (Tron) prices an exact-scheme accept as buyer-paid (non-zero), not gasless', async () => {
    const c = await tronDriver.resolve({ chain: 'tron' })!.estimateCost(exactAccept('tron:mainnet', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
    expect(BigInt(c.fee) > 0n).toBe(true)
  })
})
