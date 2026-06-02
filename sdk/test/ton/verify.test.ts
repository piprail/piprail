import { describe, it, expect } from 'vitest'
import { Address, beginCell, comment, type Cell, type Transaction } from '@ton/core'
import { verifyTon } from '../../src/drivers/ton/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const PAYER = new Address(0, Buffer.alloc(32, 9)) // payer owner
const PAYER_JW = new Address(0, Buffer.alloc(32, 8)) // payer jetton wallet (msg src)
const MERCHANT = new Address(0, Buffer.alloc(32, 7)).toString() // payTo owner
const WATCH = new Address(0, Buffer.alloc(32, 6)) // merchant jetton wallet (mock target)
const NOW = () => Math.floor(Date.now() / 1000)

function jettonAccept(amount: string, nonce = 'nonce-1'): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'ton:-239',
    amount,
    asset: USDT_MASTER,
    payTo: MERCHANT,
    maxTimeoutSeconds: 600,
    extra: { nonce, decimals: 6, minConfirmations: 1, amountFormatted: '0.05' },
  }
}
function nativeAccept(amount: string, nonce = 'nonce-1'): X402AcceptEntry {
  return { ...jettonAccept(amount, nonce), asset: 'native', extra: { ...jettonAccept(amount, nonce).extra, decimals: 9 } }
}

/** A real TEP-74 internal_transfer body (op 0x178d4519) with a forward comment. */
function internalTransferBody(amount: bigint, fromOwner: Address, note: string): Cell {
  return beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(0n, 64) // query_id
    .storeCoins(amount) // jetton amount
    .storeAddress(fromOwner) // from (owner)
    .storeAddress(null) // response_address = addr_none
    .storeCoins(1n) // forward_ton_amount
    .storeBit(true) // forward_payload as ref
    .storeRef(comment(note)) // the comment (nonce)
    .endCell()
}

function jettonTx(opts: {
  amount: bigint
  note: string
  from?: Address
  aborted?: boolean
  success?: boolean
  bounced?: boolean
  now?: number
}): Transaction {
  return {
    lt: 100n,
    now: opts.now ?? NOW(),
    hash: () => Buffer.alloc(32, 0xab),
    inMessage: {
      info: { type: 'internal', src: PAYER_JW, dest: WATCH, bounced: opts.bounced ?? false, value: { coins: 12345n } },
      body: internalTransferBody(opts.amount, opts.from ?? PAYER, opts.note),
    },
    description: {
      type: 'generic',
      aborted: opts.aborted ?? false,
      computePhase: { type: 'vm', success: opts.success ?? true, exitCode: 0 },
    },
  } as unknown as Transaction
}

function nativeTx(opts: { coins: bigint; note: string; now?: number }): Transaction {
  return {
    lt: 100n,
    now: opts.now ?? NOW(),
    hash: () => Buffer.alloc(32, 0xcd),
    inMessage: {
      info: { type: 'internal', src: PAYER, dest: WATCH, bounced: false, value: { coins: opts.coins } },
      body: comment(opts.note),
    },
    description: { type: 'generic', aborted: false, computePhase: { type: 'vm', success: true, exitCode: 0 } },
  } as unknown as Transaction
}

const client = (...txs: Transaction[]) => ({ getTransactions: async () => txs })

describe('verifyTon — jetton (USD₮)', () => {
  it('accepts an internal_transfer of the required amount carrying our nonce', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 50000n, note: 'nonce-1' })), watch: WATCH, accept: jettonAccept('50000') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.payer).toBe(PAYER.toString())
      expect(res.receipt.asset).toBe(USDT_MASTER)
      expect(res.receipt.network).toBe('ton:-239')
      // x402 v2 SettlementResponse shape
      expect(res.receipt.success).toBe(true)
      expect(typeof res.receipt.transaction).toBe('string')
      expect(res.receipt.transaction.length).toBeGreaterThan(0)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('rejects when the credited amount is too low', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 40000n, note: 'nonce-1' })), watch: WATCH, accept: jettonAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('does not match a transfer carrying a different nonce (challenge-bound)', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 50000n, note: 'someone-elses-nonce' })), watch: WATCH, accept: jettonAccept('50000', 'nonce-1') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects an aborted (failed) transaction', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 50000n, note: 'nonce-1', aborted: true })), watch: WATCH, accept: jettonAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('skips a bounced message', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 50000n, note: 'nonce-1', bounced: true })), watch: WATCH, accept: jettonAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const res = await verifyTon({ client: client(jettonTx({ amount: 50000n, note: 'nonce-1', now: NOW() - 5000 })), watch: WATCH, accept: jettonAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('picks our transfer out of a batch of unrelated ones', async () => {
    const res = await verifyTon({
      client: client(
        jettonTx({ amount: 99999n, note: 'unrelated-a' }),
        jettonTx({ amount: 50000n, note: 'nonce-1' }),
        jettonTx({ amount: 1n, note: 'unrelated-b' }),
      ),
      watch: WATCH,
      accept: jettonAccept('50000'),
    })
    expect(res.ok).toBe(true)
  })

  it('reports tx_not_found (transient) when the RPC read fails', async () => {
    const failing = { getTransactions: async () => { throw new Error('429') } }
    const res = await verifyTon({ client: failing, watch: WATCH, accept: jettonAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifyTon — native TON', () => {
  it('accepts a native transfer of the required nanoton with our comment', async () => {
    const res = await verifyTon({ client: client(nativeTx({ coins: 100000000n, note: 'nonce-1' })), watch: WATCH, accept: nativeAccept('100000000') })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.payer).toBe(PAYER.toString())
  })

  it('rejects native amount too low', async () => {
    const res = await verifyTon({ client: client(nativeTx({ coins: 9n, note: 'nonce-1' })), watch: WATCH, accept: nativeAccept('100000000') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })
})
