/**
 * ── TRON SECTION: swap ──
 * Same-chain swap through **SunSwap V2**, called **contract-to-contract with no API**.
 *
 * 🔴 THIS IS A THIRD-PARTY CONTRACT, named as such everywhere it surfaces. Tron has no
 * protocol-level swap. SunSwap's own front end talks to a smart-router service on an
 * **undocumented, obfuscated hostname** (`rot.endjgfsv.link`), which answers keyless but is
 * not something a payments SDK should depend on: it is one unannounced rename away from
 * breaking every caller. So this module skips the service entirely and calls the router
 * contract, whose address was verified on-chain via TronGrid before shipping.
 *
 *   - **No API and no API key.** Quoting is `getAmountsIn`, a constant (read-only) contract
 *     call; swapping is a normal contract call the user's own key signs.
 *   - **No integrator fee.** The router has no fee, referrer or partner parameter to set.
 *     The only cost is the pool's 0.3% constant-product fee.
 *   - **Self-custody.** The user's key signs; the tokens go straight to their own address.
 *
 * ⭐ **Exact output, natively.** `getAmountsIn(amountOut, path)` prices the input needed for
 * an exact output, and `swapETHForExactTokens` / `swapTokensForExactTokens` /
 * `swapTokensForExactETH` execute it with the input capped on-chain. That is the shape of an
 * x402 invoice, so there is no probe-and-scale approximation here.
 *
 * ⚠️ **Tron swaps are expensive, and that is the chain, not this code.** A swap burns roughly
 * 230,000 ENERGY. With no staked energy the account pays it in TRX at the chain's
 * `getEnergyFee` (100 sun per energy when measured), which is about **23 TRX (~$7.79) per
 * swap** regardless of trade size. The quote's `source.note` says so up front, so a caller
 * is never surprised by a fee larger than the trade.
 *
 * 🔴 **A TRC-20 input needs an approval first**, exactly as it does on EVM: the router calls
 * `transferFrom`, so selling a token costs TWO transactions (approve, then swap). The approve
 * is not a rounding error either. Measured on mainnet it burns about 99,800 energy for a
 * fresh allowance slot, roughly 10 TRX, taking a token-in swap to about **33 TRX all in**
 * against 23 TRX for native-in. Selling native TRX costs one transaction, because the amount
 * rides along as `callValue`.
 *
 * This was missing when the module was first written, which would have failed every token-in
 * swap on allowance while native-in worked, so the two paths are now explicitly separated by
 * `route.needsApproval`.
 */
import { TRX_DECIMALS } from './chains.js'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** SunSwap V2 router (a Uniswap V2 clone). Existence verified on-chain via TronGrid. */
const SUNSWAP_V2_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'

/** Wrapped TRX — the router speaks TRC-20 only, so native TRX enters the path as WTRX. */
const WTRX = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'

/** Native TRX's display ticker. */
const TRX_SYMBOL = 'TRX'

/** Roughly what a SunSwap V2 swap burns, measured live on mainnet. */
export const TRON_SWAP_ENERGY = 230_629

/** Enough fee headroom for the measured energy; the unused part is never charged. */
const FEE_LIMIT_SUN = 40_000_000

/**
 * Roughly what a first-time TRC-20 approve to the router burns, measured live on mainnet
 * with a constant call against Tether's Tron contract. Writing a fresh storage slot is the
 * expensive part; overwriting an existing allowance came back at about a third of this.
 */
export const TRON_APPROVE_ENERGY = 99_764

/**
 * Ceiling for the approve. Sized off the measurement above with real headroom, NOT trimmed
 * to it: a limit of 10 TRX looked generous next to a "cheap" approve and is in fact below
 * what a fresh slot costs at 100 sun per energy, so every first approval would have died on
 * OUT_OF_ENERGY. The unused part is never charged, so headroom is free.
 */
const APPROVE_FEE_LIMIT_SUN = 20_000_000

/** How long to wait for an approve to solidify before giving up, in milliseconds. */
const APPROVE_TIMEOUT_MS = 60_000

/** How often to poll for the approve's receipt. Tron produces a block every ~3s. */
const APPROVE_POLL_MS = 3_000

/** How long the on-chain deadline allows, in seconds. */
const DEADLINE_SECONDS = 300

export interface TronSwapClient {
  transactionBuilder: {
    triggerConstantContract(
      contractAddress: string,
      functionSelector: string,
      options: Record<string, unknown>,
      parameters: { type: string; value: unknown }[],
      issuerAddress: string
    ): Promise<{ result?: { result?: boolean }; constant_result?: string[]; energy_used?: number }>
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: { feeLimit: number; callValue?: number },
      parameters: { type: string; value: unknown }[],
      issuerAddress: string
    ): Promise<{ result: { result: boolean; message?: string }; transaction: unknown }>
  }
  trx: {
    /** Read a transaction's receipt. Used to confirm an approve before spending against it. */
    getTransactionInfo(txid: string): Promise<{ receipt?: { result?: string }; id?: string } | null>
    sign(tx: unknown, privateKey: string): Promise<{ txID: string }>
    sendRawTransaction(signed: { txID: string }): Promise<{
      result?: boolean
      txid?: string
      transaction?: { txID: string }
      code?: string
      message?: string
    }>
  }
}

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
function sourceFor(needsApproval: boolean) {
  return {
    kind: 'provider' as const,
    name: 'SunSwap V2',
    note:
      'Third-party Tron DEX (SunSwap V2), called contract-to-contract with no API and no API key: ' +
      'the quote is a constant contract call and the swap is a router call your own key signs. ' +
      "Cost on this route: the pool's own 0.30% constant-product fee. PipRail adds nothing, and " +
      'the router has no fee parameter to add. Note Tron charges roughly 23 TRX of ENERGY per ' +
      'swap regardless of size, which is usually the dominant cost' +
      (needsApproval
        ? ', and selling a TRC-20 costs a second transaction on top: an approve to the router, ' +
          'about another 10 TRX the first time, so budget roughly 33 TRX for this direction.'
        : '; selling native TRX needs no approval, so this is a single transaction.'),
  }
}

/** The router path for a pair; native TRX enters as WTRX. */
function pathFor(from: ResolvedToken, to: ResolvedToken): string[] {
  const a = from.asset === 'native' ? WTRX : from.asset
  const b = to.asset === 'native' ? WTRX : to.asset
  return [a, b]
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? TRX_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? TRX_SYMBOL : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

/** Decode a `uint256[]` return from a constant call, tolerating a hostile shape. */
function decodeUintArray(hex: string | undefined): bigint[] | null {
  try {
    if (!hex) return null
    const words = hex.match(/.{64}/g)
    if (!words || words.length < 3) return null
    // [0] offset, [1] length, then the values
    const len = Number(BigInt('0x' + words[1]))
    if (!Number.isSafeInteger(len) || len < 2) return null
    const vals = words.slice(2, 2 + len).map((w) => BigInt('0x' + w))
    return vals.length === len ? vals : null
  } catch {
    return null
  }
}

export interface TronRoute {
  router: string
  path: string[]
  amountInMax: string
  fromIsNative: boolean
  toIsNative: boolean
  /** A TRC-20 input must approve the router first; a native input rides as `callValue`. */
  needsApproval: boolean
  /** The TRC-20 being sold, when one is. Empty for a native-in swap. */
  tokenIn: string
}

export interface QuoteTronSwapParams {
  client: TronSwapClient
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
  owner: string
}

/**
 * Price an exact-output swap. Reads only; never throws (the contract for `quoteSwap`).
 * Returns `null` when the pair has no pool or the read fails.
 */
export async function quoteTronSwap(p: QuoteTronSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const path = pathFor(p.from, p.to)
  if (path[0] === path[1]) return null

  let amounts: bigint[] | null = null
  try {
    const res = await p.client.transactionBuilder.triggerConstantContract(
      SUNSWAP_V2_ROUTER,
      'getAmountsIn(uint256,address[])',
      {},
      [
        { type: 'uint256', value: p.wantAmount.toString() },
        { type: 'address[]', value: path },
      ],
      p.owner
    )
    if (res?.result?.result !== true) return null
    amounts = decodeUintArray(res.constant_result?.[0])
  } catch {
    return null
  }
  if (!amounts?.length) return null
  const amountIn = amounts[0]
  if (amountIn === undefined || amountIn <= 0n) return null

  // Exact output means the OUTPUT is fixed, so slippage pads the input ceiling. The router
  // enforces it: `amountInMax` is a contract argument, not a client-side promise.
  const amountInMax = applySlippage(amountIn, p.slippageBps)

  return {
    source: sourceFor(p.from.asset !== 'native'),
    network: p.network,
    from: side(p.from, amountIn),
    to: side(p.to, p.wantAmount),
    maxSpend: amountInMax.toString(),
    maxSpendFormatted: formatUnits(amountInMax, p.from.asset === 'native' ? TRX_DECIMALS : p.from.decimals),
    slippageBps: p.slippageBps,
    route: {
      router: SUNSWAP_V2_ROUTER,
      path,
      amountInMax: amountInMax.toString(),
      fromIsNative: p.from.asset === 'native',
      toIsNative: p.to.asset === 'native',
      needsApproval: p.from.asset !== 'native',
      tokenIn: p.from.asset === 'native' ? '' : p.from.asset,
    } satisfies TronRoute,
  }
}

/**
 * Read the router's TRC-20 allowance. An unreadable allowance is reported as `0n` rather
 * than as an error, so the caller attempts the approve instead of assuming it is already
 * in place. Being wrong in that direction costs one cheap transaction; being wrong the
 * other way fails the swap after the energy has already been burned.
 */
async function readAllowance(
  client: TronSwapClient,
  token: string,
  owner: string,
  spender: string
): Promise<bigint> {
  try {
    const res = await client.transactionBuilder.triggerConstantContract(
      token,
      'allowance(address,address)',
      {},
      [
        { type: 'address', value: owner },
        { type: 'address', value: spender },
      ],
      owner
    )
    if (res?.result?.result !== true) return 0n
    const raw = res.constant_result?.[0]
    return raw ? BigInt('0x' + raw.slice(0, 64)) : 0n
  } catch {
    return 0n
  }
}

/**
 * Broadcast one contract call and wait until Tron has a receipt for it. Tron acknowledges a
 * broadcast immediately, so returning on the txid alone would let the swap run against an
 * allowance that has not landed yet.
 */
async function sendAndConfirm(
  client: TronSwapClient,
  contract: string,
  selector: string,
  params: { type: string; value: unknown }[],
  owner: string,
  privateKey: string,
  feeLimit: number
): Promise<string> {
  const built = await client.transactionBuilder.triggerSmartContract(
    contract,
    selector,
    { feeLimit },
    params,
    owner
  )
  if (built?.result?.result !== true) {
    throw new Error(built?.result?.message ?? `Tron: ${selector} could not be built`)
  }
  const signed = await client.trx.sign(built.transaction, privateKey)
  const broadcast = await client.trx.sendRawTransaction(signed)
  if (broadcast?.result === false || broadcast?.code) {
    throw new Error(`${broadcast.code ?? 'broadcast failed'}: ${broadcast.message ?? ''}`)
  }
  const txid = broadcast?.txid ?? broadcast?.transaction?.txID ?? signed.txID

  const deadline = Date.now() + APPROVE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVE_POLL_MS))
    let info: { receipt?: { result?: string } } | null = null
    try {
      info = await client.trx.getTransactionInfo(txid)
    } catch {
      continue // a transient read failure is not a failed transaction
    }
    const result = info?.receipt?.result
    if (!result) continue
    if (result !== 'SUCCESS') {
      throw new Error(`Tron: ${selector} failed on-chain (${result}, tx ${txid})`)
    }
    return txid
  }
  throw new Error(`Tron: ${selector} was not confirmed within ${APPROVE_TIMEOUT_MS / 1000}s (tx ${txid})`)
}

/** TronWeb takes `callValue` as a JS number, so refuse rather than round money. */
function safeCallValue(sun: bigint): number {
  const n = Number(sun)
  if (!Number.isSafeInteger(n)) {
    throw new InsufficientFundsError(
      `Tron: a native input of ${sun} sun exceeds the largest amount that can be sent without ` +
        'rounding. Split the swap into smaller amounts.'
    )
  }
  return n
}

export interface SwapTronParams {
  client: TronSwapClient
  owner: string
  privateKey: string
  quote: SwapQuote
}

/**
 * Execute a quoted swap. One router call, signed by the user's own key, with the input
 * ceiling enforced by the contract rather than by trusting the quote.
 */
export async function swapTron(p: SwapTronParams): Promise<SwapReceipt> {
  const route = p.quote.route as TronRoute
  if (!route?.router || !route.path?.length) {
    throw new Error('Tron: swap quote is missing its SunSwap routing data — re-quote before swapping.')
  }
  const amountOut = BigInt(p.quote.to.amount)
  const amountInMax = BigInt(route.amountInMax)
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS

  const selector = route.fromIsNative
    ? 'swapETHForExactTokens(uint256,address[],address,uint256)'
    : route.toIsNative
      ? 'swapTokensForExactETH(uint256,uint256,address[],address,uint256)'
      : 'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)'

  const params: { type: string; value: unknown }[] = route.fromIsNative
    ? [
        { type: 'uint256', value: amountOut.toString() },
        { type: 'address[]', value: route.path },
        { type: 'address', value: p.owner },
        { type: 'uint256', value: deadline },
      ]
    : [
        { type: 'uint256', value: amountOut.toString() },
        { type: 'uint256', value: amountInMax.toString() },
        { type: 'address[]', value: route.path },
        { type: 'address', value: p.owner },
        { type: 'uint256', value: deadline },
      ]

  try {
    /*
     * 1. Approve, only when a TRC-20 is going out and the allowance is short. SunSwap V2 is a
     * Uniswap V2 clone, so the router moves the input with `transferFrom` and simply cannot
     * do it without an allowance. A native-in swap skips this entirely.
     */
    if (route.needsApproval && route.tokenIn) {
      const allowance = await readAllowance(p.client, route.tokenIn, p.owner, route.router)
      if (allowance < amountInMax) {
        /*
         * 🔴 Tron's USDT is a port of Tether's contract, which REVERTS on a non-zero to
         * non-zero approve. A leftover allowance from an earlier attempt would therefore
         * poison every retry, and the failure would surface later inside the swap as a
         * transfer failure, which reads like a balance problem and is not one. Zero it
         * first whenever a stale allowance exists. (The EVM driver learned this on FDUSD.)
         */
        if (allowance > 0n) {
          await sendAndConfirm(
            p.client,
            route.tokenIn,
            'approve(address,uint256)',
            [
              { type: 'address', value: route.router },
              { type: 'uint256', value: '0' },
            ],
            p.owner,
            p.privateKey,
            APPROVE_FEE_LIMIT_SUN
          )
        }
        await sendAndConfirm(
          p.client,
          route.tokenIn,
          'approve(address,uint256)',
          [
            { type: 'address', value: route.router },
            { type: 'uint256', value: amountInMax.toString() },
          ],
          p.owner,
          p.privateKey,
          APPROVE_FEE_LIMIT_SUN
        )
      }
    }

    // 2. The swap itself.
    const built = await p.client.transactionBuilder.triggerSmartContract(
      route.router,
      selector,
      {
        feeLimit: FEE_LIMIT_SUN,
        /*
         * A native input is sent as callValue, capped at the ceiling: the router refunds
         * whatever the exact-output trade did not need.
         *
         * TronWeb's callValue is a JS number, so a value past 2^53 would be silently rounded
         * and the swap would spend an amount nobody chose. That is ~9 billion TRX, far more
         * than anyone will ever swap, but a payment library must never round money quietly.
         */
        ...(route.fromIsNative ? { callValue: safeCallValue(amountInMax) } : {}),
      },
      params,
      p.owner
    )
    if (built?.result?.result !== true) {
      throw new Error(built?.result?.message ?? 'SunSwap router refused to build the swap')
    }
    const signed = await p.client.trx.sign(built.transaction, p.privateKey)
    const broadcast = await p.client.trx.sendRawTransaction(signed)
    /*
     * 🔴 A broadcast acknowledgement is not a successful swap. Tron returns `result: false`
     * with a `code` for a rejected transaction, so check it rather than assume the txid means
     * it worked. (Same class of bug as the EVM reverted-receipt hole.)
     */
    if (broadcast?.result === false || broadcast?.code) {
      throw new Error(`${broadcast.code ?? 'broadcast failed'}: ${broadcast.message ?? ''}`)
    }
    const txid = broadcast?.txid ?? broadcast?.transaction?.txID ?? signed.txID
    return {
      transaction: txid,
      network: p.quote.network,
      source: p.quote.source,
      from: p.quote.from,
      to: p.quote.to,
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/energy|bandwidth|balance|insufficient|OUT_OF_ENERGY/i.test(msg)) {
      throw new InsufficientFundsError(
        'Tron swap failed: the account cannot cover it. Note a SunSwap swap burns about ' +
          `${TRON_SWAP_ENERGY.toLocaleString('en-US')} energy, which without staked energy is charged as ` +
          `roughly 23 TRX regardless of trade size. (${msg.slice(0, 140)})`,
        { cause: err }
      )
    }
    throw err
  }
}
