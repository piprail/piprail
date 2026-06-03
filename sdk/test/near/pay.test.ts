import { describe, it, expect } from 'vitest'
import { payNear, payNearNative, type NearSendClient } from '../../src/drivers/near/pay.js'
import { InsufficientFundsError, RecipientNotReadyError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const PAY_TO = 'merchant.near'

function mockClient(throwErr?: Error) {
  const captured: { args?: Record<string, unknown>; native?: Record<string, unknown> } = {}
  const client: NearSendClient = {
    async ftTransfer(input) {
      captured.args = input
      if (throwErr) throw throwErr
      return { hash: 'NEARTXHASH123' }
    },
    async nativeTransfer(input) {
      captured.native = input
      if (throwErr) throw throwErr
      return { hash: 'NEARNATIVE456' }
    },
  }
  return { client, captured }
}

function nativeAccept(): X402AcceptEntry {
  return {
    scheme: 'onchain-proof', network: 'near:mainnet', amount: '10000000000000000000000', asset: 'native', payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 24, minConfirmations: 1, amountFormatted: '0.01', symbol: 'NEAR' },
  }
}

function usdcAccept(nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof', network: 'near:mainnet', amount: '50000', asset: USDC, payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('payNear — ft_transfer with the nonce in the memo (Template A binding)', () => {
  it('calls ft_transfer to payTo with the nonce memo + 1 yoctoNEAR, returns the hash', async () => {
    const { client, captured } = mockClient()
    const hash = await payNear({ client, accept: usdcAccept('nonce-xyz') })
    expect(hash).toBe('NEARTXHASH123')
    expect(captured.args).toMatchObject({
      contractId: USDC,
      receiverId: PAY_TO,
      amount: '50000',
      memo: 'nonce-xyz', // the challenge nonce — the binding
      deposit: 1n, // mandatory anti-phishing yoctoNEAR
    })
    expect(captured.args!.gas).toBe(30_000_000_000_000n)
  })
})

describe('payNear — error mapping (ERRORS.md §6)', () => {
  it('an unregistered recipient (storage_deposit) → RecipientNotReadyError (not the payer)', async () => {
    const raw = new Error('Smart contract panicked: The account merchant.near is not registered')
    const { client } = mockClient(raw)
    const err = await payNear({ client, accept: usdcAccept() }).catch((e) => e)
    expect(err).toBeInstanceOf(RecipientNotReadyError)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
    expect(err.code).toBe('RECIPIENT_NOT_READY')
    expect(err.message).toMatch(/storage_deposit|not registered/)
    expect(err.cause).toBe(raw) // raw NEAR panic preserved
  })

  it('an insufficient-balance failure → InsufficientFundsError', async () => {
    const { client } = mockClient(new Error("The account doesn't have enough balance"))
    await expect(payNear({ client, accept: usdcAccept() })).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})

describe('payNearNative — plain Transfer (digest-bound; no memo, no storage_deposit)', () => {
  it('calls nativeTransfer to payTo with the amount and returns the hash', async () => {
    const { client, captured } = mockClient()
    const hash = await payNearNative({ client, accept: nativeAccept() })
    expect(hash).toBe('NEARNATIVE456')
    expect(captured.native).toMatchObject({ receiverId: PAY_TO, amount: '10000000000000000000000' })
  })

  it('maps an insufficient-balance failure → InsufficientFundsError', async () => {
    const { client } = mockClient(new Error("doesn't have enough balance"))
    await expect(payNearNative({ client, accept: nativeAccept() })).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})
