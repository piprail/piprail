/**
 * ── STELLAR SECTION: swap ──
 * Same-chain swap via a PATH PAYMENT TO YOURSELF. No DEX contract, no aggregator,
 * no API key, no extra dependency — `@stellar/stellar-sdk` is already here for
 * payments and ships both halves (path finding + the operation).
 *
 * Stellar has no "swap" operation. It has path payments, which send asset A and
 * deliver asset B, routing across the SDEX order books AND the protocol liquidity
 * pools in ONE ATOMIC OPERATION. Set `destination` to your own account and it
 * degenerates into a self-swap: USDC out of your balance, XLM into it, one
 * operation, one fee, all-or-nothing.
 *
 * We use `PathPaymentStrictReceive` (fix the OUTPUT, cap the input) because that
 * is the shape of an invoice: a 402 names an exact amount owed, and what it costs
 * you floats. `sendMax` is the slippage guard and it is enforced BY THE VALIDATORS
 * — if the market moves past it the operation fails rather than overspending.
 *
 * Custody: perfect. One operation inside the user's own signed transaction. No
 * router to approve, no solver, no relayer, no intermediate holder.
 *
 * Cost: the 100-stroop base fee, plus the market. SDEX order books charge NO
 * trading fee (spread only); the protocol liquidity pools charge a fixed 30 bps.
 * Nobody can insert an integrator fee — there is no field for one.
 */
import { Asset, BASE_FEE, type Keypair, Operation, TransactionBuilder, type Horizon } from '@stellar/stellar-sdk'
import { STELLAR_PASSPHRASE, STELLAR_DECIMALS, XLM_SYMBOL, parseStellarAssetId } from './chains.js'
import { InsufficientFundsError, RecipientNotReadyError, toInsufficientFundsError } from '../../errors.js'
import { parseUnits, formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
const SOURCE = {
  kind: 'protocol' as const,
  name: 'Stellar SDEX',
  note: 'Rate from the ledger’s own order books and liquidity pools, read live from Horizon. Order books charge no trading fee; liquidity pools charge a fixed 0.30%.',
}

/**
 * Turn a driver asset id ('native' | 'CODE:ISSUER') into a Stellar Asset.
 *
 * 🔴 `new Asset()` VALIDATES and THROWS on a malformed issuer ("Issuer is invalid"),
 * so this must never be called bare from a read path. `quoteSwap` is contractually
 * never-throw, and a caller passing a custom token with a bad issuer would otherwise
 * blow up a method documented to return null. Found by an adversarial test.
 */
function assetForId(asset: string): Asset | null {
  if (asset === 'native') return Asset.native()
  const parts = parseStellarAssetId(asset)
  if (!parts) return null
  try {
    return new Asset(parts.code, parts.issuer)
  } catch {
    return null
  }
}

/** A Horizon path hop, loosely typed (the union differs per asset_type). */
type PathHop = { asset_type: string; asset_code?: string; asset_issuer?: string }

function hopToAsset(h: PathHop): Asset {
  return h.asset_type === 'native' ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!)
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? XLM_SYMBOL : t.asset),
    decimals: STELLAR_DECIMALS,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, STELLAR_DECIMALS),
  }
}

export interface QuoteStellarSwapParams {
  server: Pick<Horizon.Server, 'strictReceivePaths'>
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a self-swap. NEVER THROWS — returns `null` when the pair can't be routed,
 * there is no liquidity, or Horizon is unreachable. `null` means "no quote", never
 * "no funds".
 */
export async function quoteStellarSwap(p: QuoteStellarSwapParams): Promise<SwapQuote | null> {
  const fromAsset = assetForId(p.from.asset)
  const toAsset = assetForId(p.to.asset)
  if (!fromAsset || !toAsset) return null
  if (p.from.asset === p.to.asset) return null // not a swap
  if (p.wantAmount <= 0n) return null

  const wantFormatted = formatUnits(p.wantAmount, STELLAR_DECIMALS)
  let records: Array<{ source_amount: string; path?: PathHop[] }>
  try {
    const page = await p.server.strictReceivePaths([fromAsset], toAsset, wantFormatted).call()
    records = page.records as unknown as Array<{ source_amount: string; path?: PathHop[] }>
  } catch {
    return null // transient read failure — "no quote", not "no route"
  }
  if (!records?.length) return null

  /*
   * Horizon returns candidates; the cheapest INPUT wins (the output is fixed either
   * way). Parse FIRST, then compare.
   *
   * 🔴 Seeding `best` with records[0] and comparing inside a try/catch looks
   * equivalent and is NOT: one unparseable candidate sitting FIRST is never replaced,
   * because every comparison against it throws and gets skipped. A single bad row
   * from Horizon then poisoned an otherwise perfectly good quote. Found by an
   * adversarial test, not by review.
   */
  let best: { source_amount: string; path?: PathHop[] } | null = null
  let spend: bigint | null = null
  for (const r of records) {
    let candidate: bigint
    try {
      candidate = parseUnits(r.source_amount, STELLAR_DECIMALS)
    } catch {
      continue // ignore this row, never the whole response
    }
    if (candidate <= 0n) continue
    if (spend === null || candidate < spend) {
      spend = candidate
      best = r
    }
  }
  if (best === null || spend === null) return null
  const maxSpend = applySlippage(spend, p.slippageBps)

  return {
    source: SOURCE,
    network: p.network,
    from: side(p.from, spend),
    to: side(p.to, p.wantAmount),
    maxSpend: maxSpend.toString(),
    maxSpendFormatted: formatUnits(maxSpend, STELLAR_DECIMALS),
    slippageBps: p.slippageBps,
    route: best.path ?? [],
  }
}

export interface SwapStellarParams {
  server: Pick<Horizon.Server, 'loadAccount' | 'submitTransaction'>
  keypair: Keypair
  quote: SwapQuote
}

/**
 * Execute a quoted self-swap. One `PathPaymentStrictReceive` whose destination is
 * the signer's own account. Throws {@link InsufficientFundsError} when the wallet
 * can't cover it (ERRORS.md §5).
 */
export async function swapStellar(p: SwapStellarParams): Promise<SwapReceipt> {
  const { server, keypair, quote } = p
  const sendAsset = assetForId(quote.from.asset)
  const destAsset = assetForId(quote.to.asset)
  if (!sendAsset || !destAsset) {
    throw new Error(`Stellar: malformed asset id in swap quote (${quote.from.asset} → ${quote.to.asset}).`)
  }
  const path = Array.isArray(quote.route) ? (quote.route as PathHop[]).map(hopToAsset) : []

  try {
    const source = await server.loadAccount(keypair.publicKey())
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: STELLAR_PASSPHRASE })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset,
          // The on-chain slippage cap. Validators enforce it; we do not.
          sendMax: formatUnits(BigInt(quote.maxSpend), STELLAR_DECIMALS),
          destination: keypair.publicKey(), // ← ourselves: this is what makes it a swap
          destAsset,
          destAmount: quote.to.amountFormatted,
          path,
        })
      )
      .setTimeout(120)
      .build()
    tx.sign(keypair)
    const res = await server.submitTransaction(tx)
    return {
      transaction: res.hash,
      network: quote.network,
      source: quote.source,
      // Strict-RECEIVE fixes the output exactly; the input is whatever the market
      // took, bounded by maxSpend. We report the quoted estimate for `from`.
      from: quote.from,
      to: quote.to,
    }
  } catch (err) {
    throw mapSwapError(err)
  }
}

/** Map Horizon path-payment failures to the SDK's typed errors (ERRORS.md §5). */
function mapSwapError(err: unknown): unknown {
  const codes = extractResultCodes(err)
  const seen = codes.join(', ')
  const has = (re: RegExp) => codes.some((c) => re.test(c))

  // The swap would have cost more than sendMax — the market moved. This is the
  // slippage guard doing its job, and it is NOT an affordability problem, so say so.
  if (has(/op_over_sendmax/i)) {
    return new InsufficientFundsError(
      `Stellar swap refused: the price moved past your slippage cap, so nothing was spent. Re-quote and retry, or raise slippageBps. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  if (has(/op_too_few_offers|op_no_path/i)) {
    return new InsufficientFundsError(
      `Stellar swap refused: not enough liquidity on this pair right now, so nothing was spent. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  // Swapping INTO an asset needs your own trustline for it first.
  if (has(/op_no_(trust|issuer)|op_not_authorized|op_line_full/i)) {
    return new RecipientNotReadyError(
      `Stellar swap refused: your account needs a trustline for the asset you're swapping INTO (and authorization) before it can hold it. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  if (has(/underfunded|insufficient|low_reserve|src_no_trust/i)) {
    return new InsufficientFundsError(
      `Stellar swap failed: the account can't cover it — balance, base reserve, or no trustline to send this asset. (Stellar: ${seen})`,
      { cause: err }
    )
  }
  return toInsufficientFundsError(err) ?? err
}

function extractResultCodes(err: unknown): string[] {
  const extras = (
    err as {
      response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } }
    }
  )?.response?.data?.extras?.result_codes
  if (!extras) return []
  return [extras.transaction ?? '', ...(extras.operations ?? [])].filter(Boolean)
}
