import { describe, it, expect } from 'vitest'
import { Keypair, hash } from '@stellar/stellar-sdk'
import { verifyStellar, type StellarReader, type StellarTxRecord, type StellarPaymentRecord } from '../../src/drivers/stellar/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const MERCHANT = Keypair.random().publicKey()
const PAYER = Keypair.random().publicKey()
const NOW_ISO = () => new Date().toISOString()

/** Horizon encodes a MEMO_HASH as base64 of the 32 bytes. */
function memoB64(nonce: string): string {
  return Buffer.from(hash(Buffer.from(nonce, 'utf8'))).toString('base64')
}

function usdcAccept(amount = '500000', nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'stellar:pubnet',
    amount,
    asset: `USDC:${USDC_ISSUER}`,
    payTo: MERCHANT,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 7, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}
function nativeAccept(amount = '10000000', nonce = 'nonce-1'): X402AcceptEntry {
  return { ...usdcAccept(amount, nonce), asset: 'native', extra: { ...usdcAccept(amount, nonce).extra, symbol: 'XLM' } }
}

function txRec(opts: { hash?: string; nonce: string; successful?: boolean; created_at?: string }): StellarTxRecord {
  return {
    hash: opts.hash ?? 'tx-our',
    successful: opts.successful ?? true,
    memo: memoB64(opts.nonce),
    memo_type: 'hash',
    created_at: opts.created_at ?? NOW_ISO(),
  }
}
function usdcPay(opts: { to?: string; amount: string; from?: string; code?: string; issuer?: string }): StellarPaymentRecord {
  return {
    type: 'payment',
    from: opts.from ?? PAYER,
    to: opts.to ?? MERCHANT,
    asset_type: 'credit_alphanum4',
    asset_code: opts.code ?? 'USDC',
    asset_issuer: opts.issuer ?? USDC_ISSUER,
    amount: opts.amount,
  }
}
function nativePay(opts: { to?: string; amount: string; from?: string }): StellarPaymentRecord {
  return { type: 'payment', from: opts.from ?? PAYER, to: opts.to ?? MERCHANT, asset_type: 'native', amount: opts.amount }
}

/** sha256(nonce) as hex — Horizon normally returns base64, but verify tolerates hex too. */
function memoHex(nonce: string): string {
  return Buffer.from(hash(Buffer.from(nonce, 'utf8'))).toString('hex')
}
/** A tx with an explicit memo + memo_type (for the binding-edge tests). */
function rawTxRec(opts: { memo: string; memo_type: string; hash?: string }): StellarTxRecord {
  return { hash: opts.hash ?? 'tx-our', successful: true, memo: opts.memo, memo_type: opts.memo_type, created_at: NOW_ISO() }
}

function reader(txs: StellarTxRecord[], payments: Record<string, StellarPaymentRecord[]>): StellarReader {
  return {
    transactionsForAccount: async () => txs,
    paymentsForTransaction: async (h) => payments[h] ?? [],
  }
}
const failingReader: StellarReader = {
  transactionsForAccount: async () => { throw new Error('429 rate limited') },
  paymentsForTransaction: async () => [],
}

describe('verifyStellar — G6: scans a full page so a busy merchant can\'t overflow the recency window', () => {
  it('requests 200 txs (the provider max), not 50', async () => {
    let askedLimit = -1
    const capturing: StellarReader = {
      transactionsForAccount: async (_acct, limit) => { askedLimit = limit; return [txRec({ nonce: 'nonce-1' })] },
      paymentsForTransaction: async () => [usdcPay({ amount: '0.0500000' })],
    }
    const res = await verifyStellar({ reader: capturing, accept: usdcAccept('500000', 'nonce-1') })
    expect(res.ok).toBe(true)
    expect(askedLimit).toBe(200)
  })
})

describe('verifyStellar — USDC (memo-bound)', () => {
  it('accepts a payment of the required amount whose tx memo == sha256(nonce)', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe('tx-our')
      expect(res.receipt.asset).toBe(`USDC:${USDC_ISSUER}`)
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.network).toBe('stellar:pubnet')
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('rejects when the paid amount is too low', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [usdcPay({ amount: '0.0400000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('sums multiple payment ops in the same tx', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], {
      'tx-our': [usdcPay({ amount: '0.0300000' }), usdcPay({ amount: '0.0300000' })],
    })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res.ok).toBe(true) // 0.06 ≥ 0.05
  })

  it('does not match a tx carrying a different nonce (challenge-bound)', async () => {
    const r = reader([txRec({ nonce: 'someone-elses-nonce' })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a failed (unsuccessful) transaction', async () => {
    const r = reader([txRec({ nonce: 'nonce-1', successful: false })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const old = new Date(Date.now() - 5000 * 1000).toISOString()
    const r = reader([txRec({ nonce: 'nonce-1', created_at: old })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('BREAK-IT: an unparseable created_at fails CLOSED (payment_expired), never open (NaN age)', async () => {
    const r = reader([txRec({ nonce: 'nonce-1', created_at: 'not-a-date' })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a tx that carries our nonce but pays the wrong asset', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [usdcPay({ amount: '0.0500000', code: 'EURC' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a tx that carries our nonce but pays the wrong recipient', async () => {
    const someoneElse = Keypair.random().publicKey()
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [usdcPay({ amount: '0.0500000', to: someoneElse })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('picks our tx out of a batch of unrelated ones', async () => {
    const r = reader(
      [txRec({ hash: 'tx-x', nonce: 'unrelated-a' }), txRec({ hash: 'tx-our', nonce: 'nonce-1' }), txRec({ hash: 'tx-y', nonce: 'unrelated-b' })],
      { 'tx-our': [usdcPay({ amount: '0.0500000' })] }
    )
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res.ok).toBe(true)
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifyStellar({ reader: failingReader, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('ignores a MEMO_TEXT carrying the nonce — only MEMO_HASH binds', async () => {
    const r = reader([rawTxRec({ memo: 'nonce-1', memo_type: 'text' })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('matches a hash memo Horizon returns as hex (defensive fallback)', async () => {
    const r = reader([rawTxRec({ memo: memoHex('nonce-1'), memo_type: 'hash' })], { 'tx-our': [usdcPay({ amount: '0.0500000' })] })
    const res = await verifyStellar({ reader: r, accept: usdcAccept('500000', 'nonce-1') })
    expect(res.ok).toBe(true)
  })

  it('verifies an EURC payment (a different asset code on the same tx)', async () => {
    const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
    const accept = { ...usdcAccept('500000', 'nonce-1'), asset: `EURC:${EURC_ISSUER}` }
    const r = reader([txRec({ nonce: 'nonce-1' })], {
      'tx-our': [usdcPay({ amount: '0.0500000', code: 'EURC', issuer: EURC_ISSUER })],
    })
    const res = await verifyStellar({ reader: r, accept })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe(`EURC:${EURC_ISSUER}`)
  })
})

describe('verifyStellar — native XLM', () => {
  it('accepts a native payment of the required lumens with our nonce', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [nativePay({ amount: '1.0000000' })] })
    const res = await verifyStellar({ reader: r, accept: nativeAccept('10000000', 'nonce-1') })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe('native')
  })

  it('rejects native amount too low', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [nativePay({ amount: '0.5000000' })] })
    const res = await verifyStellar({ reader: r, accept: nativeAccept('10000000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('does not treat a USDC payment as a native one', async () => {
    const r = reader([txRec({ nonce: 'nonce-1' })], { 'tx-our': [usdcPay({ amount: '1.0000000' })] })
    const res = await verifyStellar({ reader: r, accept: nativeAccept('10000000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})
