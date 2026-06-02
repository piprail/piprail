import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData } from 'viem'
import {
  parseExactRequirements,
  chainIdForExactNetwork,
  buildExactAuthorization,
  encodeXPaymentHeader,
  EIP3009_TYPES,
} from '../../src/index.js'

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
