import { describe, it, expect } from 'vitest'
import { verifyAlgorand, type AlgorandReader, type AlgorandTxRecord } from '../../src/drivers/algorand/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const PAY_TO = 'SSWUCC4W2CXH5UQ4SPZGBJ2ITLGNN555EZURKPP6ZUOWYHDVG3SRVJC7KE'
const PAYER = '2OT6GLZYUDWFGFAPD3ZCN7TZZ2YJD5TPVX5MZHNBTFAUATTX25DY2GC5E4'
const USDC_ID = 31566704

function reader(records: AlgorandTxRecord[]): AlgorandReader {
  return { transactionsForAccount: async () => records }
}
const failing: AlgorandReader = {
  transactionsForAccount: async () => {
    throw new Error('indexer down')
  },
}

function usdcAccept(amount = '50000'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
    amount,
    asset: String(USDC_ID),
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n-1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

function axfer(opts: Partial<AlgorandTxRecord> = {}): AlgorandTxRecord {
  return {
    id: 'TX1',
    note: 'n-1',
    txType: 'axfer',
    receiver: PAY_TO,
    amount: '50000',
    assetId: USDC_ID,
    sender: PAYER,
    roundTime: Math.floor(Date.now() / 1000),
    ...opts,
  }
}

describe('verifyAlgorand — USDC (note-bound, Template A)', () => {
  it('accepts a tx whose note == nonce and pays the required USDC to payTo', async () => {
    const res = await verifyAlgorand({ reader: reader([axfer()]), accept: usdcAccept('50000') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.transaction).toBe('TX1')
      expect(res.receipt.asset).toBe('31566704')
      expect(res.receipt.payer).toBe(PAYER)
    }
  })

  it('rejects when no tx carries our nonce (transfer_not_found)', async () => {
    const res = await verifyAlgorand({ reader: reader([axfer({ note: 'other-nonce' })]), accept: usdcAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects when the amount is too low (amount_too_low)', async () => {
    const res = await verifyAlgorand({ reader: reader([axfer({ amount: '40000' })]), accept: usdcAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects when the transfer went to a different recipient (transfer_not_found)', async () => {
    const res = await verifyAlgorand({ reader: reader([axfer({ receiver: PAYER })]), accept: usdcAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects when the asset id is wrong (transfer_not_found)', async () => {
    const res = await verifyAlgorand({ reader: reader([axfer({ assetId: 999 })]), accept: usdcAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a payment older than maxTimeoutSeconds (payment_expired)', async () => {
    const res = await verifyAlgorand({
      reader: reader([axfer({ roundTime: Math.floor(Date.now() / 1000) - 5000 })]),
      accept: usdcAccept(),
    })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('reports tx_not_found (transient) when the indexer read fails', async () => {
    const res = await verifyAlgorand({ reader: failing, accept: usdcAccept() })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifyAlgorand — native ALGO', () => {
  it('accepts a native ALGO payment (tx-type pay, no assetId) to payTo', async () => {
    const base = usdcAccept('1000000')
    const accept: X402AcceptEntry = { ...base, asset: 'native', extra: { ...base.extra, symbol: 'ALGO' } }
    const pay: AlgorandTxRecord = {
      id: 'TXPAY',
      note: 'n-1',
      txType: 'pay',
      receiver: PAY_TO,
      amount: '1000000',
      sender: PAYER,
      roundTime: Math.floor(Date.now() / 1000),
    }
    const res = await verifyAlgorand({ reader: reader([pay]), accept })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.asset).toBe('native')
  })

  it('rejects an ASA transfer when native ALGO was required (transfer_not_found)', async () => {
    const base = usdcAccept('1000000')
    const accept: X402AcceptEntry = { ...base, asset: 'native', extra: { ...base.extra, symbol: 'ALGO' } }
    // a USDC axfer carrying the nonce must NOT satisfy a native-ALGO challenge
    const res = await verifyAlgorand({ reader: reader([axfer({ amount: '1000000' })]), accept })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})
