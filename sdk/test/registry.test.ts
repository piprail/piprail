import { describe, it, expect } from 'vitest'
// Import the registry DIRECTLY (not the package root) so the registry starts
// empty — drivers/index.ts is what eagerly registers EVM, and importing it
// would pollute this file's module-isolated singleton.
import {
  registerDriver,
  isRegistered,
  resolveNetwork,
  familyForChain,
} from '../src/drivers/registry.js'
import { UnsupportedNetworkError } from '../src/errors.js'
import { CHAINS } from '../src/drivers/evm/chains.js'
import type { ResolvedNetwork } from '../src/drivers/types.js'

function fakeNet(network: string): ResolvedNetwork {
  return {
    family: 'evm',
    network: network as `${string}:${string}`,
    supports: () => true,
    resolveToken: () => ({ asset: 'native', decimals: 18, symbol: 'ETH' }),
    describeAsset: () => ({ symbol: 'ETH', decimals: 18 }),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => ({ _native: w }),
    send: async () => 'ref',
    confirm: async () => ({ height: '1' }),
    estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' }),
    addressOf: async () => 'FAKE_SELF_ADDRESS',
    balanceOf: async () => ({ token: 0n, native: 0n }),
    recipientReady: async () => ({ ready: "n/a" as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused' }),
  }
}

// NOTE: tests run in definition order and share this file's module-singleton
// registry, so the "empty registry" case must come first.
describe('registry — routing + the no-driver / unrecognised branches', () => {
  it('familyForChain routes every selector', () => {
    expect(familyForChain('base')).toBe('evm')
    expect(familyForChain({ id: 8453, rpcUrl: 'https://x' })).toBe('evm')
    expect(familyForChain('solana')).toBe('solana')
    expect(familyForChain('ton')).toBe('ton')
    expect(familyForChain('stellar')).toBe('stellar')
  })

  it('throws UnsupportedNetworkError when no driver is registered for the family', () => {
    // MISSING_DRIVER is reserved for failed optional-dep imports (the loaders);
    // an unmounted/unknown family is UnsupportedNetwork.
    expect(() => resolveNetwork({ chain: 'base' })).toThrow(UnsupportedNetworkError)
  })

  it('throws UnsupportedNetworkError when the driver does not recognise the chain (resolve → null)', () => {
    registerDriver({ family: 'evm', resolve: () => null })
    expect(() => resolveNetwork({ chain: 'base' })).toThrow(UnsupportedNetworkError)
  })

  it('returns the bound network when a driver recognises the chain', () => {
    registerDriver({ family: 'evm', resolve: () => fakeNet('eip155:8453') })
    expect(resolveNetwork({ chain: 'base' }).network).toBe('eip155:8453')
  })

  it('isRegistered reflects registration', () => {
    expect(isRegistered('solana')).toBe(false)
    registerDriver({ family: 'solana', resolve: () => fakeNet('solana:x') })
    expect(isRegistered('solana')).toBe(true)
  })
})

/**
 * Routing used a bare `startsWith`, so any EVM preset whose NAME begins with a non-EVM
 * family name was delivered to the wrong driver. `chain: 'xrplevm'` (the XRPL EVM Sidechain,
 * an ordinary EVM chain, id 1440000) went to the XRP Ledger driver, which then reported that
 * it "didn't recognise this chain input" — an error pointing at the driver rather than at the
 * routing that misdelivered it. Every current preset is checked here, so the next name that
 * collides fails at build time instead of at a customer's first payment.
 */
describe('familyForChain — a preset name is not a family prefix', () => {
  it('routes xrplevm to EVM, not to the XRP Ledger', () => {
    expect(familyForChain('xrplevm')).toBe('evm')
    expect(familyForChain('xrpl')).toBe('xrpl')
  })

  it('routes EVERY built-in EVM preset to the evm family', () => {
    for (const slug of Object.keys(CHAINS)) {
      expect(`${slug} → ${familyForChain(slug)}`).toBe(`${slug} → evm`)
    }
  })

  it('still routes each non-EVM family name and its CAIP-2 namespace', () => {
    const CASES: Array<[string, string]> = [
      ['solana', 'solana'],
      ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana'],
      ['stellar', 'stellar'],
      ['stellar:pubnet', 'stellar'],
      ['xrpl', 'xrpl'],
      ['xrpl:0', 'xrpl'],
      ['tron', 'tron'],
      ['sui', 'sui'],
      ['near', 'near'],
      ['aptos', 'aptos'],
      ['algorand', 'algorand'],
      ['ton', 'ton'],
    ]
    for (const [input, want] of CASES) {
      expect(`${input} → ${familyForChain(input)}`).toBe(`${input} → ${want}`)
    }
  })

  it('an unknown name falls through to evm, as an unlisted EVM chain', () => {
    expect(familyForChain('some-new-l2')).toBe('evm')
    expect(familyForChain('suithing')).toBe('evm')
    expect(familyForChain('nearly')).toBe('evm')
  })
})
