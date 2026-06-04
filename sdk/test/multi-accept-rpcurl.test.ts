import { describe, it, expect } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'
import type { Caip2 } from '../src/x402.js'

// Multi-chain merchants pin a reliable RPC PER chain so one throttled public
// endpoint can't take down verification for the others. This proves each
// accept[] entry is resolved with its OWN rpcUrl, falling back to the top-level
// rpcUrl when an entry omits it.

const PAY_TO = '0x1111111111111111111111111111111111111111'

// A fake EVM driver (module-isolated) that RECORDS the rpcUrl each network was
// resolved with — so the test can prove the per-accept plumbing. It recognises
// EVM chains by string name (the common case where you'd pin a per-accept RPC).
const resolvedWith: Record<string, string | undefined> = {}
const NAME_TO_NET: Record<string, string> = { base: 'eip155:8453', arbitrum: 'eip155:42161' }
const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const net = typeof opts.chain === 'string' ? NAME_TO_NET[opts.chain] : undefined
    if (!net) return null
    const network = net as Caip2
    resolvedWith[network] = opts.rpcUrl
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: () => ({ asset: 'native', decimals: 18, symbol: 'ETH' }),
      describeAsset: () => ({ symbol: 'ETH', decimals: 18 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'ETH', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: "n/a" as const }),
      verify: async () => ({ ok: false, error: 'transfer_not_found', detail: 'x' }),
    }
  },
}
registerDriver(fakeEvm)

describe('per-accept rpcUrl — each chain resolves with its own RPC (multi-chain reliability)', () => {
  it('uses the accept-level rpcUrl, and falls back to the top-level rpcUrl when omitted', async () => {
    const gate = createPaymentGate({
      rpcUrl: 'https://top-level.example/rpc', // fallback for entries without their own
      accept: [
        { chain: 'base', token: 'native', amount: '1', payTo: PAY_TO, rpcUrl: 'https://base.example/rpc' },
        { chain: 'arbitrum', token: 'native', amount: '2', payTo: PAY_TO }, // no rpcUrl → falls back
      ],
    })
    await gate.challenge() // triggers the (memoized) resolution of every accept

    expect(resolvedWith['eip155:8453']).toBe('https://base.example/rpc') // accept-level wins
    expect(resolvedWith['eip155:42161']).toBe('https://top-level.example/rpc') // fell back to top-level
  })

  it('does not leak rpcUrl into the challenge (the server RPC stays private)', async () => {
    const gate = createPaymentGate({
      accept: [{ chain: 'base', token: 'native', amount: '1', payTo: PAY_TO, rpcUrl: 'https://secret-key.example/rpc?apikey=SHHH' }],
    })
    const { challenge } = await gate.challenge()
    expect(JSON.stringify(challenge)).not.toContain('secret-key.example')
    expect(JSON.stringify(challenge)).not.toContain('SHHH')
  })
})
