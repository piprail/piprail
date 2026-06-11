import { describe, it, expect, vi } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import type { PaidReceipt } from '../src/x402.js'
import { buildSignatureHeader } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const PAY_TO = '0x2222222222222222222222222222222222222222'

// A fake EVM driver (module-isolated) so a verified payment round-trips with NO RPC.
// verify() always succeeds and echoes the server-trusted accept into the receipt.
const fakeEvm: PaymentDriver = {
  family: 'evm',
  resolve(opts) {
    const chain = opts.chain as { id?: number }
    if (typeof chain !== 'object' || typeof chain.id !== 'number') return null
    const network = `eip155:${chain.id}` as const
    const resolveToken = (token: unknown) =>
      token === 'native'
        ? { asset: 'native', decimals: 18, symbol: 'BNB' }
        : { asset: `0x${String(token).toLowerCase()}`, decimals: 6, symbol: String(token) }
    return {
      family: 'evm',
      network,
      supports: (n) => n === network,
      resolveToken,
      describeAsset: () => ({ symbol: 'USDC', decimals: 6 }),
      assertValidPayTo: () => undefined,
      bindWallet: (w) => ({ _native: w }),
      send: async () => `0x${'1'.repeat(64)}`,
      confirm: async () => ({ height: '1' }),
      estimateCost: async () => ({ feeSymbol: 'BNB', feeDecimals: 18, fee: '0', feeFormatted: '0', basis: 'heuristic' as const }),
      balanceOf: async () => ({ token: 0n, native: 0n }),
      recipientReady: async () => ({ ready: 'n/a' as const }),
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

// A gate on a custom EVM chain (so the fake driver answers), priced 0.05 USDC (6dp).
function gateWith(opts: Partial<Parameters<typeof createPaymentGate>[0]> = {}) {
  return createPaymentGate({
    chain: { id: 56, rpcUrl: 'x' },
    token: 'USDC',
    amount: '0.05',
    payTo: PAY_TO,
    ...opts,
  })
}

// Drive one successful payment through a gate; returns the verify() result.
async function pay(gate: ReturnType<typeof createPaymentGate>, tx = `0x${'c'.repeat(64)}`) {
  const { challenge } = await gate.challenge()
  const accept = proofAccepts(challenge)[0]!
  return gate.verify(
    buildSignatureHeader({
      x402Version: 2,
      accepted: accept,
      payload: { nonce: accept.extra.nonce, txHash: tx },
    })
  )
}

describe('onPaid — the enriched receipt', () => {
  it('hands the hook decimals, symbol, a formatted amount, and an idempotency key', async () => {
    let got: PaidReceipt | undefined
    const gate = gateWith({ onPaid: (r) => void (got = r) })
    const res = await pay(gate)

    expect(res.kind).toBe('paid')
    expect(got).toBeDefined()
    // Wire fields survive…
    expect(got!.transaction).toBe(`0x${'c'.repeat(64)}`)
    expect(got!.scheme).toBe('onchain-proof')
    expect(got!.payTo).toBe(PAY_TO)
    // …plus the merchant-facing enrichment the gate already had.
    expect(got!.decimals).toBe(6)
    expect(got!.symbol).toBe('USDC')
    expect(got!.amountFormatted).toBe('0.05') // formatted from the SETTLED base-unit amount
    expect(got!.amount).toBe('50000') // 0.05 × 10^6, still present in base units
    expect(got!.idempotencyKey).toBe(got!.transaction)
  })
})

describe('onPaid — isolation (a hook can never break the request or crash the process)', () => {
  it('an async onPaid that REJECTS does not reject verify, and is routed to onPaidError', async () => {
    const onPaidError = vi.fn()
    const boom = new Error('db is down')
    const gate = gateWith({
      onPaid: async () => {
        throw boom
      },
      onPaidError,
    })
    const res = await pay(gate)
    expect(res.kind).toBe('paid') // a settled payment stays settled
    // give the rejection a tick to surface through the isolation wrapper
    await new Promise((r) => setTimeout(r, 0))
    expect(onPaidError).toHaveBeenCalledTimes(1)
    expect(onPaidError.mock.calls[0]![0]).toBe(boom)
    expect((onPaidError.mock.calls[0]![1] as PaidReceipt).idempotencyKey).toBeDefined()
  })

  it('a SYNCHRONOUS throw in onPaid is caught and routed to onPaidError', async () => {
    const onPaidError = vi.fn()
    const gate = gateWith({
      onPaid: () => {
        throw new Error('sync boom')
      },
      onPaidError,
    })
    const res = await pay(gate)
    expect(res.kind).toBe('paid')
    expect(onPaidError).toHaveBeenCalledTimes(1)
  })

  it('a rejecting async onPaid with NO onPaidError still does not crash (no unhandledRejection)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const gate = gateWith({
        onPaid: async () => {
          throw new Error('silent boom')
        },
      })
      const res = await pay(gate)
      expect(res.kind).toBe('paid')
      // let any stray rejection propagate to the process handler
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a throwing onPaidError also cannot break the request', async () => {
    const gate = gateWith({
      onPaid: () => {
        throw new Error('boom')
      },
      onPaidError: () => {
        throw new Error('observer boom')
      },
    })
    const res = await pay(gate)
    expect(res.kind).toBe('paid')
  })
})

describe('onPaid — awaitOnPaid (record before the resource is served)', () => {
  it('awaitOnPaid:true blocks the paid result until the hook resolves', async () => {
    let release: () => void = () => {}
    const gateGate = new Promise<void>((r) => (release = r))
    let recorded = false
    const gate = gateWith({
      awaitOnPaid: true,
      onPaid: async () => {
        await gateGate
        recorded = true
      },
    })

    const p = pay(gate)
    await Promise.resolve() // let microtasks flush
    expect(recorded).toBe(false) // verify is still waiting on the hook
    release()
    const res = await p
    expect(res.kind).toBe('paid')
    expect(recorded).toBe(true) // recorded BEFORE verify resolved
  })

  it('default is fire-and-forget — the paid result does not wait on a slow hook', async () => {
    let recorded = false
    const gate = gateWith({
      onPaid: () => new Promise<void>((r) => setTimeout(() => ((recorded = true), r()), 20)),
    })
    const res = await pay(gate)
    expect(res.kind).toBe('paid')
    expect(recorded).toBe(false) // the 20ms hook has NOT blocked the response
    await new Promise((r) => setTimeout(r, 30))
    expect(recorded).toBe(true) // it still ran, just not on the critical path
  })
})

describe('onPaid — fires exactly on a fresh settlement', () => {
  it('does not fire on a challenge or a rejected/replayed proof, fires once on success', async () => {
    const onPaid = vi.fn()
    const gate = gateWith({ onPaid })

    // a challenge (no proof) → no fire
    await gate.verify(undefined)
    expect(onPaid).toHaveBeenCalledTimes(0)

    // a fresh, valid proof → one fire
    const tx = `0x${'a'.repeat(64)}`
    expect((await pay(gate, tx)).kind).toBe('paid')
    expect(onPaid).toHaveBeenCalledTimes(1)

    // the SAME proof again → replay-rejected → still just one fire
    const replay = await pay(gate, tx)
    expect(replay.kind).toBe('invalid')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })
})
