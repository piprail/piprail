import { describe, it, expect } from 'vitest'
import {
  verifyNear,
  parseFtTransferEvent,
  type NearReader,
  type NearTxView,
} from '../../src/drivers/near/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const PAY_TO = 'merchant.near'
const PAYER = 'alice.near'

/** A NEP-297 EVENT_JSON ft_transfer log line. */
function ftLog(opts: { from?: string; to: string; amount: string; memo: string }): string {
  return (
    'EVENT_JSON:' +
    JSON.stringify({
      standard: 'nep141',
      version: '1.0.0',
      event: 'ft_transfer',
      data: [{ old_owner_id: opts.from ?? PAYER, new_owner_id: opts.to, amount: opts.amount, memo: opts.memo }],
    })
  )
}

function txView(opts: { logs: string[]; executorId?: string; success?: boolean; ts?: number }): NearTxView {
  return {
    success: opts.success ?? true,
    receipts: [{ executorId: opts.executorId ?? USDC, logs: opts.logs }],
    ...(opts.ts != null ? { timestampMs: opts.ts } : {}),
  }
}
const reader = (v: NearTxView | null): NearReader => ({ txStatus: async () => v })
const failing: NearReader = { txStatus: async () => { throw new Error('rpc down') } }

function usdcAccept(amount = '50000', nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof', network: 'near:mainnet', amount, asset: USDC, payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

const ARGS = { hash: 'H1', senderId: PAYER }

describe('verifyNear — NEP-141 ft_transfer (memo-bound, verify-by-hash)', () => {
  it('accepts a transfer to payTo carrying our nonce, from the token contract', async () => {
    const res = await verifyNear({
      ...ARGS,
      reader: reader(txView({ logs: [ftLog({ to: PAY_TO, amount: '50000', memo: 'nonce-1' })] })),
      accept: usdcAccept('50000', 'nonce-1'),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.transaction).toBe('H1')
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.asset).toBe(USDC)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('rejects when the amount is too low', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(txView({ logs: [ftLog({ to: PAY_TO, amount: '40000', memo: 'nonce-1' })] })), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('does not match a transfer carrying a different nonce (challenge-bound)', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(txView({ logs: [ftLog({ to: PAY_TO, amount: '50000', memo: 'someone-elses-nonce' })] })), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('does not match a transfer to a different recipient', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(txView({ logs: [ftLog({ to: 'someone.near', amount: '50000', memo: 'nonce-1' })] })), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('IGNORES an ft_transfer event emitted by a NON-token contract (provenance)', async () => {
    // A look-alike contract emits a perfect-looking event — but it's not the trusted
    // token contract, so it must not satisfy the check.
    const res = await verifyNear({
      ...ARGS,
      reader: reader(txView({ executorId: 'evil.near', logs: [ftLog({ to: PAY_TO, amount: '50000', memo: 'nonce-1' })] })),
      accept: usdcAccept('50000', 'nonce-1'),
    })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a failed transaction', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(txView({ logs: [ftLog({ to: PAY_TO, amount: '50000', memo: 'nonce-1' })], success: false })), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds (when a timestamp is present)', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(txView({ logs: [ftLog({ to: PAY_TO, amount: '50000', memo: 'nonce-1' })], ts: Date.now() - 5000 * 1000 })), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('reports tx_not_found when the tx is unknown', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(null), accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifyNear({ ...ARGS, reader: failing, accept: usdcAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

function nativeAccept(amount: string, nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof', network: 'near:mainnet', amount, asset: 'native', payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 24, minConfirmations: 1, amountFormatted: '0.01', symbol: 'NEAR' },
  }
}
function nativeTxView(opts: { receiverId?: string; deposit: string; success?: boolean; ts?: number | null }): NearTxView {
  return {
    success: opts.success ?? true,
    receipts: [],
    receiverId: opts.receiverId ?? PAY_TO,
    nativeDeposit: opts.deposit,
    ...(opts.ts === null ? {} : { timestampMs: opts.ts ?? Date.now() }),
  }
}

describe('verifyNear — native NEAR (digest-bound)', () => {
  const AMT = '10000000000000000000000' // 0.01 NEAR in yoctoNEAR

  it('accepts a recent native transfer of >= amount to payTo', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ deposit: AMT })), accept: nativeAccept(AMT) })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.asset).toBe('native')
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.transaction).toBe('H1')
    }
  })

  it('rejects when the native amount is too low', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ deposit: '9000000000000000000000' })), accept: nativeAccept(AMT) })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects a native transfer to a different recipient', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ receiverId: 'someone.near', deposit: AMT })), accept: nativeAccept(AMT) })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('FAILS CLOSED when the block time is unavailable (no recency ⇒ no accept)', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ deposit: AMT, ts: null })), accept: nativeAccept(AMT) })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a native payment older than maxTimeoutSeconds', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ deposit: AMT, ts: Date.now() - 5000 * 1000 })), accept: nativeAccept(AMT) })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a failed native transaction', async () => {
    const res = await verifyNear({ ...ARGS, reader: reader(nativeTxView({ deposit: AMT, success: false })), accept: nativeAccept(AMT) })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })
})

describe('parseFtTransferEvent', () => {
  it('parses a valid NEP-297 ft_transfer line', () => {
    const data = parseFtTransferEvent(ftLog({ to: PAY_TO, amount: '7', memo: 'n' }))
    expect(data).not.toBeNull()
    expect(data![0]).toMatchObject({ new_owner_id: PAY_TO, amount: '7', memo: 'n' })
  })
  it('returns null for a non-EVENT_JSON log', () => {
    expect(parseFtTransferEvent('just a normal log line')).toBeNull()
  })
  it('returns null for a different event standard', () => {
    expect(parseFtTransferEvent('EVENT_JSON:' + JSON.stringify({ standard: 'nep171', event: 'nft_transfer', data: [] }))).toBeNull()
  })
})
