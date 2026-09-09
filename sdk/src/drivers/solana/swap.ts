/**
 * ── SOLANA SECTION: swap ──
 * Same-chain swap through **Jupiter**, the open Solana DEX aggregator.
 *
 * 🔴 THIS IS A THIRD PARTY, and it is named as such everywhere it surfaces. Unlike
 * the Stellar and XRPL rails (where the ledger itself does the swap), Solana has no
 * protocol-level swap, so a router is unavoidable. Jupiter was chosen on evidence,
 * not popularity:
 *
 *   - **Keyless.** Verified live 2026-09-08 with a plain server-side request, no
 *     browser and no headers: `GET lite-api.jup.ag/swap/v1/quote` → HTTP 200.
 *   - **No fee to us or by us.** The quote carries `platformFee: null`, and PipRail
 *     never sets `platformFeeBps`. We take nothing and add nothing.
 *   - **Self-custody.** `/swap` returns a SERIALIZED TRANSACTION that the user's own
 *     keypair signs locally. Jupiter never holds the funds and never signs.
 *
 * `swapMode: 'ExactOut'` is the invoice shape: fix the output at what the 402 asks
 * for, and let the input float up to `otherAmountThreshold`, which is the slippage
 * cap Jupiter builds INTO the transaction. If the market moves past it the swap
 * fails on-chain rather than overspending.
 *
 * ⚠️ Not every pair supports ExactOut routing. When Jupiter can't route one it says
 * so, and `quoteSwap` returns null rather than silently falling back to ExactIn and
 * delivering a different amount than the caller asked for.
 */
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import { SOL_DECIMALS } from './chains.js'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** Jupiter's public, keyless endpoint. No key, no account, no signup. */
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1'

/** Wrapped SOL — Jupiter routes native SOL under its wrapped mint. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

/**
 * The rate always carries its origin — PipRail never asserts a price (STANDARDS §7).
 *
 * 🔴 THE FEE CLAIM IS SELF-VERIFYING. We do not hardcode "no fee" and hope. Every
 * quote is inspected, and if Jupiter ever returns a `platformFee`, the note SAYS SO
 * instead of repeating a claim that has quietly become false. PipRail never sets
 * `platformFeeBps`, so a fee could only appear as a change on their side, and the
 * user would find out from the quote rather than from their balance.
 */
function sourceFor(platformFee: unknown) {
  const charged =
    platformFee != null &&
    !(typeof platformFee === 'object' && Object.keys(platformFee as object).length === 0)
  return {
    kind: 'provider' as const,
    name: 'Jupiter',
    note:
      'Third-party Solana DEX aggregator (lite-api.jup.ag), used keyless. It routes and builds the ' +
      'transaction; your own key signs it and Jupiter never holds your funds. ' +
      (charged
        ? `⚠️ THIS QUOTE CARRIES A PLATFORM FEE: ${JSON.stringify(platformFee)}. PipRail did not set one.`
        : 'This quote carries no platform fee, and PipRail adds none.'),
  }
}

/** A quote as Jupiter returns it. Only the fields we rely on are named. */
interface JupQuote {
  inputMint: string
  inAmount: string
  outputMint: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  platformFee: unknown
  priceImpactPct?: string
}

/** Jupiter speaks mints; `'native'` is wrapped SOL to a router. */
function mintFor(t: ResolvedToken): string {
  return t.asset === 'native' ? WSOL_MINT : t.asset
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? SOL_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? 'SOL' : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

/** A bounded fetch that never hangs a caller's process. */
async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
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

export interface QuoteSolanaSwapParams {
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a swap through Jupiter. NEVER THROWS: returns `null` when the pair can't be
 * routed for exact output, Jupiter is unreachable, or the response is unusable.
 * `null` means "no quote", never "no funds".
 */
export async function quoteSolanaSwap(p: QuoteSolanaSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const inputMint = mintFor(p.from)
  const outputMint = mintFor(p.to)
  if (inputMint === outputMint) return null // not a swap

  const url =
    `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${p.wantAmount.toString()}&swapMode=ExactOut&slippageBps=${p.slippageBps}`

  const q = await getJson<JupQuote>(url)
  if (!q?.otherAmountThreshold || !q.inAmount) return null
  // Refuse anything that is not the exact-output route we asked for: silently
  // delivering a different amount than the invoice demands would be worse than
  // returning no quote at all.
  if (q.swapMode !== 'ExactOut') return null
  if (q.outAmount !== p.wantAmount.toString()) return null

  let spend: bigint
  let maxSpend: bigint
  try {
    spend = BigInt(q.inAmount)
    // Jupiter already applied our slippage to build the threshold. Trust its number
    // when it is the larger one, so the on-chain cap and our reported cap agree.
    const jupCap = BigInt(q.otherAmountThreshold)
    const ourCap = applySlippage(spend, p.slippageBps)
    maxSpend = jupCap > ourCap ? jupCap : ourCap
  } catch {
    return null
  }
  if (spend <= 0n) return null

  const fromDecimals = p.from.asset === 'native' ? SOL_DECIMALS : p.from.decimals
  return {
    source: sourceFor(q.platformFee),
    network: p.network,
    from: side(p.from, spend),
    to: side(p.to, p.wantAmount),
    maxSpend: maxSpend.toString(),
    maxSpendFormatted: formatUnits(maxSpend, fromDecimals),
    slippageBps: p.slippageBps,
    // Jupiter needs its own quote object back verbatim to build the transaction.
    route: q,
  }
}

export interface SwapSolanaParams {
  connection: Connection
  keypair: Keypair
  quote: SwapQuote
}

/**
 * Execute a quoted swap. Jupiter BUILDS the transaction; the user's keypair SIGNS it
 * here, locally, and this process broadcasts it. Jupiter never signs and never holds
 * the funds.
 */
export async function swapSolana(p: SwapSolanaParams): Promise<SwapReceipt> {
  const { connection, keypair, quote } = p
  const jupQuote = quote.route as JupQuote
  if (!jupQuote?.otherAmountThreshold) {
    throw new Error('Solana: swap quote is missing its Jupiter routing data — re-quote before swapping.')
  }

  const built = await getJson<{ swapTransaction?: string; error?: string }>(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: jupQuote,
      userPublicKey: keypair.publicKey.toBase58(),
      // Let Jupiter create + close the wrapped-SOL account in the same transaction,
      // so a SOL leg needs no separate setup step from the caller.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  })
  if (!built?.swapTransaction) {
    throw new InsufficientFundsError(
      'Jupiter could not build this swap transaction (no route, or the market moved). Nothing was spent — re-quote and retry.'
    )
  }

  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'))
  } catch (cause) {
    throw new Error('Solana: Jupiter returned a transaction this SDK could not decode.', { cause })
  }

  // 🔴 The ONLY signature is the user's own, applied locally.
  tx.sign([keypair])

  try {
    // Mirrors pay.ts's confirmation idiom so both Solana paths agree on "landed".
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    })
    /*
     * 🔴 Submitting is not landing. `sendRawTransaction` returns as soon as the RPC accepts
     * the bytes, so a transaction that then FAILS on-chain would still have been reported
     * here as a completed swap. Confirm it, and read the slot's error. (Same class of bug as
     * the EVM reverted-receipt hole; both were fixed together.)
     */
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    )
    if (conf?.value?.err) {
      throw new InsufficientFundsError(
        `Solana swap failed on-chain (tx ${sig}): ${JSON.stringify(conf.value.err)}. ` +
          'Nothing was swapped. The usual cause is slippage — re-quote and retry.'
      )
    }
    return {
      transaction: sig,
      network: quote.network,
      source: quote.source,
      from: quote.from,
      to: quote.to,
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/insufficient|0x1\b/i.test(msg)) {
      throw new InsufficientFundsError(
        `Solana swap failed: the wallet can't cover it (token balance, or SOL for fees and rent). (${msg.slice(0, 160)})`,
        { cause: err }
      )
    }
    if (/slippage|0x1771/i.test(msg)) {
      throw new InsufficientFundsError(
        'Solana swap refused: the price moved past your slippage cap, so nothing was spent. Re-quote and retry, or raise slippageBps.',
        { cause: err }
      )
    }
    throw err
  }
}
