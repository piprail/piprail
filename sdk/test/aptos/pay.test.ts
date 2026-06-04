import { describe, it, expect } from 'vitest'
import { Account } from '@aptos-labs/ts-sdk'
import { payAptos, type AptosPayClient, type AptosEntryData } from '../../src/drivers/aptos/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_META = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const PAY_TO = Account.generate().accountAddress.toString()

interface Captured {
  data?: AptosEntryData
  submitted?: boolean
}

function mockClient(opts?: { submitThrows?: Error }) {
  const captured: Captured = {}
  const client: AptosPayClient = {
    async build(input) {
      captured.data = input.data
      return { __raw: true }
    },
    async signSubmit() {
      if (opts?.submitThrows) throw opts.submitThrows
      captured.submitted = true
      return { hash: 'APTHASH123' }
    },
  }
  return { client, captured }
}

function usdcAccept(asset = USDC_META): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'aptos:1',
    amount: '50000',
    asset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'nonce-1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('payAptos — builds + submits a primary_fungible_store transfer (digest-bound)', () => {
  it('builds the FA transfer with the token metadata + amount, returns the hash', async () => {
    const { client, captured } = mockClient()
    const ref = await payAptos({ client, signer: {}, sender: PAY_TO, accept: usdcAccept() })
    expect(ref).toBe('APTHASH123')
    expect(captured.submitted).toBe(true)
    expect(captured.data?.function).toBe('0x1::primary_fungible_store::transfer')
    expect(captured.data?.typeArguments).toEqual(['0x1::fungible_asset::Metadata'])
    expect(captured.data?.functionArguments).toEqual([USDC_META, PAY_TO, '50000'])
  })

  it('native APT transfers the APT FA metadata (0xa)', async () => {
    const { client, captured } = mockClient()
    const base = usdcAccept()
    const accept: X402AcceptEntry = {
      ...base,
      asset: 'native',
      amount: '100000000',
      extra: { ...base.extra, symbol: 'APT', decimals: 8, amountFormatted: '1' },
    }
    const ref = await payAptos({ client, signer: {}, sender: PAY_TO, accept })
    expect(ref).toBe('APTHASH123')
    expect(captured.data?.functionArguments?.[0]).toBe('0xa')
  })
})

describe('payAptos — affordability maps to one typed error (ERRORS.md §6)', () => {
  it('an "insufficient balance" submit failure → InsufficientFundsError', async () => {
    const { client } = mockClient({ submitThrows: new Error('EINSUFFICIENT_BALANCE: not enough coins') })
    await expect(payAptos({ client, signer: {}, sender: PAY_TO, accept: usdcAccept() })).rejects.toBeInstanceOf(
      InsufficientFundsError
    )
  })
})
