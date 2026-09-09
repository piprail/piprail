/**
 * ── NEAR SECTION: swap ──
 * Same-chain swap through **Ref Finance** (now branded Rhea), NEAR's largest AMM.
 *
 * 🔴 THIS IS A THIRD PARTY, named as such everywhere it surfaces. NEAR has no
 * protocol-level swap. Ref was chosen over NEAR Intents deliberately, and the reason
 * matters more than the fee:
 *
 *   **Intents re-adds a facilitator.** A solver takes possession of the funds in the
 *   middle, which is exactly the intermediary PipRail exists to remove. Ref does not:
 *   the whole swap is one `ft_transfer_call` receipt chain, token contract → AMM →
 *   back to the user, inside a single transaction the user signs. Nobody else ever
 *   holds the money.
 *
 *   - **Keyless, and needs no service at all.** Verified live 2026-09-08 against two
 *     independent public RPCs (`rpc.mainnet.near.org` and `free.rpc.fastnear.com`),
 *     both returning the identical quote. Quoting is a `get_return` view call on the
 *     contract, so it uses the same RPC the NEAR driver already talks to.
 *   - **No integrator fee.** The cost is the pool's own `total_fee`, read live per
 *     pool. There is no field for PipRail to set or waive.
 *
 * ⚠️ LIQUIDITY IS THIN ON MOST POOLS, and that is the real hazard here. The top-pool
 * list shows many native-USDC pools at a TVL of ~0. We therefore quote the ACTUAL
 * amount and verify it clears the invoice, rather than trusting a spot price.
 */
import { InsufficientFundsError, RecipientNotReadyError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import { NEAR_DECIMALS } from './chains.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** The Ref Finance exchange contract. */
const REF_EXCHANGE = 'v2.ref-finance.near'
/** Wrapped NEAR: the AMM trades wrap.near, never the bare native coin. */
const WRAP_NEAR = 'wrap.near'
/** Ref's keyless indexer, used ONLY to find candidate pools. */
const REF_INDEXER = 'https://indexer.ref.finance'

function sourceFor(feeBps: number | null) {
  const fee = feeBps === null ? "the pool's own fee" : `${(feeBps / 100).toFixed(2)}%`
  return {
    kind: 'provider' as const,
    name: 'Ref Finance',
    note:
      "Third-party NEAR AMM (v2.ref-finance.near), used keyless over the chain's own RPC. The swap is one " +
      'ft_transfer_call receipt chain, so no solver ever takes possession of the funds, which is why this is ' +
      `used instead of an intent network. Pool fee on this route: ${fee}. PipRail adds nothing.`,
  }
}

/** Ref trades contract ids; native NEAR trades as wrap.near. */
function refToken(t: ResolvedToken): string {
  return t.asset === 'native' ? WRAP_NEAR : t.asset
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? NEAR_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? 'NEAR' : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

/** A read-only NEAR view call, injected so this module stays unit-testable. */
export interface NearViewClient {
  /** call_function on a contract, returning the decoded JSON result. */
  view(contractId: string, method: string, args: Record<string, unknown>): Promise<unknown>
}

interface RefPool {
  /** 🔴 The indexer returns this as a STRING ("6416"); the contract wants a NUMBER.
   *  Passing it through unconverted made get_return error on every pool, and the whole
   *  family reported "no swap support" while the pools existed and quoted fine by hand. */
  id: number | string
  token_account_ids: string[]
  total_fee: number
  tvl?: string | number
}

async function getJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    /*
     * 🔴 Do NOT set accept-encoding by hand here. The indexer serves gzip, and undici
     * decompresses automatically ONLY when it owns the header; setting it manually
     * hands back a still-compressed body, JSON.parse throws, and the whole family
     * silently reports "no swap support" while the pools exist and quote fine.
     */
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Candidate pools holding BOTH tokens, deepest first. Uses Ref's keyless indexer; on
 * failure returns an empty list, and the caller degrades to "no quote" rather than
 * guessing a pool id.
 */
async function findPools(tokenIn: string, tokenOut: string): Promise<Array<Omit<RefPool, 'id'> & { id: number }>> {
  const all = await getJson<RefPool[]>(`${REF_INDEXER}/list-top-pools`)
  if (!Array.isArray(all)) return []
  return all
    .filter(
      (p) =>
        Array.isArray(p.token_account_ids) &&
        p.token_account_ids.includes(tokenIn) &&
        p.token_account_ids.includes(tokenOut)
    )
    .sort((a, b) => Number(b.tvl ?? 0) - Number(a.tvl ?? 0))
    .slice(0, 4)
    .map((p) => ({ ...p, id: Number(p.id) }))
}

export interface QuoteNearSwapParams {
  client: NearViewClient
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a swap through Ref. NEVER THROWS: returns `null` when no pool holds the pair,
 * liquidity cannot cover the invoice, or a read fails.
 */
export async function quoteNearSwap(p: QuoteNearSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const tokenIn = refToken(p.from)
  const tokenOut = refToken(p.to)
  if (tokenIn === tokenOut) return null

  const pools = await findPools(tokenIn, tokenOut)
  if (!pools.length) return null

  const fromDecimals = p.from.asset === 'native' ? NEAR_DECIMALS : p.from.decimals
  const probeIn = 10n ** BigInt(Math.max(fromDecimals - 2, 1))

  const getReturn = async (poolId: number, amountIn: bigint): Promise<bigint | null> => {
    try {
      const out = await p.client.view(REF_EXCHANGE, 'get_return', {
        pool_id: poolId,
        token_in: tokenIn,
        amount_in: amountIn.toString(),
        token_out: tokenOut,
      })
      const s = String(out ?? '')
      return s && /^\d+$/.test(s) ? BigInt(s) : null
    } catch {
      return null
    }
  }

  // Try each candidate pool deepest-first; the first that can actually clear the
  // invoice wins. Thin pools are the norm here, so this is not a formality.
  for (const pool of pools) {
    const probeOut = await getReturn(pool.id, probeIn)
    if (probeOut === null || probeOut <= 0n) continue

    let needIn = (probeIn * p.wantAmount + probeOut - 1n) / probeOut
    needIn = applySlippage(needIn, p.slippageBps)

    const realOut = await getReturn(pool.id, needIn)
    if (realOut === null) continue
    // 🔴 Never ship a swap that lands short of the invoice.
    if (realOut < p.wantAmount) continue

    // min_amount_out is the ON-CHAIN slippage guard: the AMM refuses below it.
    const minOut = p.wantAmount

    return {
      source: sourceFor(typeof pool.total_fee === 'number' ? pool.total_fee : null),
      network: p.network,
      from: side(p.from, needIn),
      to: side(p.to, realOut),
      maxSpend: needIn.toString(),
      maxSpendFormatted: formatUnits(needIn, fromDecimals),
      slippageBps: p.slippageBps,
      route: {
        poolId: pool.id,
        tokenIn,
        tokenOut,
        amountIn: needIn.toString(),
        minAmountOut: minOut.toString(),
      },
    }
  }
  return null
}

/** The routing data we stashed on the quote. */
interface NearRoute {
  poolId: number
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
}

export interface SwapNearParams {
  /** Signs and sends one function call from the user's own account. */
  call(input: {
    contractId: string
    method: string
    args: Record<string, unknown>
    gas: bigint
    deposit: bigint
  }): Promise<string>
  quote: SwapQuote
}

/**
 * Execute a quoted swap: one `ft_transfer_call` from the user's own account into the
 * Ref exchange, carrying the swap actions as its `msg`. Nobody else signs, and no
 * solver takes possession at any point.
 */
export async function swapNear(p: SwapNearParams): Promise<SwapReceipt> {
  const route = p.quote.route as NearRoute
  if (!route?.poolId || !route.tokenIn) {
    throw new Error('NEAR: swap quote is missing its Ref routing data — re-quote before swapping.')
  }

  // The AMM enforces min_amount_out on-chain: below it the whole call reverts and the
  // tokens return to the sender, so a market move costs gas rather than value.
  const msg = JSON.stringify({
    force: 0,
    actions: [
      {
        pool_id: route.poolId,
        token_in: route.tokenIn,
        token_out: route.tokenOut,
        amount_in: route.amountIn,
        min_amount_out: route.minAmountOut,
      },
    ],
  })

  try {
    const tx = await p.call({
      contractId: route.tokenIn,
      method: 'ft_transfer_call',
      args: { receiver_id: REF_EXCHANGE, amount: route.amountIn, msg },
      // NEP-141 transfer_call into an AMM needs generous gas: 180 TGas.
      gas: 180_000_000_000_000n,
      // ft_transfer_call requires exactly 1 yoctoNEAR as a signing assertion.
      deposit: 1n,
    })
    return {
      transaction: tx,
      network: p.quote.network,
      source: p.quote.source,
      from: p.quote.from,
      to: p.quote.to,
    }
  } catch (err) {
    const msgText = String((err as Error)?.message ?? err)
    if (/storage|not registered|NotRegistered/i.test(msgText)) {
      throw new RecipientNotReadyError(
        'NEAR swap refused: your account is not storage-registered on the token you are swapping INTO. ' +
          'Call storage_deposit on that token contract first (about 0.00125 NEAR).',
        { cause: err }
      )
    }
    if (/ERR_MIN_AMOUNT|slippage/i.test(msgText)) {
      throw new InsufficientFundsError(
        'NEAR swap refused: the pool could not deliver the minimum output, so the tokens were returned. Re-quote and retry.',
        { cause: err }
      )
    }
    if (/insufficient|balance|exceeded/i.test(msgText)) {
      throw new InsufficientFundsError(
        `NEAR swap failed: the account can't cover it (token balance or NEAR for gas). (${msgText.slice(0, 160)})`,
        { cause: err }
      )
    }
    throw err
  }
}
