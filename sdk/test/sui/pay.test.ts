import { describe, it, expect } from 'vitest'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { paySui, type SuiPayClient } from '../../src/drivers/sui/pay.js'
import { InsufficientFundsError } from '../../src/errors.js'
import type { X402AcceptEntry } from '../../src/x402.js'

const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const PAY_TO = new Ed25519Keypair().getPublicKey().toSuiAddress()

interface Captured {
  getCoinsArgs?: { owner: string; coinType: string }
  executed?: boolean
}

function mockClient(opts?: { coins?: number; execThrows?: Error }) {
  const captured: Captured = {}
  const client: SuiPayClient = {
    async getCoins(input) {
      captured.getCoinsArgs = input
      return { data: Array.from({ length: opts?.coins ?? 1 }, (_, i) => ({ coinObjectId: `0xcoin${i}` })) }
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
