import { describe, it, expect } from 'vitest'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { paySui, type SuiPayClient } from '../../src/drivers/sui/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const PAY_TO = new Ed25519Keypair().getPublicKey().toSuiAddress()

interface Captured {
  getCoinsArgs?: { owner: string; coinType: string; cursor?: string | null }
  getCoinsCalls: number
  executed?: boolean
}

function mockClient(opts?: { coins?: number; coinBalance?: bigint; pageSize?: number; execThrows?: Error }) {
  const captured: Captured = { getCoinsCalls: 0 }
  const total = opts?.coins ?? 1
  const bal = opts?.coinBalance ?? 50000n
  const allCoins = Array.from({ length: total }, (_, i) => ({ coinObjectId: `0xcoin${i}`, balance: String(bal) }))
  const pageSize = opts?.pageSize ?? Math.max(total, 1)
  const client: SuiPayClient = {
    async getCoins(input) {
      captured.getCoinsCalls += 1
      captured.getCoinsArgs = input
      const start = input.cursor ? Number(input.cursor) : 0
      const end = start + pageSize
      const data = allCoins.slice(start, end)
      const hasNextPage = end < allCoins.length
      return { data, nextCursor: hasNextPage ? String(end) : null, hasNextPage }
    },
    async signAndExecuteTransaction() {
      if (opts?.execThrows) throw opts.execThrows
      captured.executed = true
      return { digest: 'SUIDIGEST123' }
    },
  }
  return { client, captured }
}

function usdcAccept(asset = USDC): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: 'sui:mainnet',
    amount: '50000',
    asset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'nonce-1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}

describe('paySui — builds + executes a coin transfer (digest-bound)', () => {
  it('fetches the payer USDC coins, executes, returns the digest', async () => {
    const { client, captured } = mockClient({ coins: 2 })
    const ref = await paySui({ client, keypair: new Ed25519Keypair(), accept: usdcAccept() })
    expect(ref).toBe('SUIDIGEST123')
    expect(captured.getCoinsArgs?.coinType).toBe(USDC)
    expect(captured.executed).toBe(true)
  })

  it('a FRAGMENTED wallet (coins spread across pages) pages through getCoins until covered', async () => {
    // 5 coins of 20_000 each = 100_000 total, but only 2 per page; amount is 50_000.
    const { client, captured } = mockClient({ coins: 5, coinBalance: 20_000n, pageSize: 2 })
    const ref = await paySui({ client, keypair: new Ed25519Keypair(), accept: usdcAccept() })
    expect(ref).toBe('SUIDIGEST123')
    expect(captured.getCoinsCalls).toBeGreaterThan(1) // it followed nextCursor past page 1
    expect(captured.executed).toBe(true)
  })

  it('stops paging early once enough balance is gathered (one big coin → a single page)', async () => {
    const { client, captured } = mockClient({ coins: 100, coinBalance: 50_000n, pageSize: 1 })
    await paySui({ client, keypair: new Ed25519Keypair(), accept: usdcAccept() })
    expect(captured.getCoinsCalls).toBe(1) // first coin already covers the amount — no needless paging
  })

  it('native SUI does not fetch coins (splits from gas)', async () => {
    const { client, captured } = mockClient()
    const base = usdcAccept()
    const accept: X402AcceptEntry = { ...base, asset: 'native', amount: '1000000000', extra: { ...base.extra, symbol: 'SUI', amountFormatted: '1' } }
    const ref = await paySui({ client, keypair: new Ed25519Keypair(), accept })
    expect(ref).toBe('SUIDIGEST123')
    expect(captured.getCoinsArgs).toBeUndefined() // native uses the gas coin
  })
})

describe('paySui — affordability maps to one typed error (ERRORS.md §6)', () => {
  it('no coin objects of the token → InsufficientFundsError', async () => {
    const { client } = mockClient({ coins: 0 })
    await expect(paySui({ client, keypair: new Ed25519Keypair(), accept: usdcAccept() })).rejects.toBeInstanceOf(
      InsufficientFundsError
    )
  })

  it('an "insufficient gas" execution failure → InsufficientFundsError', async () => {
    const { client } = mockClient({ execThrows: new Error('No valid gas coins found for the transaction') })
    await expect(paySui({ client, keypair: new Ed25519Keypair(), accept: usdcAccept() })).rejects.toBeInstanceOf(
      InsufficientFundsError
    )
  })
})
