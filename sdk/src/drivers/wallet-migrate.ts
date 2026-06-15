/**
 * v2 wallet-field migration guard. PipRail v2 unified every family's wallet secret
 * into a single `key` field (NEAR also keeps `accountId`). If a caller still passes a
 * v1 field name (`privateKey`/`secretKey`/`seed`/`secret`/`mnemonic`), throw a clear,
 * actionable error pointing at `{ key }` — instead of a generic "wrong shape". Shared
 * by every family's wallet binding so the migration message is identical everywhere.
 *
 * The check is on the TOP-LEVEL wallet object only, so a bring-your-own native object
 * with a nested secret (e.g. TON `{ keyPair: { secretKey } }`) is never falsely flagged.
 */
import { WrongFamilyError } from '../errors.js'

/** The pre-v2 per-family secret field names, all replaced by `key`. */
const LEGACY_WALLET_FIELDS = ['privateKey', 'secretKey', 'seed', 'secret', 'mnemonic'] as const

/**
 * Throw a v2 migration error if `wallet` uses a pre-v2 secret field name. Call at the
 * top of each family's shape guard (after the object null-check). `family` names the
 * chain family for the message (e.g. 'EVM', 'Solana', 'NEAR').
 */
export function assertNoLegacyWalletKey(wallet: object, family: string): void {
  for (const f of LEGACY_WALLET_FIELDS) {
    if (f in wallet) {
      throw new WrongFamilyError(
        `${family} wallet: PipRail v2 unified the wallet secret to a single field — ` +
          `replace { ${f} } with { key }` +
          (family === 'NEAR' ? ' ({ accountId, key })' : '') +
          '.'
      )
    }
  }
}
