import { describe, it, expect } from 'vitest'
import { Wallet } from 'xrpl'
import {
  payXrpl,
  nonceToMemoHex,
  nonceToDestinationTag,
  type XrplPayClient,
} from '../../src/drivers/xrpl/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_ISSUER = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE'
const USDC_HEX = '5553444300000000000000000000000000000000'

/** A mock node that records the submitted blob and returns a fixed engine result. */
function mockClient(engine = 'tesSUCCESS') {
  const client: XrplPayClient = {
    accountSequence: async () => 10,
    feeDrops: async () => '10',
    currentLedgerIndex: async () => 1000,
    submit: async () => ({ engine_result: engine, tx_json: { hash: 'SUBMITHASH' } }),
  }
  return client
}

/** A stub Wallet that captures the tx it's asked to sign (only sign + classicAddress are used). */
function mockWallet() {
  const captured: { tx?: any } = {}
  const wallet = {
    classicAddress: Wallet.generate().classicAddress,
    sign: (tx: any) => {
      captured.tx = tx
      return { tx_blob: 'BLOB', hash: 'SIGNEDHASH' }
    },
  } as unknown as Wallet
  return { wallet, captured }
}

function usdcAccept(payTo: string, nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'xrpl:0',
    amount: '50000',
    asset: `${USDC_HEX}:${USDC_ISSUER}`,
    payTo,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('payXrpl — builds + signs a memo-bound payment', () => {
  it('pays USDC to payTo with the nonce in a Memo + a derived DestinationTag', async () => {
    const merchant = Wallet.generate().classicAddress
    const { wallet, captured } = mockWallet()

    const ref = await payXrpl({ client: mockClient(), wallet, accept: usdcAccept(merchant, 'nonce-xyz') })

    expect(ref).toBe('SUBMITHASH')
    const tx = captured.tx
    expect(tx.TransactionType).toBe('Payment')
    expect(tx.Destination).toBe(merchant)
    expect(tx.Amount).toEqual({ currency: USDC_HEX, issuer: USDC_ISSUER, value: '0.05' })
    // The nonce is bound as the full nonce hex in a Memo (the cryptographic binding).
    expect(tx.Memos[0].Memo.MemoData).toBe(nonceToMemoHex('nonce-xyz'))
    // …plus a deterministic DestinationTag for deliverability (NOT the binding).
    expect(tx.DestinationTag).toBe(nonceToDestinationTag('nonce-xyz'))
    expect(tx.Sequence).toBe(10)
    expect(tx.LastLedgerSequence).toBe(1020)
    expect(tx.Flags).toBe(0) // never tfPartialPayment
  })

  it('pays native XRP with Amount = drops string', async () => {
    const merchant = Wallet.generate().classicAddress
    const { wallet, captured } = mockWallet()
    const base = usdcAccept(merchant)
    const accept: X402AcceptEntry = {
      ...base,
      asset: 'native',
      amount: '1000000',
      extra: { ...base.extra, symbol: 'XRP', amountFormatted: '1' },
    }

    await payXrpl({ client: mockClient(), wallet, accept })

    expect(captured.tx.Amount).toBe('1000000')
    expect(captured.tx.Destination).toBe(merchant)
  })
})

describe('payXrpl — affordability maps to one typed error (ERRORS.md §6)', () => {
  it('a tecUNFUNDED_PAYMENT engine result → InsufficientFundsError', async () => {
    const { wallet } = mockWallet()
    await expect(
      payXrpl({ client: mockClient('tecUNFUNDED_PAYMENT'), wallet, accept: usdcAccept(Wallet.generate().classicAddress) })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a tecPATH_DRY engine result (no trustline path) → InsufficientFundsError', async () => {
    const { wallet } = mockWallet()
    await expect(
      payXrpl({ client: mockClient('tecPATH_DRY'), wallet, accept: usdcAccept(Wallet.generate().classicAddress) })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a non-affordability rejection (temMALFORMED) throws a plain error, not InsufficientFunds', async () => {
    const { wallet } = mockWallet()
    const err = await payXrpl({ client: mockClient('temMALFORMED'), wallet, accept: usdcAccept(Wallet.generate().classicAddress) }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
    expect(err.message).toMatch(/temMALFORMED/)
  })
})
