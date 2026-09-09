/**
 * ── XRPL SECTION: swap ──
 * Same-chain swap via a CROSS-CURRENCY PAYMENT TO YOURSELF. No DEX contract, no
 * aggregator, no API key, no extra dependency — the `xrpl` package is already here
 * for payments and ships path finding, order-book reads and the transaction types.
 *
 * The XRP Ledger explicitly permits `Account == Destination` for exactly one
 * purpose: currency conversion. From the Payment reference — it "consumes offers in
 * the decentralized exchange to convert one currency to another". So a self-payment
 * with `SendMax` set IS the swap, and it is a protocol primitive, not a product.
 *
 * We fix the OUTPUT (`Amount`) and cap the input (`SendMax`) because that is the
 * shape of an invoice: a 402 names an exact amount owed and the cost floats.
 * `SendMax` is the slippage guard and it is enforced BY THE VALIDATORS — a market
 * that moves past it fails the transaction rather than overspending.
 *
 * Routing is free and automatic. Since the AMM amendment, payments are optimised
 * across the order books AND the liquidity pools, and AUTO-BRIDGING routes a
 * token→token trade through XRP whenever that is cheaper. You reach the whole
 * ledger's liquidity without asking for it.
 *
 * Custody: perfect. One transaction the user signs, executed atomically by the
 * validators. No router contract, no token approval, no solver, no relayer.
 *
 * Cost: the ~10-drop network fee, plus the market. Order books charge no protocol
 * fee (spread only); AMM pools charge a per-pool fee set by LP vote (0%–1%), paid
 * to the pool. There is no integrator fee field, so nobody can add one.
 *
 * ⚠️ `ledger_index: 'current'` is MANDATORY on path finding. Public Clio servers
 * serve only validated data and reject a path find without it; some public nodes
 * refuse path finding altogether. A failed lookup returns `null` (no quote), never
 * a throw.
 */
import type { Wallet } from 'xrpl'
import { XRP_DECIMALS, XRP_SYMBOL, parseXrplAssetId } from './chains.js'
import { InsufficientFundsError, RecipientNotReadyError, toInsufficientFundsError } from '../../errors.js'
import { parseUnits, formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { XrplPayClient } from './pay.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
const SOURCE = {
  kind: 'protocol' as const,
  name: 'XRPL DEX + AMM',
  note: 'Rate from the ledger’s own order books and AMM pools, read live via ripple_path_find, with auto-bridging through XRP where cheaper. Order books charge no protocol fee; AMM pools charge a per-pool fee (0%–1%) paid to the pool.',
}

/** An XRPL amount: a drops string (XRP) or an issued-currency object. */
export type XrplAmount = string | { currency: string; issuer: string; value: string }

/** The one extra read a swap needs on top of the pay client. */
export interface XrplSwapClient extends XrplPayClient {
  /** ripple_path_find → alternatives[]. MUST pass ledger_index:'current'. */
  pathFind(params: {
    source_account: string
    destination_account: string
    destination_amount: XrplAmount
    source_currencies: Array<{ currency: string; issuer?: string }>
  }): Promise<{ alternatives?: Array<{ paths_computed?: unknown[]; source_amount?: XrplAmount }> }>
}

/** Base units → an XRPL amount for this asset. */
function toAmount(t: ResolvedToken, base: bigint): XrplAmount {
  if (t.asset === 'native') return base.toString() // drops
  const parts = parseXrplAssetId(t.asset)
  if (!parts) throw new Error(`XRPL: malformed asset id "${t.asset}".`)
  return { currency: parts.currencyHex, issuer: parts.issuer, value: formatUnits(base, t.decimals) }
}

/**
 * Parse a decimal string to base units, ROUNDING UP past our precision.
 *
 * 🔴 XRPL issued amounts are floats carried as strings with up to 15-16 significant
 * digits, while our base-unit convention is a fixed `decimals` (6). `parseUnits`
 * REJECTS the excess precision, so a perfectly good route like
 * `"0.02789866666666666"` RLUSD threw and the whole quote came back `null` as though
 * no route existed. That is not a theoretical case: it is what a real RLUSD to XRP
 * path returns, and it made the reverse direction look unsupported.
 *
 * Rounds UP, because this is what the caller will SPEND: over-stating it by one base
 * unit is harmless, under-stating it would set a cap the swap cannot satisfy.
 */
function parseCeil(value: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = value.trim().split('.')
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  const rest = frac.slice(decimals)
  const base = BigInt(whole + kept)
  // Anything truncated that was not a zero means we rounded down; push it back up.
  return /[1-9]/.test(rest) ? base + 1n : base
}

/** An XRPL amount → base units under this asset's scaling convention. */
function fromAmount(t: ResolvedToken, a: XrplAmount | undefined): bigint | null {
  if (a == null) return null
  try {
    return typeof a === 'string' ? BigInt(a) : parseCeil(a.value, t.decimals)
  } catch {
    return null
  }
}

/** The `source_currencies` entry that names the asset we're willing to spend. */
function sourceCurrency(t: ResolvedToken): { currency: string; issuer?: string } {
  if (t.asset === 'native') return { currency: 'XRP' }
  const parts = parseXrplAssetId(t.asset)
  if (!parts) throw new Error(`XRPL: malformed asset id "${t.asset}".`)
  return { currency: parts.currencyHex, issuer: parts.issuer }
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? XRP_SYMBOL : t.asset),
    decimals: t.asset === 'native' ? XRP_DECIMALS : t.decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, t.asset === 'native' ? XRP_DECIMALS : t.decimals),
  }
}

export interface QuoteXrplSwapParams {
  client: XrplSwapClient
  network: Caip2
  owner: string
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a self-swap. NEVER THROWS — returns `null` when the pair can't be routed,
 * there is no liquidity, or the node refuses path finding. `null` means "no quote",
 * never "no funds".
 */
export async function quoteXrplSwap(p: QuoteXrplSwapParams): Promise<SwapQuote | null> {
  if (p.from.asset === p.to.asset) return null // not a swap
  if (p.wantAmount <= 0n) return null
  // XRPL forbids a cross-currency payment where BOTH sides are XRP; a self-swap
  // native→native is meaningless anyway and is already excluded above.

  /*
   * 🔴 `ripple_path_find` on the public cluster is INTERMITTENT: the same request can
   * return one alternative and then none a second later, with no error. Observed
   * directly while live-testing RLUSD to XRP, where the route existed throughout.
   * A single empty answer is therefore not evidence that no route exists, so try
   * twice before reporting "no quote". Still bounded, still never throws.
   */
  let alternatives: Array<{ paths_computed?: unknown[]; source_amount?: XrplAmount }> = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await p.client.pathFind({
        source_account: p.owner,
        destination_account: p.owner, // ← ourselves: this is what makes it a swap
        destination_amount: toAmount(p.to, p.wantAmount),
        source_currencies: [sourceCurrency(p.from)],
      })
      alternatives = res.alternatives ?? []
    } catch {
      alternatives = [] // transient read failure, or a node that won't path-find
    }
    if (alternatives.length) break
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
  }
  if (!alternatives.length) return null

  // Pick the cheapest INPUT (the output is fixed either way).
  let best: { paths_computed?: unknown[]; source_amount?: XrplAmount } | null = null
  let bestSpend: bigint | null = null
  for (const alt of alternatives) {
    const spend = fromAmount(p.from, alt.source_amount)
    if (spend == null || spend <= 0n) continue
    if (bestSpend == null || spend < bestSpend) {
      bestSpend = spend
      best = alt
    }
  }
  if (!best || bestSpend == null) return null

  const maxSpend = applySlippage(bestSpend, p.slippageBps)
  return {
    source: SOURCE,
    network: p.network,
    from: side(p.from, bestSpend),
    to: side(p.to, p.wantAmount),
    maxSpend: maxSpend.toString(),
    maxSpendFormatted: formatUnits(maxSpend, p.from.asset === 'native' ? XRP_DECIMALS : p.from.decimals),
    slippageBps: p.slippageBps,
    // `paths_computed` drops straight into the transaction's Paths field.
    route: { paths: best.paths_computed ?? [], from: p.from, to: p.to },
  }
}

export interface SwapXrplParams {
  client: XrplSwapClient
  wallet: Wallet
  quote: SwapQuote
}

/** The routing data we stashed on the quote. Opaque to callers, ours to read. */
type XrplRoute = { paths: unknown[]; from: ResolvedToken; to: ResolvedToken }

/** One step of a path as `ripple_path_find` returns it. */
type PathStep = { account?: string; currency?: string; issuer?: string; type?: number; type_hex?: string }

/**
 * Strip a path down to the fields xrpl.js can encode.
 *
 * 🔴 WHY: `ripple_path_find` returns each step with `type` and `type_hex` alongside
 * the real fields. xrpl.js derives the type itself and chokes on some of these
 * shapes with `Cannot construct UInt32 from given value` — an opaque client-side
 * encoding failure, NOT a chain rejection. It is INTERMITTENT, because which route
 * comes back depends on live liquidity, so it looks like a flake and is not one.
 * Found by running the same live swap twice and getting different outcomes.
 */
function sanitizePaths(paths: unknown): PathStep[][] {
  if (!Array.isArray(paths)) return []
  return paths
    .map((path) =>
      (Array.isArray(path) ? path : [])
        .map((raw) => {
          const step = raw as PathStep
          const clean: PathStep = {}
          if (typeof step.account === 'string') clean.account = step.account
          if (typeof step.currency === 'string') clean.currency = step.currency
          if (typeof step.issuer === 'string') clean.issuer = step.issuer
          return clean
        })
        .filter((step) => Object.keys(step).length > 0)
    )
    .filter((path) => path.length > 0)
}

/**
 * Execute a quoted self-swap. One cross-currency `Payment` whose destination is the
 * signer's own address. Throws {@link InsufficientFundsError} when the wallet can't
 * cover it (ERRORS.md §5).
 */
export async function swapXrpl(p: SwapXrplParams): Promise<SwapReceipt> {
  const { client, wallet, quote } = p
  const route = quote.route as XrplRoute
  if (!route?.from || !route?.to) {
    throw new Error('XRPL: swap quote is missing its routing data — re-quote before swapping.')
  }

  try {
    const [sequence, feeDrops, ledgerIndex] = await Promise.all([
      client.accountSequence(wallet.classicAddress),
      client.feeDrops(),
      client.currentLedgerIndex(),
    ])

    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: wallet.classicAddress,
      Destination: wallet.classicAddress, // ← ourselves: the ledger's own swap idiom
      Amount: toAmount(route.to, BigInt(quote.to.amount)), // exact output
      SendMax: toAmount(route.from, BigInt(quote.maxSpend)), // the on-chain slippage cap
      // Sanitized: raw path steps from ripple_path_find can break xrpl.js encoding.
      ...(sanitizePaths(route.paths).length ? { Paths: sanitizePaths(route.paths) } : {}),
      Sequence: sequence,
      Fee: feeForSubmit(feeDrops),
      LastLedgerSequence: ledgerIndex + 20,
      // NOT tfPartialPayment: we want the full `Amount` delivered or nothing at all.
      Flags: 0,
    }

    /*
     * xrpl.js encoding errors are famously opaque ("Cannot construct UInt32 from
     * given value") and name neither the field nor the value. Catch and re-throw with
     * the actual transaction shape, so the next person debugging this does not have
     * to bisect it by hand the way we did.
     */
    let signed: { tx_blob: string; hash: string }
    try {
      signed = wallet.sign(tx as never)
    } catch (cause) {
      const shape = Object.fromEntries(
        Object.entries(tx).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${String(v)}`])
      )
      throw new Error(
        `XRPL could not encode the swap transaction: ${String((cause as Error)?.message ?? cause)}. ` +
          `Transaction was ${JSON.stringify(shape)}`,
        { cause }
      )
    }
    const res = await client.submit(signed.tx_blob)
    const code = res.engine_result

    if (code.startsWith('tes')) {
      return {
        transaction: res.tx_json?.hash ?? signed.hash,
        network: quote.network,
        source: quote.source,
        from: quote.from,
        to: quote.to,
      }
    }
    throw mapEngineResult(code, res)
  } catch (err) {
    if (err instanceof InsufficientFundsError || err instanceof RecipientNotReadyError) throw err
    throw toInsufficientFundsError(err) ?? err
  }
}

/** XRPL asks for a fee in drops; pad the open-ledger fee a little for safety. */
function feeForSubmit(openLedgerFee: string): string {
  try {
    const f = BigInt(openLedgerFee)
    const padded = f * 2n
    return (padded < 10n ? 10n : padded).toString()
  } catch {
    return '12'
  }
}

/** Map an XRPL engine result to the SDK's typed errors (ERRORS.md §5). */
function mapEngineResult(code: string, res: unknown): unknown {
  const err = new Error(`XRPL swap rejected: ${code}`)
  ;(err as { cause?: unknown }).cause = res

  // The slippage guard did its job: the market moved past SendMax. Nothing was spent.
  if (code === 'tecPATH_PARTIAL' || code === 'tecPATH_DRY') {
    return new InsufficientFundsError(
      `XRPL swap refused: the price moved past your slippage cap, or the path ran dry, so nothing was spent. Re-quote and retry, or raise slippageBps. (XRPL: ${code})`,
      { cause: res }
    )
  }
  // Swapping INTO an issued currency needs your own trustline for it first.
  if (code === 'tecNO_LINE' || code === 'tecNO_AUTH' || code === 'tecNO_ISSUER') {
    return new RecipientNotReadyError(
      `XRPL swap refused: your account needs a trustline for the currency you're swapping INTO before it can hold it. (XRPL: ${code})`,
      { cause: res }
    )
  }
  if (code === 'tecUNFUNDED_PAYMENT' || code === 'terINSUF_FEE_B' || code === 'tecINSUFF_FEE') {
    return new InsufficientFundsError(
      `XRPL swap failed: the account can't cover it — balance or the 1 XRP base reserve. (XRPL: ${code})`,
      { cause: res }
    )
  }
  return err
}
