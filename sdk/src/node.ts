/**
 * `@piprail/sdk/node` — Node-only helpers, kept OUT of the main (browser-safe)
 * entry so `@piprail/sdk` never statically imports `node:fs`.
 *
 * Today this is {@link fileSpendStore}: a one-line durable {@link SpendStore} backed
 * by a local append-only JSONL file, so a client's budget (`maxTotal`,
 * `maxTotalPerDenom`, the payment-count caps) survives a restart. No backend, no
 * database — just a file you own.
 *
 *   import { PipRailClient } from '@piprail/sdk'
 *   import { fileSpendStore } from '@piprail/sdk/node'
 *
 *   const client = new PipRailClient({
 *     chain: 'base', wallet,
 *     policy: { maxTotalPerDenom: { USD: '20.00' } },
 *     spendStore: fileSpendStore('./.piprail-spend.jsonl'),
 *   })
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { SpendRecord } from './ledger.js'
import type { SpendStore } from './spendstore.js'

// Re-export the pure store primitives so `@piprail/sdk/node` is self-sufficient.
export { memorySpendStore } from './spendstore.js'
export type { SpendStore } from './spendstore.js'

/**
 * A durable {@link SpendStore} backed by a local JSONL file (one settled payment per
 * line). `load()` reads + parses the file at construction (a corrupt line is skipped,
 * never fatal); `append()` writes one line per settle. Both swallow every I/O error so
 * a disk hiccup can never abort a confirmed payment (ERRORS.md). The whole
 * {@link SpendRecord} — incl. `decimals` + `denom` — round-trips, so totals and the
 * cross-token grand total rebuild exactly on reload.
 *
 * @param path Filesystem path to the append-only log (created on first write).
 */
export function fileSpendStore(path: string): SpendStore {
  return {
    load(): SpendRecord[] {
      try {
        if (!existsSync(path)) return []
        const out: SpendRecord[] = []
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            out.push(JSON.parse(trimmed) as SpendRecord)
          } catch {
            /* skip a corrupt line — never fail the whole load */
          }
        }
        return out
      } catch {
        return []
      }
    },
    append(record: SpendRecord): void {
      try {
        appendFileSync(path, `${JSON.stringify(record)}\n`)
      } catch {
        /* a failed append must never throw on the payment hot path */
      }
    },
  }
}
