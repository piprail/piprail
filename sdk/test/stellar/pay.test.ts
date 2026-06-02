import { describe, it, expect } from 'vitest'
import { Account, Keypair, hash } from '@stellar/stellar-sdk'
import { payStellar } from '../../src/drivers/stellar/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** A mock Horizon that records the submitted tx and returns a fixed hash. */
function mockServer() {
  const captured: { tx: any } = { tx: null }
  const server = {
    loadAccount: async (pk: string) => new Account(pk, '100'),
    submitTransaction: async (tx: any) => {
      captured.tx = tx
      return { hash: 'abc123hash' } as never
    },
  }
  return { server: server as never, captured }
}

function usdcAccept(payTo: string, nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'stellar:pubnet',
    amount: '500000',
    asset: `USDC:${USDC_ISSUER}`,
    payTo,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('payStellar — builds + signs a memo-bound payment', () => {
  it('pays USDC to payTo, amount = amountFormatted, MEMO_HASH = sha256(nonce)', async () => {
    const payer = Keypair.random()
    const merchant = Keypair.random().publicKey()
    const { server, captured } = mockServer()

    const ref = await payStellar({ server, keypair: payer, accept: usdcAccept(merchant, 'nonce-xyz') })

    expect(ref).toBe('abc123hash')
    const tx = captured.tx
    expect(tx.operations).toHaveLength(1)
    const op = tx.operations[0]
    expect(op.type).toBe('payment')
    expect(op.destination).toBe(merchant)
    // The SDK canonicalises the amount to Stellar's 7dp form (same value as '0.05').
    expect(Number(op.amount)).toBe(0.05)
    expect(op.asset.getCode()).toBe('USDC')
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER)
    // The nonce is bound as a 32-byte MEMO_HASH = sha256(nonce).
    expect(tx.memo.type).toBe('hash')
    expect(Buffer.from(tx.memo.value).toString('hex')).toBe(
      Buffer.from(hash(Buffer.from('nonce-xyz', 'utf8'))).toString('hex')
    )
    // Signed by the payer.
    expect(tx.signatures.length).toBe(1)
  })

  it('pays native XLM with Asset.native()', async () => {
    const payer = Keypair.random()
    const merchant = Keypair.random().publicKey()
    const { server, captured } = mockServer()
    const base = usdcAccept(merchant)
    const accept: X402AcceptEntry = {
      ...base,
      asset: 'native',
      amount: '10000000',
      extra: { ...base.extra, symbol: 'XLM', amountFormatted: '1' },
    }

    await payStellar({ server, keypair: payer, accept })

    const op = captured.tx.operations[0]
    expect(op.asset.isNative()).toBe(true)
    expect(Number(op.amount)).toBe(1)
    expect(op.destination).toBe(merchant)
  })
})

describe('payStellar — affordability maps to one typed error (ERRORS.md §6)', () => {
  it('an unfunded source account (loadAccount 404) → InsufficientFundsError', async () => {
    const payer = Keypair.random()
    const merchant = Keypair.random().publicKey()
    const server = {
      loadAccount: async () => {
        const e = new Error('Resource Missing') as Error & { response?: { status: number } }
        e.name = 'NotFoundError'
        e.response = { status: 404 }
        throw e
      },
      submitTransaction: async () => ({ hash: 'unused' }) as never,
    }
    await expect(
      payStellar({ server: server as never, keypair: payer, accept: usdcAccept(merchant) })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('a Horizon op_underfunded submit failure → InsufficientFundsError', async () => {
    const payer = Keypair.random()
    const merchant = Keypair.random().publicKey()
    const server = {
      loadAccount: async (pk: string) => new Account(pk, '100'),
      submitTransaction: async () => {
        const e = new Error('tx_failed') as Error & { response?: unknown }
        e.response = {
          data: { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } },
        }
        throw e
      },
    }
    await expect(
      payStellar({ server: server as never, keypair: payer, accept: usdcAccept(merchant) })
    ).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})
