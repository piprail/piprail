import { describe, it, expect, vi } from 'vitest'
import { createPaymentGate } from '../src/server.js'
import type { FailedPayment } from '../src/server.js'
import { buildSignatureHeader } from '../src/x402.js'
import { proofAccepts } from './_dual-rail.js'
import { registerDriver } from '../src/drivers/index.js'
import type { PaymentDriver } from '../src/drivers/types.js'

const PAY_TO = '0x3333333333333333333333333333333333333333'

// A proof ref carrying this sentinel makes the fake driver REJECT (ok:false, amount_too_low),
// so ONE driver drives both a settlement and a driver-level rejection with NO RPC.
const BAD_TX = `0x${'bad'.padEnd(64, '0')}` // 0x + 64 hex, contains "bad"

// A fake EVM driver (module-isolated): verify() SUCCEEDS for a normal tx, REJECTS for BAD_TX.
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
      verify: async (ref, accept) =>
        ref.includes('bad')
          ? { ok: false, error: 'amount_too_low', detail: 'Paid 1, required 50000.' }
          : {
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
            },
    }
  },
}
registerDriver(fakeEvm)

function gateWith(opts: Partial<Parameters<typeof createPaymentGate>[0]> = {}) {
  return createPaymentGate({
    chain: { id: 56, rpcUrl: 'x' },
    token: 'USDC',
    amount: '0.05',
    payTo: PAY_TO,
    ...opts,
  })
}

// Drive a proof through the gate. Default tx → success; pass BAD_TX → driver rejection.
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

// Submit a proof claiming an asset/network this gate doesn't accept → gate-level transfer_not_found.
async function payWrongAsset(gate: ReturnType<typeof createPaymentGate>) {
  const { challenge } = await gate.challenge()
  const accept = proofAccepts(challenge)[0]!
  return gate.verify(
    buildSignatureHeader({
      x402Version: 2,
      accepted: { ...accept, asset: '0xdeadbeef', network: 'eip155:999' },
      payload: { nonce: accept.extra.nonce, txHash: `0x${'e'.repeat(64)}` },
    })
  )
}

describe('onFailed — fires on a rejected proof, carrying the right code', () => {
  it('fires on a DRIVER rejection (amount_too_low) with the canonical code + detail', async () => {
    let got: FailedPayment | undefined
    const gate = gateWith({ onFailed: (f) => void (got = f) })
    const res = await pay(gate, BAD_TX)

    expect(res.kind).toBe('invalid')
    expect(got).toBeDefined()
    expect(got!.code).toBe('amount_too_low')
    expect(got!.detail).toContain('required')
  })

  it('fires on a GATE-level replay (tx_already_used) — and NOT on the first, successful pay', async () => {
    const onFailed = vi.fn()
    const gate = gateWith({ onFailed })

    const tx = `0x${'a'.repeat(64)}`
    expect((await pay(gate, tx)).kind).toBe('paid') // first: success
    expect(onFailed).toHaveBeenCalledTimes(0) // a settlement does NOT fire onFailed

    const replay = await pay(gate, tx) // same proof again → replay-rejected
    expect(replay.kind).toBe('invalid')
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect((onFailed.mock.calls[0]![0] as FailedPayment).code).toBe('tx_already_used')
  })

  it('fires on a GATE-level wrong-asset proof (transfer_not_found)', async () => {
    let got: FailedPayment | undefined
    const gate = gateWith({ onFailed: (f) => void (got = f) })
    const res = await payWrongAsset(gate)

    expect(res.kind).toBe('invalid')
    expect(got!.code).toBe('transfer_not_found')
  })
})

describe('onFailed — does NOT fire on a challenge or a success', () => {
  it('no fire on a no-proof challenge (the normal first leg, not a failure)', async () => {
    const onFailed = vi.fn()
    const gate = gateWith({ onFailed })
    await gate.verify(undefined)
    expect(onFailed).toHaveBeenCalledTimes(0)
  })

  it('a successful payment fires onPaid, never onFailed', async () => {
    const onFailed = vi.fn()
    const onPaid = vi.fn()
    const gate = gateWith({ onFailed, onPaid })
    expect((await pay(gate)).kind).toBe('paid')
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledTimes(0)
  })
})

describe('onFailed — isolation (a hook can never break the request or crash the process)', () => {
  it('an async onFailed that REJECTS does not reject verify, and is routed to onFailedError', async () => {
    const onFailedError = vi.fn()
    const boom = new Error('alerting is down')
    const gate = gateWith({
      onFailed: async () => {
        throw boom
      },
      onFailedError,
    })
    const res = await pay(gate, BAD_TX)
    expect(res.kind).toBe('invalid') // a rejection stays a rejection
    await new Promise((r) => setTimeout(r, 0)) // let the rejection surface through the isolation wrapper
    expect(onFailedError).toHaveBeenCalledTimes(1)
    expect(onFailedError.mock.calls[0]![0]).toBe(boom)
    expect((onFailedError.mock.calls[0]![1] as FailedPayment).code).toBe('amount_too_low')
  })

  it('a SYNCHRONOUS throw in onFailed is caught and routed to onFailedError', async () => {
    const onFailedError = vi.fn()
    const gate = gateWith({
      onFailed: () => {
        throw new Error('sync boom')
      },
      onFailedError,
    })
    const res = await pay(gate, BAD_TX)
    expect(res.kind).toBe('invalid')
    expect(onFailedError).toHaveBeenCalledTimes(1)
  })

  it('a rejecting async onFailed with NO onFailedError still does not crash (no unhandledRejection)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const gate = gateWith({
        onFailed: async () => {
          throw new Error('silent boom')
        },
      })
      const res = await pay(gate, BAD_TX)
      expect(res.kind).toBe('invalid')
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a throwing onFailedError also cannot break the request', async () => {
    const gate = gateWith({
      onFailed: () => {
        throw new Error('boom')
      },
      onFailedError: () => {
        throw new Error('observer boom')
      },
    })
    const res = await pay(gate, BAD_TX)
    expect(res.kind).toBe('invalid')
  })
})

describe('onFailed — awaitOnFailed (record before the 402 is returned)', () => {
  it('awaitOnFailed:true blocks the invalid result until the hook resolves', async () => {
    let release: () => void = () => {}
    const hookGate = new Promise<void>((r) => (release = r))
    let recorded = false
    const gate = gateWith({
      awaitOnFailed: true,
      onFailed: async () => {
        await hookGate
        recorded = true
      },
    })

    const p = pay(gate, BAD_TX)
    await Promise.resolve() // let microtasks flush
    expect(recorded).toBe(false) // verify is still waiting on the hook
    release()
    const res = await p
    expect(res.kind).toBe('invalid')
    expect(recorded).toBe(true) // recorded BEFORE verify resolved
  })

  it('default is fire-and-forget — the invalid result does not wait on a slow hook', async () => {
    let recorded = false
    const gate = gateWith({
      onFailed: () => new Promise<void>((r) => setTimeout(() => ((recorded = true), r()), 20)),
    })
    const res = await pay(gate, BAD_TX)
    expect(res.kind).toBe('invalid')
    expect(recorded).toBe(false) // the 20ms hook has NOT blocked the response
    await new Promise((r) => setTimeout(r, 30))
    expect(recorded).toBe(true) // it still ran, just not on the critical path
  })
})

describe('onFailed — symmetry: the merchant gets the SAME code the buyer is sent', () => {
  it('onFailed.code === the rejection code embedded in the 402 the buyer receives', async () => {
    let got: FailedPayment | undefined
    const gate = gateWith({ onFailed: (f) => void (got = f) })
    const res = await pay(gate, BAD_TX)

    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') return
    // The merchant hook and the buyer-facing verdict carry one consistent code…
    expect(got!.code).toBe(res.error)
    // …and the gate embeds that SAME code in extensions.piprail.code, which the buyer's
    // client reads via readInvalidReason — so both sides see 'amount_too_low'.
    const ext = (res.challenge as { extensions?: { piprail?: { code?: string } } }).extensions
    expect(ext?.piprail?.code).toBe(got!.code)
    expect(got!.code).toBe('amount_too_low')
  })
})

describe('onPaid + onFailed — both hooks coexist across a sequence', () => {
  it('routes each verdict to exactly one hook', async () => {
    const onPaid = vi.fn()
    const onFailed = vi.fn()
    const gate = gateWith({ onPaid, onFailed })

    await gate.verify(undefined) // challenge → neither
    expect((await pay(gate, `0x${'1'.repeat(64)}`)).kind).toBe('paid') // → onPaid
    expect((await pay(gate, BAD_TX)).kind).toBe('invalid') // → onFailed
    await payWrongAsset(gate) // → onFailed

    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledTimes(2)
  })
})
