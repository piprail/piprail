import { describe, it, expect } from 'vitest'
import {
  summarizePlan,
  explainDecline,
  formatSpendReport,
  PaymentDeclinedError,
  PaymentTimeoutError,
  MaxRetriesExceededError,
  ConfirmationTimeoutError,
  InsufficientFundsError,
  NoCompatibleAcceptError,
  type PaymentPlan,
  type SpendSummary,
} from '../src/index.js'

const payablePlan = {
  url: 'https://api.example.com/r',
  network: 'eip155:8453',
  status: 'ready',
  payable: true,
  best: {
    accept: { network: 'eip155:8453' },
    quote: { amountFormatted: '0.05', symbol: 'USDC' },
    cost: { feeFormatted: '0.000021', feeSymbol: 'ETH' },
  },
  options: [{}, {}], // best + one other
  fundingHint: null,
} as unknown as PaymentPlan

const blockedPlan = {
  url: 'https://api.example.com/r',
  network: 'eip155:8453',
  status: 'blocked',
  payable: false,
  best: null,
  options: [],
  fundingHint: 'top up 0.50 USDC',
} as unknown as PaymentPlan

describe('summarizePlan', () => {
  it('renders a payable plan with amount, chain, gas, and other-rail count', () => {
    expect(summarizePlan(payablePlan)).toBe(
      'Payable: 0.05 USDC on eip155:8453 (gas ~0.000021 ETH). 1 other rail(s) not settleable.'
    )
  })
  it('renders a blocked plan from its fundingHint', () => {
    expect(summarizePlan(blockedPlan)).toBe('NOT payable: top up 0.50 USDC')
  })
  it('renders null (not gated) plainly', () => {
    expect(summarizePlan(null)).toBe('No payment required — the URL is not payment-gated.')
  })
})

describe('explainDecline', () => {
  it('passes a PaymentDeclinedError message through verbatim', () => {
    expect(explainDecline(new PaymentDeclinedError('Payment refused by policy: over maxAmount'))).toBe(
      'Payment refused by policy: over maxAmount'
    )
  })
  it('carries the never-re-pay + .ref rule for EVERY broadcast-but-unconfirmed code', () => {
    for (const err of [
      new PaymentTimeoutError('timed out', { ref: '0xabc' }),
      new MaxRetriesExceededError('still 402', { ref: '0xdef' }),
      new ConfirmationTimeoutError('not confirmed'),
    ]) {
      const out = explainDecline(err)
      expect(out).toMatch(/never re-pay/)
      expect(out).toContain('.ref')
    }
  })
  it('guides a top-up for insufficient funds', () => {
    expect(explainDecline(new InsufficientFundsError('low'))).toMatch(/top up/i)
  })
  it('surfaces the no-rail message (it already distinguishes wrong-chain vs enable-exact)', () => {
    const msg = "This 402 is payable only via the standard 'exact' rail; enable schemes."
    expect(explainDecline(new NoCompatibleAcceptError(msg))).toBe(msg)
  })
  it('wraps a non-PipRailError as a plain failure', () => {
    expect(explainDecline(new Error('socket hang up'))).toBe('Payment failed: socket hang up')
  })
})

describe('formatSpendReport', () => {
  const empty: SpendSummary = { count: 0, byAsset: [], records: [] }
  const two: SpendSummary = {
    count: 3,
    records: [],
    byAsset: [
      { network: 'eip155:8453', asset: '0xusdc', symbol: 'USDC', decimals: 6, totalBase: '120000', totalFormatted: '0.12', count: 2 },
      { network: 'solana:x', asset: 'mint', symbol: 'USDC', decimals: 6, totalBase: '50000', totalFormatted: '0.05', count: 1 },
    ],
  }
  it('says "no payments yet" when empty', () => {
    expect(formatSpendReport(empty)).toBe('No payments yet.')
  })
  it('joins per-asset lines with "; " and NEVER sums across tokens', () => {
    const out = formatSpendReport(two)
    expect(out).toBe('0.12 USDC on eip155:8453 (2 payments); 0.05 USDC on solana:x (1 payment)')
    expect(out).not.toContain('0.17') // no cross-token aggregate
  })
})
