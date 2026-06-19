/**
 * Durable spend store — the pluggable seam that lets a client's budget SURVIVE a
 * restart, mirroring the gate's replay-protection `isUsed`/`markUsed` hook.
 *
 * The {@link SpendLedger} is in-memory by default (the session IS the process). Pass
 * a `SpendStore` to {@link PipRailClientOptions.spendStore} (or to
 * `MultiChainPayer.fromWallets`) and the ledger HYDRATES from `load()` at
 * construction and `append()`s every settled payment — so `maxTotal`,
 * `maxTotalPerDenom`, and the payment-count caps resume where they left off after a
 * crash or redeploy, with NO PipRail backend (you own the store, exactly like the
 * replay set).
 *
 * Contract:
 *   - `load()` is read ONCE, synchronously, at ledger construction (the log is small
 *     — one line per payment). Return `[]` for a fresh store.
 *   - `append(record)` persists ONE settled payment. It is called on the hot path, so
 *     it MUST NOT throw and SHOULD NOT block (ERRORS.md §: store I/O never throws — a
 *     failed append is swallowed so a disk hiccup can't abort a confirmed payment).
 *   - Round-trip the WHOLE `SpendRecord` (incl. `decimals` + `denom`) so totals and
 *     the grand-total rebuild exactly on reload — the built-in stores below do.
 *
 * PURE + browser-safe: this module has zero Node/chain imports. The Node-only
 * {@link fileSpendStore} (a one-line local JSONL log) lives in `@piprail/sdk/node`.
 */
import type { SpendRecord } from './ledger.js'

export interface SpendStore {
  /** Hydrate the ledger at construction — every previously-settled payment, in order.
   *  Read once, synchronously. Return `[]` for a fresh store. */
  load(): SpendRecord[]
  /** Persist one settled payment. MUST NOT throw (failures are swallowed by the ledger). */
  append(record: SpendRecord): void
}

/**
 * An in-memory {@link SpendStore} — useful for tests and for sharing a seed across
 * clients in one process. Not durable (it's the default behaviour made explicit);
 * for restart-survival use `fileSpendStore` from `@piprail/sdk/node` or your own.
 */
export function memorySpendStore(seed: SpendRecord[] = []): SpendStore {
  const records: SpendRecord[] = [...seed]
  return {
    load: () => [...records],
    append: (r) => {
      records.push(r)
    },
  }
}
