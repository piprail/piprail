import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { createPaymentGate, ConfirmationTimeoutError, UnknownTokenError, WrongFamilyError } from '../../src/index.js'
import { solanaDriver } from '../../src/drivers/solana/index.js'

const PAY_TO = Keypair.generate().publicKey.toBase58()

describe('solanaDriver.confirm — guards its RPC read (ConfirmationTimeoutError)', () => {
  it('throws ConfirmationTimeoutError when the status read fails (never a raw chain error)', async () => {
    // Point at a dead local RPC: getSignatureStatuses can't read → the confirm()
    // guard must surface a typed ConfirmationTimeoutError, not a raw @solana error.
    const net = solanaDriver.resolve({ chain: 'solana', rpcUrl: 'http://127.0.0.1:1' })!
    const err = await net
      .confirm('1111111111111111111111111111111111111111111111111111111111111111', 1)
      .catch((e) => e)
    expect(err).toBeInstanceOf(ConfirmationTimeoutError)
    expect(err.code).toBe('CONFIRMATION_TIMEOUT')
  })
})

describe('solanaDriver.estimateCost — the exact rail is buyer-gasless (so autoRoute prefers it)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const net = solanaDriver.resolve({ chain: 'solana' })!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accept = (scheme: 'onchain-proof' | 'exact'): any => ({
    scheme, network: net.network, asset: USDC, amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { decimals: 6 },
  })

  it('reports ~0 buyer gas for an `exact` rail (the fee payer pays the SOL fee), basis estimated', async () => {
    const cost = await net.estimateCost(accept('exact'))
    expect(cost.fee).toBe('0')
    expect(cost.feeSymbol).toBe('SOL')
    expect(cost.basis).toBe('estimated')
  })

  it('an `onchain-proof` USDC rail still reports a real (non-zero) SOL fee — the buyer broadcasts', async () => {
    const cost = await net.estimateCost(accept('onchain-proof'))
    expect(BigInt(cost.fee) > 0n).toBe(true)
  })
})

describe('solanaDriver — typed token/family errors at the throw site', () => {
  it('rejects an unknown built-in symbol with a typed UnknownTokenError', async () => {
    const gate = createPaymentGate({ chain: 'solana', token: 'DOGE', amount: '0.05', payTo: PAY_TO })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(UnknownTokenError)
    expect(err.code).toBe('UNKNOWN_TOKEN')
  })

  it('rejects a TON { master } token with a typed WrongFamilyError', async () => {
    const gate = createPaymentGate({
      chain: 'solana',
      token: { master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6 },
      amount: '0.05',
      payTo: PAY_TO,
    })
    const err = await gate.challenge().catch((e) => e)
    expect(err).toBeInstanceOf(WrongFamilyError)
    expect(err.code).toBe('WRONG_FAMILY')
  })
})
