/**
 * Seller-side `exact` (EIP-3009) verify + self-settle — every branch, deterministic.
 * Uses a REAL EIP-712 signature (real sign via buildExactAuthorization → real recover
 * in verifyAndSettleExactEvm) with a MOCKED publicClient/walletClient, so the crypto is
 * genuine and only the chain I/O is faked. This is the unit-level smash test for the
 * rail PipRail gets PAID on.
 */
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildExactAuthorization,
  verifyAndSettleExactEvm,
  readExactDomain,
  type ExactAccept,
} from '../../src/drivers/evm/exact.js'
import type { X402ExactAcceptEntry } from '../../src/x402.js'
import { SettlementError } from '../../src/errors.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const PAY_TO = '0x1111111111111111111111111111111111111111' as const
const RELAYER = '0x2222222222222222222222222222222222222222' as const
const CHAIN = { id: 8453, name: 'base' } as unknown as Parameters<typeof verifyAndSettleExactEvm>[0]['chain']
const DOMAIN = { name: 'USD Coin', version: '2' }

/** Build a real, signed EIP-3009 authorization for `amount` to `payTo`, `ttl` secs from now. */
async function signAuth(opts: { amount: string; payTo?: string; ttl?: number; now?: number }) {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const accept: ExactAccept = {
    scheme: 'exact',
    network: 'eip155:8453',
    maxAmountRequired: opts.amount,
    asset: USDC,
    payTo: (opts.payTo ?? PAY_TO) as `0x${string}`,
    maxTimeoutSeconds: opts.ttl ?? 600,
    extra: DOMAIN,
  }
  const nonce = `0x${Math.floor(Math.random() * 1e9).toString(16).padStart(64, '0')}` as `0x${string}`
  const { authorization, signature } = await buildExactAuthorization({ account, accept, chainId: 8453, now, nonce })
  return { authorization, signature, payload: { signature, authorization } }
}

/** The TRUSTED server rail. payTo/amount/domain come from the SERVER, never the client. */
function serverAccept(over: Partial<X402ExactAcceptEntry> = {}): X402ExactAcceptEntry {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '50000',
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' },
    ...over,
  }
}

/** A fake publicClient + walletClient. Override any reader/writer per test.
 *  `fromCode` simulates a smart-wallet payer (address with code → EIP-1271 path). */
function fakeChain(opts: {
  authState?: boolean
  simulate?: () => Promise<unknown>
  write?: () => Promise<`0x${string}`>
  receiptStatus?: 'success' | 'reverted'
  fromCode?: string
} = {}) {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'authorizationState') return opts.authState ?? false
      if (functionName === 'name') return 'USD Coin'
      if (functionName === 'version') return '2'
      throw new Error(`unexpected read ${functionName}`)
    }),
    getCode: vi.fn(async () => opts.fromCode ?? '0x'),
    simulateContract: vi.fn(opts.simulate ?? (async () => ({ request: {} }))),
    waitForTransactionReceipt: vi.fn(async () => ({ status: opts.receiptStatus ?? 'success' })),
  } as unknown as Parameters<typeof verifyAndSettleExactEvm>[0]['publicClient']
  const walletClient = {
    writeContract: vi.fn(opts.write ?? (async () => `0x${'fe'.repeat(32)}` as `0x${string}`)),
  } as unknown as Parameters<typeof verifyAndSettleExactEvm>[0]['walletClient']
  return { publicClient, walletClient }
}

const settle = (payload: unknown, accept: X402ExactAcceptEntry, chain = fakeChain()) =>
  verifyAndSettleExactEvm({
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    account: { address: RELAYER } as unknown as Parameters<typeof verifyAndSettleExactEvm>[0]['account'],
    chain: CHAIN,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: payload as any,
    accept,
  })

describe('verifyAndSettleExactEvm — happy path', () => {
  it('verifies a real signature, broadcasts, returns an exact receipt', async () => {
    const { payload, authorization } = await signAuth({ amount: '50000' })
    const chain = fakeChain()
    const res = await settle(payload, serverAccept(), chain)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('exact')
      expect(res.receipt.transaction).toBe(`0x${'fe'.repeat(32)}`)
      expect(res.receipt.payer.toLowerCase()).toBe(authorization.from.toLowerCase())
      expect(res.receipt.payTo).toBe(PAY_TO)
      expect(res.receipt.amount).toBe('50000')
    }
    // Broadcast used transferWithAuthorization with the (v,r,s) overload (9 args).
    const call = (chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.functionName).toBe('transferWithAuthorization')
    expect(call.args).toHaveLength(9)
  })

  it('accepts an over-payment (value > required)', async () => {
    const { payload } = await signAuth({ amount: '99999' })
    const res = await settle(payload, serverAccept({ amount: '50000' }))
    expect(res.ok).toBe(true)
  })
})

describe('verifyAndSettleExactEvm — minConfirmations + smart-wallet (EIP-1271)', () => {
  const waitCall = (chain: ReturnType<typeof fakeChain>) =>
    (chain.publicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mock.calls[0]![0]

  it('honours the gate minConfirmations in the settle wait', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain()
    const accept = serverAccept({ extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2', minConfirmations: 3 } })
    await settle(payload, accept, chain)
    expect(waitCall(chain).confirmations).toBe(3)
  })

  it('defaults to 1 confirmation when minConfirmations is unset', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain()
    await settle(payload, serverAccept(), chain)
    expect(waitCall(chain).confirmations).toBe(1)
  })

  it('a contract-wallet payer (code at `from`) skips off-chain ECDSA recovery, uses the bytes overload, defers to on-chain validation', async () => {
    // A signature that would NOT ECDSA-recover to `from` — but a contract wallet validates
    // on-chain (EIP-1271), so we don't recover; the passing simulate settles it.
    const { payload } = await signAuth({ amount: '50000' })
    const tampered = { ...payload, signature: payload.signature.slice(0, -4) + '0000' }
    const chain = fakeChain({ fromCode: '0x363d3d373d3d3d363d73' })
    const res = await settle(tampered, serverAccept(), chain)
    expect(res.ok).toBe(true)
    const call = (chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.args).toHaveLength(7) // bytes overload, not (v,r,s)
  })

  it('a contract-wallet payer whose on-chain validation reverts → signature_invalid', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain({ fromCode: '0xabcd', simulate: async () => { throw new Error('execution reverted: FiatTokenV2: invalid signature') } })
    const res = await settle(payload, serverAccept(), chain)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })
})

describe('verifyAndSettleExactEvm — client-fixable rejections (→ 402, never throws)', () => {
  it('wrong_recipient when authorization.to != payTo', async () => {
    const { payload } = await signAuth({ amount: '50000', payTo: '0x9999999999999999999999999999999999999999' })
    const res = await settle(payload, serverAccept())
    expect(res).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('amount_too_low when value < required', async () => {
    const { payload } = await signAuth({ amount: '40000' })
    const res = await settle(payload, serverAccept({ amount: '50000' }))
    expect(res).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('payment_expired when validBefore is in the past', async () => {
    const past = Math.floor(Date.now() / 1000) - 10_000
    const { payload } = await signAuth({ amount: '50000', ttl: 60, now: past })
    const res = await settle(payload, serverAccept())
    expect(res).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('signature_invalid when the signature is tampered', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const bad = { ...payload, signature: payload.signature.slice(0, -4) + '0000' }
    const res = await settle(bad, serverAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('signature_invalid when the authorization is mutated after signing (recovers to a different signer)', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    // Keep the signature, but raise the value — recovery yields a different address.
    const tampered = { ...payload, authorization: { ...payload.authorization, value: '50001' } }
    const res = await settle(tampered, serverAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('signature_invalid on a malformed nonce', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const res = await settle({ ...payload, authorization: { ...payload.authorization, nonce: '0xnothex' } }, serverAccept())
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('tx_already_used when the on-chain nonce is already consumed', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const res = await settle(payload, serverAccept(), fakeChain({ authState: true }))
    expect(res).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('maps a "used or canceled" simulate revert → tx_already_used', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain({ simulate: async () => { throw new Error('execution reverted: FiatTokenV2: authorization is used or canceled') } })
    const res = await settle(payload, serverAccept(), chain)
    expect(res).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('maps a generic simulate revert (insufficient balance) → tx_reverted, and does NOT broadcast', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain({ simulate: async () => { throw new Error('execution reverted: ERC20: transfer amount exceeds balance') } })
    const res = await settle(payload, serverAccept(), chain)
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
    expect((chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('tx_reverted when the settle tx mines but reverts (post-simulate race)', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const res = await settle(payload, serverAccept(), fakeChain({ receiptStatus: 'reverted' }))
    expect(res).toMatchObject({ ok: false, error: 'tx_reverted' })
  })

  it('tx_not_found when the authorizationState read fails (transient RPC)', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain()
    ;(chain.publicClient.readContract as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('RPC 429'))
    const res = await settle(payload, serverAccept(), chain)
    expect(res).toMatchObject({ ok: false, error: 'tx_not_found' })
  })
})

describe('verifyAndSettleExactEvm — server-side settle failure (→ throws SettlementError, never 402)', () => {
  it('throws SettlementError when the relayer broadcast throws (out of gas / RPC down)', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain({ write: async () => { throw new Error('insufficient funds for gas * price + value') } })
    await expect(settle(payload, serverAccept(), chain)).rejects.toBeInstanceOf(SettlementError)
  })

  it('throws SettlementError when the broadcast lands but the confirm read fails', async () => {
    const { payload } = await signAuth({ amount: '50000' })
    const chain = fakeChain()
    ;(chain.publicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('RPC timeout'))
    await expect(settle(payload, serverAccept(), chain)).rejects.toBeInstanceOf(SettlementError)
  })
})

describe('readExactDomain', () => {
  it('returns { name, version } for an EIP-3009 token', async () => {
    const chain = fakeChain()
    const d = await readExactDomain(chain.publicClient, USDC)
    expect(d).toEqual({ name: 'USD Coin', version: '2' })
  })

  it('returns null for native', async () => {
    const chain = fakeChain()
    expect(await readExactDomain(chain.publicClient, 'native')).toBeNull()
  })

  it('returns null when the token is not EIP-3009 (version()/authorizationState revert)', async () => {
    const publicClient = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'name') return 'Tether USD'
        throw new Error('execution reverted') // version()/authorizationState don't exist
      }),
    } as unknown as Parameters<typeof readExactDomain>[0]
    expect(await readExactDomain(publicClient, USDC)).toBeNull()
  })

  it('returns null for a non-address asset', async () => {
    const chain = fakeChain()
    expect(await readExactDomain(chain.publicClient, 'not-an-address')).toBeNull()
  })
})
