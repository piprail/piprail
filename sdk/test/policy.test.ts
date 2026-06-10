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

  it("'native' is a chain-agnostic alias for the chain's coin — matched by asset, on any family", () => {
    // mirrors the merchant side (`token: 'native'`): you allow the native coin by
    // the word `native`, not by guessing the ticker. Matched on asset, not symbol.
    const ethPay = intent({ asset: 'native', symbol: 'ETH' })
    const tronPay = intent({ chain: 'tron', network: 'tron:mainnet', asset: 'native', symbol: 'TRX' })
    expect(ok(ethPay, { tokens: ['native'] })).toBe(true) // the alias (case-insensitive)
    expect(ok(ethPay, { tokens: ['NATIVE'] })).toBe(true)
    expect(ok(tronPay, { tokens: ['native'] })).toBe(true) // works on every family
    expect(ok(ethPay, { tokens: ['ETH'] })).toBe(true) // the real ticker still works
    expect(ok(ethPay, { tokens: ['USDC'] })).toBe(false) // unrelated token still refused
    // 'native' must NOT loosen anything for a non-native asset:
    expect(ok(intent(/* USDC ERC-20 */), { tokens: ['native'] })).toBe(false)
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

// A PolicyContext literal — the type is module-internal, but it's structural, so a
// matching literal is a valid 4th arg (the client builds the real one).
const ctx = (
  over: Partial<{ now: number; sessionStart: number; spentInWindowBase: bigint }> = {}
) => ({ now: 1_000_000, sessionStart: 0, spentInWindowBase: 0n, ...over })

describe('evaluatePolicy — typed deny code (no prose-sniffing)', () => {
  it('stamps a code on every deny path; undefined when allowed', () => {
    expect(evaluatePolicy(intent(), { chains: ['solana'] }, 0n).code).toBe('CHAIN')
    expect(evaluatePolicy(intent(), { hosts: ['other.com'] }, 0n).code).toBe('HOST')
    expect(evaluatePolicy(intent({ recognized: false }), {}, 0n).code).toBe('UNKNOWN_TOKEN')
    expect(evaluatePolicy(intent(), { tokens: ['USDT'] }, 0n).code).toBe('TOKEN')
    expect(evaluatePolicy(intent(), { maxAmount: '0.04' }, 0n).code).toBe('MAX_AMOUNT')
    expect(evaluatePolicy(intent(), { maxTotal: '0.10' }, 60_000n).code).toBe('MAX_TOTAL')
    expect(evaluatePolicy(intent(), { maxAmount: '0.10' }, 0n).code).toBeUndefined()
  })
})

describe('evaluatePolicy — no ctx is byte-identical (time fields ignored)', () => {
  it('a 3-arg call never runs a time check, even with time fields set', () => {
    expect(ok(intent(), { ttlSeconds: 1, windowTotal: '0', windowSeconds: 1 })).toBe(true)
  })
})

describe('evaluatePolicy — session TTL / expiry', () => {
  const ttl = { ttlSeconds: 100 } // deadline = sessionStart + 100_000ms

  it('allows before the deadline, denies AT and after (inclusive expiry)', () => {
    expect(evaluatePolicy(intent(), ttl, 0n, ctx({ now: 99_999 })).allowed).toBe(true)
    const at = evaluatePolicy(intent(), ttl, 0n, ctx({ now: 100_000 }))
    expect(at.allowed).toBe(false)
    expect(at.code).toBe('SESSION_EXPIRED')
    expect(evaluatePolicy(intent(), ttl, 0n, ctx({ now: 200_000 })).allowed).toBe(false)
  })

  it('expiry denies even a zero-amount / under-cap payment (amount-blind)', () => {
    const zero = intent({ amountBase: 0n })
    expect(
      evaluatePolicy(zero, { ttlSeconds: 1, maxAmount: '100' }, 0n, ctx({ now: 10_000 })).code
    ).toBe('SESSION_EXPIRED')
  })

  it('honours absolute expiresAt; the EARLIER of ttl/expiresAt wins', () => {
    const both = { ttlSeconds: 100, expiresAt: 50_000 } // abs 50_000 is earlier than ttl 100_000
    expect(evaluatePolicy(intent(), both, 0n, ctx({ now: 60_000 })).code).toBe('SESSION_EXPIRED')
    expect(evaluatePolicy(intent(), both, 0n, ctx({ now: 40_000 })).allowed).toBe(true)
  })

  it('SESSION_EXPIRED is checked FIRST — it wins over chain/host/amount', () => {
    const d = evaluatePolicy(
      intent(),
      { ttlSeconds: 1, chains: ['solana'], maxAmount: '0.001' },
      0n,
      ctx({ now: 100_000 })
    )
    expect(d.code).toBe('SESSION_EXPIRED')
  })
})

describe('evaluatePolicy — rolling window', () => {
  const win = { windowTotal: '0.10', windowSeconds: 60 } // cap 100000 base

  it('allows within the window cap, denies over (strict >)', () => {
    expect(evaluatePolicy(intent(), win, 0n, ctx({ spentInWindowBase: 40_000n })).allowed).toBe(true)
    expect(evaluatePolicy(intent(), win, 0n, ctx({ spentInWindowBase: 50_000n })).allowed).toBe(true) // exactly at
    const over = evaluatePolicy(intent(), win, 0n, ctx({ spentInWindowBase: 60_000n }))
    expect(over.allowed).toBe(false)
    expect(over.code).toBe('WINDOW_TOTAL')
  })

  it('does NOT run at the policy layer when windowSeconds is unset (half-armed = inert)', () => {
    const d = evaluatePolicy(
      intent(),
      { windowTotal: '0.01' } as PaymentPolicy,
      0n,
      ctx({ spentInWindowBase: 999_999n })
    )
    expect(d.allowed).toBe(true)
  })

  it('windowTotal is LAST — maxTotal wins when both would fail', () => {
    const d = evaluatePolicy(
      intent(),
      { maxTotal: '0.10', windowTotal: '0.10', windowSeconds: 60 },
      60_000n,
      ctx({ spentInWindowBase: 60_000n })
    )
    expect(d.code).toBe('MAX_TOTAL')
  })

  it('is per-(network,asset): the window cap is keyed on the slice the client passes', () => {
    // The client pre-slices per asset; this asserts the pure function trusts ctx, not a global.
    expect(evaluatePolicy(intent(), win, 0n, ctx({ spentInWindowBase: 0n })).allowed).toBe(true)
  })
})
