import { describe, it, expect } from 'vitest'
import { evaluatePolicy, type PaymentIntent, type PaymentPolicy } from '../src/index.js'

// A recognised USDC-on-Base intent: 0.05 USDC (6dp → 50000 base units).
function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    host: 'api.example.com',
    chain: 'base',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amountBase: 50_000n,
    decimals: 6,
    symbol: 'USDC',
    recognized: true,
    ...over,
  }
}
const ok = (i: PaymentIntent, p?: PaymentPolicy, spent = 0n) =>
  evaluatePolicy(i, p, spent).allowed

describe('evaluatePolicy — no policy is wide open', () => {
  it('allows anything when no policy is configured', () => {
    expect(ok(intent(), undefined)).toBe(true)
  })
})

describe('evaluatePolicy — maxAmount uses TRUE decimals', () => {
  it('allows at or under the cap, refuses over', () => {
    expect(ok(intent(), { maxAmount: '0.10' })).toBe(true)
    expect(ok(intent(), { maxAmount: '0.05' })).toBe(true)
    expect(ok(intent(), { maxAmount: '0.04' })).toBe(false)
  })

  it("a server can't slip past the cap by understating the price", () => {
    // Server tried to charge 50 USDC (50_000_000 base) but the client priced it
    // against the TOKEN'S TRUE 6 decimals (via describeAsset), so the cap bites.
    const attack = intent({ amountBase: 50_000_000n, decimals: 6 })
    expect(ok(attack, { maxAmount: '0.10' })).toBe(false)
  })

  it('floors a cap finer than the token instead of throwing', () => {
    // 2-decimal token, cap '0.001' → floors to 0 base units, so nothing is affordable.
    expect(ok(intent({ decimals: 2, amountBase: 1n }), { maxAmount: '0.001' })).toBe(false)
    // '0.059' floors to 0.05 (=5 base) → a 5-unit payment is exactly at the cap.
    expect(ok(intent({ decimals: 2, amountBase: 5n }), { maxAmount: '0.059' })).toBe(true)
    expect(ok(intent({ decimals: 2, amountBase: 6n }), { maxAmount: '0.059' })).toBe(false)
  })
})

describe('evaluatePolicy — chains allowlist', () => {
  it('matches string selectors and refuses others', () => {
    expect(ok(intent(), { chains: ['base'] })).toBe(true)
    expect(ok(intent(), { chains: ['solana'] })).toBe(false)
  })
  it('matches object selectors by resolved network id', () => {
    expect(ok(intent({ chain: { id: 8453, rpcUrl: 'x' } }), { chains: [{ id: 8453, rpcUrl: 'x' }] })).toBe(true)
    expect(ok(intent({ chain: { id: 8453, rpcUrl: 'x' } }), { chains: [{ id: 1, rpcUrl: 'x' }] })).toBe(false)
  })
})

describe('evaluatePolicy — tokens allowlist (TRUE symbol)', () => {
  it('matches case-insensitively; refuses others; an unrecognised asset never matches', () => {
    expect(ok(intent(), { tokens: ['usdc'] })).toBe(true)
    expect(ok(intent(), { tokens: ['USDT'] })).toBe(false)
    expect(ok(intent({ recognized: false, symbol: 'USDC' }), { tokens: ['USDC'], allowUnknownTokens: true })).toBe(false)
  })
})

describe('evaluatePolicy — unknown tokens are refused by default', () => {
  it('refuses an asset the SDK cannot price unless explicitly allowed', () => {
    const unknown = intent({ recognized: false, symbol: undefined })
    expect(ok(unknown, { maxAmount: '1' })).toBe(false)
    expect(ok(unknown, { maxAmount: '1', allowUnknownTokens: true })).toBe(true)
  })
})

describe('evaluatePolicy — hosts allowlist', () => {
  it('exact and wildcard match; refuses others', () => {
    expect(ok(intent(), { hosts: ['api.example.com'] })).toBe(true)
    expect(ok(intent(), { hosts: ['*.example.com'] })).toBe(true)
    expect(ok(intent({ host: 'example.com' }), { hosts: ['*.example.com'] })).toBe(true)
    expect(ok(intent(), { hosts: ['other.com'] })).toBe(false)
  })
})

describe('evaluatePolicy — maxTotal is per asset', () => {
  it('counts prior spend on the same asset toward the cap', () => {
    // cap 0.10 (=100000), this payment 50000.
    expect(ok(intent(), { maxTotal: '0.10' }, 40_000n)).toBe(true) // 40000+50000 = 90000 ≤ 100000
    expect(ok(intent(), { maxTotal: '0.10' }, 60_000n)).toBe(false) // 60000+50000 = 110000 > 100000
  })
})

describe('evaluatePolicy — the reason is specific', () => {
  it('names which guard fired', () => {
    expect(evaluatePolicy(intent(), { maxAmount: '0.04' }, 0n).reason).toMatch(/maxAmount/)
    expect(evaluatePolicy(intent(), { chains: ['solana'] }, 0n).reason).toMatch(/chains/)
    expect(evaluatePolicy(intent(), { hosts: ['other.com'] }, 0n).reason).toMatch(/hosts/)
    // An unknown token is refused once ANY policy is present (empty policy counts).
    expect(evaluatePolicy(intent({ recognized: false }), {}, 0n).allowed).toBe(false)
  })
})
