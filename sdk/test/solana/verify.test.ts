import { describe, it, expect } from 'vitest'
import { verifySolana } from '../../src/drivers/solana/verify.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const PAY_TO = '6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW'
const PAYER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SIG = '5' + 'x'.repeat(86)
const NOW = () => Math.floor(Date.now() / 1000)

function splAccept(amount: string): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    amount,
    asset: MINT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05' },
  }
}
function nativeAccept(amount: string): X402AcceptEntry {
  return { ...splAccept(amount), asset: 'native', extra: { ...splAccept(amount).extra, decimals: 9 } }
}

const keys = (...addrs: string[]) => ({
  transaction: { message: { accountKeys: addrs.map((a) => ({ pubkey: { toBase58: () => a } })) } },
})

function splTx(opts: {
  amount: string
  owner?: string
  mint?: string
  err?: unknown
  blockTime?: number
  prior?: string
}) {
  const owner = opts.owner ?? PAY_TO
  const mint = opts.mint ?? MINT
  return {
    blockTime: opts.blockTime ?? NOW(),
    ...keys(PAYER, 'ata'),
    meta: {
      err: opts.err ?? null,
      preBalances: [0, 0],
      postBalances: [0, 0],
      preTokenBalances: [
        { accountIndex: 1, mint, owner, uiTokenAmount: { amount: opts.prior ?? '0' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner, uiTokenAmount: { amount: opts.amount } },
      ],
    },
  }
}

function solTx(opts: { lamports: string; blockTime?: number; err?: unknown }) {
  return {
    blockTime: opts.blockTime ?? NOW(),
    ...keys(PAYER, PAY_TO),
    meta: {
      err: opts.err ?? null,
      preBalances: [0, 0],
      postBalances: [0, Number(opts.lamports)],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  }
}

const conn = (tx: unknown) => ({ getParsedTransaction: async () => tx }) as never

describe('verifySolana — SPL', () => {
  it('accepts an SPL transfer of the required amount to payTo', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000' })), signature: SIG, accept: splAccept('50000') })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.asset).toBe(MINT)
      // x402 v2 SettlementResponse shape
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe(SIG)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('credits only the delta when the ATA already had a balance', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000', prior: '10000' })), signature: SIG, accept: splAccept('40000') })
    expect(res.ok).toBe(true)
  })

  it('rejects a transfer to a different owner', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000', owner: PAYER })), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects a look-alike mint', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000', mint: PAYER })), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })

  it('rejects an amount that is too low', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '40000' })), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})

describe('verifySolana — native SOL', () => {
  it('accepts a native transfer of the required lamports', async () => {
    const res = await verifySolana({ connection: conn(solTx({ lamports: '10000000' })), signature: SIG, accept: nativeAccept('10000000') })
    expect(res.ok).toBe(true)
  })
  it('rejects native amount too low', async () => {
    const res = await verifySolana({ connection: conn(solTx({ lamports: '9' })), signature: SIG, accept: nativeAccept('10000000') })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })
})

describe('verifySolana — guards', () => {
  it('rejects a failed transaction', async () => {
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000', err: { InstructionError: [0, 'Custom'] } })), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })
  it('reports tx_not_found when the signature is missing', async () => {
    const res = await verifySolana({ connection: conn(null), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
  it('rejects a payment older than maxTimeoutSeconds', async () => {
    const stale = NOW() - 5000
    const res = await verifySolana({ connection: conn(splTx({ amount: '50000', blockTime: stale })), signature: SIG, accept: splAccept('50000') })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })
  it('BREAK-IT: a NaN/Infinity blockTime fails CLOSED (NaN is typeof number and would slip the > check)', async () => {
    for (const bt of [NaN, Infinity, -Infinity]) {
      const res = await verifySolana({ connection: conn(splTx({ amount: '50000', blockTime: bt })), signature: SIG, accept: splAccept('50000') })
      expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
    }
  })
})
