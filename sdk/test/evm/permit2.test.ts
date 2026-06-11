/**
 * x402 `exact` scheme — `permit2` variant (for non-EIP-3009 tokens, e.g. Binance-Peg
 * USDC on BNB). The load-bearing correctness test is SIGN → RECOVER: if `recoverTypedDataAddress`
 * over the Permit2 domain + our `PERMIT2_WITNESS_TYPES` returns the signer, then the exact
 * bytes an on-chain Permit2 `permitWitnessTransferFrom` hashes are what we signed — i.e. a
 * real BNB settlement would verify. Plus: the EOA guard, the one-time approval branch, and the
 * seller's trusted-accept field checks (which run BEFORE any RPC — proven with a throwing client).
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress, maxUint256, type PublicClient, type WalletClient } from 'viem'
import { bsc } from 'viem/chains'
import {
  payPermit2Evm,
  verifyAndSettlePermit2Evm,
  PERMIT2_ADDRESS,
  X402_EXACT_PERMIT2_PROXY,
  PERMIT2_WITNESS_TYPES,
} from '../../src/drivers/evm/permit2.js'
import { buildExactSignatureHeader, parseExactPaymentHeader } from '../../src/x402.js'
import type { X402ExactAcceptEntry, Permit2PaymentPayload } from '../../src/x402.js'

const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
const PAYTO = '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0'
const AMOUNT = '50000000000000000' // 0.05 USDC at 18 decimals (Binance-Peg)
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123' as const
const account = privateKeyToAccount(KEY)

const accept = (over: Partial<X402ExactAcceptEntry> = {}): X402ExactAcceptEntry => ({
  scheme: 'exact',
  network: 'eip155:56',
  amount: AMOUNT,
  asset: USDC,
  payTo: PAYTO,
  maxTimeoutSeconds: 600,
  extra: { assetTransferMethod: 'permit2', decimals: 18, minConfirmations: 1 },
  ...over,
})

// A walletClient whose signTypedData signs locally with the test account (no network), and
// whose writeContract is a recordable stub (the one-time approve).
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

// A publicClient with a fixed Permit2 allowance + code; readContract returns the allowance.
const makePublic = (allowance: bigint, code = '0x'): PublicClient =>
  ({
    getCode: async () => code,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: async ({ functionName }: any) => (functionName === 'allowance' ? allowance : 0n),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  }) as unknown as PublicClient

// A publicClient that throws on ANY call — proves a code path took no RPC.
const throwingPublic = new Proxy(
  {},
  { get: () => () => { throw new Error('no RPC expected on this path') } }
) as unknown as PublicClient

describe('payPermit2Evm — buyer signing', () => {
  it('signs a PermitWitnessTransferFrom that RECOVERS to the signer (EIP-712 matches on-chain Permit2)', async () => {
    const res = await payPermit2Evm({
      publicClient: makePublic(maxUint256), // already approved → no on-chain approve
      walletClient: makeWallet(),
      account,
      chainId: bsc.id,
      chain: bsc,
      accept: accept(),
    })
    const pa = res.payload.permit2Authorization
    // The wire payload matches the x402 `permit2` shape exactly.
    expect(pa.spender).toBe(X402_EXACT_PERMIT2_PROXY)
    expect(pa.witness.to).toBe(PAYTO)
    expect(pa.permitted.token).toBe(USDC)
    expect(pa.permitted.amount).toBe(AMOUNT)
    expect(pa.from).toBe(account.address)
    expect(res.payerFrom).toBe(account.address)
    expect(res.approvalTx).toBeUndefined() // no approval needed when already allowed

    // THE key assertion: the signature recovers over our domain+types+message.
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: bsc.id, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT2_WITNESS_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: pa.permitted.token as `0x${string}`, amount: BigInt(pa.permitted.amount) },
        spender: pa.spender as `0x${string}`,
        nonce: BigInt(pa.nonce),
        deadline: BigInt(pa.deadline),
        witness: { to: pa.witness.to as `0x${string}`, validAfter: BigInt(pa.witness.validAfter) },
      },
      signature: res.payload.signature as `0x${string}`,
    })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('does the one-time Permit2 approval when allowance is insufficient (and reports the tx)', async () => {
    let approveArgs: { functionName?: string; args?: unknown[] } | undefined
    const res = await payPermit2Evm({
      publicClient: makePublic(0n), // not approved yet
      walletClient: makeWallet((a) => (approveArgs = a as typeof approveArgs)),
      account,
      chainId: bsc.id,
      chain: bsc,
      accept: accept(),
    })
    expect(res.approvalTx).toBe(`0x${'aa'.repeat(32)}`)
    expect(approveArgs?.functionName).toBe('approve')
    expect(approveArgs?.args?.[0]).toBe(PERMIT2_ADDRESS)
    expect(approveArgs?.args?.[1]).toBe(maxUint256)
  })

  it('refuses a CONTRACT / smart-wallet signer (EOA-only) before signing', async () => {
    await expect(
      payPermit2Evm({
        publicClient: makePublic(maxUint256, '0x60016001'), // code at `from`
        walletClient: makeWallet(),
        account,
        chainId: bsc.id,
        chain: bsc,
        accept: accept(),
      })
    ).rejects.toThrow(/EOA signer/i)
  })
})

describe('verifyAndSettlePermit2Evm — seller field checks vs the TRUSTED accept (pre-RPC)', () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const goodPa = {
    permitted: { token: USDC, amount: AMOUNT },
    from: account.address as string,
    spender: X402_EXACT_PERMIT2_PROXY as string,
    nonce: '123456789',
    deadline: String(nowSec + 600),
    witness: { to: PAYTO, validAfter: '0' },
  }
  const pay = (over: Partial<typeof goodPa> = {}): Permit2PaymentPayload => ({
    signature: `0x${'ab'.repeat(65)}`,
    permit2Authorization: { ...goodPa, ...over },
  })
  const settle = (payload: Permit2PaymentPayload, acc: X402ExactAcceptEntry) =>
    verifyAndSettlePermit2Evm({
      publicClient: throwingPublic, // these rejections must NOT touch the chain
      walletClient: makeWallet(),
      account,
      chain: bsc,
      payload,
      accept: acc,
    })

  it('rejects when witness.to ≠ payTo → wrong_recipient', async () => {
    const r = await settle(pay({ witness: { to: account.address, validAfter: '0' } }), accept())
    expect(r).toMatchObject({ ok: false, error: 'wrong_recipient' })
  })

  it('rejects when the permitted token ≠ the rail asset → signature_invalid', async () => {
    const r = await settle(pay({ permitted: { token: '0x000000000000000000000000000000000000dEaD', amount: AMOUNT } }), accept())
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects when the spender is not the x402ExactPermit2Proxy → signature_invalid', async () => {
    const r = await settle(pay({ spender: '0x000000000000000000000000000000000000bEEF' }), accept())
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
  })

  it('rejects when the permitted amount < required → amount_too_low', async () => {
    const r = await settle(pay(), accept({ amount: '99999999999999999999' }))
    expect(r).toMatchObject({ ok: false, error: 'amount_too_low' })
  })

  it('rejects an expired deadline → payment_expired', async () => {
    const r = await settle(pay({ deadline: String(nowSec - 10) }), accept())
    expect(r).toMatchObject({ ok: false, error: 'payment_expired' })
  })

  it('rejects a malformed authorization → signature_invalid', async () => {
    const bad = { signature: `0x${'ab'.repeat(65)}`, permit2Authorization: { ...goodPa, nonce: 'not-a-number' } } as Permit2PaymentPayload
    const r = await settle(bad, accept())
    expect(r).toMatchObject({ ok: false, error: 'signature_invalid' })
  })
})

describe('permit2 wire — build + parse round-trips through the standard exact header', () => {
  it('buildExactSignatureHeader → parseExactPaymentHeader yields method:permit2 + the permit2Authorization', async () => {
    const res = await payPermit2Evm({
      publicClient: makePublic(maxUint256),
      walletClient: makeWallet(),
      account,
      chainId: bsc.id,
      chain: bsc,
      accept: accept(),
    })
    const header = buildExactSignatureHeader({ accepted: accept(), payload: res.payload })
    const parsed = parseExactPaymentHeader(header)
    expect(parsed).not.toBeNull()
    expect(parsed!.method).toBe('permit2')
    expect(parsed!.network).toBe('eip155:56')
    expect(parsed!.asset).toBe(USDC)
    if (parsed && parsed.method === 'permit2') {
      expect(parsed.payload.permit2Authorization.witness.to).toBe(PAYTO)
      expect(parsed.payload.permit2Authorization.spender).toBe(X402_EXACT_PERMIT2_PROXY)
      expect(parsed.payload.signature).toBe(res.payload.signature)
    }
  })

  it('a permit2 payload missing the witness is rejected by the parser', () => {
    const bad = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { scheme: 'exact', network: 'eip155:56', asset: USDC },
        payload: { signature: `0x${'ab'.repeat(65)}`, permit2Authorization: { permitted: { token: USDC, amount: AMOUNT }, from: PAYTO, spender: X402_EXACT_PERMIT2_PROXY, nonce: '1', deadline: '2' } },
      }),
      'utf8'
    ).toString('base64')
    expect(parseExactPaymentHeader(bad)).toBeNull()
  })
})
