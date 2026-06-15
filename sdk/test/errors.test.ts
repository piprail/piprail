import { describe, it, expect } from 'vitest'
import {
  PipRailError,
  InsufficientFundsError,
  RecipientNotReadyError,
  UnknownTokenError,
  WrongFamilyError,
  WrongChainError,
  ConfirmationTimeoutError,
  PaymentTimeoutError,
  MaxRetriesExceededError,
  InvalidEnvelopeError,
  NoCompatibleAcceptError,
  UnsupportedSchemeError,
  NonReplayableBodyError,
  MissingDriverError,
  UnsupportedNetworkError,
  toInsufficientFundsError,
} from '../src/index.js'

describe('typed error vocabulary — stable codes + PipRailError lineage', () => {
  // Locks the thrown-error half of the standard (ERRORS.md §2): every class is a
  // PipRailError, carries its documented SCREAMING_SNAKE .code, and self-names.
  const cases: ReadonlyArray<readonly [PipRailError, string]> = [
    [new WrongFamilyError('x'), 'WRONG_FAMILY'],
    [new UnknownTokenError('x'), 'UNKNOWN_TOKEN'],
    [new InsufficientFundsError('x'), 'INSUFFICIENT_FUNDS'],
    [new RecipientNotReadyError('x'), 'RECIPIENT_NOT_READY'],
    [new WrongChainError('x'), 'WRONG_CHAIN'],
    [new ConfirmationTimeoutError('x'), 'CONFIRMATION_TIMEOUT'],
    [new PaymentTimeoutError('x'), 'PAYMENT_TIMEOUT'],
    [new MaxRetriesExceededError('x'), 'MAX_RETRIES_EXCEEDED'],
    [new InvalidEnvelopeError('x'), 'INVALID_ENVELOPE'],
    [new NoCompatibleAcceptError('x'), 'NO_COMPATIBLE_ACCEPT'],
    [new UnsupportedSchemeError('x'), 'UNSUPPORTED_SCHEME'],
    [new NonReplayableBodyError('x'), 'NON_REPLAYABLE_BODY'],
    [new MissingDriverError('x'), 'MISSING_DRIVER'],
    [new UnsupportedNetworkError('x'), 'UNSUPPORTED_NETWORK'],
  ]
  it.each(cases)('%o has the right .code, lineage, and name', (err, code) => {
    expect(err).toBeInstanceOf(PipRailError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(code)
    expect(err.name).toBe(err.constructor.name)
  })

  it('preserves an error cause (for debugging the underlying chain error)', () => {
    const cause = new Error('horizon 404')
    expect(new ConfirmationTimeoutError('timed out', { cause }).cause).toBe(cause)
  })
})

describe('toInsufficientFundsError — one affordability error for every chain', () => {
  // Real messages seen from viem (EVM), web3.js (Solana), @ton/* (TON) and
  // Horizon (Stellar) when the payer can't cover the transfer.
  const mapped = [
    'insufficient funds for gas * price + value',
    'Insufficient Balance',
    'insufficient lamports',
    'transfer amount exceeds balance',
    'tx failed: op_underfunded',
    'account has low_reserve',
    'not enough XLM to cover the fee',
    // viem/geth gas-estimation shortfall on a no-native-balance wallet
    'Execution reverted ... gas required exceeds allowance (0)',
  ]
  it.each(mapped)('maps %j → InsufficientFundsError', (msg) => {
    const e = toInsufficientFundsError(new Error(msg))
    expect(e).toBeInstanceOf(InsufficientFundsError)
    expect(e).toBeInstanceOf(PipRailError)
    expect(e?.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('returns null for unrelated errors so they propagate unchanged', () => {
    expect(toInsufficientFundsError(new Error('nonce too low'))).toBeNull()
    expect(toInsufficientFundsError(new Error('429 Too Many Requests'))).toBeNull()
    expect(toInsufficientFundsError('a bare string')).toBeNull()
    expect(toInsufficientFundsError(undefined)).toBeNull()
    // an ERC-20 *approve* "insufficient allowance" is NOT a funds shortfall — must NOT be mis-mapped
    expect(toInsufficientFundsError(new Error('ERC20: insufficient allowance'))).toBeNull()
  })

  it('preserves the original error as `cause`', () => {
    const original = new Error('insufficient funds')
    const e = toInsufficientFundsError(original)
    expect(e?.cause).toBe(original)
  })
})
