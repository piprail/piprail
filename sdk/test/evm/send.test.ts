import { describe, it, expect } from 'vitest'
import { BaseError } from 'viem'
import { evmDriver } from '../../src/drivers/evm/index.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

// A custom EVM chain so the driver builds offline (the publicClient it makes is
// never used here — send() goes through the bring-your-own walletClient).
const NET = evmDriver.resolve({ chain: { id: 8453, rpcUrl: 'http://127.0.0.1:1' } })!

function nativeAccept(): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'eip155:8453',
    amount: '1000000000000000000',
    asset: 'native',
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 18, minConfirmations: 1, amountFormatted: '1' },
  }
}

/** Bind a bring-your-own walletClient whose broadcast throws `err`. */
function walletThatThrows(err: unknown) {
  return {
    walletClient: {
      account: { address: '0x2222222222222222222222222222222222222222' },
      sendTransaction: async () => {
        throw err
      },
    },
  }
}

describe('evmDriver.send — affordability always maps to InsufficientFundsError', () => {
  it('maps a viem STRUCTURED insufficient-funds error (BaseError.walk) → InsufficientFundsError', async () => {
    // A nested error whose .name is 'InsufficientFundsError' inside a viem BaseError —
    // the exact signal isViemInsufficientFunds detects.
    const inner = new Error('exceeds balance')
    inner.name = 'InsufficientFundsError'
    const viemErr = new BaseError('Execution reverted', { cause: inner })
    const handle = NET.bindWallet(walletThatThrows(viemErr))
    const err = await NET.send(handle, nativeAccept()).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientFundsError)
    expect(err.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('maps a message-only insufficient-funds error via the shared backstop → InsufficientFundsError', async () => {
    const handle = NET.bindWallet(walletThatThrows(new Error('insufficient funds for gas * price + value')))
    const err = await NET.send(handle, nativeAccept()).catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientFundsError)
    expect(err.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('rethrows a non-affordability error unchanged (never swallowed/mis-mapped)', async () => {
    const boom = new Error('nonce too low')
    const handle = NET.bindWallet(walletThatThrows(boom))
    const err = await NET.send(handle, nativeAccept()).catch((e) => e)
    expect(err).toBe(boom)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
  })
})
