/**
 * Read-only client (constructed with NO `wallet`): the key-less path.
 *
 * Proves the additive contract — quote / estimateCost / discoverySigner-null work
 * with no wallet, while pay (`fetch`) and `planPayment` throw `WalletRequiredError`.
 * The 895-test suite is the with-wallet contract (unchanged); this file pins the
 * no-wallet behavior that read-only mode (e.g. the MCP without a key) relies on.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  PipRailClient,
  registerDriver,
  buildChallengeHeader,
  WalletRequiredError,
  type ResolvedNetwork,
  type X402AcceptEntry,
} from '../src/index.js'

const NET = 'eip155:8453'
const URL = 'https://api.example.com/r'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYTO = '0x1111111111111111111111111111111111111111'

let bindWalletCalls = 0
function makeNet(): ResolvedNetwork {
  return {
    family: 'evm',
    network: NET,
    supports: (n) => n === NET,
    resolveToken: () => ({ asset: USDC, decimals: 6, symbol: 'USDC' }),
    describeAsset: (a) => (a === USDC ? { symbol: 'USDC', decimals: 6 } : null),
    assertValidPayTo: () => undefined,
    bindWallet: (w) => {
      bindWalletCalls += 1
      return { _native: w }
    },
    send: async () => '0xTX',
    confirm: async () => ({ height: '100' }),
    estimateCost: async () => ({
      feeSymbol: 'ETH',
      feeDecimals: 18,
      fee: '21000000000000',
      feeFormatted: '0.000021',
      basis: 'estimated' as const,
    }),
    balanceOf: async () => ({ token: 1_000_000n, native: 1_000_000_000_000_000_000n }),
    recipientReady: async () => ({ ready: 'n/a' as const }),
    verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'unused client-side' }),
    // Present so a null result is attributable to the no-wallet guard, not a missing method.
    discoverySigner: () => ({ address: '0xPAYER', signMessage: async () => '0xsig' }),
  }
}
let net = makeNet()
registerDriver({ family: 'evm', resolve: () => net })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  net = makeNet()
  bindWalletCalls = 0
})

function onchainAccept(): X402AcceptEntry {
  return {
    scheme: 'onchain-proof',
    network: NET,
    amount: '50000', // 0.05 @ 6dp
    asset: USDC,
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra: { nonce: 'n1', decimals: 6, minConfirmations: 1, amountFormatted: '0.05', symbol: 'USDC' },
  }
}
function stub402() {
  globalThis.fetch = (async () => {
    const body = { x402Version: 2 as const, error: null, resource: { url: URL }, accepts: [onchainAccept()] }
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { 'payment-required': buildChallengeHeader(body as never) },
    })
  }) as typeof fetch
}

describe('read-only client (no wallet supplied)', () => {
  it('quote() works key-less — returns the price, never binds a wallet', async () => {
    stub402()
    const client = new PipRailClient({ chain: 'base' }) // NO wallet
    const q = await client.quote(URL)
    expect(q).not.toBeNull()
    expect(q?.amount).toBe('50000')
    expect(bindWalletCalls).toBe(0) // never tried to bind a (missing) wallet
  })

  it('estimateCost() works key-less', async () => {
    stub402()
    const client = new PipRailClient({ chain: 'base' })
    const c = await client.estimateCost(URL)
    expect(c).not.toBeNull()
    expect(c?.quote.amount).toBe('50000')
    expect(c?.cost.feeSymbol).toBe('ETH')
  })

  it('discoverySigner() returns null with no wallet (and a signer WITH one)', async () => {
    expect(await new PipRailClient({ chain: 'base' }).discoverySigner()).toBeNull()
    const signer = await new PipRailClient({ chain: 'base', wallet: { key: '0x1' } }).discoverySigner()
    expect(signer?.address).toBe('0xPAYER') // the guard, not a missing method, is what nulls it
  })

  it('budget() works key-less (reads policy + ledger, not the chain)', () => {
    const client = new PipRailClient({ chain: 'base' })
    expect(() => client.budget()).not.toThrow()
    expect(client.spent().count).toBe(0)
  })

  it('fetch() (pay) throws WalletRequiredError — no key to sign/settle', async () => {
    stub402()
    const client = new PipRailClient({ chain: 'base' })
    await expect(client.fetch(URL)).rejects.toBeInstanceOf(WalletRequiredError)
  })

  it('planPayment() throws WalletRequiredError — no wallet to check balance', async () => {
    stub402()
    const client = new PipRailClient({ chain: 'base' })
    await expect(client.planPayment(URL)).rejects.toBeInstanceOf(WalletRequiredError)
  })

  it('REGRESSION: WITH a wallet, quote + a bound wallet are unchanged', async () => {
    stub402()
    const client = new PipRailClient({ chain: 'base', wallet: { key: '0x1' } })
    expect((await client.quote(URL))?.amount).toBe('50000')
    expect(bindWalletCalls).toBe(1) // the wallet IS bound exactly as before
  })
})
