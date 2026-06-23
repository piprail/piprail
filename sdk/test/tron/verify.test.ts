import { describe, it, expect } from 'vitest'
import {
  verifyTron,
  verifyTronNative,
  type TronReader,
  type TronTxInfo,
  type TronLog,
  type TronRawTx,
} from '../../src/drivers/tron/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
// 20-byte hex (no 41), as Tron logs carry — these are passed pre-derived to verifyTron.
const TOKEN_HEX = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'
const PAYTO_HEX = '1111111111111111111111111111111111111111'
const PAYER_HEX = '2222222222222222222222222222222222222222'
const TRANSFER = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** A TRC-20 Transfer log: topics = [Transfer, from(32B), to(32B)], data = amount(32B). */
function transferLog(opts: { token?: string; to?: string; from?: string; amount: bigint }): TronLog {
  return {
    address: opts.token ?? TOKEN_HEX,
    topics: [TRANSFER, '0'.repeat(24) + (opts.from ?? PAYER_HEX), '0'.repeat(24) + (opts.to ?? PAYTO_HEX)],
    data: opts.amount.toString(16).padStart(64, '0'),
  }
}

function info(opts: { logs?: TronLog[]; result?: string; ts?: number; id?: string }): TronTxInfo {
  return {
    id: opts.id ?? 'txid-1',
    blockNumber: 100,
    blockTimeStamp: opts.ts ?? Date.now(),
    receipt: { result: opts.result ?? 'SUCCESS' },
    log: opts.logs ?? [],
  }
}

const reader = (i: TronTxInfo | null): TronReader => ({
  getTransactionInfo: async () => i,
  getTransaction: async () => null, // unused by the TRC-20 path
})
const failingReader: TronReader = {
  getTransactionInfo: async () => {
    throw new Error('429')
  },
  getTransaction: async () => null,
}

function usdtAccept(amount = '50000', maxTimeoutSeconds = 600): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'tron:mainnet',
    amount,
    asset: USDT,
    payTo: 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC',
    maxTimeoutSeconds,
    extra: { nonce: 'nonce-1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDT' },
  }
}

const base = {
  txid: 'txid-1',
  tokenHex20: TOKEN_HEX,
  payToHex20: PAYTO_HEX,
  toBase58: (h: string) => `T_${h}`,
}

describe('verifyTron — TRC-20 (digest-bound)', () => {
  it('accepts a confirmed Transfer of the required amount to payTo', async () => {
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ amount: 50000n })] })), accept: usdtAccept('50000') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe('txid-1')
      expect(res.receipt.asset).toBe(USDT)
      expect(res.receipt.payer).toBe(`T_${PAYER_HEX}`)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('rejects when the transferred amount is too low', async () => {
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ amount: 40000n })] })), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('ignores a Transfer of a different token', async () => {
    const other = 'b'.repeat(40)
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ token: other, amount: 50000n })] })), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('ignores a Transfer to a different recipient', async () => {
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ to: '9'.repeat(40), amount: 50000n })] })), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a reverted transaction (receipt.result != SUCCESS)', async () => {
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ amount: 50000n })], result: 'REVERT' })), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifyTron({ ...base, reader: reader(info({ logs: [transferLog({ amount: 50000n })], ts: Date.now() - 5000 * 1000 })), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('sums multiple Transfer logs to payTo in one tx', async () => {
    const res = await verifyTron({
      ...base,
      reader: reader(info({ logs: [transferLog({ amount: 30000n }), transferLog({ amount: 30000n })] })),
      accept: usdtAccept('50000'),
    })
    expect(res.ok).toBe(true) // 60000 ≥ 50000
  })

  it('reports tx_not_found when the tx is not yet confirmed (solidified)', async () => {
    const res = await verifyTron({ ...base, reader: reader(null), accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const res = await verifyTron({ ...base, reader: failingReader, accept: usdtAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('BREAK-IT: reads the ref VERBATIM (no tron: strip) — a `tron:`-prefixed ref does NOT resolve to the bare tx', async () => {
    // The double-redeem root cause: stripping a `tron:` prefix inside verify made `txHash:"X"` and
    // `txHash:"tron:X"` claim two distinct replay keys yet verify the SAME on-chain tx. With the
    // strip removed, verify reads the ref as-is — so a `tron:`-prefixed ref is a DIFFERENT (unknown)
    // txid that the reader can't resolve, never a second redemption of the bare tx.
    const info1 = info({ logs: [transferLog({ amount: 50000n })] })
    const txidSensitive: TronReader = {
      getTransactionInfo: async (txid: string) => (txid === 'txid-1' ? info1 : null),
      getTransaction: async () => null,
    }
    const bare = await verifyTron({ ...base, txid: 'txid-1', reader: txidSensitive, accept: usdtAccept('50000') })
    expect(bare.ok).toBe(true) // the real bare txid resolves + verifies
    const prefixed = await verifyTron({ ...base, txid: 'tron:txid-1', reader: txidSensitive, accept: usdtAccept('50000') })
    expect(prefixed).toMatchObject({ ok: false, error: 'tx_not_found' }) // NOT a second redeem
  })
})

// ── native TRX (digest-bound): value/recipient from the tx's TransferContract ──
const TO_HEX41 = `41${PAYTO_HEX}`
const FROM_HEX41 = `41${PAYER_HEX}`
function rawTx(opts: { type?: string; to?: string; amount?: number; ret?: string }): TronRawTx {
  return {
    ret: [{ contractRet: opts.ret ?? 'SUCCESS' }],
    raw_data: {
      contract: [
        {
          type: opts.type ?? 'TransferContract',
          parameter: { value: { amount: opts.amount ?? 1_000_000, to_address: opts.to ?? TO_HEX41, owner_address: FROM_HEX41 } },
        },
      ],
    },
  }
}
const nativeReader = (i: TronTxInfo | null, tx: TronRawTx | null): TronReader => ({
  getTransactionInfo: async () => i,
  getTransaction: async () => tx,
})
const nbase = { txid: 'txid-1', payToHex41: TO_HEX41, toBase58: (h: string) => `T_${h}` }
function nativeAccept(amount = '1000000', maxTimeoutSeconds = 600): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'tron:mainnet',
    amount,
    asset: 'native',
    payTo: 'TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC',
    maxTimeoutSeconds,
    extra: { nonce: 'nonce-1', decimals: 6, minConfirmations: 1, amountFormatted: '1', symbol: 'TRX' },
  }
}

describe('verifyTronNative — native TRX (digest-bound, reads the TransferContract)', () => {
  it('accepts a confirmed TransferContract of the required TRX to payTo', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({}), rawTx({ amount: 1_000_000 })), accept: nativeAccept() })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.asset).toBe('native')
      expect(res.receipt.transaction).toBe('txid-1')
      expect(res.receipt.payer).toBe(`T_${FROM_HEX41}`)
    }
  })

  it('rejects when the TRX amount is too low', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({}), rawTx({ amount: 500_000 })), accept: nativeAccept('1000000') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects when sent to a different recipient', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({}), rawTx({ to: `41${'9'.repeat(40)}` })), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects a non-TransferContract tx (not a native transfer)', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({}), rawTx({ type: 'TriggerSmartContract' })), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a reverted transfer (contractRet != SUCCESS)', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({}), rawTx({ ret: 'REVERT' })), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('BREAK-IT: a native tx whose info.receipt.result is non-SUCCESS → tx_reverted (fail closed, like TRC-20)', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({ result: 'OUT_OF_ENERGY' }), rawTx({})), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('BREAK-IT: a native tx with NO blockTimeStamp fails CLOSED (payment_expired), never open', async () => {
    const i = { ...info({}), blockTimeStamp: undefined } as unknown as TronTxInfo
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(i, rawTx({})), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('reports tx_not_found when not yet solidified (finality gate)', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(null, rawTx({})), accept: nativeAccept() })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifyTronNative({ ...nbase, reader: nativeReader(info({ ts: Date.now() - 5000 * 1000 }), rawTx({})), accept: nativeAccept('1000000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })
})
