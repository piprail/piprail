import { describe, it, expect } from 'vitest'
import { getAddress, parseUnits, type PublicClient } from 'viem'
import { verifyEvm } from '../src/drivers/evm/verify.js'
import type { X402AcceptEntry } from '../src/x402.js'

const PAY_TO = getAddress('0x1111111111111111111111111111111111111111')
const PAYER = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const TX = `0x${'a'.repeat(64)}` as `0x${string}`

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const topicAddr = (a: string) =>
  `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`
const uint256 = (v: bigint) =>
  `0x${v.toString(16).padStart(64, '0')}` as `0x${string}`

function nativeAccept(amount: bigint): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'eip155:56',
    amount: amount.toString(),
    asset: 'native',
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 18, minConfirmations: 1, amountFormatted: '1' },
  }
}

function erc20Accept(amount: bigint): X402AcceptEntry {
  return { ...nativeAccept(amount), asset: TOKEN }
}

function transferLog(value: bigint, to = PAY_TO, from = PAYER) {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)] as [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
    ],
    data: uint256(value),
  }
}

/** A mock publicClient that's healthy by default; override per test. */
function mockClient(overrides: Record<string, unknown> = {}): PublicClient {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  return {
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      from: PAYER,
      logs: [],
    }),
    getBlockNumber: async () => 110n,
    getBlock: async () => ({ timestamp: nowSec }),
    getTransaction: async () => ({ to: PAY_TO, from: PAYER, value: 0n }),
    ...overrides,
  } as unknown as PublicClient
}

describe('verifyEvm — native', () => {
  it('accepts a native payment of the exact amount', async () => {
    const amount = parseUnits('1', 18)
    const client = mockClient({
      getTransaction: async () => ({ to: PAY_TO, from: PAYER, value: amount }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(amount), minConfirmations: 1 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.payTo).toBe(PAY_TO)
      expect(res.receipt.asset).toBe('native')
      // x402 v2 SettlementResponse shape (regression guard for the envelope rename)
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe(TX)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('rejects when the recipient is wrong', async () => {
    const amount = parseUnits('1', 18)
    const client = mockClient({
      getTransaction: async () => ({ to: PAYER, from: PAYER, value: amount }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(amount), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects when the amount is too low', async () => {
    const amount = parseUnits('1', 18)
    const client = mockClient({
      getTransaction: async () => ({ to: PAY_TO, from: PAYER, value: amount - 1n }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(amount), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })
})

describe('verifyEvm — ERC-20', () => {
  it('accepts an ERC-20 transfer of the required amount to payTo', async () => {
    const amount = parseUnits('0.05', 18)
    const client = mockClient({
      getTransactionReceipt: async () => ({
        status: 'success',
        blockNumber: 100n,
        from: PAYER,
        logs: [transferLog(amount)],
      }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: erc20Accept(amount), minConfirmations: 1 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.payer).toBe(PAYER)
      expect(res.receipt.success).toBe(true)
      expect(res.receipt.transaction).toBe(TX)
      expect('txHash' in res.receipt).toBe(false)
    }
  })

  it('ignores transfers to a different recipient', async () => {
    const amount = parseUnits('0.05', 18)
    const client = mockClient({
      getTransactionReceipt: async () => ({
        status: 'success',
        blockNumber: 100n,
        from: PAYER,
        logs: [transferLog(amount, PAYER)], // paid someone else
      }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: erc20Accept(amount), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'transfer_not_found' })
  })
})

describe('verifyEvm — guards', () => {
  it('rejects a reverted transaction', async () => {
    const client = mockClient({
      getTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 100n, from: PAYER, logs: [] }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(1n), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('rejects when confirmations are insufficient', async () => {
    const client = mockClient({
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, from: PAYER, logs: [] }),
      getBlockNumber: async () => 100n, // only 1 confirmation
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(1n), minConfirmations: 5 })
    expect(res).toMatchObject({ ok: false, error: 'insufficient_confirmations' })
  })

  it('rejects a payment older than maxTimeoutSeconds (replay window)', async () => {
    const amount = parseUnits('1', 18)
    const stale = BigInt(Math.floor(Date.now() / 1000) - 5000)
    const client = mockClient({
      getBlock: async () => ({ timestamp: stale }),
      getTransaction: async () => ({ to: PAY_TO, from: PAYER, value: amount }),
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(amount), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('reports tx_not_found when the receipt lookup throws', async () => {
    const client = mockClient({
      getTransactionReceipt: async () => {
        throw new Error('not found')
      },
    })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(1n), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  // A transient RPC failure on a FOLLOW-ON read must stay inside the verify
  // channel (→ tx_not_found), never throw raw out of verify().
  it('returns tx_not_found (not a throw) when getBlockNumber fails', async () => {
    const client = mockClient({ getBlockNumber: async () => { throw new Error('rpc down') } })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(1n), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('returns tx_not_found (not a throw) when getBlock fails', async () => {
    const client = mockClient({ getBlock: async () => { throw new Error('rpc down') } })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(1n), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })

  it('returns tx_not_found (not a throw) when getTransaction fails (native path)', async () => {
    const amount = parseUnits('1', 18)
    const client = mockClient({ getTransaction: async () => { throw new Error('rpc down') } })
    const res = await verifyEvm({ publicClient: client, txHash: TX, accept: nativeAccept(amount), minConfirmations: 1 })
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})
