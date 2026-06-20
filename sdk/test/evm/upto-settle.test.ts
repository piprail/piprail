/**
 * x402 `upto` (metered) scheme — the EVM-Permit2 driver, deterministic crypto (no I/O).
 * The metered sibling of permit2.test.ts + exact-settle.test.ts. The load-bearing test is
 * SIGN → RECOVER over the `{ to, facilitator, validAfter }` witness (facilitator MIDDLE): if
 * recovery returns the signer, the exact bytes the on-chain upto proxy hashes are what we
 * signed. Plus: the facilitator-binding revert-vector, the settleAmount clamp/over-max guard,
 * the recover-against-the-MAX rule, and the 0n short-circuit (no broadcast).
 */
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress, maxUint256, type PublicClient, type WalletClient } from 'viem'
import { bsc } from 'viem/chains'
import {
  payUptoEvm,
  verifyAndSettleUptoEvm,
  resolveUptoRailEvm,
  X402_UPTO_PERMIT2_PROXY,
  PERMIT2_UPTO_WITNESS_TYPES,
  isUptoProxyChain,
} from '../../src/drivers/evm/upto.js'
import { PERMIT2_ADDRESS } from '../../src/drivers/evm/permit2.js'
import { buildUptoSignatureHeader, parseUptoPaymentHeader } from '../../src/x402.js'
import type { X402UptoAcceptEntry, Permit2UptoPaymentPayload } from '../../src/x402.js'
import { SettlementError } from '../../src/errors.js'

const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
const PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const MAX = '5000000' // the signed MAX (USDC, 6dp = 5.00)
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const account = privateKeyToAccount(KEY)
// The relayer = the bound facilitator (self-settle). A SEPARATE key from the payer.
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const relayer = privateKeyToAccount(RELAYER_KEY)
const FACILITATOR = relayer.address

const accept = (over: Partial<X402UptoAcceptEntry> = {}): X402UptoAcceptEntry => ({
  scheme: 'upto',
  network: 'eip155:56',
  amount: MAX,
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: FACILITATOR, decimals: 6, minConfirmations: 1 },
  ...over,
})

const makeWallet = (onWrite?: (a: unknown) => void): WalletClient =>
  ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: ({ account: _a, ...rest }: any) => account.signTypedData(rest),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContract: async (a: any) => {
      onWrite?.(a)
      return `0x${'aa'.repeat(32)}`
    },
  }) as unknown as WalletClient

const makePublic = (allowance: bigint, code = '0x'): PublicClient =>
  ({
    getCode: async () => code,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: async ({ functionName }: any) => (functionName === 'allowance' ? allowance : 0n),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  }) as unknown as PublicClient

const throwingPublic = new Proxy(
  {},
  { get: () => () => { throw new Error('no RPC expected on this path') } }
) as unknown as PublicClient

describe('payUptoEvm — buyer signing (witness.facilitator is the MIDDLE field)', () => {
  it('signs a PermitWitnessTransferFrom that RECOVERS to the signer over the {to,facilitator,validAfter} witness', async () => {
    const res = await payUptoEvm({
      publicClient: makePublic(maxUint256),
      walletClient: makeWallet(),
      account,
      chainId: bsc.id,
      chain: bsc,
      accept: accept(),
    })
    const pa = res.payload.permit2Authorization
    expect(pa.spender).toBe(X402_UPTO_PERMIT2_PROXY)
    expect(pa.witness.to).toBe(PAYTO)
    expect(pa.witness.facilitator).toBe(FACILITATOR) // bound from extra.facilitatorAddress
    expect(pa.permitted.token).toBe(USDC)
    expect(pa.permitted.amount).toBe(MAX) // the signed MAX
    expect(pa.from).toBe(account.address)

    // THE key assertion: recovery over the UPTO witness types (facilitator middle) returns the signer.
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: bsc.id, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT2_UPTO_WITNESS_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: pa.permitted.token as `0x${string}`, amount: BigInt(pa.permitted.amount) },
        spender: pa.spender as `0x${string}`,
        nonce: BigInt(pa.nonce),
        deadline: BigInt(pa.deadline),
        witness: { to: pa.witness.to as `0x${string}`, facilitator: pa.witness.facilitator as `0x${string}`, validAfter: BigInt(pa.witness.validAfter) },
      },
      signature: res.payload.signature as `0x${string}`,
    })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('a tampered witness.facilitator does NOT recover to the signer (the field is part of the digest)', async () => {
    const res = await payUptoEvm({ publicClient: makePublic(maxUint256), walletClient: makeWallet(), account, chainId: bsc.id, chain: bsc, accept: accept() })
    const pa = res.payload.permit2Authorization
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: bsc.id, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT2_UPTO_WITNESS_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: pa.permitted.token as `0x${string}`, amount: BigInt(pa.permitted.amount) },
        spender: pa.spender as `0x${string}`,
        nonce: BigInt(pa.nonce),
        deadline: BigInt(pa.deadline),
        // tamper: a DIFFERENT facilitator
        witness: { to: pa.witness.to as `0x${string}`, facilitator: '0x000000000000000000000000000000000000bEEF', validAfter: BigInt(pa.witness.validAfter) },
      },
      signature: res.payload.signature as `0x${string}`,
    })
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })

  it('refuses a CONTRACT / smart-wallet signer (EOA-only) before signing', async () => {
    await expect(
      payUptoEvm({ publicClient: makePublic(maxUint256, '0x60016001'), walletClient: makeWallet(), account, chainId: bsc.id, chain: bsc, accept: accept() })
    ).rejects.toThrow(/EOA signer/i)
  })

  it('round-trips through buildUptoSignatureHeader → parseUptoPaymentHeader', async () => {
    const res = await payUptoEvm({ publicClient: makePublic(maxUint256), walletClient: makeWallet(), account, chainId: bsc.id, chain: bsc, accept: accept() })
    const header = buildUptoSignatureHeader({ accepted: accept(), payload: res.payload })
    const parsed = parseUptoPaymentHeader(header)
    expect(parsed!.method).toBe('permit2-upto')
    expect(parsed!.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR)
  })
})

describe('resolveUptoRailEvm — Permit2-only, proxy-gated', () => {
  it('returns a permit2-upto rail with facilitatorAddress = the relayer', () => {
    const rail = resolveUptoRailEvm({ asset: USDC, relayerAddress: FACILITATOR, proxySupported: () => true, domain: { name: 'USD Coin', version: '2' } })
    expect(rail).not.toBeNull()
    expect(rail!.method).toBe('permit2-upto')
    expect(rail!.extra.facilitatorAddress).toBe(FACILITATOR)
    expect(rail!.extra.name).toBe('USD Coin')
  })
  it('returns null for native (not Permit2-transferable)', () => {
    expect(resolveUptoRailEvm({ asset: 'native', relayerAddress: FACILITATOR, proxySupported: () => true })).toBeNull()
  })
  it('returns null on a proxy-less chain', () => {
    expect(resolveUptoRailEvm({ asset: USDC, relayerAddress: FACILITATOR, proxySupported: () => false })).toBeNull()
  })
  it('UPTO_PROXY_CHAIN_IDS covers the verified set, excludes Avalanche (43114)', () => {
    for (const id of [1, 8453, 42161, 10, 137, 56]) expect(isUptoProxyChain(id)).toBe(true)
    expect(isUptoProxyChain(43114)).toBe(false) // verdict: NOT deployed on Avalanche
  })
})

/* ---- seller verify + self-settle (a real signature, mocked chain I/O) ---- */

/** Build a real upto signature for `maxAmount`, facilitator = the relayer, ttl secs from now. */
async function signUpto(opts: { maxAmount?: string; payTo?: string; facilitator?: string; ttl?: number } = {}) {
  const res = await payUptoEvm({
    publicClient: makePublic(maxUint256),
    walletClient: makeWallet(),
    account,
    chainId: bsc.id,
    chain: bsc,
    accept: accept({
      amount: opts.maxAmount ?? MAX,
      payTo: (opts.payTo ?? PAYTO) as string,
      maxTimeoutSeconds: opts.ttl ?? 600,
      extra: { assetTransferMethod: 'permit2-upto', facilitatorAddress: opts.facilitator ?? FACILITATOR, decimals: 6, minConfirmations: 1 },
    }),
  })
  return res.payload
}

function fakeChain(opts: { nonceBitmap?: bigint; simulate?: () => Promise<unknown>; write?: () => Promise<`0x${string}`>; receiptStatus?: 'success' | 'reverted'; fromCode?: string } = {}) {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nonceBitmap') return opts.nonceBitmap ?? 0n
      throw new Error(`unexpected read ${functionName}`)
    }),
    getCode: vi.fn(async () => opts.fromCode ?? '0x'),
    simulateContract: vi.fn(opts.simulate ?? (async () => ({ request: {} }))),
    waitForTransactionReceipt: vi.fn(async () => ({ status: opts.receiptStatus ?? 'success' })),
  } as unknown as PublicClient
  const walletClient = { writeContract: vi.fn(opts.write ?? (async () => `0x${'fe'.repeat(32)}` as `0x${string}`)) } as unknown as WalletClient
  return { publicClient, walletClient }
}

const settle = (payload: Permit2UptoPaymentPayload, settleAmount: bigint, acc = accept(), chain = fakeChain()) =>
  verifyAndSettleUptoEvm({
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    // the relayer IS the facilitator
    account: relayer as unknown as Parameters<typeof verifyAndSettleUptoEvm>[0]['account'],
    chain: bsc,
    payload,
    accept: acc,
    settleAmount,
  })

describe('verifyAndSettleUptoEvm — happy path (partial settle ≤ max)', () => {
  it('verifies a real signature, broadcasts the ACTUAL (< max), returns an upto receipt', async () => {
    const payload = await signUpto()
    const chain = fakeChain()
    const res = await settle(payload, 1858n, accept(), chain)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.scheme).toBe('upto')
      expect(res.receipt.amount).toBe('1858') // the ACTUAL settled, not the MAX
      expect(res.receipt.transaction).toBe(`0x${'fe'.repeat(32)}`)
      expect(res.receipt.payTo).toBe(PAYTO)
    }
    // The settle call put the ACTUAL at position 1 and the permitted MAX inside the permit tuple.
    const call = (chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.functionName).toBe('settle')
    expect(call.args[1]).toBe(1858n) // amount (the actual) at position 1
    expect(call.args[0].permitted.amount).toBe(BigInt(MAX)) // the signed MAX unchanged
  })

  it('settling the FULL max is allowed', async () => {
    const payload = await signUpto()
    const res = await settle(payload, BigInt(MAX))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.receipt.amount).toBe(MAX)
  })
})

describe('verifyAndSettleUptoEvm — the upto invariants', () => {
  it('settleAmount === 0n short-circuits: a zero-charge receipt, NO broadcast, transaction:""', async () => {
    const payload = await signUpto()
    const chain = fakeChain()
    const res = await settle(payload, 0n, accept(), chain)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.receipt.amount).toBe('0')
      expect(res.receipt.transaction).toBe('') // empty STRING, never omitted (spec §5.3)
    }
    expect((chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0) // NO broadcast
    expect((chain.publicClient.simulateContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('settleAmount > the signed MAX → upto_settle_exceeds_max, pre-broadcast', async () => {
    const payload = await signUpto({ maxAmount: '5000000' })
    const chain = fakeChain()
    const res = await settle(payload, 5000001n, accept({ amount: '5000000' }), chain)
    expect(res).toMatchObject({ ok: false, error: 'upto_settle_exceeds_max' })
    expect((chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0) // never broadcast over-max
  })

  it('recovers the signature against the signed MAX (NOT the metered actual) — partial settle still verifies', async () => {
    // The buyer signed for MAX=5000000; we settle 1858. If verify recovered against 1858 it would
    // FAIL (the signature commits to 5000000). A passing happy-path settle of 1858 proves we recover
    // against permitted.amount (the MAX). This is the conformance crux.
    const payload = await signUpto({ maxAmount: '5000000' })
    const res = await settle(payload, 1858n)
    expect(res.ok).toBe(true)
  })

  it('the witness facilitator MUST equal the relayer — a mismatch is a client-fixable rejection (revert-vector)', async () => {
    // Sign binding a DIFFERENT facilitator than the relayer that settles → reject pre-broadcast
    // (the on-chain proxy would revert UnauthorizedFacilitator; we fail fast).
    const payload = await signUpto({ facilitator: '0x000000000000000000000000000000000000bEEF' })
    const chain = fakeChain()
    const res = await settle(payload, 1000n, accept(), chain)
    expect(res).toMatchObject({ ok: false, error: 'signature_invalid' })
    expect((chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })
})

describe('verifyAndSettleUptoEvm — field checks vs the TRUSTED accept (pre-RPC)', () => {
  const PA = (over: Record<string, unknown> = {}) => ({
    permitted: { token: USDC, amount: MAX },
    from: account.address as string,
    spender: X402_UPTO_PERMIT2_PROXY as string,
    nonce: '123456789',
    deadline: String(Math.floor(Date.now() / 1000) + 600),
    witness: { to: PAYTO, facilitator: FACILITATOR, validAfter: '0' },
    ...over,
  })
  const pay = (over: Record<string, unknown> = {}): Permit2UptoPaymentPayload => ({ signature: `0x${'ab'.repeat(65)}`, permit2Authorization: { ...PA(), ...over } as Permit2UptoPaymentPayload['permit2Authorization'] })
  const settleThrowing = (payload: Permit2UptoPaymentPayload, acc: X402UptoAcceptEntry) =>
    verifyAndSettleUptoEvm({ publicClient: throwingPublic, walletClient: makeWallet(), account: relayer as unknown as Parameters<typeof verifyAndSettleUptoEvm>[0]['account'], chain: bsc, payload, accept: acc, settleAmount: 1000n })

  it('rejects when witness.to ≠ payTo → wrong_recipient', async () => {
    const r = await settleThrowing(pay({ witness: { to: account.address, facilitator: FACILITATOR, validAfter: '0' } }), accept())
    expect(r).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })
  it('rejects when the spender is not the upto proxy → signature_invalid', async () => {
    const r = await settleThrowing(pay({ spender: '0x000000000000000000000000000000000000bEEF' }), accept())
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
  })
  it('rejects when the permitted MAX < the rail max → amount_too_low', async () => {
    const r = await settleThrowing(pay(), accept({ amount: '99999999999999999999' }))
    expect(r).toMatchObject({ ok: false, error: 'amount_too_low' })
  })
  it('rejects an OVER-permit (permitted MAX > the rail max) → upto_settle_exceeds_max (x402 strict-equality)', async () => {
    // x402 conformance: at verify time permitted.amount MUST EQUAL the advertised ceiling. An
    // over-permit would let a hostile meter settle MORE than advertised; reject it pre-broadcast.
    const r = await settleThrowing(pay(), accept({ amount: '1' }))
    expect(r).toMatchObject({ ok: false, error: 'upto_settle_exceeds_max' })
  })
  it('rejects an expired deadline → payment_expired', async () => {
    const r = await settleThrowing(pay({ deadline: String(Math.floor(Date.now() / 1000) - 10) }), accept())
    expect(r).toMatchObject({ ok: false, error: 'payment_expired' })
  })
  it('rejects a malformed authorization → signature_invalid', async () => {
    const r = await settleThrowing(pay({ nonce: 'not-a-number' }), accept())
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
  })
})

describe('verifyAndSettleUptoEvm — replay + server-side failure', () => {
  it('tx_already_used when the Permit2 nonce bit is already set', async () => {
    const payload = await signUpto()
    // Set the bit for this nonce in the bitmap word.
    const nonce = BigInt(payload.permit2Authorization.nonce)
    const bitmap = 1n << (nonce & 0xffn)
    const r = await settle(payload, 1000n, accept(), fakeChain({ nonceBitmap: bitmap }))
    expect(r).toMatchObject({ ok: false, error: 'tx_already_used' })
  })

  it('a generic simulate revert (low balance) → tx_reverted, no broadcast', async () => {
    const payload = await signUpto()
    const chain = fakeChain({ simulate: async () => { throw new Error('execution reverted: ERC20: transfer amount exceeds balance') } })
    const r = await settle(payload, 1000n, accept(), chain)
    expect(r).toMatchObject({ ok: false, error: 'tx_reverted' })
    expect((chain.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('throws SettlementError when the relayer broadcast throws (out of gas / RPC down)', async () => {
    const payload = await signUpto()
    const chain = fakeChain({ write: async () => { throw new Error('insufficient funds for gas * price + value') } })
    await expect(settle(payload, 1000n, accept(), chain)).rejects.toBeInstanceOf(SettlementError)
  })

  it('tx_reverted when the settle tx mines but reverts (post-simulate race)', async () => {
    const payload = await signUpto()
    const r = await settle(payload, 1000n, accept(), fakeChain({ receiptStatus: 'reverted' }))
    expect(r).toMatchObject({ ok: false, error: 'tx_reverted' })
  })
})
