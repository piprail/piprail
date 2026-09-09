/**
 * ── APTOS SECTION: swap ──
 * Same-chain swap through **Hyperion**, an open Aptos concentrated-liquidity DEX,
 * called **contract-to-contract with no API in the middle**.
 *
 * 🔴 THIS IS A THIRD-PARTY CONTRACT, named as such everywhere it surfaces. Aptos has no
 * protocol-level swap, so a DEX is unavoidable. Hyperion was chosen on evidence gathered
 * live on mainnet 2026-09-08:
 *
 *   - **No API and therefore no API key.** Every other Aptos route we probed wanted one or
 *     took a cut: Panora returns `401 API key is required` even for its token list, and
 *     Kana Labs is keyless but keeps `kanaFee` = 0.2% of every swap with no parameter to
 *     remove it. Hyperion needs neither, because we never call a service: quoting is an
 *     on-chain `view` and swapping is an entry function. There is no host to go down, no
 *     key to rotate, and no vendor between the wallet and the pool.
 *   - **No integrator fee.** PipRail passes no fee, referrer or partner argument, because
 *     the entry function has no such parameter. The only cost is the pool's own fee, which
 *     the quote reads back from the chain and reports.
 *   - **Self-custody.** `exact_output_swap_entry` takes the user's own `&signer`. The
 *     account signs locally, this process submits, and the funds go straight to `recipient`
 *     (always the user's own address). Nobody else signs and nobody holds the funds.
 *
 * ⭐ **Exact output, natively.** Unlike the exact-in aggregators the other families use,
 * Hyperion's `exact_output_swap_entry` takes the amount you want OUT plus an
 * `amount_in_max` cap. That is precisely the shape of an x402 invoice, so there is no
 * probe-and-scale approximation here: we ask for the invoice amount and the chain refuses
 * the trade if it would cost more than the cap. **Slippage is enforced on-chain**, not by
 * this SDK trusting a quote.
 *
 * Assets are Fungible Assets, identified by metadata object address (native APT is the
 * `0xa` paired metadata), matching the rest of the Aptos driver.
 */
import { APT_DECIMALS, APT_SYMBOL, APT_FA_METADATA } from './chains.js'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** Hyperion's mainnet package. Verified on-chain: 32 modules, `router_v3` + `pool_v3` present. */
const HYPERION = '0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c'

/**
 * Hyperion fee tiers are a `u8`. We do not hardcode what each tier means — we ask the chain
 * which tiers have a pool for this pair and price every one, then take the cheapest. A tier
 * that does not exist, or whose pool is empty, simply loses.
 */
const FEE_TIERS = [0, 1, 2, 3, 4] as const

/** How long the on-chain deadline allows, in seconds. */
const DEADLINE_SECONDS = 120

/**
 * Cap max gas, for the same reason `pay.ts` does: Aptos validates
 * `max_gas_amount × gas_unit_price` against the sender's balance BEFORE execution, so the
 * SDK default (200_000 units) demands roughly half an APT be held just to be admitted, and
 * a wallet with a modest balance is rejected with INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE
 * before the swap is ever attempted. A concentrated-liquidity swap costs more than a
 * transfer, so this is set higher than the pay path's 50k while keeping the upfront
 * requirement small. (Found the same way pay.ts found it: a live mainnet run.)
 */
const MAX_GAS_AMOUNT = 80_000

/*
 * 🔴 The price limit is REQUIRED and directional. Passing `0` for "no limit" aborts with
 * `ESQRT_PRICE_LIMIT_UNAVAILABLE` (found on mainnet — the transaction commits and fails).
 * A concentrated-liquidity swap needs a bound on the side the price is moving toward, so we
 * pass the extreme bound for the direction of travel and let `amount_in_max` do the real
 * protecting.
 *
 * These are Q64.64 (u128) bounds, READ OFF THE CHAIN rather than copied from another DEX:
 * `tick_math::get_sqrt_price_at_tick_u32` at ticks ∓443636 returns exactly these, and ticks
 * beyond that abort with EINVALID_TICK.
 */
const MIN_SQRT_PRICE = 4295048016n
const MAX_SQRT_PRICE = 79226673515401279992447579055n

/** The slice of the Aptos client this module needs. Narrow on purpose, so it is testable. */
export interface AptosSwapClient {
  view<T>(input: {
    payload: { function: string; typeArguments?: string[]; functionArguments: unknown[] }
  }): Promise<T>
  build(input: {
    sender: string
    data: { function: string; typeArguments?: string[]; functionArguments: unknown[] }
    options?: { maxGasAmount?: number }
  }): Promise<unknown>
  signSubmit(input: { signer: unknown; transaction: unknown }): Promise<{ hash: string }>
  waitFor(input: { hash: string }): Promise<{ success?: boolean; vm_status?: string }>
}

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
function sourceFor(feeRate: bigint) {
  const pct = feeRate > 0n ? `${(Number(feeRate) / 10_000).toFixed(4)}%` : 'the pool fee'
  return {
    kind: 'provider' as const,
    name: 'Hyperion',
    note:
      'Third-party Aptos DEX (Hyperion), called contract-to-contract with no API and no API key: ' +
      'the quote is an on-chain view and the swap is an entry function your own account signs. ' +
      `Cost on this route: ${pct}, which is the pool's own fee. PipRail adds nothing, and the ` +
      'entry function has no fee parameter to add.',
  }
}

/**
 * Compare two Aptos addresses by VALUE, not by spelling. A `view` returns them fully
 * padded (`0x0000…000a`) while presets carry the short form (`0xa`), so a plain string
 * compare silently says "different" for the same address. That is how the native-APT
 * routes broke: the pool's token0 never matched, the price bound was chosen for the wrong
 * direction, and the swap aborted on-chain.
 */
function sameAddress(a: string, b: string): boolean {
  return padAddress(a) === padAddress(b)
}

/** Canonical 64-hex form, so the same address always compares equal to itself. */
function padAddress(x: string): string {
  return x.replace(/^0x/i, '').padStart(64, '0').toLowerCase()
}

/**
 * Which side of the pair are we selling? Token0 is simply the numerically SMALLER metadata
 * address, the standard concentrated-liquidity convention, and selling token0 pushes the
 * price down.
 *
 * 🔴 Derived by comparing the two addresses, NOT by reading the pool's token0 field. That
 * field comes back as all-zeros for pools holding native APT (which is a legacy coin with a
 * paired FA), so trusting it silently chose the wrong direction and every native-APT swap
 * aborted with ESQRT_PRICE_LIMIT_UNAVAILABLE. Comparing addresses needs no extra call and
 * was checked against all four live directions on two different pools.
 */
function sellingToken0(from: string, to: string): boolean {
  return BigInt('0x' + padAddress(from)) < BigInt('0x' + padAddress(to))
}

/** Aptos speaks FA metadata addresses; `'native'` is APT's paired metadata object. */
function metadataFor(t: ResolvedToken): string {
  return t.asset === 'native' ? APT_FA_METADATA : t.asset
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? APT_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? APT_SYMBOL : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

/** Parse a u64-as-string without letting a hostile shape throw. */
function u64(v: unknown): bigint | null {
  try {
    const n = BigInt(String(v))
    return n >= 0n ? n : null
  } catch {
    return null
  }
}

/** One priced candidate route. */
interface Candidate {
  feeTier: number
  pool: string
  amountIn: bigint
  /** The pool's own fee rate in hundredths of a basis point (100 = 0.01%). */
  feeRate: bigint
  fromIsToken0: boolean
}

export interface AptosRoute {
  feeTier: number
  pool: string
  fromMetadata: string
  toMetadata: string
  recipient: string
  /** True when we are selling the pool's token0, so the price moves DOWN. */
  fromIsToken0: boolean
}

/*
 * NOTE on `recipient`: it records the account the quote was priced for. The swap sends the
 * output to whoever SIGNS, never to this field. Pricing does not depend on the account, so
 * the two differing is harmless; paying out to a stale one would not be.
 */

export interface QuoteAptosSwapParams {
  client: AptosSwapClient
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
  owner: string
}

/**
 * Price an exact-output swap. Reads only; never throws (the contract for `quoteSwap`).
 * Returns `null` when no tier has a pool, every pool is empty, or a read fails.
 */
export async function quoteAptosSwap(p: QuoteAptosSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const fromMeta = metadataFor(p.from)
  const toMeta = metadataFor(p.to)
  if (sameAddress(fromMeta, toMeta)) return null

  const candidates: Candidate[] = []
  for (const feeTier of FEE_TIERS) {
    /*
     * One CHEAP call does discovery: `liquidity_pool_info_both_fa` returns the pool object,
     * the pool's token0, its liquidity and its fee rate together. It replaces a separate
     * address lookup AND a separate token-order lookup.
     *
     * 🔴 Then SKIP a pool with no liquidity before pricing it. Pricing walks ticks, and on an
     * empty pool that walk exhausts the node's view budget and comes back
     * EXECUTION_LIMIT_REACHED. Beyond being useless, those calls are expensive: an Aptos
     * public fullnode meters anonymous callers at 40k compute units per 300s, and pricing
     * every tier blindly burned the quota, after which perfectly good routes came back as
     * "no route". Cheap-filter first, and only pay for pools that could actually fill.
     */
    let pool: string
    let feeRate = 0n
    try {
      const [info] = await p.client.view<[string[]]>({
        payload: {
          function: `${HYPERION}::pool_v3::liquidity_pool_info_both_fa`,
          functionArguments: [fromMeta, toMeta, feeTier],
        },
      })
      pool = String(info?.[4] ?? '')
      const liquidity = u64(info?.[7]) ?? 0n
      feeRate = u64(info?.[9]) ?? 0n
      if (!pool || liquidity === 0n) continue
    } catch {
      continue // no pool at this tier, or the read failed — either way this tier loses
    }

    /*
     * Price through `router_v3::get_batch_amount_in`, NOT `pool_v3::get_amount_in`. The
     * pool-level view names the asset its amount is measured in, so its second argument
     * flips meaning between the in/out directions and is easy to read backwards. The router
     * view takes `from` and `to` explicitly, so the direction cannot be misread.
     */
    try {
      const [inRaw] = await p.client.view<[string]>({
        payload: {
          function: `${HYPERION}::router_v3::get_batch_amount_in`,
          functionArguments: [[pool], p.wantAmount.toString(), fromMeta, toMeta],
        },
      })
      const amountIn = u64(inRaw)
      if (amountIn === null || amountIn === 0n) continue
      candidates.push({ feeTier, pool, amountIn, feeRate, fromIsToken0: sellingToken0(fromMeta, toMeta) })
    } catch {
      continue
    }
  }

  if (!candidates.length) return null
  // Cheapest input for the same fixed output wins.
  const best = candidates.reduce((a, b) => (b.amountIn < a.amountIn ? b : a))

  // The cap that actually goes on-chain. Exact output means the OUTPUT is fixed, so
  // slippage pads the input ceiling.
  const maxSpend = applySlippage(best.amountIn, p.slippageBps)

  return {
    source: sourceFor(best.feeRate),
    network: p.network,
    from: side(p.from, best.amountIn),
    to: side(p.to, p.wantAmount),
    maxSpend: maxSpend.toString(),
    maxSpendFormatted: formatUnits(maxSpend, p.from.asset === 'native' ? APT_DECIMALS : p.from.decimals),
    slippageBps: p.slippageBps,
    route: {
      feeTier: best.feeTier,
      pool: best.pool,
      fromMetadata: fromMeta,
      toMetadata: toMeta,
      recipient: p.owner,
      fromIsToken0: best.fromIsToken0,
    } satisfies AptosRoute,
  }
}

export interface SwapAptosParams {
  client: AptosSwapClient
  signer: unknown
  sender: string
  quote: SwapQuote
}

/**
 * Execute a quoted swap. One transaction, signed by the user's own account, with the
 * input ceiling enforced by the contract rather than by trusting the quote.
 */
export async function swapAptos(p: SwapAptosParams): Promise<SwapReceipt> {
  const route = p.quote.route as AptosRoute
  if (!route?.pool || !route.fromMetadata || !route.toMetadata) {
    throw new Error('Aptos: swap quote is missing its Hyperion routing data — re-quote before swapping.')
  }
  const amountOut = BigInt(p.quote.to.amount)
  const amountInMax = BigInt(p.quote.maxSpend)
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS

  let hash: string
  try {
    const transaction = await p.client.build({
      sender: p.sender,
      data: {
        function: `${HYPERION}::router_v3::exact_output_swap_entry`,
        /*
         * 🔴 Argument order: (fee_tier, FROM amount, TO amount, …). Both the exact-input and
         * exact-output entry functions share one signature, and the two amount slots are
         * "what leaves" then "what arrives" — NOT "the exact one" then "the limit". So here
         * p2 is the input CAP and p3 is the exact output, which is the opposite of what the
         * names suggest. Getting it backwards aborts with `fungible_asset::EINSUFFICIENT_BALANCE`,
         * which reads like a funding problem and is not one. Established by simulating every
         * candidate ordering against mainnet rather than by guessing.
         */
        functionArguments: [
          route.feeTier,
          amountInMax.toString(), // ← the on-chain slippage cap; the trade aborts above it
          amountOut.toString(), // ← the exact amount we require to arrive
          // Selling token0 pushes the price DOWN, so bound it below; otherwise bound above.
          (route.fromIsToken0 ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n).toString(),
          route.fromMetadata,
          route.toMetadata,
          /*
           * 🔴 The SIGNER receives, always. `route.recipient` records who quoted, and is not
           * used here: it was captured at quote time, so a quote carried across wallets (or
           * simply held while the client rebound) would have paid the output to whoever asked
           * for the price rather than whoever signed. Every other family already derives this
           * from the signing wallet at swap time; this one did not, and the comment claiming
           * "the funds never leave the wallet" was only true by luck of them matching.
           */
          p.sender,
          deadline.toString(),
        ],
      },
      options: { maxGasAmount: MAX_GAS_AMOUNT },
    })
    const res = await p.client.signSubmit({ signer: p.signer, transaction })
    hash = res.hash
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/EINSUFFICIENT|insufficient|balance/i.test(msg)) {
      throw new InsufficientFundsError(
        `Aptos swap could not be submitted: the account cannot cover it (token balance or APT gas). (${msg.slice(0, 160)})`,
        { cause: err }
      )
    }
    throw err
  }

  /*
   * 🔴 A submitted transaction is not a completed swap. Aptos commits failed transactions
   * to the chain with `success: false`, so returning here on submission alone would report
   * a swap that moved nothing. (Same class of bug as the EVM reverted-receipt hole.)
   */
  const out = await p.client.waitFor({ hash })
  if (out?.success === false) {
    throw new InsufficientFundsError(
      `Aptos swap failed on-chain (tx ${hash}): ${out.vm_status ?? 'unknown status'}. ` +
        'Nothing was swapped. The usual cause is the price moving past the input cap — re-quote and retry.'
    )
  }

  return {
    transaction: hash,
    network: p.quote.network,
    source: p.quote.source,
    from: p.quote.from,
    to: p.quote.to,
  }
}
