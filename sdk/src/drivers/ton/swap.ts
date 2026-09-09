/**
 * ── TON SECTION: swap ──
 * Same-chain swap through **STON.fi**, TON's open DEX.
 *
 * 🔴 THIS IS A THIRD PARTY, named as such everywhere it surfaces. TON has no protocol-level
 * swap, so a DEX is unavoidable. STON.fi was chosen on evidence gathered live 2026-09-08:
 *
 *   - **Keyless.** `POST /v1/reverse_swap/simulate` and `/v1/routers` both answer HTTP 200
 *     from a plain server request, with no key, no account and no browser headers.
 *   - **Exact output, natively.** `/v1/reverse_swap/simulate` fixes the ASK side and tells
 *     you the offer required, which is exactly the shape of an x402 invoice. There is no
 *     probe-and-scale approximation here.
 *   - **No added fee.** The only cost is the pool's own fee, which the simulation reports as
 *     `fee_percent` and this module passes through verbatim. PipRail sets no referral or
 *     partner field, and the swap body has none.
 *   - **Self-custody.** The swap is a message the user's own wallet signs and sends to the
 *     router contract. STON.fi never signs and never holds the funds.
 *
 * DeDust was the alternative and serves keyless data, but `POST /v2/routing/plan` returns an
 * empty array for a TON → USDT request, so it quotes nothing and could not be used.
 *
 * ⚠️ **TON is asynchronous.** A swap resolves over several messages rather than in one
 * atomic transaction, so "did it land" is a polling question — the same property the TON
 * payment driver already deals with. `swap()` therefore waits for the wallet's seqno to
 * advance (the wallet accepted and sent the message) and reports the resulting wallet
 * transaction hash. **Confirming the ASK side actually arrived is the caller's balance
 * check**, which is exactly how the payment path treats TON too.
 *
 * ⚠️ Gas: the simulation returns `gas_params.forward_gas` (0.3 TON on the routes seen), which
 * is ATTACHED to the message, not spent. Most of it bounces back; on the observed route about
 * 0.045 TON is actually consumed. The wallet must nonetheless hold the full attached amount.
 */
import { TON_DECIMALS, TON_NATIVE_SYMBOL } from './chains.js'
import { InsufficientFundsError } from '../../errors.js'
import { formatUnits } from '../../util/units.js'
import type { SwapQuote, SwapReceipt, SwapSide } from '../../swap.js'
import type { Caip2 } from '../../x402.js'
import type { ResolvedToken } from '../types.js'

/** STON.fi's public, keyless API. No key, no account, no signup. */
const STONFI_API = 'https://api.ston.fi'

/**
 * TON is not a jetton, so STON.fi represents native TON with a **proxy-TON (pTON) jetton
 * master**. The simulation is asked in terms of this address and answers with the router and
 * pTON version to use, so nothing about the router set is hardcoded here.
 */
const PTON_MASTER_V2_1 = 'EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S'

interface StonfiSimulation {
  router_address?: string
  pool_address?: string
  offer_units?: string
  ask_units?: string
  min_ask_units?: string
  fee_percent?: string
  offer_jetton_wallet?: string
  ask_jetton_wallet?: string
  router?: {
    address?: string
    major_version?: number
    minor_version?: number
    pton_master_address?: string
    pton_version?: string
  }
  gas_params?: { forward_gas?: string; estimated_gas_consumption?: string }
}

/** The rate always carries its origin — PipRail never asserts a price (STANDARDS §7). */
function sourceFor(feePercent: string | undefined) {
  const pct = feePercent ? `${(Number(feePercent) * 100).toFixed(4)}%` : 'the underlying pool fee'
  return {
    kind: 'provider' as const,
    name: 'STON.fi',
    note:
      'Third-party TON DEX (ston.fi), used keyless. It prices the route and returns the router to ' +
      'message; your own wallet signs and sends, and STON.fi never holds your funds. ' +
      `Cost on this route: ${pct}, which is the pool fee. PipRail adds nothing.`,
  }
}

/** A jetton master address, or the pTON master when the side is native TON. */
function masterFor(t: ResolvedToken): string {
  return t.asset === 'native' ? PTON_MASTER_V2_1 : t.asset
}

function side(t: ResolvedToken, amount: bigint): SwapSide {
  const decimals = t.asset === 'native' ? TON_DECIMALS : t.decimals
  return {
    asset: t.asset,
    symbol: t.symbol ?? (t.asset === 'native' ? TON_NATIVE_SYMBOL : t.asset),
    decimals,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, decimals),
  }
}

async function postJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export interface TonRoute {
  routerAddress: string
  routerVersion: string
  ptonMaster: string
  ptonVersion: string
  offerMaster: string
  askMaster: string
  askJettonWallet?: string
  minAskUnits: string
  forwardGas: string
  fromIsNative: boolean
  toIsNative: boolean
}

export interface QuoteTonSwapParams {
  network: Caip2
  from: ResolvedToken
  to: ResolvedToken
  wantAmount: bigint
  slippageBps: number
}

/**
 * Price an exact-output swap through STON.fi's reverse simulation. Reads only; never throws
 * (the contract for `quoteSwap`). Returns `null` when the pair cannot be routed.
 */
export async function quoteTonSwap(p: QuoteTonSwapParams): Promise<SwapQuote | null> {
  if (p.wantAmount <= 0n) return null
  const offerMaster = masterFor(p.from)
  const askMaster = masterFor(p.to)
  if (offerMaster === askMaster) return null

  // slippage_tolerance is a FRACTION here (0.01 = 1%), not basis points.
  const tolerance = (p.slippageBps / 10_000).toFixed(6)

  /*
   * 🔴 "Reverse" does not mean "exact". Ask STON.fi for 50000 units and it answers with an
   * offer priced for ~50000 but an ON-CHAIN floor of `min_ask_units` = 50000 × (1 − tolerance):
   * at 1% that is 49500, and the router will happily deliver 49500. An x402 invoice for 50000
   * is then unpaid, and this route had been advertised as "exactly 0.05 USDT" on that basis.
   *
   * So ask for MORE: units / (1 − tolerance), rounded up, which puts the floor at or above the
   * invoice. The user may receive a little over; they can never receive under. And if the
   * simulation still comes back with a floor below the invoice, there is no honest quote.
   */
  const bps = BigInt(Math.max(0, Math.min(p.slippageBps, 9_999)))
  const askUnits = (p.wantAmount * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps)
  const url =
    `${STONFI_API}/v1/reverse_swap/simulate?offer_address=${encodeURIComponent(offerMaster)}` +
    `&ask_address=${encodeURIComponent(askMaster)}&units=${askUnits.toString()}` +
    `&slippage_tolerance=${tolerance}`

  const sim = await postJson<StonfiSimulation>(url)
  if (!sim?.offer_units || !sim.router_address) return null

  // Every number that later reaches BigInt() in swap() is validated HERE, in the never-throw
  // half, so a hostile or reshaped response becomes "no quote" rather than a SyntaxError later.
  const num = (v: unknown): bigint | null => {
    if (typeof v !== 'string' && typeof v !== 'number') return null
    try {
      const n = BigInt(v)
      return n >= 0n ? n : null
    } catch {
      return null
    }
  }
  const offerUnits = num(sim.offer_units)
  if (offerUnits === null || offerUnits <= 0n) return null
  const minAsk = num(sim.min_ask_units)
  if (minAsk === null || minAsk < p.wantAmount) return null // the floor must cover the invoice
  const forwardGas = num(sim.gas_params?.forward_gas) ?? 300_000_000n

  const major = sim.router?.major_version ?? 2
  const minor = sim.router?.minor_version ?? 1
  const routerVersion = major === 1 ? 'v1' : `v${major}_${minor}`

  return {
    source: sourceFor(sim.fee_percent),
    network: p.network,
    from: side(p.from, offerUnits),
    to: side(p.to, p.wantAmount),
    // The offer side is fixed by the simulation, so it IS the ceiling.
    maxSpend: offerUnits.toString(),
    maxSpendFormatted: formatUnits(offerUnits, p.from.asset === 'native' ? TON_DECIMALS : p.from.decimals),
    slippageBps: p.slippageBps,
    route: {
      routerAddress: sim.router_address,
      routerVersion,
      ptonMaster: sim.router?.pton_master_address ?? PTON_MASTER_V2_1,
      ptonVersion: sim.router?.pton_version ?? '2.1',
      offerMaster,
      askMaster,
      askJettonWallet: sim.ask_jetton_wallet,
      // 🔴 The on-chain floor, checked above to be ≥ the invoice. The router refuses the swap
      // below it, so "at least the invoice" is enforced by the contract, not by this quote.
      minAskUnits: minAsk.toString(),
      forwardGas: forwardGas.toString(),
      fromIsNative: p.from.asset === 'native',
      toIsNative: p.to.asset === 'native',
    } satisfies TonRoute,
  }
}

/** The slice of the TON world this module needs, kept narrow so it stays testable. */
export interface TonSwapDeps {
  /** An opened TonClient (`open` is all we use); the contract type is the SDK's own. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { open: (contract: any) => any }
  /** The user's wallet contract + key pair, already resolved by the driver. */
  wallet: { contract: { address: unknown }; keyPair: { secretKey: Uint8Array } }
  /** Send one internal message and return the wallet transaction hash. */
  send: (msg: { to: string; value: bigint; body: unknown }) => Promise<string>
}

export interface SwapTonParams extends TonSwapDeps {
  quote: SwapQuote
}

/**
 * Execute a quoted swap. One message, signed by the user's own wallet, addressed to the
 * router STON.fi's own simulation named.
 */
export async function swapTon(p: SwapTonParams): Promise<SwapReceipt> {
  const route = p.quote.route as TonRoute
  if (!route?.routerAddress || !route.offerMaster || !route.askMaster) {
    throw new Error('TON: swap quote is missing its STON.fi routing data — re-quote before swapping.')
  }

  // Lazily imported, like every other non-EVM library: a pure-EVM install never downloads it.
  const [{ DEX, pTON }, { Address }] = await Promise.all([
    import('@ston-fi/sdk'),
    import('@ton/core'),
  ])

  const dex = (DEX as Record<string, { Router: { create(a: unknown): unknown } }>)[route.routerVersion]
  if (!dex?.Router) {
    throw new Error(
      `TON: STON.fi router version ${route.routerVersion} is not supported by the installed @ston-fi/sdk.`
    )
  }
  const ptonNs = (pTON as Record<string, { create(a: unknown): unknown }>)[
    route.ptonVersion.startsWith('2') ? 'v2_1' : 'v1'
  ]
  if (!ptonNs?.create) {
    throw new Error(`TON: STON.fi pTON version ${route.ptonVersion} is not supported by the installed SDK.`)
  }

  type TxParams = { to: unknown; value: bigint; body: unknown }
  type SwapFn = (args: Record<string, unknown>) => Promise<TxParams>
  const router = p.client.open(dex.Router.create(Address.parse(route.routerAddress))) as Partial<
    Record<string, SwapFn>
  >
  const call = (name: string, args: Record<string, unknown>): Promise<TxParams> => {
    const fn = router[name]
    if (typeof fn !== 'function') {
      throw new Error(`TON: the installed @ston-fi/sdk router has no ${name} — is it a supported version?`)
    }
    return fn.call(router, args)
  }
  const proxyTon = ptonNs.create(Address.parse(route.ptonMaster))
  const userWalletAddress = p.wallet.contract.address
  const offerAmount = BigInt(p.quote.from.amount)
  const minAskAmount = BigInt(route.minAskUnits)

  let txParams: { to: unknown; value: bigint; body: unknown }
  try {
    if (route.fromIsNative) {
      txParams = await call('getSwapTonToJettonTxParams', {
        userWalletAddress,
        proxyTon,
        offerAmount,
        askJettonAddress: Address.parse(route.askMaster),
        minAskAmount,
      })
    } else if (route.toIsNative) {
      txParams = await call('getSwapJettonToTonTxParams', {
        userWalletAddress,
        proxyTon,
        offerJettonAddress: Address.parse(route.offerMaster),
        offerAmount,
        minAskAmount,
      })
    } else {
      txParams = await call('getSwapJettonToJettonTxParams', {
        userWalletAddress,
        offerJettonAddress: Address.parse(route.offerMaster),
        askJettonAddress: Address.parse(route.askMaster),
        offerAmount,
        minAskAmount,
      })
    }
  } catch (err) {
    throw new Error(`TON: STON.fi could not build this swap message. Nothing was sent. (${String(err).slice(0, 160)})`, {
      cause: err,
    })
  }

  try {
    const hash = await p.send({
      to: String(txParams.to),
      value: BigInt(txParams.value),
      body: txParams.body,
    })
    return {
      transaction: hash,
      network: p.quote.network,
      source: p.quote.source,
      from: p.quote.from,
      to: p.quote.to,
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/not enough|insufficient|balance|inbound message/i.test(msg)) {
      throw new InsufficientFundsError(
        'TON swap could not be sent: the wallet cannot cover the offer plus the attached forward gas ' +
          `(${formatUnits(BigInt(route.forwardGas), TON_DECIMALS)} TON is attached, most of which bounces back). (${msg.slice(0, 140)})`,
        { cause: err }
      )
    }
    throw err
  }
}
