/**
 * Buyer-side tolerance of Binance b402's `permit2-exact` dialect. The coinbase/x402 spec labels the
 * EVM-Permit2 exact rail `'permit2'`; Binance's own facilitator labels it `'permit2-exact'`. PipRail
 * EMITS only `'permit2'` but the BUYER must treat both as the SAME rail, or it falls through to the
 * EIP-3009 path and throws on a Binance-Peg (non-3009) token. This drives the REAL evm driver with
 * the two pay-functions mocked, so it's a true regression lock on the routing branch (index.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two buyer pay-functions the driver routes between; keep every other export real.
vi.mock('../../src/drivers/evm/permit2.js', async () => ({
  ...(await vi.importActual('../../src/drivers/evm/permit2.js')),
  payPermit2Evm: vi.fn(async () => ({ payload: { _via: 'permit2' }, payerFrom: '0xpayer', nonce: '0x1' })),
}))
vi.mock('../../src/drivers/evm/exact.js', async () => ({
  ...(await vi.importActual('../../src/drivers/evm/exact.js')),
  payExactEvm: vi.fn(async () => ({ payload: { _via: 'eip3009' }, payerFrom: '0xpayer', nonce: '0x2' })),
}))

const { evmDriver } = await import('../../src/drivers/evm/index.js')
const { payPermit2Evm } = await import('../../src/drivers/evm/permit2.js')
const { payExactEvm } = await import('../../src/drivers/evm/exact.js')

// A buyer handle the driver only forwards (the mocks ignore it).
const wallet = { _native: { walletClient: {}, account: { address: '0xbuyer' } } } as never

const acceptWith = (assetTransferMethod: string) =>
  ({
    scheme: 'exact' as const,
    network: 'eip155:56',
    amount: '1000000000000000000',
    asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // Binance-Peg USDC (Permit2 token)
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod },
  }) as never

describe('payExact — permit2-exact label tolerance (Binance b402 dialect)', () => {
  const bnb = evmDriver.resolve({ chain: 'bnb' })!

  beforeEach(() => {
    vi.mocked(payPermit2Evm).mockClear()
    vi.mocked(payExactEvm).mockClear()
  })

  it('routes literal `permit2` to the Permit2 path', async () => {
    const out = await bnb.payExact!(wallet, acceptWith('permit2'))
    expect(payPermit2Evm).toHaveBeenCalledOnce()
    expect(payExactEvm).not.toHaveBeenCalled()
    expect((out.payload as unknown as { _via: string })._via).toBe('permit2')
  })

  it('routes Binance `permit2-exact` to the SAME Permit2 path (the fix)', async () => {
    const out = await bnb.payExact!(wallet, acceptWith('permit2-exact'))
    expect(payPermit2Evm).toHaveBeenCalledOnce()
    expect(payExactEvm).not.toHaveBeenCalled()
    expect((out.payload as unknown as { _via: string })._via).toBe('permit2')
  })

  it('still routes `eip3009` to the EIP-3009 path (no regression)', async () => {
    const out = await bnb.payExact!(wallet, acceptWith('eip3009'))
    expect(payExactEvm).toHaveBeenCalledOnce()
    expect(payPermit2Evm).not.toHaveBeenCalled()
    expect((out.payload as unknown as { _via: string })._via).toBe('eip3009')
  })
})
