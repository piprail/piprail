import { describe, it, expect } from 'vitest'
import { parseUnits } from 'viem'
import { createPaymentGate } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const PAY_TO = '0x1111111111111111111111111111111111111111'

// A fake EVM driver (module-isolated to this file) so multi-accept verify can be
// exercised with NO RPC. Each { id, rpcUrl } becomes its own network; verify
// echoes the accept it was handed, so a test can prove which accept was used.
const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    // Resolve a token by its given form so a gate can offer two tokens on one chain.
    const resolveToken = (token: unknown) =>
      token === 'native'
        ? { asset: 'native', decimals: 18, symbol: 'ETH' }
        : typeof token === 'string'
          ? { asset: `0x${token.toLowerCase()}`, decimals: 6, symbol: token }
          : { asset: 'native', decimals: 18, symbol: 'ETH' }
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken,
      describeAsset: () => ({ symbol: 'ETH', decimals: 18 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: "n/a" as const }),
      // Echo the accept verbatim into the receipt — the test inspects it.
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof',
          success: true,
          network: accept.network,
          transaction: ref,
          asset: accept.asset,
          amount: accept.amount,
          payer: '0xpayer',
          payTo: accept.payTo,
          verifiedAt: 'now',
        },
      }),
    }
  },
}
registerDriver(fakeEvm)

// Two EVM "chains" at different amounts: id 1 → 1 ETH, id 8453 → 2 ETH.
const gate = () =>
  createPaymentGate({
    accept: [
      { chain: { id: 1, rpcUrl: 'x' }, token: 'native', amount: '1', payTo: PAY_TO },
      { chain: { id: 8453, rpcUrl: 'y' }, token: 'native', amount: '2', payTo: PAY_TO },
    ],
  })

describe('multi-accept verify — routes to the claimed network and trusts only the server spec', () => {
  it('verifies the proof against the option for the claimed network', async () => {
    const g = gate()
    const { challenge } = await g.challenge()
    const onBase = challenge.accepts.find((a) => a.network === 'eip155:8453')!
    const res = await g.verify(
      buildSignatureHeader({
        x402Version: 2,
        accepted: onBase,
        payload: { nonce: onBase.extra.nonce, txHash: `0x${'c'.repeat(64)}` },
      })
    )
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') {
      expect(res.receipt.network).toBe('eip155:8453')
      expect(res.receipt.amount).toBe(parseUnits('2', 18).toString())
    }
  })

  it('ignores a forged amount in the client-echoed accept — uses the SERVER amount', async () => {
    const g = gate()
    const { challenge } = await g.challenge()
    const onEth = challenge.accepts.find((a) => a.network === 'eip155:1')!
    // Tamper the echoed accept: claim a tiny amount. verify must use the server's '1 ETH'.
    const res = await g.verify(
      buildSignatureHeader({
        x402Version: 2,
        accepted: { ...onEth, amount: '1' }, // forged — 1 wei
        payload: { nonce: onEth.extra.nonce, txHash: `0x${'d'.repeat(64)}` },
      })
    )
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') {
      expect(res.receipt.amount).toBe(parseUnits('1', 18).toString()) // SERVER's amount, not 1 wei
      expect(res.receipt.amount).not.toBe('1')
    }
  })

  it('disambiguates two tokens on the SAME network by the claimed asset', async () => {
    // One chain (eip155:1), two offered tokens: native ETH and USDC.
    const g = createPaymentGate({
      accept: [
        { chain: { id: 1, rpcUrl: 'x' }, token: 'native', amount: '1', payTo: PAY_TO },
        { chain: { id: 1, rpcUrl: 'x' }, token: 'USDC', amount: '5', payTo: PAY_TO },
      ],
    })
    const { challenge } = await g.challenge()
    const usdc = challenge.accepts.find((a) => a.asset !== 'native')!
    const res = await g.verify(
      buildSignatureHeader({
        x402Version: 2,
        accepted: usdc, // claim the USDC option, not native
        payload: { nonce: usdc.extra.nonce, txHash: `0x${'e'.repeat(64)}` },
      })
    )
    expect(res.kind).toBe('paid')
    if (res.kind === 'paid') {
      expect(res.receipt.asset).toBe(usdc.asset) // verified against the USDC spec, not native
      expect(res.receipt.amount).toBe(parseUnits('5', 6).toString())
    }
  })
})
