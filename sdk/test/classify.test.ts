import { describe, it, expect } from 'vitest'
import { classifyChallenge, type X402Challenge } from '../src/index.js'

const BASE = 'eip155:8453'
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

const challenge = (
  rails: { scheme: 'onchain-proof' | 'exact'; network: string }[]
): X402Challenge =>
  ({
    x402Version: 2,
    error: null,
    resource: { url: 'https://api.example.com/r' },
    accepts: rails,
  }) as unknown as X402Challenge

describe('classifyChallenge', () => {
  it('PAYABLE_RAIL — a rail on your chain via an enabled scheme', () => {
    const t = classifyChallenge(challenge([{ scheme: 'onchain-proof', network: BASE }]), {
      network: BASE,
      schemes: ['onchain-proof'],
    })
    expect(t.verdict).toBe('PAYABLE_RAIL')
    expect(t.onClientChain).toBe(true)
    expect(t.payableScheme).toBe(true)
    expect(t.offeredSchemes).toEqual(['onchain-proof'])
    expect(t.offeredNetworks).toEqual([BASE])
  })

  it('UNPAYABLE_SCHEME — a rail on your chain but only via a scheme you have not enabled', () => {
    const t = classifyChallenge(challenge([{ scheme: 'exact', network: BASE }]), {
      network: BASE,
      schemes: ['onchain-proof'],
    })
    expect(t.verdict).toBe('UNPAYABLE_SCHEME')
    expect(t.onClientChain).toBe(true)
    expect(t.payableScheme).toBe(false)
  })

  it('WRONG_CHAIN — rails exist but none on your chain', () => {
    const t = classifyChallenge(challenge([{ scheme: 'onchain-proof', network: SOL }]), {
      network: BASE,
      schemes: ['onchain-proof'],
    })
    expect(t.verdict).toBe('WRONG_CHAIN')
    expect(t.onClientChain).toBe(false)
  })

  it('NO_RAIL — the challenge offers nothing', () => {
    const t = classifyChallenge(challenge([]), { network: BASE, schemes: ['onchain-proof'] })
    expect(t.verdict).toBe('NO_RAIL')
  })

  it('dedupes offered schemes + networks across a multi-rail challenge', () => {
    const t = classifyChallenge(
      challenge([
        { scheme: 'onchain-proof', network: BASE },
        { scheme: 'exact', network: BASE },
        { scheme: 'exact', network: SOL },
      ]),
      { network: BASE, schemes: ['onchain-proof', 'exact'] }
    )
    expect(t.verdict).toBe('PAYABLE_RAIL')
    expect(t.offeredSchemes.sort()).toEqual(['exact', 'onchain-proof'])
    expect(t.offeredNetworks).toEqual([BASE, SOL])
  })
})
