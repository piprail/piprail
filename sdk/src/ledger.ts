/**
 * Spend ledger — a per-asset tally of what a client has paid, optionally durable.
 *
 * An autonomous agent that can't account for its spend can't be trusted to
 * spend, so the client records every settled payment here and exposes a
 * snapshot via `client.spent()`. The ledger powers the policy's per-asset
 * `maxTotal` cap (via {@link SpendLedger.totalFor}), the cross-token GRAND TOTAL
 * (`maxTotalPerDenom`, via {@link SpendLedger.totalForDenom}), and the payment-count
 * caps (via {@link SpendLedger.count}/{@link SpendLedger.countSince}).
 *
 * PURE + chain-agnostic. Per-asset aggregation is keyed by `network|asset`. The
 * GRAND total is keyed by DENOMINATION (a unit of account the caller declares, e.g.
 * `USD` across every stablecoin) — see {@link denomOf}; it is NOT a price oracle, it
 * sums tokens the caller grouped as one unit, each 1:1.
 *
 * Durability is OPT-IN: pass a {@link SpendStore} and the ledger hydrates from it at
 * construction and appends each settled payment, so caps survive a restart. With no
 * store it's in-memory and process-scoped (the default — the session is the process).
 */
import { formatUnits, MAX_DECIMALS } from './util/units.js'
import { DENOM_PRECISION, scaleToDenom } from './policy.js'
import type { SpendStore } from './spendstore.js'
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
  /** TRUE token decimals. Carried on the record so a {@link SpendStore} can rebuild
   *  exact totals + the grand total on reload (the client stamps it on every settle). */
  decimals?: number
  /** The DENOMINATION this payment counts toward in the cross-token grand total
   *  (e.g. `'USD'`), or absent for a token with no denomination. Stamped by the
   *  client from the policy at settle time so it round-trips through persistence. */
  denom?: string
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

/** Cumulative spend in one DENOMINATION (a unit of account), summed across every
 *  token of that denomination and every chain — the cross-token grand total. */
export interface SpendDenomTotal {
  /** The denomination, e.g. `'USD'`. */
  denom: string
  /** Total spent, scaled to {@link DENOM_PRECISION} (the accumulator's base), as a string. */
  totalScaled: string
  /** Human-readable denomination total, e.g. '12.34'. */
  totalFormatted: string
  /** Number of payments (across all tokens + chains) that contributed to this denom. */
  count: number
}

export interface SpendSummary {
  /** Total number of settled payments (across every chain + token). */
  count: number
  /** Cumulative spend per distinct (network, asset). */
  byAsset: SpendAssetTotal[]
  /** Cumulative spend per DENOMINATION — the cross-token grand total (empty when no
   *  payment carried a denomination). NEVER a price-converted figure: a sum of tokens
   *  grouped as one unit, each 1:1. */
  byDenom: SpendDenomTotal[]
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
  /** Per-denomination running total, scaled to {@link DENOM_PRECISION}. Keyed by the
   *  UPPERCASE denomination so lookups are case-insensitive. */
  private readonly denomTotals = new Map<string, bigint>()
  private readonly store?: SpendStore

  /**
   * Session clock origin (epoch-ms) — process/session start = ledger
   * construction. In-memory; a new process is a new session. The client reads it
   * to compute the `ttlSeconds` deadline and the rolling-window slice.
   */
  readonly sessionStart: number = Date.now()

  /**
   * @param store Optional durable {@link SpendStore}. When supplied, the ledger
   *   HYDRATES from `store.load()` here (so prior spend resumes after a restart) and
   *   `append()`s every settled payment. A throwing/absent store fails SAFE to an
   *   empty in-memory ledger — it never blocks construction (ERRORS.md: never throw).
   */
  constructor(store?: SpendStore) {
    this.store = store
    if (store) {
      let seed: SpendRecord[] = []
      try {
        seed = store.load() ?? []
      } catch {
        seed = []
      }
      // Each record is ingested defensively (corrupt entries are SKIPPED, not fatal), so a
      // poisoned/hand-edited store line can never throw out of construction (ERRORS.md).
      for (const r of seed) this.ingest(r, r?.decimals ?? 0, r?.denom)
    }
  }

  /**
   * A record is safe to tally iff its `amountBase` is a non-negative integer STRING and its
   * `decimals` is an integer in `[0, MAX_DECIMALS]`. The live `record()` path always passes
   * (the client validated the quote), but a hydrated record comes from an UNTRUSTED store
   * (a tampered/corrupt/future-version JSONL line), so we gate it here — a bad record is
   * dropped rather than allowed to throw `BigInt(...)`/`formatUnits(...)` later and brick a
   * read or the constructor.
   */
  private isTallyable(r: SpendRecord | undefined, decimals: number): boolean {
    return (
      !!r &&
      typeof r.amountBase === 'string' &&
      /^\d+$/.test(r.amountBase) &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= MAX_DECIMALS
    )
  }

  /** Apply a record to the in-memory tallies (records + per-asset bucket + denom total).
   *  Shared by {@link record} and constructor hydration; does NOT persist. Returns the
   *  stored record, or `null` when the record is corrupt and was skipped. */
  private ingest(r: SpendRecord, decimals: number, denom?: string): SpendRecord | null {
    if (!this.isTallyable(r, decimals)) return null
    const rec: SpendRecord = { ...r, decimals, ...(denom ? { denom } : {}) }
    this.records.push(rec)

    const key = keyFor(rec.network, rec.asset)
    const bucket = this.buckets.get(key)
    if (bucket) {
      bucket.total += BigInt(rec.amountBase)
      bucket.count += 1
      if (!bucket.symbol && rec.symbol) bucket.symbol = rec.symbol
    } else {
      this.buckets.set(key, {
        network: rec.network,
        asset: rec.asset,
        symbol: rec.symbol,
        decimals,
        total: BigInt(rec.amountBase),
        count: 1,
      })
    }

    if (denom) {
      const scaled = scaleToDenom(BigInt(rec.amountBase), decimals)
      // A token finer than the accumulator can't be summed safely — exclude it from
      // the grand total (its per-asset total still tracks it). Never mis-count.
      if (scaled !== null) {
        const k = denom.toUpperCase()
        this.denomTotals.set(k, (this.denomTotals.get(k) ?? 0n) + scaled)
      }
    }
    return rec
  }

  /** Record a settled payment. `decimals` is the TRUE token decimals (for the
   *  per-asset running total + the formatted summary). `denom` is the unit-of-account
   *  the payment counts toward in the grand total (or omit for none). Persists to the
   *  {@link SpendStore} when one is configured (a failed append never throws). */
  record(r: SpendRecord, decimals: number, denom?: string): void {
    const rec = this.ingest(r, decimals, denom)
    if (rec && this.store) {
      try {
        this.store.append(rec)
      } catch {
        /* store I/O must never abort a confirmed payment (ERRORS.md) */
      }
    }
  }

  /** Running total (base units) already spent on this (network, asset). */
  totalFor(network: string, asset: string): bigint {
    return this.buckets.get(keyFor(network, asset))?.total ?? 0n
  }

  /**
   * Running grand total for a DENOMINATION, scaled to {@link DENOM_PRECISION} (so
   * tokens of different decimals add up exactly). Summed across every token of that
   * denomination and every chain this ledger has seen. Powers `maxTotalPerDenom`.
   * `0n` for a denomination never spent on. Case-insensitive.
   */
  totalForDenom(denom: string): bigint {
    return this.denomTotals.get(denom.toUpperCase()) ?? 0n
  }

  /** Total number of settled payments (across every chain + token). Powers `maxPayments`. */
  count(): number {
    return this.records.length
  }

  /**
   * Number of settled payments whose `at` (ISO) is at or after `sinceMs` (epoch-ms),
   * across every chain + token. Backs the rolling payment-count cap
   * (`maxPaymentsPerWindow`, `sinceMs = now - windowSeconds*1000`). Linear scan —
   * negligible at agent-session cardinality and only when a window count cap is set.
   */
  countSince(sinceMs: number): number {
    let n = 0
    for (const r of this.records) {
      // FAIL CLOSED on an unparseable `at` (corrupt store): count it toward the window
      // rather than let `NaN >= sinceMs` (always false) silently drop it from the cap.
      const t = Date.parse(r.at)
      if (Number.isNaN(t) || t >= sinceMs) n += 1
    }
    return n
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
      if (r.network !== network || r.asset !== asset) continue
      // FAIL CLOSED on an unparseable `at` (count it toward the window) — see countSince.
      const t = Date.parse(r.at)
      if (Number.isNaN(t) || t >= sinceMs) sum += BigInt(r.amountBase)
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

  /**
   * The per-denomination grand totals, as read-only tuples — `denom` and the running
   * `totalScaled` (at {@link DENOM_PRECISION}). Lets the client compose the grand-total
   * budget view; the cap math lives in the client. A never-spent denomination is absent.
   */
  denomBuckets(): { denom: string; totalScaled: bigint }[] {
    return [...this.denomTotals.entries()].map(([denom, totalScaled]) => ({ denom, totalScaled }))
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
      byDenom: [...this.denomTotals.entries()].map(([denom, scaled]) => ({
        denom,
        totalScaled: scaled.toString(),
        totalFormatted: formatUnits(scaled, DENOM_PRECISION),
        count: this.records.filter((r) => r.denom?.toUpperCase() === denom).length,
      })),
      records: [...this.records],
    }
  }
}
