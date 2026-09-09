/**
 * ── EVM SECTION: swap ──
 * Same-chain swap through **KyberSwap's aggregator**, across every EVM chain it
 * covers. EVM has no protocol-level swap, so a router is unavoidable here.
 *
 * 🔴 THIS IS A THIRD PARTY, named as such everywhere it surfaces. It was chosen on
 * evidence, not popularity. The alternatives were probed live from a plain server on
 * 2026-09-08 and most of them failed the "open and keyless" bar outright:
 *
 *   | Aggregator | Result |
 *   |---|---|
 *   | KyberSwap  | **HTTP 200, keyless** ✅ |
 *   | 0x         | HTTP 401 `No API key found in request` |
 *   | 1inch      | HTTP 401 `Unauthorized` |
 *   | Odos       | HTTP 530 (Cloudflare 1033 to a server request) |
 *   | OpenOcean  | HTTP 403 (Cloudflare challenge) |
 *
 * An endpoint that bot-blocks a plain server request is not a headless integration
 * target however good its documentation is.
 *
 * ⚠️ TWO TRANSACTIONS, and the caller should know it. ERC-20 tokens require an
 * `approve` to the router before it can move them, so a token swap costs an approve
 * plus the swap. `quoteSwap()` reports this in the quote's note. Native-in swaps
 * need no approval.
 *
 * Custody: the router is a contract the user calls directly from their own wallet.
 * Nobody takes possession, but note the difference from Stellar and XRPL honestly:
 * this is a third-party CONTRACT, not the ledger itself, so it carries that
 * contract's risk. Users who do not want that should not use this, and nothing in
 * PipRail makes them.
 */
import type { Account, Chain, PublicClient, WalletClient, Hex } from 'viem'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** KyberSwap's public aggregator. No key, no account, no signup. */
const KYBER_API = 'https://aggregator-api.kyberswap.com'

/**
 * KyberSwap's per-chain path segment, keyed by EIP-155 chain id.
 *
 * 🔴 EVERY ENTRY WAS PROBED LIVE (2026-09-08) with a real USDC/USDT route request and
 * only listed after it returned a usable `amountOut`. Chains are deliberately ABSENT
 * rather than optimistically included:
 *
 *   - **Celo (42220)** and **Scroll (534352)**: the API answers but returns NO ROUTE
 *     even for the most liquid stablecoin pair. Listing them would advertise a swap
 *     that cannot execute.
 *
 * An unlisted chain makes `quoteSwap()` return `null`, which is the honest answer.
 * Re-probe before adding one; do not add from a coverage page.
 */
const KYBER_CHAIN: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
  4663: 'robinhood',
}

/** EVM routers move ERC-20s only, so native is represented by this sentinel. */
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

/** KyberSwap reports any integrator fee here; all-empty means none was charged. */
interface KyberExtraFee {
  feeAmount?: string
  chargeFeeBy?: string
  feeReceiver?: string
}

/**
 * 🔴 THE FEE CLAIM IS SELF-VERIFYING. We inspect `extraFee` on every quote rather than
 * hardcoding "no integrator fee" and hoping. PipRail never sends fee parameters, so a
 * fee could only appear as a change on their side, and the note would say so.
 */
function sourceFor(needsApproval: boolean, extraFee: KyberExtraFee | undefined) {
  const charged = !!(extraFee?.feeAmount && extraFee.feeAmount !== '0' && extraFee.feeReceiver)
  return {
    kind: 'provider' as const,
    name: 'KyberSwap',
    note:
      'Third-party EVM DEX aggregator (aggregator-api.kyberswap.com), used keyless. ' +
      'It routes; your own wallet calls the router contract directly and nobody takes possession of the funds. ' +
      (charged
        ? `⚠️ THIS QUOTE CARRIES AN INTEGRATOR FEE: ${extraFee!.feeAmount} to ${extraFee!.feeReceiver}. PipRail did not set one. `
        : 'This quote carries no integrator fee, and PipRail adds none. ') +
      (needsApproval
        ? 'This swap needs TWO transactions: an ERC-20 approve to the router, then the swap.'
        : 'Native-in, so no ERC-20 approval is needed.'),
  }
}

function addrFor(t: ResolvedToken): string {
  return t.asset === 'native' ? NATIVE_SENTINEL : t.asset
}

function side(t: ResolvedToken, amount: bigint, nativeSymbol: string): SwapSide {
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? nativeSymbol : t.asset),
    decimals: t.decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, t.decimals),
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(url, { ...(init ?? {}), signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface KyberRouteResponse {
  code: number
  data?: {
    routeSummary?: Record<string, unknown> & {
      amountIn?: string
      amountOut?: string
      extraFee?: KyberExtraFee
    }
    routerAddress?: string
  }
}
interface KyberBuildResponse {
  code: number
  data?: { data?: string; routerAddress?: string; amountIn?: string; amountOut?: string }
}

/** The routing data we stash on the quote so `swap()` can build the calldata. */
interface EvmRoute {
  chainPath: string
  routeSummary: Record<string, unknown>
  routerAddress: string
  needsApproval: boolean
  tokenIn: string
}

export interface QuoteEvmSwapParams {
  publicClient: PublicClient
  chainId: number
  network: Caip2
  nativeSymbol: string
  owner: string
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a swap through KyberSwap. NEVER THROWS: returns `null` when the chain isn't
 * covered, the pair can't be routed, or the API is unreachable.
 *
 * ⚠️ KyberSwap's aggregator is EXACT-IN only. An x402 invoice wants exact output, so
 * we solve for the input with one extra probe: quote a nominal input, derive the
 * implied rate, then re-quote at the input that yields at least `wantAmount`, and
 * finally VERIFY the second quote actually clears the target. If it doesn't, we
 * return null rather than shipping a swap that lands short of the invoice.
 */
export async function quoteEvmSwap(p: QuoteEvmSwapParams): Promise<SwapQuote | null> {
  const chainPath = KYBER_CHAIN[p.chainId]
  if (!chainPath) return null // chain not covered — say nothing rather than guess
  if (p.wantAmount <= 0n) return null
  const tokenIn = addrFor(p.from)
  const tokenOut = addrFor(p.to)
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null

  const route = async (amountIn: bigint) =>
    getJson<KyberRouteResponse>(
      `${KYBER_API}/${chainPath}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn.toString()}`
    )

  // Probe with a nominal input to learn the rate. Scale from the wanted output so
  // the probe is in the right ballpark even for very different decimals.
  const probeIn = 10n ** BigInt(Math.max(p.from.decimals - 2, 1))
  const probe = await route(probeIn)
  const probeOut = probe?.data?.routeSummary?.amountOut
  if (!probeOut) return null

  let needIn: bigint
  try {
    const out = BigInt(probeOut)
    if (out <= 0n) return null
    // needIn = probeIn * wantAmount / probeOut, rounded UP, then padded by slippage
    // so the exact-in swap comfortably clears the target output.
    needIn = (probeIn * p.wantAmount + out - 1n) / out
    needIn = applySlippage(needIn, p.slippageBps)
  } catch {
    return null
  }

  /*
   * REFINE, don't give up.
   *
   * The estimate above extrapolates a real trade's price from a deliberately tiny probe
   * (0.01 of the input token). Price impact between those two sizes is not the caller's
   * slippage tolerance, so when the real quote lands short there is usually a perfectly good
   * route a fraction further in. Returning null there tells an agent "this chain cannot swap",
   * which is false and unrecoverable: measured on Optimism, a probe rate of 402.0 wei per
   * USDC-base became 398.1 at 2.5 USDC, a 0.49% drift that a 50 bps pad could not absorb, and
   * the swap was refused while Base — same code, luckier drift — went through.
   *
   * So re-solve from the rate observed AT SIZE, which is the number that actually matters, and
   * try again a bounded number of times. The invoice guard below is unchanged and absolute: a
   * swap that still cannot clear is still refused. Spending more is not silent either — the
   * input IS `maxSpend`, and `swapPolicy.maxPerSwap` is enforced against it afterwards.
   */
  const MAX_REFINEMENTS = 3
  let real = await route(needIn)
  let summary = real?.data?.routeSummary

  for (let attempt = 0; attempt < MAX_REFINEMENTS; attempt++) {
    if (!summary?.amountOut) break
    let out: bigint
    try {
      out = BigInt(summary.amountOut)
    } catch {
      return null
    }
    if (out >= p.wantAmount) break // clears the invoice
    if (out <= 0n) return null
    // Re-solve at the observed rate, then re-apply the caller's pad. Ceil-divide so a rounding
    // remainder can never leave us one unit short of the invoice again.
    const next = applySlippage((needIn * p.wantAmount + out - 1n) / out, p.slippageBps)
    if (next <= needIn) break // not converging — refuse rather than loop on a flat rate
    needIn = next
    real = await route(needIn)
    summary = real?.data?.routeSummary
  }

  if (!summary?.amountOut || !real?.data?.routerAddress) return null

  // 🔴 Verify we actually clear the invoice. Never ship a short swap.
  try {
    if (BigInt(summary.amountOut) < p.wantAmount) return null
  } catch {
    return null
  }

  const needsApproval = p.from.asset !== 'native'
  const spend = needIn

  return {
    source: sourceFor(needsApproval, summary.extraFee as KyberExtraFee | undefined),
    network: p.network,
    from: side(p.from, spend, p.nativeSymbol),
    // What we will actually receive: at least the invoice amount, usually a little more.
    to: side(p.to, BigInt(summary.amountOut), p.nativeSymbol),
    // Exact-in means the input IS the cap: it cannot spend more than this.
    maxSpend: spend.toString(),
    maxSpendFormatted: formatUnits(spend, p.from.decimals),
    slippageBps: p.slippageBps,
    route: {
      chainPath,
      routeSummary: summary,
      routerAddress: real.data.routerAddress,
      needsApproval,
      tokenIn,
    } satisfies EvmRoute,
  }
}

export interface SwapEvmParams {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  chain: Chain
  quote: SwapQuote
}

/**
 * Execute a quoted swap: approve if needed, then call the router. Both transactions
 * are sent from the user's own wallet; nobody else signs anything.
 */
export async function swapEvm(p: SwapEvmParams): Promise<SwapReceipt> {
  const { publicClient, walletClient, account, chain, quote } = p
  const route = quote.route as EvmRoute
  if (!route?.routerAddress || !route.routeSummary) {
    throw new Error('EVM: swap quote is missing its routing data — re-quote before swapping.')
  }
  const router = route.routerAddress as `0x${string}`
  const spend = BigInt(quote.maxSpend)

  // 1. Approve, only when an ERC-20 is going out and the allowance is short.
  if (route.needsApproval) {
    const token = route.tokenIn as `0x${string}`
    let allowance = 0n
    try {
      allowance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [account.address, router],
      })) as bigint
    } catch {
      allowance = 0n // unreadable → attempt the approve rather than assume
    }
    if (allowance < spend) {
      /*
       * 🔴 Some tokens (the USDT pattern, and FDUSD on BNB, which is how we found
       * this) REVERT on a non-zero → non-zero approve. A leftover allowance from an
       * earlier attempt therefore poisons every retry, and the failure surfaces far
       * away as `TRANSFER_FROM_FAILED` inside the swap, which reads like a balance
       * problem and is not one. Zero it first whenever a stale allowance exists.
       */
      if (allowance > 0n) {
        const resetHash = await walletClient.writeContract({
          address: token,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'approve',
          args: [router, 0n],
          account,
          chain,
        })
        await publicClient.waitForTransactionReceipt({ hash: resetHash })
      }
      const approveHash = await walletClient.writeContract({
        address: token,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [router, spend],
        account,
        chain,
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })
    }
  }

  // 2. Ask KyberSwap to build the calldata for the route we already showed the caller.
  const built = await getJson<KyberBuildResponse>(
    `${KYBER_API}/${route.chainPath}/api/v1/route/build`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routeSummary: route.routeSummary,
        sender: account.address,
        recipient: account.address, // ← ourselves: the funds never leave the wallet
        slippageTolerance: quote.slippageBps,
      }),
    }
  )
  if (!built?.data?.data) {
    throw new InsufficientFundsError(
      'KyberSwap could not build this swap (the route went stale, or the market moved). Nothing was spent — re-quote and retry.'
    )
  }

  /*
   * Send to the router the BUILD step names, not the one the ROUTE step named. They
   * are usually identical, but KyberSwap is free to build calldata for a different
   * router, and sending that calldata to the wrong address reverts deep inside with
   * TRANSFER_FROM_FAILED, which reads like an allowance problem and is not one.
   * Re-approve if the build router is one we have not approved.
   */
  const execRouter = (built.data.routerAddress as `0x${string}`) ?? router
  if (route.needsApproval && execRouter.toLowerCase() !== router.toLowerCase()) {
    const token = route.tokenIn as `0x${string}`
    const approveHash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'approve',
      args: [execRouter, spend],
      account,
      chain,
    })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
  }

  try {
    const hash = await walletClient.sendTransaction({
      account,
      chain,
      to: execRouter,
      data: built.data.data as Hex,
      value: route.tokenIn === NATIVE_SENTINEL ? spend : 0n,
    })
    /*
     * 🔴 A receipt is NOT a success. `waitForTransactionReceipt` resolves for a REVERTED
     * transaction exactly as it does for a mined one — it only throws on timeout or
     * replacement. Returning here unconditionally handed the caller a SwapReceipt, with a
     * real tx hash, for a swap that moved nothing; an agent would then try to pay an
     * invoice it still cannot cover. Found on Robinhood Chain, whose 100ms blocks make a
     * stale route common, but the hole was the same on every EVM chain.
     */
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') {
      throw new InsufficientFundsError(
        `EVM swap reverted on-chain (tx ${hash}). Nothing was swapped and only gas was spent. ` +
          'The usual cause is the route going stale between the quote and inclusion, so the ' +
          "router's minimum-output check fails. Re-quote and retry; on a fast-block chain a " +
          'wider `slippageBps` helps.'
      )
    }
    return {
      transaction: hash,
      network: quote.network,
      source: quote.source,
      from: quote.from,
      to: quote.to,
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/TRANSFER_FROM_FAILED/i.test(msg)) {
      throw new InsufficientFundsError(
        'EVM swap reverted moving the token: the router allowance was rejected or the balance is short. ' +
          'Nothing was swapped. Some tokens refuse a non-zero to non-zero approve; re-quote and retry, which resets the allowance first.',
        { cause: err }
      )
    }
    if (/insufficient funds|exceeds balance/i.test(msg)) {
      throw new InsufficientFundsError(
        `EVM swap failed: the wallet can't cover it (token balance or native gas). (${msg.slice(0, 160)})`,
        { cause: err }
      )
    }
    throw err
  }
}
