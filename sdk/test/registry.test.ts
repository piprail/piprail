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
