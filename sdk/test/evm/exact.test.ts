import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData, type PublicClient, type WalletClient, type Account } from 'viem'
import {
  parseExactRequirements,
  chainIdForExactNetwork,
  buildExactAuthorization,
  encodeXPaymentHeader,
  buildExactSignatureHeader,
  parseExactPaymentHeader,
  EIP3009_TYPES,
  UnsupportedSchemeError,
  type X402ExactAcceptEntry,
} from '../../src/index.js'
import { payExactEvm } from '../../src/drivers/evm/exact.js'

// A fixed test key (NOT a real wallet) → deterministic signatures.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const PAY_TO = '0x1111111111111111111111111111111111111111' as const
const NONCE = `0x${'ab'.repeat(32)}` as const

const exactChallenge = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '50000',
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
      description: 'A report',
    },
    // an onchain-proof entry in the same challenge must be ignored here
    { scheme: 'onchain-proof', network: 'eip155:8453', amount: '50000', asset: USDC, payTo: PAY_TO },
  ],
}

describe('parseExactRequirements', () => {
  it('extracts only the exact entries, normalising the amount field', () => {
    const accepts = parseExactRequirements(exactChallenge)!
    expect(accepts).toHaveLength(1)
    expect(accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '50000',
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    })
  })

  it('tolerates the `amount` field name and a missing maxTimeoutSeconds', () => {
    const a = parseExactRequirements({ accepts: [{ scheme: 'exact', network: 'base', amount: '1', asset: USDC, payTo: PAY_TO }] })!
    expect(a[0]!.maxAmountRequired).toBe('1')
    expect(a[0]!.maxTimeoutSeconds).toBe(600)
  })

  it('returns null for a non-challenge body, [] when there are no exact entries', () => {
    expect(parseExactRequirements('nope')).toBeNull()
    expect(parseExactRequirements({})).toBeNull()
    expect(parseExactRequirements({ accepts: [{ scheme: 'onchain-proof' }] })).toEqual([])
  })
})

describe('chainIdForExactNetwork', () => {
  it('maps known slugs and rejects unknown ones', () => {
    expect(chainIdForExactNetwork('base')).toBe(8453)
    expect(chainIdForExactNetwork('ethereum')).toBe(1)
    expect(chainIdForExactNetwork('not-a-chain')).toBeNull()
  })
})

describe('buildExactAuthorization — EIP-3009 signing', () => {
  it('builds the authorization and produces a signature that recovers to the payer', async () => {
    const accept = parseExactRequirements(exactChallenge)![0]!
    const { authorization, signature } = await buildExactAuthorization({
      account,
      accept,
      chainId: 8453,
      now: 1_000_000,
      nonce: NONCE,
    })

    expect(authorization).toMatchObject({
      from: account.address,
      to: PAY_TO,
      value: '50000',
      validAfter: '0',
      validBefore: String(1_000_000 + 300),
      nonce: NONCE,
    })

    // The signature must verify against the EXACT EIP-712 domain + message.
    const valid = await verifyTypedData({
      address: account.address,
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: 50_000n,
        validAfter: 0n,
        validBefore: 1_000_300n,
        nonce: NONCE,
      },
      signature,
    })
    expect(valid).toBe(true)
  })

  it('is deterministic for the same inputs (RFC-6979)', async () => {
    const accept = parseExactRequirements(exactChallenge)![0]!
    const a = await buildExactAuthorization({ account, accept, chainId: 8453, now: 1_000_000, nonce: NONCE })
    const b = await buildExactAuthorization({ account, accept, chainId: 8453, now: 1_000_000, nonce: NONCE })
    expect(a.signature).toBe(b.signature)
  })
})

describe('encodeXPaymentHeader', () => {
  it('base64-encodes the x402 exact PaymentPayload', () => {
    const header = encodeXPaymentHeader({
      network: 'base',
      authorization: { from: account.address, to: PAY_TO, value: '50000', validAfter: '0', validBefore: '1000300', nonce: NONCE },
      signature: `0x${'cd'.repeat(65)}`,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded).toMatchObject({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: `0x${'cd'.repeat(65)}`, authorization: { value: '50000' } },
    })
  })
})

/* ───────────────────── BUYER, production path (payExactEvm) ───────────────────── */

const EXACT_ACCEPT: X402ExactAcceptEntry = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '50000',
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' },
}

/** A fake publicClient exposing only what payExactEvm/readExactDomain touch: getCode
 *  (EOA detection) + readContract (name/version + the EIP-3009 authorizationState probe). */
function mockPublic(opts: { code?: string; name?: string; version?: string; eip3009?: boolean } = {}) {
  return {
    getCode: async () => opts.code, // undefined ⇒ no code ⇒ EOA
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'name') return opts.name ?? 'USD Coin'
      if (functionName === 'version') return opts.version ?? '2'
      if (functionName === 'authorizationState') {
        if (opts.eip3009 === false) throw new Error('not an EIP-3009 token')
        return false
      }
      throw new Error(`unexpected readContract(${functionName})`)
    },
  } as unknown as PublicClient
}

/** A minimal walletClient that signs via the given local account — mirrors viem's
 *  walletClient.signTypedData for a local account, without standing up a transport. */
function localWalletClient(acct: Account = account): WalletClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { signTypedData: (args: any) => acct.signTypedData!(args) } as unknown as WalletClient
}

describe('payExactEvm — production buyer signing', () => {
  it('re-derives the EIP-712 domain ON-CHAIN, ignoring a lying extra.{name,version}', async () => {
    // The server LIES about the domain in extra; payExactEvm must sign over the real
    // on-chain name ("USD Coin"/"2"), not the wire claim ("Tether USD"/"9").
    const lying: X402ExactAcceptEntry = { ...EXACT_ACCEPT, extra: { assetTransferMethod: 'eip3009', name: 'Tether USD', version: '9' } }
    const { payload, payerFrom, nonce } = await payExactEvm({
      publicClient: mockPublic({ name: 'USD Coin', version: '2' }),
      walletClient: localWalletClient(),
      account,
      chainId: 8453,
      accept: lying,
    })
    expect(payerFrom).toBe(account.address)
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(payload.authorization).toMatchObject({ from: account.address, to: PAY_TO, value: '50000', validAfter: '0' })

    const msg = {
      from: account.address,
      to: PAY_TO,
      value: 50_000n,
      validAfter: 0n,
      validBefore: BigInt(payload.authorization.validBefore),
      nonce: payload.authorization.nonce as `0x${string}`,
    }
    // Verifies under the TRUE on-chain domain …
    expect(
      await verifyTypedData({
        address: account.address,
        domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
        types: EIP3009_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: msg,
        signature: payload.signature as `0x${string}`,
      })
    ).toBe(true)
    // … and NOT under the lying wire domain.
    expect(
      await verifyTypedData({
        address: account.address,
        domain: { name: 'Tether USD', version: '9', chainId: 8453, verifyingContract: USDC },
        types: EIP3009_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: msg,
        signature: payload.signature as `0x${string}`,
      })
    ).toBe(false)
  })

  it('generates a fresh CSPRNG nonce on every call', async () => {
    const a = await payExactEvm({ publicClient: mockPublic(), walletClient: localWalletClient(), account, chainId: 8453, accept: EXACT_ACCEPT })
    const b = await payExactEvm({ publicClient: mockPublic(), walletClient: localWalletClient(), account, chainId: 8453, accept: EXACT_ACCEPT })
    expect(a.nonce).not.toBe(b.nonce)
  })

  it('signs via walletClient.signTypedData (BYO JsonRpcAccount with no account.signTypedData)', async () => {
    const fakeSig = `0x${'ab'.repeat(65)}` as const
    const spy = vi.fn(async () => fakeSig)
    // An account WITHOUT signTypedData (a JsonRpcAccount shape) must not crash.
    const acct = { address: account.address } as unknown as Account
    const { payload } = await payExactEvm({
      publicClient: mockPublic(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      walletClient: { signTypedData: spy } as any,
      account: acct,
      chainId: 8453,
      accept: EXACT_ACCEPT,
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(payload.signature).toBe(fakeSig)
  })

  it('throws UnsupportedSchemeError when the token is NOT EIP-3009 (USDT/native/plain ERC-20)', async () => {
    await expect(
      payExactEvm({ publicClient: mockPublic({ eip3009: false }), walletClient: localWalletClient(), account, chainId: 8453, accept: EXACT_ACCEPT })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('throws UnsupportedSchemeError for a contract / EIP-1271 signer (code at from)', async () => {
    await expect(
      payExactEvm({ publicClient: mockPublic({ code: '0x6060604052' }), walletClient: localWalletClient(), account, chainId: 8453, accept: EXACT_ACCEPT })
    ).rejects.toBeInstanceOf(UnsupportedSchemeError)
  })

  it('binds the chainId into the signed domain (a non-Base chain — Arbitrum)', async () => {
    const accept: X402ExactAcceptEntry = { ...EXACT_ACCEPT, network: 'eip155:42161' }
    const { payload } = await payExactEvm({ publicClient: mockPublic(), walletClient: localWalletClient(), account, chainId: 42161, accept })
    const msg = {
      from: account.address, to: PAY_TO, value: 50_000n, validAfter: 0n,
      validBefore: BigInt(payload.authorization.validBefore), nonce: payload.authorization.nonce as `0x${string}`,
    }
    expect(await verifyTypedData({ address: account.address, domain: { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: USDC }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: msg, signature: payload.signature as `0x${string}` })).toBe(true)
    // the SAME signature must NOT verify under a different chainId — proving it's bound in
    expect(await verifyTypedData({ address: account.address, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: msg, signature: payload.signature as `0x${string}` })).toBe(false)
  })

  it('re-derives EURC\'s per-chain domain name on-chain ("Euro Coin", not the "EURC" symbol)', async () => {
    // EURC's on-chain EIP-712 name is "Euro Coin" on Ethereum/Avalanche (but "EURC" on Base) —
    // the buyer must sign over whatever name() returns, never the symbol.
    const eurc: X402ExactAcceptEntry = { ...EXACT_ACCEPT, network: 'eip155:1', extra: { assetTransferMethod: 'eip3009', symbol: 'EURC' } }
    const { payload } = await payExactEvm({ publicClient: mockPublic({ name: 'Euro Coin', version: '2' }), walletClient: localWalletClient(), account, chainId: 1, accept: eurc })
    const msg = {
      from: account.address, to: PAY_TO, value: 50_000n, validAfter: 0n,
      validBefore: BigInt(payload.authorization.validBefore), nonce: payload.authorization.nonce as `0x${string}`,
    }
    expect(await verifyTypedData({ address: account.address, domain: { name: 'Euro Coin', version: '2', chainId: 1, verifyingContract: USDC }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: msg, signature: payload.signature as `0x${string}` })).toBe(true)
    expect(await verifyTypedData({ address: account.address, domain: { name: 'EURC', version: '2', chainId: 1, verifyingContract: USDC }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: msg, signature: payload.signature as `0x${string}` })).toBe(false)
  })
})

describe('buildExactSignatureHeader — the v2 PAYMENT-SIGNATURE envelope', () => {
  it('emits {x402Version:2, accepted, payload} and round-trips through parseExactPaymentHeader', () => {
    const payload = {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: { from: account.address, to: PAY_TO, value: '50000', validAfter: '0', validBefore: '1000300', nonce: NONCE },
    }
    const header = buildExactSignatureHeader({ accepted: EXACT_ACCEPT, payload })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted).toEqual(EXACT_ACCEPT) // verbatim echo
    expect('scheme' in decoded).toBe(false) // nested v2, NOT the v1 flat shape

    const p = parseExactPaymentHeader(header)
    expect(p).not.toBeNull()
    expect(p!.x402Version).toBe(2)
    expect(p!.network).toBe('eip155:8453')
    expect(p!.asset).toBe(USDC)
    expect(p!.method).toBe('eip3009')
    if (p && p.method === 'eip3009') expect(p.payload.authorization.nonce).toBe(NONCE)
  })
})
