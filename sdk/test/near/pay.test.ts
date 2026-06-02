import { describe, it, expect } from 'vitest'
import { payNear, type NearSendClient } from '../../src/drivers/near/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const PAY_TO = 'merchant.near'

function mockClient(throwErr?: Error) {
  const captured: { args?: Record<string, unknown> } = {}
  const client: NearSendClient = {
    async ftTransfer(input) {
      captured.args = input
      if (throwErr) throw throwErr
      return { hash: 'NEARTXHASH123' }
    },
  }
  return { client, captured }
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
  it('an unregistered recipient (storage_deposit) surfaces a clear, non-affordability error', async () => {
    const { client } = mockClient(new Error('Smart contract panicked: The account merchant.near is not registered'))
    const err = await payNear({ client, accept: usdcAccept() }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
    expect(err.message).toMatch(/storage_deposit|not registered/)
  })

  it('an insufficient-balance failure → InsufficientFundsError', async () => {
    const { client } = mockClient(new Error("The account doesn't have enough balance"))
    await expect(payNear({ client, accept: usdcAccept() })).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})
