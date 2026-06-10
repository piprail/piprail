/**
 * Spend ledger — an in-memory, per-asset tally of what a client has paid.
 *
 * An autonomous agent that can't account for its spend can't be trusted to
 * spend, so the client records every settled payment here and exposes a
 * snapshot via `client.spent()`. The ledger also powers the policy's per-asset
 * `maxTotal` cap (via {@link SpendLedger.totalFor}).
 *
 * PURE + chain-agnostic. Aggregation is keyed by `network|asset` because
 * summing across different tokens is unit-meaningless without a price oracle
 * (which the SDK deliberately doesn't add).
 */
import { formatUnits } from './util/units.js'
import type { Caip2 } from './x402.js'

export interface SpendRecord {
  url: string
  host: string
  network: Caip2
  asset: string
  /** Base units paid (already scaled by decimals). */
  amountBase: string
  /** Human-readable amount, e.g. '0.05'. */
  amountFormatted: string
  symbol?: string
  /** Proof ref (EVM tx hash, Solana signature, TON locator, Stellar tx hash). */
  ref: string
  /** ISO timestamp of settlement. */
  at: string
}

export interface SpendAssetTotal {
  network: Caip2
  asset: string
  symbol?: string
  decimals: number
  totalBase: string
  totalFormatted: string
  count: number
}

export interface SpendSummary {
  /** Total number of settled payments. */
  count: number
  /** Cumulative spend per distinct (network, asset). */
  byAsset: SpendAssetTotal[]
  /** Every settled payment, in order. */
  records: SpendRecord[]
}

interface Bucket {
  network: Caip2
  asset: string
  symbol?: string
  decimals: number
  total: bigint
  count: number
}

const keyFor = (network: string, asset: string) => `${network}|${asset}`

export class SpendLedger {
  private readonly records: SpendRecord[] = []
  private readonly buckets = new Map<string, Bucket>()

  /**
   * Session clock origin (epoch-ms) — process/session start = ledger
   * construction. In-memory; a new process is a new session. The client reads it
   * to compute the `ttlSeconds` deadline and the rolling-window slice.
   */
  readonly sessionStart: number = Date.now()

  /** Record a settled payment. `decimals` is the TRUE token decimals (for the
   *  per-asset running total used by maxTotal + the formatted summary). */
  record(r: SpendRecord, decimals: number): void {
    this.records.push(r)
    const key = keyFor(r.network, r.asset)
    const bucket = this.buckets.get(key)
    if (bucket) {
      bucket.total += BigInt(r.amountBase)
      bucket.count += 1
      if (!bucket.symbol && r.symbol) bucket.symbol = r.symbol
    } else {
      this.buckets.set(key, {
        network: r.network,
        asset: r.asset,
        symbol: r.symbol,
        decimals,
        total: BigInt(r.amountBase),
        count: 1,
      })
    }
  }

  /** Running total (base units) already spent on this (network, asset). */
  totalFor(network: string, asset: string): bigint {
    return this.buckets.get(keyFor(network, asset))?.total ?? 0n
  }

  /**
   * Sum of base-unit amounts for (network, asset) whose record `at` (ISO
   * timestamp) is at or after `sinceMs` (epoch-ms). Backs the rolling window
   * (`sinceMs = now - windowSeconds*1000`). A linear scan of `records` —
   * agent-session cardinality is small (tens), and it only runs when a window
   * policy is set, so it's negligible against the network round-trip.
   */
  totalSince(network: string, asset: string, sinceMs: number): bigint {
    let sum = 0n
    for (const r of this.records) {
      if (r.network === network && r.asset === asset && Date.parse(r.at) >= sinceMs) {
        sum += BigInt(r.amountBase)
      }
    }
    return sum
  }

  /**
   * The per-(network, asset) buckets, as read-only tuples — `network`, `asset`,
   * `symbol`, the TRUE `decimals` (frozen from the first record), and the running
   * `totalBase`. Lets the client compose a budget view WITHOUT coupling the ledger
   * to the policy (the cap math lives in the client). Decimals only exist for a
   * pair once it's been spent on — a never-spent pair simply isn't a bucket.
   */
  assetBuckets(): { network: Caip2; asset: string; symbol?: string; decimals: number; totalBase: bigint }[] {
    return [...this.buckets.values()].map((b) => ({
      network: b.network,
      asset: b.asset,
      ...(b.symbol ? { symbol: b.symbol } : {}),
      decimals: b.decimals,
      totalBase: b.total,
    }))
  }

  /** An immutable snapshot of all spend so far. */
  summary(): SpendSummary {
    return {
      count: this.records.length,
      byAsset: [...this.buckets.values()].map((b) => ({
        network: b.network,
        asset: b.asset,
        symbol: b.symbol,
        decimals: b.decimals,
        totalBase: b.total.toString(),
        totalFormatted: formatUnits(b.total, b.decimals),
        count: b.count,
      })),
      records: [...this.records],
    }
  }
}
