import { describe, it, expect } from 'vitest'
import {
  evaluatePolicy,
  denomOf,
  BUILTIN_DENOMS,
  DENOM_PRECISION,
  type PaymentIntent,
  type PaymentPolicy,
} from '../src/index.js'
// scaleToDenom is an internal helper (not part of the public surface) — import it directly.
import { scaleToDenom } from '../src/policy.js'

// A recognised USDC-on-Base intent: 0.05 USDC (6dp → 50000 base units).
function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    host: 'api.example.com',
    chain: 'base',
    network: 'eip155:8453',
    asset: '0xusdc',
    amountBase: 50_000n,
    decimals: 6,
    symbol: 'USDC',
    recognized: true,
    ...over,
  }
}

// Full policy context (the client builds this); the new count/denom fields default to 0.
const ctx = (
  over: Partial<{
    now: number
    sessionStart: number
    spentInWindowBase: bigint
    spentInDenomScaled: bigint
    paymentCount: number
    paymentCountInWindow: number
  }> = {}
) => ({
  now: 1_000_000,
  sessionStart: 0,
  spentInWindowBase: 0n,
  spentInDenomScaled: 0n,
  paymentCount: 0,
  paymentCountInWindow: 0,
  ...over,
})

describe('denomOf — the unit-of-account label (NOT a price oracle)', () => {
  it('maps the built-in stablecoins to their unit', () => {
    expect(denomOf('USDC', '0xusdc', undefined)).toBe('USD')
    expect(denomOf('USDT', '0xusdt', undefined)).toBe('USD')
    expect(denomOf('USD1', '0x', undefined)).toBe('USD')
    expect(denomOf('FDUSD', '0x', undefined)).toBe('USD')
    expect(denomOf('RLUSD', 'rlusd', undefined)).toBe('USD')
    expect(denomOf('EURC', '0xeurc', undefined)).toBe('EUR')
    expect(BUILTIN_DENOMS.USDC).toBe('USD')
    expect(BUILTIN_DENOMS.EURC).toBe('EUR')
  })
  it('a native coin / unknown token has NO denomination', () => {
    expect(denomOf('ETH', 'native', undefined)).toBeUndefined()
    expect(denomOf('WIDGET', '0xwhatever', undefined)).toBeUndefined()
    expect(denomOf(undefined, 'native', undefined)).toBeUndefined()
  })
  it('is case-insensitive on the symbol', () => {
    expect(denomOf('usdc', '0x', undefined)).toBe('USD')
  })
  it('denomFor override wins — by symbol (case-insensitive) and by asset id', () => {
    expect(denomOf('PYUSD', '0xpyusd', { denomFor: { PYUSD: 'USD' } })).toBe('USD')
    expect(denomOf('pyusd', '0x', { denomFor: { PYUSD: 'usd' } })).toBe('USD')
    // asset-id key matches exactly and wins over symbol
    expect(denomOf('WIDGET', '0xmystable', { denomFor: { '0xmystable': 'USD' } })).toBe('USD')
    // override an existing built-in (e.g. exclude by relabelling)
    expect(denomOf('USDC', '0xusdc', { denomFor: { USDC: 'POINTS' } })).toBe('POINTS')
  })
})

describe('scaleToDenom — exact cross-decimal summation', () => {
  it('scales to DENOM_PRECISION so different-decimal tokens add up exactly', () => {
    // 0.05 USDC (6dp) and 0.05 of an 18dp stablecoin must scale to the SAME value.
    const usdc = scaleToDenom(50_000n, 6) // 0.05 @ 6dp
    const dai = scaleToDenom(50_000_000_000_000_000n, 18) // 0.05 @ 18dp
    expect(usdc).toBe(dai)
    expect(usdc).toBe(50_000n * 10n ** BigInt(DENOM_PRECISION - 6))
  })
  it('returns null for a token finer than the accumulator (excluded, never mis-counted)', () => {
    expect(scaleToDenom(1n, DENOM_PRECISION + 1)).toBeNull()
    expect(scaleToDenom(1n, -1)).toBeNull()
  })
})

describe('evaluatePolicy — maxTotalPerDenom (cross-token grand total)', () => {
  const policy: PaymentPolicy = { maxTotalPerDenom: { USD: '0.08' } } // cap = 0.08 USD

  it('sums ACROSS tokens: a USDC payment is refused once prior USD spend + it exceed the cap', () => {
    // Prior 0.05 USDT spend lives in ctx.spentInDenomScaled (scaled at DENOM_PRECISION).
    const priorUsd = scaleToDenom(50_000n, 6)! // 0.05
    const d = evaluatePolicy(intent(), policy, 0n, ctx({ spentInDenomScaled: priorUsd }))
    // 0.05 (prior) + 0.05 (this) = 0.10 > 0.08 → refused
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('MAX_TOTAL_DENOM')
  })
  it('allows while the running denom total stays within the cap (strict >)', () => {
    const prior = scaleToDenom(20_000n, 6)! // 0.02
    expect(evaluatePolicy(intent(), policy, 0n, ctx({ spentInDenomScaled: prior })).allowed).toBe(true)
    const at = scaleToDenom(30_000n, 6)! // 0.03 → +0.05 = exactly 0.08
    expect(evaluatePolicy(intent(), policy, 0n, ctx({ spentInDenomScaled: at })).allowed).toBe(true)
  })
  it('a token with NO denomination is untouched by the grand total', () => {
    const native = intent({ symbol: 'ETH', asset: 'native', recognized: true })
    const d = evaluatePolicy(native, policy, 0n, ctx({ spentInDenomScaled: scaleToDenom(999_000_000n, 6)! }))
    expect(d.allowed).toBe(true)
  })
  it('keys are case-insensitive ({ usd } caps USDC)', () => {
    const lower: PaymentPolicy = { maxTotalPerDenom: { usd: '0.04' } }
    expect(evaluatePolicy(intent(), lower, 0n, ctx()).code).toBe('MAX_TOTAL_DENOM')
  })
  it('does NOT run without a ctx (zero-config byte-identical)', () => {
    expect(evaluatePolicy(intent(), policy, 0n).allowed).toBe(true)
  })
})

describe('evaluatePolicy — payment-count caps', () => {
  it('maxPayments refuses the (cap+1)-th payment (cross-everything)', () => {
    const p: PaymentPolicy = { maxPayments: 2 }
    expect(evaluatePolicy(intent(), p, 0n, ctx({ paymentCount: 1 })).allowed).toBe(true)
    const d = evaluatePolicy(intent(), p, 0n, ctx({ paymentCount: 2 }))
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('MAX_PAYMENTS')
  })
  it('maxPaymentsPerWindow refuses once the window count is full', () => {
    const p: PaymentPolicy = { maxPaymentsPerWindow: 3, windowSeconds: 60 }
    expect(evaluatePolicy(intent(), p, 0n, ctx({ paymentCountInWindow: 2 })).allowed).toBe(true)
    const d = evaluatePolicy(intent(), p, 0n, ctx({ paymentCountInWindow: 3 }))
    expect(d.code).toBe('WINDOW_COUNT')
  })
})

describe('evaluatePolicy — pinned order with the new caps', () => {
  it('maxTotal (per-asset) wins over the denom grand total', () => {
    const d = evaluatePolicy(
      intent(),
      { maxTotal: '0.04', maxTotalPerDenom: { USD: '0.04' } },
      50_000n, // already at the per-asset cap
      ctx({ spentInDenomScaled: scaleToDenom(50_000n, 6)! })
    )
    expect(d.code).toBe('MAX_TOTAL')
  })
  it('denom grand total wins over maxPayments', () => {
    const d = evaluatePolicy(
      intent(),
      { maxTotalPerDenom: { USD: '0.04' }, maxPayments: 1 },
      0n,
      ctx({ spentInDenomScaled: scaleToDenom(50_000n, 6)!, paymentCount: 5 })
    )
    expect(d.code).toBe('MAX_TOTAL_DENOM')
  })
  it('windowTotal wins over the window count', () => {
    const d = evaluatePolicy(
      intent(),
      { windowTotal: '0.04', windowSeconds: 60, maxPaymentsPerWindow: 1 },
      0n,
      ctx({ spentInWindowBase: 50_000n, paymentCountInWindow: 5 })
    )
    expect(d.code).toBe('WINDOW_TOTAL')
  })
})

describe('denomOf / capForDenom — adversarial hardening', () => {
  it('a NATIVE coin is NEVER in a denomination, even if its symbol matches a built-in', () => {
    // A hostile/edge native coin labelled USDC must not be bucketed into USD (no oracle for native).
    expect(denomOf('USDC', 'native', undefined)).toBeUndefined()
    expect(denomOf('USDC', 'native', { denomFor: { USDC: 'USD' } })).toBeUndefined()
  })
  it('denomination keys are whitespace-insensitive (a " USD " value/key still resolves)', () => {
    expect(denomOf('PYUSD', '0x', { denomFor: { PYUSD: ' usd ' } })).toBe('USD')
  })
  it('a non-string denomFor value is ignored (never throws .toUpperCase out of a pure fn)', () => {
    // @ts-expect-error — deliberately malformed value
    expect(denomOf('WIDGET', '0xw', { denomFor: { WIDGET: 123 } })).toBeUndefined()
  })
  it('the STRICTEST cap wins when maxTotalPerDenom has case-variant keys (no looser-cap bypass)', () => {
    // { USD:'5', usd:'0.04' } must enforce 0.04 — a 0.05 USDC payment is refused.
    const d = evaluatePolicy(intent(), { maxTotalPerDenom: { USD: '5', usd: '0.04' } }, 0n, ctx())
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('MAX_TOTAL_DENOM')
  })
})
