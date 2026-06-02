/**
 * The shared gas/cost helper — the single place a per-driver native-coin fee
 * becomes the uniform {@link CostEstimate}. Each family's `estimateCost()`
 * computes its chain's fee as a bigint of NATIVE base units (EVM gas × price,
 * Solana lamports, Tron energy × price, XRPL drops, …) and calls this, so the
 * shape + formatting are identical on every chain. Chain-agnostic: imports only
 * `units` + the type, so it stays free of any chain SDK.
 */
import { formatUnits } from './units.js'
import type { CostEstimate } from '../drivers/types.js'

/** Build a {@link CostEstimate} from a native-coin fee in base units. */
export function nativeCost(opts: {
  /** Native coin ticker (ETH, SOL, TON, XLM, XRP, TRX, …). */
  symbol: string
  /** Native coin decimals. */
  decimals: number
  /** Fee in the native coin's base units. */
  fee: bigint
  /** 'estimated' = from a live RPC read; 'heuristic' = a typical-cost constant. */
  basis: 'estimated' | 'heuristic'
  /** Optional human note on what's included. */
  detail?: string
}): CostEstimate {
  return {
    feeSymbol: opts.symbol,
    feeDecimals: opts.decimals,
    fee: opts.fee.toString(),
    feeFormatted: formatUnits(opts.fee, opts.decimals),
    basis: opts.basis,
    ...(opts.detail ? { detail: opts.detail } : {}),
  }
}
