/**
 * ── TRON: THE TRC-20 APPROVAL PATH ──────────────────────────────────────────────
 *
 * SunSwap V2 is a Uniswap V2 clone, so the router moves the input token with
 * `transferFrom` and cannot do it without an allowance. The first version of this driver
 * had no approve step at all: native-in swaps (TRX → USDT) worked, and every token-in
 * swap would have failed on allowance after the energy was already spent.
 *
 * It survived review because the route ships UNPROVEN — there is no mainnet transaction
 * to contradict it, and a quote proves routing rather than settlement. So the contract has
 * to be pinned here instead, with a fake TronWeb that records every call in order.
 *
 * What each test protects:
 *   - a native input must cost exactly ONE transaction (an approve would be a wasted fee)
 *   - a token input must approve FIRST, for the on-chain ceiling rather than the estimate
 *   - a sufficient allowance must be reused, not re-approved
 *   - a stale non-zero allowance must be zeroed first (Tron's USDT is a Tether port, which
 *     reverts on a non-zero to non-zero approve)
 *   - an approve that fails, or never lands, must stop the swap rather than let it run
 *     against an allowance that was never granted
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { quoteTronSwap, swapTron, TRON_SWAP_ENERGY, TRON_APPROVE_ENERGY } from '../src/drivers/tron/swap.js'
import { InsufficientFundsError } from '../src/errors.js'
import type { SwapQuote } from '../src/swap.js'

const OWNER = 'TVvRPbEpkY34SmqEkioxtKywenWLmtuVzL'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'

/** Encode a `uint256[]` return: offset, length, then the values. */
const uintArray = (...vals: bigint[]) =>
  [32n, BigInt(vals.length), ...vals].map((v) => v.toString(16).padStart(64, '0')).join('')

/** Encode a single `uint256` return, which is what `allowance` gives back. */
const uint = (v: bigint) => v.toString(16).padStart(64, '0')

interface Call {
  kind: 'constant' | 'send'
  contract: string
  selector: string
  params: { type: string; value: unknown }[]
  options?: Record<string, unknown>
}

/**
 * A fake TronWeb that records the exact call sequence. `allowance` is answered from
 * `opts.allowance`; every other constant call is the router's `getAmountsIn`.
 */
function fakeTron(opts: {
  allowance?: bigint
  /** `undefined` = never confirms. */
  receipt?: string
  amountIn?: bigint
  allowanceReadFails?: boolean
  broadcastRejects?: boolean
}) {
  const calls: Call[] = []
  const client = {
    transactionBuilder: {
      async triggerConstantContract(
        contract: string,
        selector: string,
        _o: Record<string, unknown>,
        params: { type: string; value: unknown }[]
      ) {
        calls.push({ kind: 'constant', contract, selector, params })
        if (selector.startsWith('allowance')) {
          if (opts.allowanceReadFails) throw new Error('node refused the read')
          return { result: { result: true }, constant_result: [uint(opts.allowance ?? 0n)] }
        }
        return {
          result: { result: true },
          constant_result: [uintArray(opts.amountIn ?? 148_079n, 50_000n)],
        }
      },
      async triggerSmartContract(
        contract: string,
        selector: string,
        options: Record<string, unknown>,
        params: { type: string; value: unknown }[]
      ) {
        calls.push({ kind: 'send', contract, selector, params, options })
        return { result: { result: true }, transaction: {} }
      },
    },
    trx: {
      async getTransactionInfo(txid: string) {
        return opts.receipt ? { id: txid, receipt: { result: opts.receipt } } : {}
      },
      async sign() {
        return { txID: `tx${calls.length}` }
      },
      async sendRawTransaction(signed: { txID: string }) {
        if (opts.broadcastRejects) return { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: 'nope' }
        return { result: true, txid: signed.txID }
      },
    },
  }
  return { client, calls }
}

/** Build a real quote through the driver, so the route under test is never hand-faked. */
async function quoteFor(fromNative: boolean, client: unknown): Promise<SwapQuote> {
  const q = await quoteTronSwap({
    client: client as never,
    network: 'tron:mainnet' as never,
    from: fromNative
      ? { asset: 'native', decimals: 6, symbol: 'TRX' }
      : ({ asset: USDT, decimals: 6, symbol: 'USDT' } as never),
    to: fromNative
      ? ({ asset: USDT, decimals: 6, symbol: 'USDT' } as never)
      : { asset: 'native', decimals: 6, symbol: 'TRX' },
    wantAmount: 50_000n,
    slippageBps: 100,
    owner: OWNER,
  })
  expect(q).not.toBeNull()
  return q!
}

/** Drive the poll loop without waiting on real seconds. */
async function runWithTimers<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  const settled = work.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e })
  )
  await vi.advanceTimersByTimeAsync(ms)
  const r = await settled
  if (!r.ok) throw r.e
  return r.v
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Tron: a native input needs no approval', () => {
  it('sends exactly one transaction, and it is the swap', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ receipt: 'SUCCESS' })
    const quote = await quoteFor(true, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const sends = calls.filter((c) => c.kind === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.selector).toMatch(/^swapETHForExactTokens/)
    // No allowance was even read: there is no token to approve.
    expect(calls.some((c) => c.selector.startsWith('allowance'))).toBe(false)
  })

  it('caps the native input with callValue rather than an approval', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ receipt: 'SUCCESS' })
    const quote = await quoteFor(true, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const swap = calls.find((c) => c.kind === 'send')!
    expect(swap.options?.callValue).toBe(Number(quote.maxSpend))
  })

  it('says plainly in the quote that this is a single transaction', async () => {
    const { client } = fakeTron({})
    const quote = await quoteFor(true, client)
    expect(quote.source.note).toMatch(/single transaction/i)
  })
})

describe('Tron: a TRC-20 input must approve the router first', () => {
  it('approves before swapping when the allowance is zero', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 0n, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const sends = calls.filter((c) => c.kind === 'send')
    expect(sends).toHaveLength(2)
    // Order is the whole point: approve, THEN swap.
    expect(sends[0]!.selector).toMatch(/^approve/)
    expect(sends[0]!.contract).toBe(USDT)
    expect(sends[1]!.selector).toMatch(/^swapTokensForExactETH/)
  })

  it('approves the on-chain CEILING, not the estimated input', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 0n, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const approve = calls.find((c) => c.kind === 'send' && c.selector.startsWith('approve'))!
    // Approving only the estimate would leave the swap short the moment the price moved,
    // which is the exact case the ceiling exists to survive.
    expect(approve.params[1]!.value).toBe(quote.maxSpend)
    expect(BigInt(quote.maxSpend)).toBeGreaterThan(BigInt(quote.from.amount))
    expect(approve.params[0]!.value).toBe(ROUTER)
  })

  it('reuses an allowance that is already large enough', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 10_000_000n, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const sends = calls.filter((c) => c.kind === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.selector).toMatch(/^swapTokensForExactETH/)
  })

  it('zeroes a stale allowance first, because Tron’s USDT reverts otherwise', async () => {
    vi.useFakeTimers()
    // Non-zero but too small: the Tether pattern rejects a direct non-zero to non-zero approve.
    const { client, calls } = fakeTron({ allowance: 5n, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const sends = calls.filter((c) => c.kind === 'send')
    expect(sends).toHaveLength(3)
    expect(sends[0]!.selector).toMatch(/^approve/)
    expect(sends[0]!.params[1]!.value).toBe('0')
    expect(sends[1]!.selector).toMatch(/^approve/)
    expect(sends[1]!.params[1]!.value).toBe(quote.maxSpend)
    expect(sends[2]!.selector).toMatch(/^swapTokensForExactETH/)
  })

  it('attempts the approve when the allowance cannot be read', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowanceReadFails: true, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)

    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    // Assuming an allowance we could not see would burn the swap's energy for nothing.
    const sends = calls.filter((c) => c.kind === 'send')
    expect(sends[0]!.selector).toMatch(/^approve/)
    expect(sends).toHaveLength(2)
  })

  it('warns in the quote that a token input costs a second transaction', async () => {
    const { client } = fakeTron({})
    const quote = await quoteFor(false, client)
    expect(quote.source.note).toMatch(/approve/i)
  })
})

describe('Tron: an approval that does not land must stop the swap', () => {
  it('throws when the approve fails on-chain, and never sends the swap', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 0n, receipt: 'OUT_OF_ENERGY' })
    const quote = await quoteFor(false, client)

    await expect(
      runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))
    ).rejects.toThrow(/OUT_OF_ENERGY/)

    expect(calls.filter((c) => c.kind === 'send' && c.selector.startsWith('swap'))).toHaveLength(0)
  })

  it('throws rather than swapping against an approve that never confirms', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 0n, receipt: undefined })
    const quote = await quoteFor(false, client)

    await expect(
      runWithTimers(
        swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }),
        70_000
      )
    ).rejects.toThrow(/not confirmed/i)

    expect(calls.filter((c) => c.kind === 'send' && c.selector.startsWith('swap'))).toHaveLength(0)
  })

  it('reports a rejected broadcast as a failure, not a receipt', async () => {
    vi.useFakeTimers()
    const { client } = fakeTron({ receipt: 'SUCCESS', broadcastRejects: true })
    const quote = await quoteFor(true, client)

    await expect(
      runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))
    ).rejects.toThrow(/CONTRACT_VALIDATE_ERROR/)
  })
})

describe('Tron: money is never rounded to fit a JS number', () => {
  it('refuses a native input past the safe-integer range instead of truncating it', async () => {
    vi.useFakeTimers()
    const { client } = fakeTron({ receipt: 'SUCCESS' })
    const quote = await quoteFor(true, client)
    // 2^53 sun is ~9 billion TRX: unreachable in practice, but rounding money is never OK.
    const huge: SwapQuote = {
      ...quote,
      maxSpend: (2n ** 60n).toString(),
      route: { ...(quote.route as object), amountInMax: (2n ** 60n).toString() } as never,
    }

    await expect(
      runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote: huge }))
    ).rejects.toThrow(InsufficientFundsError)
  })

  it('accepts the largest input that still fits exactly', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ receipt: 'SUCCESS' })
    const quote = await quoteFor(true, client)
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    const big: SwapQuote = {
      ...quote,
      maxSpend: max.toString(),
      route: { ...(quote.route as object), amountInMax: max.toString() } as never,
    }

    await runWithTimers(
      swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote: big })
    )
    const swap = calls.find((c) => c.kind === 'send')!
    expect(swap.options?.callValue).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('Tron: the route records which path it is on', () => {
  it('marks a token input as needing approval and names the token', async () => {
    const { client } = fakeTron({})
    const quote = await quoteFor(false, client)
    const route = quote.route as { needsApproval: boolean; tokenIn: string }
    expect(route.needsApproval).toBe(true)
    expect(route.tokenIn).toBe(USDT)
  })

  it('marks a native input as needing none, with no token to approve', async () => {
    const { client } = fakeTron({})
    const quote = await quoteFor(true, client)
    const route = quote.route as { needsApproval: boolean; tokenIn: string }
    expect(route.needsApproval).toBe(false)
    expect(route.tokenIn).toBe('')
  })
})

describe('Tron: the fee ceilings must cover what the chain actually charges', () => {
  /*
   * Tron charges energy in TRX at the chain's `getEnergyFee`, measured at 100 sun per energy.
   * A fee limit BELOW that cost does not make the transaction cheaper; it makes it die with
   * OUT_OF_ENERGY after the energy is already gone.
   *
   * The first version of this driver set the approve ceiling to 10 TRX because an approve
   * "is cheap". A fresh allowance slot on Tether's Tron contract measured 99,764 energy,
   * which is 9.976 TRX: under the ceiling by a quarter of a percent. These assertions exist
   * so nobody trims a ceiling toward its measurement again.
   */
  const SUN_PER_ENERGY = 100n
  const cost = (energy: number) => BigInt(energy) * SUN_PER_ENERGY

  it('the approve ceiling clears a fresh allowance slot with real headroom', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ allowance: 0n, receipt: 'SUCCESS' })
    const quote = await quoteFor(false, client)
    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const approve = calls.find((c) => c.kind === 'send' && c.selector.startsWith('approve'))!
    const limit = BigInt(approve.options!.feeLimit as number)
    expect(limit).toBeGreaterThan(cost(TRON_APPROVE_ENERGY))
    // At least 50% headroom, so a fee-parameter change does not immediately break it.
    expect(limit).toBeGreaterThanOrEqual((cost(TRON_APPROVE_ENERGY) * 3n) / 2n)
  })

  it('the swap ceiling clears the measured swap energy with real headroom', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeTron({ receipt: 'SUCCESS' })
    const quote = await quoteFor(true, client)
    await runWithTimers(swapTron({ client: client as never, owner: OWNER, privateKey: 'k', quote }))

    const swap = calls.find((c) => c.kind === 'send' && c.selector.startsWith('swap'))!
    const limit = BigInt(swap.options!.feeLimit as number)
    expect(limit).toBeGreaterThan(cost(TRON_SWAP_ENERGY))
    expect(limit).toBeGreaterThanOrEqual((cost(TRON_SWAP_ENERGY) * 3n) / 2n)
  })
})
