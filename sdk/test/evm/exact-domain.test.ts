/**
 * readExactDomain — resolves an EIP-3009 token's EIP-712 domain `{ name, version }`. Most tokens
 * expose `version()` (USDC → "2"); some HARDCODE it and don't (FDUSD / USD1 on BNB → "1"), so we
 * DERIVE the version by matching the token's on-chain `DOMAIN_SEPARATOR`. The derivation tests use
 * the REAL on-chain separators (captured from BNB mainnet), so they're a true regression test of
 * the EIP-712 domain-separator math — break it and the derivation no longer matches.
 */
import { describe, it, expect } from 'vitest'
import { readExactDomain } from '../../src/drivers/evm/exact.js'
import type { PublicClient } from 'viem'

// A fake publicClient (chainId 56) whose readContract dispatches by function name; a handler that
// throws models a reverting view (e.g. a token with no version()).
const fakePublic = (handlers: Record<string, () => unknown>): PublicClient =>
  ({
    chain: { id: 56 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: async ({ functionName }: any) => {
      const h = handlers[functionName]
      if (!h) throw new Error(`no handler for ${functionName}`)
      return h()
    },
    getChainId: async () => 56,
  }) as unknown as PublicClient

const throwing = () => {
  throw new Error('reverted')
}

describe('readExactDomain — version() path (canonical FiatToken)', () => {
  it('uses version() when the token exposes it (USDC → "2")', async () => {
    const d = await readExactDomain(
      fakePublic({ name: () => 'USD Coin', authorizationState: () => false, version: () => '2' }),
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
    )
    expect(d).toEqual({ name: 'USD Coin', version: '2' })
  })
})

describe('readExactDomain — derive version from DOMAIN_SEPARATOR (no version())', () => {
  it('FDUSD on BNB → derives version "1" from the real on-chain DOMAIN_SEPARATOR', async () => {
    const d = await readExactDomain(
      fakePublic({
        name: () => 'First Digital USD',
        authorizationState: () => false,
        version: throwing, // FDUSD has no version()
        DOMAIN_SEPARATOR: () => '0xac2ff863e00ee93e90d01514d46b9b8179ca650e856138a6d8aea00702ca62a0',
      }),
      '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409'
    )
    expect(d).toEqual({ name: 'First Digital USD', version: '1' })
  })

  it('USD1 on BNB → derives version "1" from the real on-chain DOMAIN_SEPARATOR', async () => {
    const d = await readExactDomain(
      fakePublic({
        name: () => 'World Liberty Financial USD',
        authorizationState: () => false,
        version: throwing,
        DOMAIN_SEPARATOR: () => '0x5d939dc193fd011c5e26fb861450a696546a09db6b26db26501fe354ba3ed4ba',
      }),
      '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d'
    )
    expect(d).toEqual({ name: 'World Liberty Financial USD', version: '1' })
  })
})

describe('readExactDomain — safely returns null (→ permit2 / onchain-proof fallback)', () => {
  it('not an EIP-3009 token (authorizationState reverts)', async () => {
    const d = await readExactDomain(
      fakePublic({ name: () => 'Tether USD', authorizationState: throwing, version: () => '1' }),
      '0x55d398326f99059fF775485246999027B3197955'
    )
    expect(d).toBeNull()
  })

  it('EIP-3009 but a non-standard / salted domain that matches no candidate version', async () => {
    const d = await readExactDomain(
      fakePublic({
        name: () => 'Weird Token',
        authorizationState: () => false,
        version: throwing,
        DOMAIN_SEPARATOR: () => `0x${'de'.repeat(32)}`, // won't match version "1" or "2"
      }),
      '0x000000000000000000000000000000000000bEEF'
    )
    expect(d).toBeNull()
  })

  it('native asset is never exact-payable', async () => {
    expect(await readExactDomain(fakePublic({}), 'native')).toBeNull()
  })
})
