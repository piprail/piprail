/**
 * ── SUI SECTION: swap ──
 * Same-chain swap through **Aftermath**, an open Sui DEX aggregator.
 *
 * 🔴 THIS IS A THIRD PARTY, named as such everywhere it surfaces. Sui has no
 * protocol-level swap, so a router is unavoidable. Aftermath was chosen on evidence:
 *
 *   - **Keyless.** Verified live 2026-09-08 from a plain server request: both
 *     `POST /api/router/trade-route` and `POST /api/router/transactions/trade`
 *     returned HTTP 200 with no key and no browser.
 *   - **No fee added.** The route's top-level `coinIn.tradeFee` and `coinOut.tradeFee`
 *     both read `0n`; the only cost is the underlying pool fee, reported as
 *     `netTradeFeePercentage`. PipRail passes no fee parameter of any kind.
 *   - **Self-custody, and unusually clean.** The second endpoint returns a COMPLETE
 *     serialized programmable transaction block: sender, gas coin, gas budget, inputs
 *     and Move calls. `Transaction.from()` in `@mysten/sui` (already a peer dependency)
 *     turns it back into a signable object, so the user's own keypair signs locally
 *     and this process broadcasts. Aftermath never signs and never holds the funds.
 *
 * Cetus was the alternative and is keyless too, but `router_v2/build` returns 404: it
 * quotes and leaves you to construct the transaction, which would mean taking on a new
 * dependency. Aftermath needs none.
 *
 * ⚠️ Aftermath's router is EXACT-IN. An x402 invoice wants exact output, so we size the
 * input from a probe, then VERIFY the real route clears the target before returning a
 * quote. A route that would land short returns null rather than a swap that leaves the
 * caller still unable to pay.
 */
import { Transaction } from '@mysten/sui/transactions'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SUI_DECIMALS, SUI_SYMBOL, SUI_NATIVE_COINTYPE } from './chains.js'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** Aftermath's public, keyless router. No key, no account, no signup. */
const AFTERMATH_API = 'https://aftermath.finance/api/router'

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
function sourceFor(netFeePct: number | undefined) {
  const pct = typeof netFeePct === 'number' ? `${(netFeePct * 100).toFixed(4)}%` : 'the underlying pool fee'
  return {
    kind: 'provider' as const,
    name: 'Aftermath',
    note:
      'Third-party Sui DEX aggregator (aftermath.finance), used keyless. It routes and returns a ' +
      'complete transaction block; your own keypair signs it locally and Aftermath never holds your funds. ' +
      `Cost on this route: ${pct}, which is the underlying pool fee. PipRail adds nothing.`,
  }
}

/** Sui speaks coin types; `'native'` is the SUI coin type to a router. */
function coinType(t: ResolvedToken): string {
  return t.asset === 'native' ? SUI_NATIVE_COINTYPE : t.asset
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? SUI_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? SUI_SYMBOL : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

/** Aftermath returns bigint-ish strings with a trailing `n`. Tolerate both forms. */
function toBig(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v
    const s = String(v ?? '').replace(/n$/, '')
    return s ? BigInt(s) : null
  } catch {
    return null
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface AftermathRoute {
  coinIn?: { type?: string; amount?: unknown }
  coinOut?: { type?: string; amount?: unknown }
  netTradeFeePercentage?: number
  routes?: unknown[]
}

export interface QuoteSuiSwapParams {
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a swap through Aftermath. NEVER THROWS: returns `null` when the pair can't be
 * routed, liquidity is short of the target, or the router is unreachable.
 */
export async function quoteSuiSwap(p: QuoteSuiSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const coinInType = coinType(p.from)
  const coinOutType = coinType(p.to)
  if (coinInType === coinOutType) return null // not a swap

  const route = (amountIn: bigint) =>
    postJson<AftermathRoute>(`${AFTERMATH_API}/trade-route`, {
      coinInType,
      coinOutType,
      coinInAmount: amountIn.toString(),
    })

  // Probe to learn the rate, scaled off the input token's own precision.
  const fromDecimals = p.from.asset === 'native' ? SUI_DECIMALS : p.from.decimals
  const probeIn = 10n ** BigInt(Math.max(fromDecimals - 2, 1))
  const probe = await route(probeIn)
  const probeOut = toBig(probe?.coinOut?.amount)
  if (probeOut === null || probeOut <= 0n) return null

  // needIn = probeIn * want / probeOut, rounded up, then padded by slippage so the
  // exact-in swap comfortably clears the invoice.
  let needIn = (probeIn * p.wantAmount + probeOut - 1n) / probeOut
  needIn = applySlippage(needIn, p.slippageBps)

  const real = await route(needIn)
  const realOut = toBig(real?.coinOut?.amount)
  if (realOut === null) return null

  // 🔴 Never ship a swap that lands short of the invoice.
  if (realOut < p.wantAmount) return null

  return {
    source: sourceFor(real?.netTradeFeePercentage),
    network: p.network,
    from: side(p.from, needIn),
    to: side(p.to, realOut),
    // Exact-in: the input IS the cap. It cannot spend more than this.
    maxSpend: needIn.toString(),
    maxSpendFormatted: formatUnits(needIn, fromDecimals),
    slippageBps: p.slippageBps,
    // Aftermath needs its own route object back verbatim to build the transaction.
    route: { completeRoute: real, slippage: p.slippageBps / 10_000 },
  }
}

export interface SwapSuiParams {
  client: {
    signAndExecuteTransaction(input: {
      transaction: Transaction
      signer: Ed25519Keypair
    }): Promise<{ digest: string; effects?: { status?: { status?: string; error?: string } } }>
  }
  keypair: Ed25519Keypair
  quote: SwapQuote
}

/**
 * Execute a quoted swap. Aftermath BUILDS the transaction block; the user's keypair
 * SIGNS it here, locally, and this process broadcasts it.
 */
export async function swapSui(p: SwapSuiParams): Promise<SwapReceipt> {
  const { client, keypair, quote } = p
  const route = quote.route as { completeRoute?: unknown; slippage?: number }
  if (!route?.completeRoute) {
    throw new Error('Sui: swap quote is missing its Aftermath routing data — re-quote before swapping.')
  }

  const built = await postJson<string | { serializedTx?: string }>(
    `${AFTERMATH_API}/transactions/trade`,
    {
      walletAddress: keypair.getPublicKey().toSuiAddress(),
      completeRoute: route.completeRoute,
      slippage: route.slippage ?? 0.01,
    }
  )
  const serialized = typeof built === 'string' ? built : built?.serializedTx
  if (!serialized) {
    throw new InsufficientFundsError(
      'Aftermath could not build this swap (the route went stale, or the market moved). Nothing was spent — re-quote and retry.'
    )
  }

  let tx: Transaction
  try {
    tx = Transaction.from(serialized)
  } catch (cause) {
    throw new Error('Sui: Aftermath returned a transaction this SDK could not decode.', { cause })
  }

  try {
    // 🔴 The ONLY signature is the user's own, applied locally.
    const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair })
    const status = res.effects?.status?.status
    if (status && status !== 'success') {
      throw new InsufficientFundsError(
        `Sui swap failed on-chain: ${res.effects?.status?.error ?? status}. Re-quote and retry.`
      )
    }
    return {
      transaction: res.digest,
      network: quote.network,
      source: quote.source,
      from: quote.from,
      to: quote.to,
    }
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err
    const msg = String((err as Error)?.message ?? err)
    if (/insufficient|balance|GasBalanceTooLow/i.test(msg)) {
      throw new InsufficientFundsError(
        `Sui swap failed: the wallet can't cover it (coin balance or SUI for gas). (${msg.slice(0, 160)})`,
        { cause: err }
      )
    }
    if (/slippage|SlippageExceeded/i.test(msg)) {
      throw new InsufficientFundsError(
        'Sui swap refused: the price moved past your slippage cap, so nothing was spent. Re-quote and retry.',
        { cause: err }
      )
    }
    throw err
  }
}
