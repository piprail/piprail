import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { paySolana } from '../../src/drivers/solana/pay.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const PAY_TO = '6dNVR2qHmFwkR2nQpHvP8sJ7yX9bQ1cKfL3mZ8aT4uW'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
// 32 zero-bytes is a structurally valid base58 blockhash for serialize().
const BLOCKHASH = '1'.repeat(32)

function mockConn() {
  const calls: { sent?: Uint8Array; confirmed?: unknown } = {}
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      calls.sent = raw
      return 'SignatureReturnedByRpc'
    },
    confirmTransaction: async (cfg: unknown) => {
      calls.confirmed = cfg
      return { value: { err: null } }
    },
  }
  return { connection, calls }
}

function nativeAccept(amount: string): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    amount,
    asset: 'native',
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n', decimals: 9, minConfirmations: 1, amountFormatted: '0.01' },
  }
}

describe('paySolana', () => {
  it('signs, serializes, broadcasts a native transfer, and returns the signature', async () => {
    const { connection, calls } = mockConn()
    const keypair = Keypair.generate()
    const sig = await paySolana({ connection: connection as never, keypair, accept: nativeAccept('10000000') })
    expect(sig).toBe('SignatureReturnedByRpc')
    expect(calls.sent).toBeInstanceOf(Uint8Array)
    expect(calls.sent!.length).toBeGreaterThan(0)
    expect(calls.confirmed).toMatchObject({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 })
  })

  it('builds an SPL checked transfer (with idempotent ATA create) without throwing', async () => {
    const { connection } = mockConn()
    const keypair = Keypair.generate()
    const accept: X402AcceptEntry = {
      ...nativeAccept('50000'),
      asset: MINT,
      extra: { nonce: 'n', decimals: 6, minConfirmations: 1, amountFormatted: '0.05' },
    }
    const sig = await paySolana({ connection: connection as never, keypair, accept })
    expect(sig).toBe('SignatureReturnedByRpc')
  })
})
