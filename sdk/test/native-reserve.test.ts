/**
 * Spendable is not the same as held.
 *
 * Some chains require an account to retain a minimum it can never send: Solana's rent
 * exemption, XRPL's base reserve. Measuring affordability against the RAW balance calls such a
 * payment affordable right up until the chain refuses it — which is the one outcome
 * `planPayment` exists to prevent, because by then the agent has already signed.
 *
 * Found live: a Solana wallet holding 0.0011 SOL was told it could send 0.0005 SOL, and the
 * transfer failed simulation with a bare `SendTransactionError`. The driver now reports the
 * reserve-deducted figure as `token`, and the client measures the native payment against that.
 */
import { describe, it, expect } from 'vitest'
import { PipRailClient } from '../src/client.js'
import { createPaymentGate } from '../src/server.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'
const CHAIN = { id: 8453, rpcUrl: 'https://fake.example/rpc' }

/** The chain holds RAW, but only RAW - RESERVE may ever be sent. */
let RAW = 1_000_000n
let RESERVE = 890_000n
const FEE = 5_000n

const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken: (t) =>
        t === 'native'
          ? { asset: 'native', decimals: 6, symbol: 'COIN' }
          : { asset: `0x${'a'.repeat(40)}`, decimals: 6, symbol: 'USDC' },
      describeAsset: () => ({ symbol: 'COIN', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({
        feeSymbol: 'COIN', feeDecimals: 6, fee: String(FEE), feeFormatted: '0.005', basis: 'estimated' as const,
      }),
      addressOf: async () => '0xself',
      // The contract: `token` is SPENDABLE, `native` is the true balance.
      balanceOf: async (_w, asset) =>
        asset === 'native'
          ? { token: RAW > RESERVE ? RAW - RESERVE : 0n, native: RAW }
          : { token: 10n ** 12n, native: RAW },
      recipientReady: async () => ({ ready: 'n/a' as const }),
      verify: async (ref, accept) => ({
        ok: true,
        receipt: {
          scheme: 'onchain-proof', success: true, network: accept.network, transaction: ref,
          asset: accept.asset, amount: accept.amount, payer: '0xp', payTo: accept.payTo, verifiedAt: 'now',
        },
      }),
    }
  },
}
registerDriver(fakeEvm)

async function planFor(amount: string) {
  const http = await import('node:http')
  const gate = createPaymentGate({ chain: CHAIN, token: 'native', amount, payTo: PAY_TO })
  const server = http.createServer(async (req, res) => {
    const r = await gate.verify(req.headers['payment-signature'] as string | undefined)
    if (r.kind === 'paid') { res.writeHead(200); res.end('{}'); return }
    res.writeHead(402, { 'payment-required': r.requiredHeader, 'content-type': 'application/json' })
    res.end(JSON.stringify(r.challenge))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    const client = new PipRailClient({ chain: CHAIN, wallet: { key: `0x${'1'.repeat(64)}` } } as never)
    return await client.planPayment(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

describe('a native payment is measured against the SPENDABLE balance', () => {
  it('refuses a payment that would eat into the retained reserve', async () => {
    RAW = 1_000_000n // holds 1.0
    RESERVE = 890_000n // may only ever send 0.11
    const plan = await planFor('0.5') // 0.5 + fee is affordable ONLY if the reserve is ignored
    expect(plan?.payable).toBe(false)
    expect(plan?.options?.[0]?.blockers).toContain('INSUFFICIENT_TOKEN')
  })

  it('names the exact shortfall, so the fix is a number not a guess', async () => {
    RAW = 1_000_000n
    RESERVE = 890_000n
    const plan = await planFor('0.5')
    // spendable 110000; needs 500000 + 5000 → short by 395000 = 0.395
    expect(plan?.fundingHint).toMatch(/0\.395/)
  })

  it('allows a payment that fits INSIDE the spendable balance', async () => {
    RAW = 1_000_000n
    RESERVE = 890_000n
    const plan = await planFor('0.1') // 100000 + 5000 ≤ 110000
    expect(plan?.payable).toBe(true)
    expect(plan?.options?.[0]?.blockers ?? []).toHaveLength(0)
  })

  it('is exact at the boundary: spendable == amount + fee is affordable', async () => {
    RAW = 1_000_000n
    RESERVE = 895_000n // spendable 105000 == 100000 + 5000
    expect((await planFor('0.1'))?.payable).toBe(true)
  })

  it('is exact one unit past the boundary', async () => {
    RAW = 999_999n
    RESERVE = 895_000n // spendable 104999 < 105000
    const plan = await planFor('0.1')
    expect(plan?.payable).toBe(false)
    expect(plan?.options?.[0]?.blockers).toContain('INSUFFICIENT_TOKEN')
  })

  it('a family with NO reserve is unaffected (token === native)', async () => {
    RAW = 1_000_000n
    RESERVE = 0n
    expect((await planFor('0.9'))?.payable).toBe(true)
  })
})
