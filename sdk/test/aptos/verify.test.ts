import { describe, it, expect } from 'vitest'
import { verifyAptos, type AptosReader, type AptosTxView } from '../../src/drivers/aptos/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC_META = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const APT_META = '0xa'
const PAY_TO = '0x3b64e41401307dbd4da6fe3a801f330a467dad85b21283021c42366dd90e49d7'
const PAYER = '0x1111111111111111111111111111111111111111111111111111111111111111'
// payTo's primary store for the asset (what reader.primaryStore returns).
const STORE = '0x5700000000000000000000000000000000000000000000000000000000000057'

function view(opts: { deposits: { store: string; amount: string }[]; success?: boolean; ts?: number }): AptosTxView {
  return {
    success: opts.success ?? true,
    timestampSeconds: opts.ts ?? Math.floor(Date.now() / 1000),
    sender: PAYER,
    deposits: opts.deposits,
  }
}
// reader that returns `v` for the tx and `store` as payTo's primary store.
const reader = (v: AptosTxView | null, store = STORE): AptosReader => ({
  getTransaction: async () => v,
  primaryStore: async () => store,
})
const failing: AptosReader = {
  getTransaction: async () => {
    throw new Error('rpc down')
  },
  primaryStore: async () => STORE,
}

function usdcAccept(amount = '50000'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'aptos:1',
    amount,
    asset: USDC_META,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('verifyAptos — USDC (digest-bound)', () => {
  it('accepts a tx that deposited the required USDC to payTo’s store', async () => {
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: STORE, amount: '50000' }] })),
      hash: 'H1',
      accept: usdcAccept('50000'),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.transaction).toBe('H1')
      expect(res.receipt.asset).toBe(USDC_META)
      expect(res.receipt.payer).toBe(PAYER)
    }
  })

  it('rejects when the delivered amount is too low (digest path → transfer_not_found)', async () => {
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: STORE, amount: '40000' }] })),
      hash: 'H1',
      accept: usdcAccept('50000'),
    })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('ignores a deposit to a different store (not payTo)', async () => {
    const other = '0x9999999999999999999999999999999999999999999999999999999999999999'
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: other, amount: '50000' }] })),
      hash: 'H1',
      accept: usdcAccept('50000'),
    })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a failed transaction', async () => {
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: STORE, amount: '50000' }], success: false })),
      hash: 'H1',
      accept: usdcAccept('50000'),
    })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: STORE, amount: '50000' }], ts: Math.floor(Date.now() / 1000) - 5000 })),
      hash: 'H1',
      accept: usdcAccept('50000'),
    })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('reports tx_not_found when the tx is unknown/pending', async () => {
    const res = await verifyAptos({ reader: reader(null), hash: 'H1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifyAptos({ reader: failing, hash: 'H1', accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifyAptos — native APT', () => {
  it('accepts a native APT delivery to payTo (FA metadata 0xa)', async () => {
    const base = usdcAccept('100000000')
    const accept: X402AcceptEntry = { ...base, asset: 'native', extra: { ...base.extra, symbol: 'APT', decimals: 8 } }
    // reader.primaryStore is for (payTo, 0xa) here — same STORE mock.
    const res = await verifyAptos({
      reader: reader(view({ deposits: [{ store: STORE, amount: '100000000' }] })),
      hash: 'H1',
      accept,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe('native')
    expect(APT_META).toBe('0xa')
  })
})
