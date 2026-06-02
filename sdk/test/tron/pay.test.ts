import { describe, it, expect } from 'vitest'
import { payTron, type TronPayClient, type TronUnsignedTx } from '../../src/drivers/tron/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const PAY_TO = 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC'
const FROM = 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs'
const PK = 'a'.repeat(64)

interface Captured {
  args?: { contract: string; selector: string; options: unknown; params: { type: string; value: unknown }[]; issuer: string }
  memoData?: string
  signedWith?: string
}

function mockClient(broadcast?: { result?: boolean; code?: string; message?: string; txid?: string }) {
  const captured: Captured = {}
  const client: TronPayClient = {
    transactionBuilder: {
      triggerSmartContract: async (contract, selector, options, params, issuer) => {
        captured.args = { contract, selector, options, params, issuer }
        return { result: { result: true }, transaction: { txID: 'BUILTTX' } as TronUnsignedTx }
      },
      addUpdateData: async (tx, data) => {
        captured.memoData = data
        return { ...tx, txID: 'MEMOTX' }
      },
    },
    trx: {
      sign: async (tx, privateKey) => {
        captured.signedWith = privateKey
        return { txID: tx.txID }
      },
      sendRawTransaction: async (signed) =>
        broadcast ?? { result: true, txid: signed.txID },
    },
  }
  return { client, captured }
}

function usdtAccept(nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'tron:mainnet',
    amount: '50000',
    asset: USDT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDT' },
  }
}

describe('payTron — digest-bound by default (no memo)', () => {
  it('builds a transfer(address,uint256) to payTo, signs, broadcasts, returns the txid', async () => {
    const { client, captured } = mockClient()
    const ref = await payTron({ client, from: FROM, privateKey: PK, tokenAddress: USDT, accept: usdtAccept() })

    expect(ref).toBe('BUILTTX')
    expect(captured.args!.contract).toBe(USDT)
    expect(captured.args!.selector).toBe('transfer(address,uint256)')
    expect(captured.args!.params).toEqual([
      { type: 'address', value: PAY_TO },
      { type: 'uint256', value: '50000' },
    ])
    expect(captured.args!.issuer).toBe(FROM)
    expect(captured.signedWith).toBe(PK)
    // digest mode → no memo attached
    expect(captured.memoData).toBeUndefined()
  })
})

describe('payTron — memo-binding opt-in', () => {
  it('attaches the nonce as a tx-level memo when bind: "memo"', async () => {
    const { client, captured } = mockClient()
    const ref = await payTron({
      client,
      from: FROM,
      privateKey: PK,
      tokenAddress: USDT,
      accept: usdtAccept('nonce-xyz'),
      bind: 'memo',
    })
    expect(captured.memoData).toBe('nonce-xyz')
    expect(ref).toBe('MEMOTX') // addUpdateData recomputed the txID
  })
})

describe('payTron — affordability maps to one typed error (ERRORS.md §6)', () => {
  it('a broadcast failure for insufficient balance → InsufficientFundsError', async () => {
    const { client } = mockClient({ result: false, code: 'CONTRACT_VALIDATE_ERROR', message: 'balance is not sufficient' })
    await expect(
      payTron({ client, from: FROM, privateKey: PK, tokenAddress: USDT, accept: usdtAccept() })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a non-affordability broadcast failure throws a plain error', async () => {
    const { client } = mockClient({ result: false, code: 'SIGERROR', message: 'signature error' })
    const err = await payTron({ client, from: FROM, privateKey: PK, tokenAddress: USDT, accept: usdtAccept() }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(InsufficientFundsError)
  })
})
