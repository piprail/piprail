import { describe, it, expect } from 'vitest'
import { Wallet } from 'xrpl'
import {
  verifyXrpl,
  type XrplReader,
  type XrplTxRecord,
  type XrplDeliveredAmount,
} from '../../src/drivers/xrpl/verify.js'
import { nonceToMemoHex } from '../../src/drivers/xrpl/pay.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_ISSUER = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE'
const USDC_HEX = '5553444300000000000000000000000000000000'
const MERCHANT = Wallet.generate().classicAddress
const PAYER = Wallet.generate().classicAddress

/** Ripple-epoch "now" (seconds since 2000-01-01Z). */
const RIPPLE_NOW = () => Math.floor(Date.now() / 1000) - 946684800

function usdcAccept(amount = '50000', nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'xrpl:0',
    amount,
    asset: `${USDC_HEX}:${USDC_ISSUER}`,
    payTo: MERCHANT,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}
function nativeAccept(amount = '1000000', nonce = 'nonce-1'): X402AcceptEntry {
  return { ...usdcAccept(amount, nonce), asset: 'native', extra: { ...usdcAccept(amount, nonce).extra, symbol: 'XRP' } }
}

function txRec(opts: {
  nonce: string
  delivered: XrplDeliveredAmount
  validated?: boolean
  result?: string
  date?: number
  to?: string
  hash?: string
  type?: string
}): XrplTxRecord {
  return {
    hash: opts.hash ?? 'tx-our',
    validated: opts.validated ?? true,
    result: opts.result ?? 'tesSUCCESS',
    TransactionType: opts.type ?? 'Payment',
    Account: PAYER,
    Destination: opts.to ?? MERCHANT,
    Memos: [{ Memo: { MemoData: nonceToMemoHex(opts.nonce) } }],
    delivered_amount: opts.delivered,
    date: opts.date ?? RIPPLE_NOW(),
  }
}

const usdcDelivered = (value: string): XrplDeliveredAmount => ({ currency: USDC_HEX, issuer: USDC_ISSUER, value })
const reader = (txs: XrplTxRecord[]): XrplReader => ({ transactionsForAccount: async () => txs })
const failingReader: XrplReader = {
  transactionsForAccount: async () => {
    throw new Error('429 rate limited')
  },
}

describe('verifyXrpl — USDC (memo-bound, partial-payment safe)', () => {
  it('accepts a delivered payment of the required amount whose Memo == nonce', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05') })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe('tx-our')
      expect(res.receipt.asset).toBe(`${USDC_HEX}:${USDC_ISSUER}`)
      expect(res.receipt.payer).toBe(PAYER)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('uses delivered_amount, NOT Amount — a partial payment that delivered too little is rejected', async () => {
    // delivered_amount is small even if the (unmodelled) Amount field were large.
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.01') })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('does not match a tx carrying a different nonce (challenge-bound)', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'someone-elses-nonce', delivered: usdcDelivered('0.05') })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a not-yet-validated tx as transient (insufficient_confirmations)', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05'), validated: false })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'insufficient_confirmations' })
  })

  it('rejects a failed (non-tesSUCCESS) transaction', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05'), result: 'tecPATH_PARTIAL' })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05'), date: RIPPLE_NOW() - 5000 })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('BREAK-IT: a MISSING ledger date fails CLOSED (payment_expired) — recency window must never be skipped', async () => {
    // When an account_tx entry carries no numeric `date`, the old `typeof === number` guard skipped
    // recency entirely → an aged-out, validated, nonce-bound proof could re-verify after the bounded
    // used-set evicted its nonce (a replay). Now it fails closed like Stellar/Solana/Sui.
    const rec = txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05') })
    delete (rec as { date?: number }).date // genuinely ABSENT (the helper defaults it to a recent date)
    const res = await verifyXrpl({ reader: reader([rec]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a tx that carries our nonce but delivered the wrong asset', async () => {
    const wrong: XrplDeliveredAmount = { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '0.05' }
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: wrong })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('does not match a Payment to a different recipient', async () => {
    const someoneElse = Wallet.generate().classicAddress
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('0.05'), to: someoneElse })]), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('picks our tx out of a batch of unrelated ones', async () => {
    const res = await verifyXrpl({
      reader: reader([
        txRec({ hash: 'tx-x', nonce: 'unrelated-a', delivered: usdcDelivered('9') }),
        txRec({ hash: 'tx-our', nonce: 'nonce-1', delivered: usdcDelivered('0.05') }),
        txRec({ hash: 'tx-y', nonce: 'unrelated-b', delivered: usdcDelivered('1') }),
      ]),
      accept: usdcAccept('50000', 'nonce-1'),
    })
    expect(res.ok).toBe(true)
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifyXrpl({ reader: failingReader, accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifyXrpl — native XRP', () => {
  it('accepts a native payment delivered as drops with our nonce', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: '1000000' })]), accept: nativeAccept('1000000', 'nonce-1') })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe('native')
  })

  it('rejects native amount too low', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: '500000' })]), accept: nativeAccept('1000000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('does not treat an IOU delivery as a native one', async () => {
    const res = await verifyXrpl({ reader: reader([txRec({ nonce: 'nonce-1', delivered: usdcDelivered('1') })]), accept: nativeAccept('1000000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})
