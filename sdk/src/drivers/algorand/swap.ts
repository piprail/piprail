/**
 * ── ALGORAND SECTION: swap ──
 * Same-chain swap through **Vestige**, an open Algorand DEX aggregator.
 *
 * 🔴 THIS IS A THIRD PARTY, named as such everywhere it surfaces. Algorand has no
 * protocol-level swap. Vestige was chosen on evidence:
 *
 *   - **Keyless.** Verified live 2026-09-08 from a plain server request: the quote and
 *     the transaction-building endpoint both returned HTTP 200 with no key.
 *   - **No integrator fee.** The only cost is the pool's own fee (0.30% on the probed
 *     route) plus the group's network fee. PipRail sends no fee parameter.
 *   - **Self-custody, provably.** The build endpoint returns UNSIGNED msgpack
 *     transactions as one atomic group, and **every `signers` array names only the
 *     sender**. Nobody co-signs, so nothing is delegated. `algosdk` (already a peer
 *     dependency) decodes, signs locally, and submits.
 *
 * ⚠️ HOST MATTERS. Use `api.vestigelabs.org`. Both `api.vestige.fi` and
 * `free-api.vestige.fi` return 530 (Cloudflare DNS failure at the edge), which is what
 * made this look unavailable on a first pass.
 *
 * ⚠️ The build endpoint wants the WHOLE quote response back, unmodified. Posting the
 * `single` or `combo` sub-object returns 422. And a sender that is not opted in to the
 * output ASA returns a bare HTTP 500, so the opt-in is checked before calling: PipRail's
 * `recipientReady()` already performs exactly that probe.
 */
import type algosdkNs from 'algosdk'
import { ALGO_DECIMALS } from './chains.js'
import { InsufficientFundsError, RecipientNotReadyError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import { applySlippage, type SwapQuote, type SwapReceipt, type SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** Vestige's public, keyless aggregator. Note the host: the .fi domains are dead. */
const VESTIGE_API = 'https://api.vestigelabs.org'

/** Algorand's native coin is asset id 0 to every aggregator. */
const ALGO_ASA = 0

function sourceFor(poolFee: number | undefined) {
  const fee = typeof poolFee === 'number' ? `${(poolFee * 100).toFixed(2)}%` : "the pool's own fee"
  return {
    kind: 'provider' as const,
    name: 'Vestige',
    note:
      'Third-party Algorand DEX aggregator (api.vestigelabs.org), used keyless. It returns an UNSIGNED ' +
      'atomic transaction group in which every signer is you: nobody co-signs and nothing is delegated. ' +
      `Pool fee on this route: ${fee}. PipRail adds nothing.`,
  }
}

/** Algorand trades ASA ids; native ALGO is asset 0. */
function asaId(t: ResolvedToken): number | null {
  if (t.asset === 'native') return ALGO_ASA
  const n = Number(t.asset)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? ALGO_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? 'ALGO' : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
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

interface VestigeQuote {
  mode: string
  amount: number
  asset_in: number
  asset_out: number
  amount_out?: number
  network_fee?: number
  single?: { transactions?: Array<{ swaps?: Array<{ fee?: number }> }> }
}

export interface QuoteAlgorandSwapParams {
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price a swap through Vestige. NEVER THROWS: returns `null` when the pair can't be
 * routed, liquidity is short of the target, or the aggregator is unreachable.
 */
export async function quoteAlgorandSwap(p: QuoteAlgorandSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const fromAsa = asaId(p.from)
  const toAsa = asaId(p.to)
  if (fromAsa === null || toAsa === null || fromAsa === toAsa) return null

  const quoteFor = (amountIn: bigint) =>
    req<VestigeQuote>(
      `${VESTIGE_API}/swap/v4?from_asa=${fromAsa}&to_asa=${toAsa}&amount=${amountIn.toString()}&mode=sef&denominating_asset_id=0`
    )

  const fromDecimals = p.from.asset === 'native' ? ALGO_DECIMALS : p.from.decimals

  /*
   * 🔴 ESCALATING PROBE. Vestige returns `amount_out: 0` for a dust input rather than an
   * error: 0.01 ALGO quotes zero while 0.1 ALGO quotes fine. A single fixed probe size
   * therefore reports "no route" on a pair that routes perfectly well, which is exactly
   * how this family first looked unsupported. Step the probe up until the aggregator
   * gives a real answer, then stop.
   */
  let probeIn = 10n ** BigInt(Math.max(fromDecimals - 2, 1))
  let probeOut = 0
  for (let step = 0; step < 4; step += 1) {
    const probe = await quoteFor(probeIn)
    const out = probe?.amount_out
    if (out && out > 0) {
      probeOut = out
      break
    }
    probeIn *= 10n
  }
  if (!probeOut) return null

  // Exact-in aggregator, exact-output invoice: size the input, then verify.
  let needIn = (probeIn * p.wantAmount + BigInt(probeOut) - 1n) / BigInt(probeOut)
  needIn = applySlippage(needIn, p.slippageBps)

  const real = await quoteFor(needIn)
  const realOut = real?.amount_out
  if (!realOut) return null
  // 🔴 Never ship a swap that lands short of the invoice.
  if (BigInt(Math.floor(realOut)) < p.wantAmount) return null

  const poolFee = real.single?.transactions?.[0]?.swaps?.[0]?.fee
  return {
    source: sourceFor(poolFee),
    network: p.network,
    from: side(p.from, needIn),
    to: side(p.to, BigInt(Math.floor(realOut))),
    maxSpend: needIn.toString(),
    maxSpendFormatted: formatUnits(needIn, fromDecimals),
    slippageBps: p.slippageBps,
    // The build endpoint wants the ENTIRE quote response back, unmodified.
    route: { quote: real },
  }
}

export interface SwapAlgorandParams {
  algosdk: typeof algosdkNs
  algod: { sendRawTransaction(stx: Uint8Array[]): { do(): Promise<{ txid?: string; txId?: string }> } }
  signer: { addr: string; sk: Uint8Array }
  quote: SwapQuote
}

/**
 * Execute a quoted swap: fetch the unsigned atomic group, sign every transaction
 * locally with the user's own key, and submit. No other party signs anything.
 */
export async function swapAlgorand(p: SwapAlgorandParams): Promise<SwapReceipt> {
  const route = p.quote.route as { quote?: VestigeQuote }
  if (!route?.quote) {
    throw new Error('Algorand: swap quote is missing its Vestige routing data — re-quote before swapping.')
  }
  const slippage = p.quote.slippageBps / 10_000

  const unsigned = await req<Array<{ txn: string; signers?: string[] }>>(
    `${VESTIGE_API}/swap/v4/transactions?sender=${p.signer.addr}&slippage=${slippage}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(route.quote),
    }
  )
  if (!unsigned?.length) {
    // A 500 here almost always means the sender is not opted in to the output ASA.
    throw new RecipientNotReadyError(
      'Vestige could not build this swap. The usual cause is that your account is not opted in to the ' +
        'asset you are swapping INTO: opt in first, then re-quote. Nothing was spent.'
    )
  }

  /*
   * 🔴 Verify nobody else is asked to sign before signing anything. The whole
   * self-custody claim for this rail rests on every signer being the sender, so it is
   * checked at runtime rather than trusted from a documentation page.
   */
  for (const t of unsigned) {
    if (t.signers && t.signers.some((s) => s !== p.signer.addr)) {
      throw new Error(
        'Algorand swap refused: the built group asks a third party to co-sign, which this rail must never do. Nothing was signed.'
      )
    }
  }

  try {
    const signed = unsigned.map((t) => {
      const decoded = p.algosdk.decodeUnsignedTransaction(Buffer.from(t.txn, 'base64'))
      return decoded.signTxn(p.signer.sk)
    })
    const res = await p.algod.sendRawTransaction(signed).do()
    const txid = res.txid ?? res.txId
    if (!txid) throw new Error('Algorand: sendRawTransaction returned no transaction id.')
    return {
      transaction: txid,
      network: p.quote.network,
      source: p.quote.source,
      from: p.quote.from,
      to: p.quote.to,
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/asset .* missing|not opted in|receiver error/i.test(msg)) {
      throw new RecipientNotReadyError(
        `Algorand swap refused: your account must opt in to the asset you are swapping INTO first. (${msg.slice(0, 140)})`,
        { cause: err }
      )
    }
    if (/overspend|insufficient|below min/i.test(msg)) {
      throw new InsufficientFundsError(
        `Algorand swap failed: the account can't cover it (balance, the 0.1 ALGO minimum, or group fees). (${msg.slice(0, 140)})`,
        { cause: err }
      )
    }
    throw err
  }
}
